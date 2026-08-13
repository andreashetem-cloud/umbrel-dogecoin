'use strict';
//
// The aux longpoll against a REAL dogecoind.
//
// Everything in test/aux_longpoll.js is about our own loop and is driven with a
// scripted RPC. This one is about the claims we make about DOGECOIN, and it
// asks the binary rather than the source:
//
//   1. getblocktemplate's longpoll returns within milliseconds of the tip
//      moving — the signal the whole change is built on.
//   2. createauxblock issues a different aux block once the tip has moved.
//   3. submitauxblock on the PREVIOUS aux hash answers "block hash unknown" —
//      the window this change exists to close, measured rather than asserted.
//   4. A spent longpollid returns immediately, which is why the loop always
//      takes the id from the newest answer and throttles anyway.
//
// Needs a regtest dogecoind. test/aux_longpoll_regtest.sh fetches one and
// starts it; this file only talks to it.
//
//   node test/aux_longpoll_regtest.js <rpcPort> <user> <password>
//

const { RpcClient } = require('../images/stratum/src/rpc');
const { Pool } = require('../images/stratum/src/pool');

const [, , portArg, user, password] = process.argv;
const rpc = new RpcClient({ host: '127.0.0.1', port: Number(portArg), user, password, timeout: 30000 });
// A second client, because a longpoll blocks its connection for as long as it
// waits — exactly the reason the pool uses a dedicated one.
const longpoll = new RpcClient({ host: '127.0.0.1', port: Number(portArg), user, password, timeout: 120000 });

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  const address = await rpc.call('getnewaddress');
  // Enough height that merged mining is allowed at all. Below Dogecoin's
  // auxpow start height every aux RPC answers "getauxblock method is not yet
  // available" — which, unlike the errors below, says nothing about the node
  // being unreachable and would be a confusing way for this suite to fail.
  await rpc.call('generate', [50]);

  console.log('\nwhat each RPC needs before it will answer');
  {
    const peers = await rpc.call('getconnectioncount');
    check('the node under test has a peer', peers >= 1, String(peers));
    // Worth stating in a test, because it is the one asymmetry that can make
    // this loop fail while the poll it backs up keeps working: Dogecoin Core
    // 1.14.9 exempts regtest from the peer requirement in AuxMiningCheck but
    // NOT in getblocktemplate — Bitcoin Core exempts both. On mainnet a node
    // without peers is a node that is not mining anyway, so the pool treats a
    // refusal here as an ordinary backoff rather than as an alarm of its own.
    const aux = await rpc.call('createauxblock', [address]);
    check('createauxblock answers once the chain is high enough',
      /^[0-9a-f]{64}$/.test(String(aux.hash)), JSON.stringify(aux).slice(0, 120));
  }

  console.log('\nthe signal: getblocktemplate longpoll on the aux chain');
  const first = await rpc.call('getblocktemplate', [{ rules: [] }]);
  check('a template carries a longpollid', typeof first.longpollid === 'string' && first.longpollid.length > 64,
    String(first.longpollid));

  {
    // Arm the longpoll, then move the tip out from under it.
    const started = Date.now();
    const waiting = longpoll.call('getblocktemplate', [{ longpollid: first.longpollid, rules: [] }]);
    // Long enough that the call is certainly blocked in cvBlockChange rather
    // than still being parsed.
    await new Promise((r) => setTimeout(r, 500));
    const generated = await rpc.call('generate', [1]);
    const answer = await waiting;
    const elapsed = Date.now() - started;

    check('the longpoll returns when the tip moves', !!answer, 'no answer');
    // The whole point. A poll notices this after up to POLL_INTERVAL_SECONDS;
    // this is the round trip of one RPC call.
    check('within a few hundred milliseconds of the block', elapsed < 2000, `${elapsed}ms`);
    check('and describes the new tip',
      answer.previousblockhash === generated[0], `${answer.previousblockhash} vs ${generated[0]}`);
    check('with a fresh longpollid', answer.longpollid !== first.longpollid, answer.longpollid);
  }

  {
    // A spent id must be assumed to return instantly: this is why the loop
    // refreshes the id from every answer and throttles regardless.
    const started = Date.now();
    await longpoll.call('getblocktemplate', [{ longpollid: first.longpollid, rules: [] }]);
    check('a spent longpollid returns immediately', Date.now() - started < 1000, `${Date.now() - started}ms`);
  }

  console.log('\nthe window: what happens to an aux block when the tip moves');
  {
    const before = await rpc.call('createauxblock', [address]);
    check('createauxblock issues an aux block', /^[0-9a-f]{64}$/.test(String(before.hash)), String(before.hash));
    check('for the Dogecoin chain id', before.chainid === 98, String(before.chainid));

    const again = await rpc.call('createauxblock', [address]);
    // Verified in AuxMiningCreateBlock: the cached block is returned unless the
    // tip moved, or the mempool changed AND more than 60 seconds passed.
    check('and caches it while the tip stands still', again.hash === before.hash,
      `${again.hash} vs ${before.hash}`);

    await rpc.call('generate', [1]);
    const after = await rpc.call('createauxblock', [address]);
    check('a moved tip produces a different aux block', after.hash !== before.hash,
      `${after.hash} vs ${before.hash}`);
    check('at the next height', after.height === before.height + 1, `${after.height} vs ${before.height}`);

    // The measurement. dogecoind cleared mapNewBlock when the tip moved, so a
    // proof for the old aux block — a Dogecoin block we actually solved — is
    // refused outright. Every second between a new Dogecoin block and our
    // noticing it is time spent producing exactly this.
    let refusal = null;
    try {
      await rpc.call('submitauxblock', [before.hash, '00']);
    } catch (err) {
      refusal = err.message;
    }
    check('a proof for the superseded aux block is refused',
      /block hash unknown/i.test(String(refusal)), String(refusal));

    // And that the POOL recognises that refusal — checked by replaying
    // dogecoind's own words back through the real code path rather than by
    // testing the same regex twice.
    //
    // This is the join between the two halves of the change. If a future
    // Dogecoin release rewords this error, the check above still passes on the
    // new wording while this one fails, and the failure says exactly what
    // broke: the pool would go back to spending its whole hundred-second retry
    // schedule on an aux block that can never be accepted, at the moment it
    // most needs those RPC threads.
    const seen = { stats: { auxTipMissed: 0, auxTipMissedAt: null }, log() {},
      submitRpc: { call() { return Promise.reject(new Error(String(refusal))); } } };
    let attempts = 0;
    seen.submitRpc.call = () => { attempts++; return Promise.reject(new Error(String(refusal))); };
    const verdict = await Pool.prototype.submitAuxWithRetries.call(seen, before.hash, '00', before.height);
    check('and the pool stops retrying on it', attempts === 1, `${attempts} attempts`);
    check('reporting it as a moved tip', /tip moved/.test(String(verdict)), String(verdict));
    check('and counting the block it cost', seen.stats.auxTipMissed === 1, String(seen.stats.auxTipMissed));
  }

  console.log('\nthe cost: what following the tip asks of the node');
  {
    // The loop holds one RPC thread while it waits. The node app ships
    // rpcthreads=8, so this only matters if a blocked longpoll were somehow to
    // block anything else — assert that it does not.
    const waiting = longpoll.call('getblocktemplate', [
      { longpollid: (await rpc.call('getblocktemplate', [{ rules: [] }])).longpollid, rules: [] },
    ]);
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    const info = await rpc.call('getblockchaininfo');
    check('other RPC calls are unaffected while a longpoll waits',
      !!info && Date.now() - started < 1000, `${Date.now() - started}ms`);
    await rpc.call('generate', [1]);
    await waiting;
  }

  console.log(failures === 0 ? '\nAUX LONGPOLL VERIFIED AGAINST DOGECOIND' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`  FAIL  the suite threw: ${err.message}`);
  process.exit(1);
});
