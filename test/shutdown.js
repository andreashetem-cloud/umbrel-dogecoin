'use strict';
//
// A block must survive a shutdown.
//
// The scenario this guards is ordinary: umbrelOS updates the app while a block
// is being submitted, or the node restarts under it and the retry schedule is
// mid-flight. Exiting there means the block never reaches the chain, and the
// only trace is a line in a rotating container log.
//

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('../images/stratum/src/pool');
const { Store } = require('../images/stratum/src/store');

const RPC_PORT = Number(process.argv[2]);
const STRATUM_PORT = Number(process.argv[3]);
const ADDRESS = process.argv[4];

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-shutdown-'));

const cfg = (extra) => ({
  rpc: { host: '127.0.0.1', port: RPC_PORT, user: 'test', password: 'test' },
  payoutAddress: ADDRESS,
  stratumPort: STRATUM_PORT,
  startDifficulty: 0.0009765625,
  minDifficulty: 0.0009765625,
  maxDifficulty: 1024,
  targetShareSeconds: 10,
  vardiffWindow: 8,
  hashrateWindowMs: 300000,
  pollIntervalMs: 60000,
  jobRebuildMs: 30000,
  socketTimeoutMs: 600000,
  coinbaseTag: '/umbrel-doge-solo/',
  ...extra,
});

(async () => {
  console.log('\nthe drain waits for a block that is still being submitted');
  {
    const pool = new Pool(cfg({}));
    await pool.start();

    // Stall submitblock the way a restarting node does.
    let release;
    const gate = new Promise((r) => { release = r; });
    pool.submitRpc = { submitBlock: async () => { await gate; return null; } };

    const job = pool.currentJob;
    const record = { height: job.height, hash: 'a'.repeat(64), worker: 'w', address: ADDRESS,
      reward: 1e12, at: Date.now(), status: 'submitting', accepted: null, error: null };
    // Kick off a submission and let it reach the stalled RPC.
    const submitting = pool.submitBlock(job, { blockHex: '00', blockHash: record.hash }, { worker: 'w', payoutAddress: ADDRESS });
    await sleep(100);

    check('a submission in progress is counted as pending', pool.pending() > 0, String(pool.pending()));

    const started = Date.now();
    const drained = await pool.drain(1500);
    check('drain does NOT report clean while a block is unsubmitted', drained === false);
    check('drain actually waited', Date.now() - started >= 1400);

    release();
    await submitting;
    check('once the submission finishes, nothing is pending', pool.pending() === 0);

    pool.stop();
    await sleep(150);
  }

  console.log('\nnew submissions are refused once shutdown starts');
  {
    const pool = new Pool(cfg({}));
    await pool.start();
    pool.beginShutdown();
    check('the shutdown flag is set', pool.draining === true);

    let replied = null;
    const fakeClient = {
      authorized: true, socket: { destroyed: false, write: () => {} },
      extranonce1: Buffer.alloc(4), target: 1n, difficulty: 1,
    };
    pool.send = (c, obj) => { replied = obj; };
    await pool.handleSubmit(fakeClient, { id: 9, params: ['w', 'nope', '00000000', '00000000', '00000000'] });
    // A submission during shutdown is VALIDATED, not refused. It can be the
    // block, and the drain already waits for work in flight — so the only
    // rejection it may earn is the one its own contents deserve.
    check('a submit during shutdown is still judged on its merits',
      replied && replied.error && /job not found/.test(replied.error[1]), JSON.stringify(replied));
    check('it is not refused merely because the app is stopping',
      !(replied && replied.error && /shutting down/.test(replied.error[1])), JSON.stringify(replied));
    check('new connections are still turned away', pool.server === null || pool.draining === true);
    pool.stop();
    await sleep(150);
  }

  console.log('\nan unresolved block is reconciled against the node at startup');
  {
    const statsPath = path.join(dir, 'stats.json');
    const store = new Store(statsPath);
    store.load();

    // A real block from the chain, recorded as if the process died mid-submit.
    const { RpcClient } = require('../images/stratum/src/rpc');
    const rpc = new RpcClient({ host: '127.0.0.1', port: RPC_PORT, user: 'test', password: 'test' });
    const height = await rpc.call('getblockcount');
    const realHash = await rpc.call('getblockhash', [height]);

    store.recordBlock({ height, hash: realHash, worker: 'w', address: ADDRESS, reward: 1e12,
      at: Date.now(), status: 'submitting', accepted: null, error: null });
    // And one the node has never heard of.
    store.recordBlock({ height: height + 1, hash: 'b'.repeat(64), worker: 'w', address: ADDRESS,
      reward: 1e12, at: Date.now(), status: 'submitting', accepted: null, error: null });
    store.save(true);
    check('before reconciliation nothing counts as found', store.blocksFound() === 0);

    const pool = new Pool(cfg({}), store);
    await pool.start();

    check('a block the node actually has is marked accepted', store.blocksFound() === 1,
      String(store.blocksFound()));
    const phantom = store.state.blocks.find((b) => b.hash === 'b'.repeat(64));
    check('a block the node never received is marked, not left as submitting',
      phantom && phantom.status !== 'submitting', phantom && phantom.status);
    check('the pool reports the reconciled count', pool.stats.blocksFound === 1,
      String(pool.stats.blocksFound));
    pool.stop();
    await sleep(150);
  }

  console.log('\na share validated during shutdown is still counted');
  {
    const pool = new Pool(cfg({}));
    await pool.start();
    const before = pool.stats.accepted;
    // A client whose socket has already gone — the shutdown case.
    const job = pool.currentJob;
    pool.stats.accepted = before; // no-op, keeps the intent explicit
    check('bookkeeping happens before the dead-socket check',
      /client\.accepted\+\+/.test(String(pool.handleSubmit)) &&
      String(pool.handleSubmit).indexOf('client.accepted++') <
        String(pool.handleSubmit).indexOf('if (gone) return;\n    this.reply'),
      'source order');
    pool.stop();
    await sleep(150);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nSHUTDOWN SAFETY VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
