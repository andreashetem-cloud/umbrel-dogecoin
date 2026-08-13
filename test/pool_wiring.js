'use strict';
//
// A real Pool, started, against nodes that answer.
//
// Everything else in this repo tests the pieces: onMergedTemplate is driven
// directly, auxLongPollLoop is driven directly, the health monitor is driven
// with hand-built snapshots. That leaves the wiring untested, and a reviewer
// proved how much that matters by deleting the single line in start() that
// launches the aux longpoll — the whole suite stayed green, because nothing
// asserted the loop is ever actually started.
//
// So this one starts the thing. Two mock nodes, merged mining on, and then the
// questions that only a started pool can answer:
//
//   * does the aux longpoll run at all, and stop when it is switched off?
//   * does a Dogecoin tip move reach the miners in milliseconds rather than
//     waiting for the poll — the entire point of the change?
//   * does the loop give itself up rather than tie up the node's RPC threads?
//   * does stop() actually stop it?
//

const { Pool } = require('../images/stratum/src/pool');
const { MockNode } = require('./mock-node');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for a condition rather than sleeping a fixed time: a fixed sleep is a
// race that passes on this machine and fails on an Umbrel.
async function until(fn, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

function config(doge, ltc, over = {}) {
  return {
    rpc: { host: '127.0.0.1', port: doge.port, user: 'u', password: 'p' },
    ltcRpc: { host: '127.0.0.1', port: ltc.port, user: 'u', password: 'p' },
    mergedMining: true,
    auxLongpoll: true,
    payoutAddress: 'DU4KTk97aC46ZbXjdTpP9tFNYCrmuLZXLd',
    ltcPayoutAddress: 'LdAEjWgrrUjyV6Cy3DTKZ3uBNmG3FQhXsj',
    stratumPort: 0,
    startDifficulty: 2048,
    minDifficulty: 64,
    maxDifficulty: 4194304,
    targetShareSeconds: 12,
    vardiffWindow: 10,
    hashrateWindowMs: 600000,
    // Deliberately far longer than anything this suite waits for. If a refresh
    // happens here it was the longpoll that caused it, not the poll — which is
    // the whole distinction being measured.
    pollIntervalMs: 3600000,
    jobRebuildMs: 30000,
    socketTimeoutMs: 900000,
    coinbaseTag: '/t/',
    minLongpollIntervalMs: 10,
    ...over,
  };
}

(async () => {
  console.log('\nstarting a merged pool');
  const doge = new MockNode({ chain: 'main', aux: true });
  const ltc = new MockNode({ chain: 'main' });
  await doge.listen();
  await ltc.listen();

  const pool = new Pool(config(doge, ltc));
  pool.on('error', () => {});
  await pool.start();

  check('it starts', pool.started === true);
  check('with a merged job', !!pool.currentJob && !!pool.currentJob.auxBlock,
    pool.currentJob ? 'no aux block' : 'no job');

  console.log('\nthe aux longpoll is actually launched by start()');
  {
    // This is the check whose absence a reviewer demonstrated: the loop can be
    // perfect and never run.
    const armed = await until(() =>
      doge.calls.some((c) => c.method === 'getblocktemplate' && c.params[0] && c.params[0].longpollid));
    check('a longpoll is armed against dogecoind', armed,
      JSON.stringify(doge.calls.map((c) => c.method)));
    check('and it is the Dogecoin node, not only the Litecoin one',
      doge.countOf('getblocktemplate') >= 1, String(doge.countOf('getblocktemplate')));
  }

  console.log('\na Dogecoin tip move reaches the miners at once');
  {
    const auxBefore = doge.countOf('createauxblock');
    const jobBefore = pool.currentJob.id;
    const started = Date.now();
    doge.mine();
    const refreshed = await until(() => doge.countOf('createauxblock') > auxBefore);
    const elapsed = Date.now() - started;

    check('a fresh aux block is fetched', refreshed,
      `${doge.countOf('createauxblock')} vs ${auxBefore}`);
    // The poll is an hour away in this configuration, so anything under a
    // second can only have come from the longpoll. This is the ~1.7%.
    check('within milliseconds, not at the next poll', elapsed < 1000, `${elapsed}ms`);
    check('and the miners are given a new job', pool.currentJob.id !== jobBefore,
      `${pool.currentJob.id} vs ${jobBefore}`);
    check('it is counted as a tip movement', pool.auxTipMoves >= 1, String(pool.auxTipMoves));
  }

  console.log('\na mempool update is not a tip movement');
  {
    // Core's longpoll has a second exit: about a minute after the mempool
    // changes it returns a template for the SAME tip. On mainnet the mempool is
    // rarely quiet for a minute, so counting those would roughly double the
    // figure that is supposed to prove this loop is working — and a dead loop
    // would be indistinguishable from a busy mempool.
    const movesBefore = pool.auxTipMoves;
    const signalsBefore = pool.auxLongpollSignals;
    doge.bumpMempool();
    const noticed = await until(() => pool.auxLongpollSignals > signalsBefore);
    check('the return is noticed', noticed, `${pool.auxLongpollSignals} vs ${signalsBefore}`);
    check('but not counted as a tip movement', pool.auxTipMoves === movesBefore,
      `${pool.auxTipMoves} vs ${movesBefore}`);
  }

  console.log('\na template that cannot become a job is not "work"');
  {
    // refreshMergedTemplate used to stamp "a template arrived" and clear the
    // error BEFORE building the job, with every caller swallowing what the
    // build threw. A template that could not be turned into a job therefore
    // left miners on stale work indefinitely while the dashboard, the
    // healthcheck and the alarm all reported a healthy pool.
    const before = pool.snapshot().templateAgeMs;
    ltc.badTemplate = true;
    doge.mine();
    const noticed = await until(() => !!pool.snapshot().templateError);
    check('it is reported as a template error', noticed, String(pool.snapshot().templateError));
    // And told apart from an unreachable node, because the two send the
    // operator to completely different places.
    check('marked as unusable rather than unreachable',
      pool.snapshot().templateErrorKind === 'unusable', String(pool.snapshot().templateErrorKind));
    check('and the pool stops claiming it just got work',
      pool.snapshot().templateAgeMs >= before, `${pool.snapshot().templateAgeMs} vs ${before}`);

    // It recovers on its own once the templates are usable again.
    ltc.badTemplate = false;
    doge.mine();
    const cleared = await until(() => !pool.snapshot().templateError);
    check('and recovers when the templates are usable again', cleared,
      String(pool.snapshot().templateError));
  }

  console.log('\nand the pool reports the template as fresh');
  {
    const snap = pool.snapshot();
    check('the template age is small', snap.templateAgeMs < 2000, String(snap.templateAgeMs));
    check('no template error', snap.templateError === null, String(snap.templateError));
    check('the aux longpoll is advertised as on', snap.auxLongpoll === true, String(snap.auxLongpoll));
  }

  console.log('\nstop() really stops it');
  {
    pool.stop();
    await sleep(100);
    const after = doge.calls.length;
    await sleep(400);
    check('no further calls are made to dogecoind', doge.calls.length === after,
      `${doge.calls.length} vs ${after}`);
  }

  console.log('\nswitched off, nothing longpolls dogecoind');
  {
    const doge2 = new MockNode({ chain: 'main', aux: true });
    const ltc2 = new MockNode({ chain: 'main' });
    await doge2.listen();
    await ltc2.listen();
    const p = new Pool(config(doge2, ltc2, { auxLongpoll: false }));
    p.on('error', () => {});
    await p.start();
    await sleep(300);
    const longpolled = doge2.calls.some((c) => c.method === 'getblocktemplate' && c.params[0] && c.params[0].longpollid);
    check('AUX_LONGPOLL=0 is honoured', longpolled === false,
      JSON.stringify(doge2.calls.map((c) => c.method)));
    // And the Litecoin longpoll is unaffected — switching the new loop off must
    // not switch off the one that was always there.
    check('the parent longpoll still runs',
      ltc2.calls.some((c) => c.method === 'getblocktemplate' && c.params[0] && c.params[0].longpollid),
      JSON.stringify(ltc2.calls.map((c) => c.method)));
    p.stop();
    await doge2.close();
    await ltc2.close();
  }

  console.log('\na node that never answers a longpoll does not tie up its RPC threads');
  {
    // dogecoind's longpoll wait has no timeout and does not notice that our
    // socket has gone, so every abandoned longpoll parks a worker thread there
    // until the tip moves. Measured on a real node: with rpcthreads=4, the
    // fourth abort made every other call — including submitauxblock — time out.
    // The loop therefore gives itself up rather than keep re-arming.
    const doge3 = new MockNode({ chain: 'main', aux: true });
    const ltc3 = new MockNode({ chain: 'main' });
    await doge3.listen();
    await ltc3.listen();
    doge3.stalled = true;

    const p = new Pool(config(doge3, ltc3, {
      // A short client timeout so three of them take a moment rather than six
      // minutes; the real one is 120 seconds.
      minLongpollIntervalMs: 5,
    }));
    // The same client the loop uses, with its timeout shortened for the test,
    // and the same give-up rule with its waits shortened. The real figures are
    // a 120 second timeout and a 30 second backoff, which would make this one
    // check take six minutes.
    p.longpollRpc.timeout = 120;
    p.auxLongpollBackoffMs = 50;
    p.on('error', () => {});
    await p.start();

    const gaveUp = await until(() => !!p.auxLongpollDisabled, 6000);
    check('it gives up after a few timeouts in a row', gaveUp, String(p.auxLongpollDisabled));
    check('and says why', /timed out/.test(String(p.auxLongpollDisabled)), String(p.auxLongpollDisabled));
    check('the dashboard is told the loop is no longer running',
      p.snapshot().auxLongpoll === false, String(p.snapshot().auxLongpoll));

    // Bounded, not unbounded: the point is that it stops re-arming.
    const armed = doge3.waiters.length;
    await sleep(300);
    check('it stops arming new longpolls', doge3.waiters.length === armed,
      `${doge3.waiters.length} vs ${armed}`);
    // And mining continues on the poll, which is correct if slower.
    check('the pool keeps its job', !!p.currentJob);

    p.stop();
    await doge3.close();
    await ltc3.close();
  }

  await doge.close();
  await ltc.close();

  console.log(failures === 0 ? '\nPOOL WIRING VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`  FAIL  the suite threw: ${err.stack}`);
  process.exit(1);
});
