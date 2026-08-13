'use strict';
//
// Following Dogecoin's tip instead of polling it.
//
// Why this exists at all, verified in Dogecoin Core 1.14.9, src/rpc/mining.cpp:
//
//   AuxMiningCreateBlock:  if (pindexPrev != chainActive.Tip()) {
//                            mapNewBlock.clear(); ... }
//   AuxMiningSubmitBlock:  const auto mit = mapNewBlock.find(hash);
//                          if (mit == mapNewBlock.end())
//                            throw JSONRPCError(RPC_INVALID_PARAMETER,
//                                               "block hash unknown");
//
// So every aux block dogecoind has issued becomes unsubmittable the instant its
// tip moves. At a two second poll that left, on average, one second of every
// sixty second Dogecoin block being hashed against an aux block that could no
// longer be handed in — the ~1.7% this loop closes. getblocktemplate's longpoll
// returns the moment the tip changes, which is the edge we actually need.
//
// The loop is driven directly, with a scripted RPC, because the interesting
// cases — a first call with no id, an id that must be refreshed, an error that
// must not end the loop — are ordering, not timing.
//

const { Pool } = require('../images/stratum/src/pool');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// `script` receives (pool, params) and returns the template to answer with, or
// throws. It is responsible for stopping the loop.
function makePool(script, over = {}) {
  const p = {
    stopped: false,
    merged: true,
    config: { minLongpollIntervalMs: 0, auxLongpoll: true },
    lastAuxLongpollId: null,
    auxLongpollSignals: 0,
    auxUnavailableSince: null,
    calls: [],
    refreshes: [],
    longpollRpc: {
      call(method, params) {
        p.calls.push({ method, params: params[0] });
        try {
          return Promise.resolve(script(p, params[0]));
        } catch (err) {
          return Promise.reject(err);
        }
      },
    },
    refreshMergedTemplate(reason) {
      p.refreshes.push(reason);
      return Promise.resolve();
    },
    log() {},
    ...over,
  };
  p.run = () => Pool.prototype.auxLongPollLoop.call(p);
  return p;
}

const timeout = () => Object.assign(new Error('RPC getblocktemplate timed out'), { code: 'ETIMEDOUT' });

(async () => {
  console.log('\nthe first call only collects an id');
  {
    // Stopped after ONE call, so what is measured below is the effect of that
    // call alone. Letting a second one run and then asserting "exactly one
    // refresh" would pass whether the first call refreshed or not.
    const p = makePool((pool) => {
      pool.stopped = true;
      return { longpollid: `id-${pool.calls.length}` };
    });
    await p.run();
    check('exactly one call was made', p.calls.length === 1, String(p.calls.length));
    check('it carries no longpollid',
      p.calls[0].params.longpollid === undefined, JSON.stringify(p.calls[0].params));
    // Otherwise every startup fires a redundant full refresh, and the counter
    // that says "the longpoll is working" is wrong from the first second.
    check('it is not counted as a tip movement',
      p.auxLongpollSignals === 0, String(p.auxLongpollSignals));
    check('nor does it refresh anything on its own',
      p.refreshes.length === 0, JSON.stringify(p.refreshes));
    check('but the id it returned is kept',
      p.lastAuxLongpollId === 'id-1', String(p.lastAuxLongpollId));
  }

  console.log('\na returning longpoll is a tip movement');
  {
    const p = makePool((pool) => {
      if (pool.calls.length >= 4) pool.stopped = true;
      return { longpollid: `id-${pool.calls.length}` };
    });
    await p.run();
    check('every call after the first refreshes the job',
      p.refreshes.length === 3, JSON.stringify(p.refreshes));
    check('labelled so the log says where it came from',
      p.refreshes.every((r) => r === 'aux-longpoll'), JSON.stringify(p.refreshes));
    check('and each one is counted', p.auxLongpollSignals === 3, String(p.auxLongpollSignals));
  }

  console.log('\nthe id always comes from the newest answer');
  {
    const p = makePool((pool) => {
      if (pool.calls.length >= 4) pool.stopped = true;
      return { longpollid: `id-${pool.calls.length}` };
    });
    await p.run();
    // A spent longpollid returns instantly — that is exactly how this loop
    // would turn into a hammer on the RPC threads a found block needs.
    check('the second call sends the first answer\'s id',
      p.calls[1].params.longpollid === 'id-1', String(p.calls[1].params.longpollid));
    check('the fourth sends the third\'s',
      p.calls[3].params.longpollid === 'id-3', String(p.calls[3].params.longpollid));
  }

  console.log('\nan answer without an id does not resurrect an old one');
  {
    const p = makePool((pool) => {
      if (pool.calls.length >= 3) pool.stopped = true;
      return pool.calls.length === 2 ? {} : { longpollid: `id-${pool.calls.length}` };
    });
    await p.run();
    check('the previous id is kept rather than cleared',
      p.calls[2].params.longpollid === 'id-1', String(p.calls[2].params.longpollid));
  }

  console.log('\nnothing ends the loop');
  {
    const p = makePool((pool) => {
      if (pool.calls.length >= 4) pool.stopped = true;
      if (pool.calls.length === 2) throw timeout();
      return { longpollid: `id-${pool.calls.length}` };
    });
    await p.run();
    check('a timed-out longpoll is survived', p.calls.length === 4, String(p.calls.length));
    check('and is not counted as a tip movement',
      p.auxLongpollSignals === 2, String(p.auxLongpollSignals));
  }
  {
    // refreshMergedTemplate rejects when the Litecoin node is unreachable.
    // Letting that escape would silently return the aux side to polling —
    // the exact regression this whole loop exists to remove, and invisible.
    const p = makePool((pool) => {
      if (pool.calls.length >= 3) pool.stopped = true;
      return { longpollid: `id-${pool.calls.length}` };
    }, {
      refreshMergedTemplate(reason) {
        this.refreshes.push(reason);
        return Promise.reject(new Error('cannot reach the Litecoin node'));
      },
    });
    await p.run();
    check('a failing refresh does not end the loop', p.calls.length === 3, String(p.calls.length));
  }

  console.log('\nit cannot become a busy loop');
  {
    const p = makePool((pool) => {
      if (pool.calls.length >= 4) pool.stopped = true;
      return { longpollid: 'same-id-every-time' };
    }, { config: { minLongpollIntervalMs: 60, auxLongpoll: true } });
    const started = Date.now();
    await p.run();
    const elapsed = Date.now() - started;
    // Four instant answers with a 60ms floor: three throttled gaps at least.
    check('the throttle is applied even when every answer is instant',
      elapsed >= 170, `${elapsed}ms for ${p.calls.length} calls`);
  }
  {
    const p = makePool((pool) => {
      if (pool.calls.length >= 2) pool.stopped = true;
      throw new Error('Dogecoin is downloading blocks...');
    });
    const started = Date.now();
    await p.run();
    // A node in initial download refuses every call instantly. Without the
    // backoff this would spin at the speed of the loop against a node that is
    // already busy doing something more useful.
    check('a refusing node is backed off from', Date.now() - started >= 1900,
      `${Date.now() - started}ms`);
  }

  console.log('\nthe recovery message is left to its owner');
  {
    const p = makePool((pool) => {
      if (pool.calls.length >= 2) pool.stopped = true;
      return { longpollid: `id-${pool.calls.length}` };
    }, { auxUnavailableSince: 1_786_000_000_000 });
    await p.run();
    // This call proves dogecoind is answering, but clearing the flag here
    // would delete "the Dogecoin node is answering again after Ns" before
    // refreshMergedTemplate ever prints it.
    check('auxUnavailableSince is not cleared by the longpoll',
      p.auxUnavailableSince === 1_786_000_000_000, String(p.auxUnavailableSince));
  }

  console.log('\nthe block this loop exists to save');
  {
    // The other half of the same source fact. When dogecoind has already
    // discarded the aux block, submitauxblock throws "block hash unknown" —
    // and mapNewBlock only ever shrinks on a tip change, so that verdict can
    // never become true again. Spending the six-step retry schedule on it
    // burns a hundred seconds of certainty.
    let calls = 0;
    const p = {
      stats: { auxTipMissed: 0, auxTipMissedAt: null },
      log() {},
      submitRpc: { call() { calls++; return Promise.reject(new Error('block hash unknown')); } },
    };
    const verdict = await Pool.prototype.submitAuxWithRetries.call(p, 'ab'.repeat(32), 'cd', 6330327);
    check('a discarded aux block is not retried', calls === 1, `${calls} attempts`);
    check('it is reported as a moved tip, not as an error',
      /tip moved/.test(String(verdict)), String(verdict));
    check('and it is counted', p.stats.auxTipMissed === 1, String(p.stats.auxTipMissed));
    check('with a timestamp', Number.isFinite(p.stats.auxTipMissedAt), String(p.stats.auxTipMissedAt));
  }
  {
    // The fail-fast must not have cost the retries that everything else needs:
    // a node that is briefly busy is exactly what the schedule is for.
    let calls = 0;
    const p = {
      stats: { auxTipMissed: 0, auxTipMissedAt: null },
      log() {},
      submitRpc: {
        call() {
          calls++;
          return calls === 1
            ? Promise.reject(new Error('Work queue depth exceeded'))
            : Promise.resolve(true);
        },
      },
    };
    const verdict = await Pool.prototype.submitAuxWithRetries.call(p, 'ab'.repeat(32), 'cd', 6330327);
    check('a busy node is still retried', calls === 2, `${calls} attempts`);
    check('and the block is accepted on the second attempt', verdict === null, String(verdict));
    check('nothing is counted as a moved tip', p.stats.auxTipMissed === 0, String(p.stats.auxTipMissed));
  }

  console.log('\nwhen it runs at all');
  {
    const wants = (merged, auxLongpoll) =>
      Pool.prototype.wantsAuxLongpoll.call({ merged, config: { auxLongpoll } });
    check('merged mining with it on: yes', wants(true, true) === true);
    // In Dogecoin-only mode the main longpoll ALREADY follows dogecoind; a
    // second loop would hold a second RPC thread for nothing.
    check('Dogecoin-only: no', wants(false, true) === false);
    check('switched off: no', wants(true, false) === false);
  }

  console.log(failures === 0 ? '\nAUX LONGPOLL VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
