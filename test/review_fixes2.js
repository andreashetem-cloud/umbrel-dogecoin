'use strict';
//
// Guards for the second review round. Both bugs below were invisible in normal
// operation: one threw away a solved block, the other quietly paid the wrong
// address while reporting the right one.
//

const net = require('node:net');
const { Pool } = require('../images/stratum/src/pool');
const { RpcClient } = require('../images/stratum/src/rpc');
const u = require('../images/stratum/src/util');

const RPC_PORT = Number(process.argv[2]);
const STRATUM_PORT = Number(process.argv[3]);
const ADDRESS = process.argv[4];

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s));
    s.on('data', () => {});
    s.on('error', () => {});
    s.once('error', (e) => { if (s.connecting) reject(e); });
  });
}
function wordSwap(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < buf.length; i += 4) {
    out[i] = buf[i + 3]; out[i + 1] = buf[i + 2];
    out[i + 2] = buf[i + 1]; out[i + 3] = buf[i];
  }
  return out;
}

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
  const rpc = new RpcClient({ host: '127.0.0.1', port: RPC_PORT, user: 'test', password: 'test' });

  console.log('\na solved block survives the miner disconnecting');
  {
    const pool = new Pool(cfg({}));
    await pool.start();

    const miner = await connect(STRATUM_PORT);
    let buf = '';
    let extranonce1 = null;
    let job = null;
    miner.on('data', (c) => {
      buf += c.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        const m = JSON.parse(l);
        if (m.id === 1 && Array.isArray(m.result)) extranonce1 = Buffer.from(m.result[1], 'hex');
        if (m.method === 'mining.notify') job = m.params;
      }
    });
    miner.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['t'] }) + '\n');
    await sleep(200);
    miner.write(JSON.stringify({ id: 2, method: 'mining.authorize', params: ['w', 'x'] }) + '\n');
    for (let i = 0; i < 40 && !job; i++) await sleep(100);
    check('the miner received a job', !!job && !!extranonce1);

    // Find a nonce that meets the NETWORK target, i.e. a real block.
    const [jobId, prev, cb1, cb2, branch, versionHex, nbitsHex, ntimeHex] = job;
    const prevInternal = u.reverseBuffer(wordSwap(u.reverseBuffer(Buffer.from(prev, 'hex'))));
    const version = parseInt(versionHex, 16);
    const nbits = parseInt(nbitsHex, 16);
    const ntime = parseInt(ntimeHex, 16);
    const target = u.targetFromBits(nbitsHex);

    let sol = null;
    outer: for (let e2 = 0; e2 < 40; e2++) {
      const en2 = Buffer.alloc(4); en2.writeUInt32BE(e2, 0);
      const cb = Buffer.concat([Buffer.from(cb1, 'hex'), extranonce1, en2, Buffer.from(cb2, 'hex')]);
      let root = u.sha256d(cb);
      for (const s of branch) root = u.sha256d(Buffer.concat([root, Buffer.from(s, 'hex')]));
      for (let nonce = 0; nonce < 300000; nonce++) {
        const h = Buffer.alloc(80);
        h.writeInt32LE(version, 0); prevInternal.copy(h, 4); root.copy(h, 36);
        h.writeUInt32LE(ntime, 68); h.writeUInt32LE(nbits, 72); h.writeUInt32LE(nonce, 76);
        if (u.bufferToBigInt(u.reverseBuffer(u.scryptHash(h))) <= target) {
          sol = { en2: en2.toString('hex'), nonce }; break outer;
        }
      }
    }
    check('found a block-level solution', !!sol);

    const before = await rpc.call('getblockcount');
    // Submit the winning share and immediately kill the connection, which is
    // what a TCP reset or the rate limiter would do mid-verification.
    miner.write(JSON.stringify({
      id: 3, method: 'mining.submit',
      params: ['w', jobId, sol.en2, ntimeHex, sol.nonce.toString(16).padStart(8, '0')],
    }) + '\n');
    miner.destroy();

    await sleep(3000);
    const after = await rpc.call('getblockcount');
    check('the block was still submitted after the miner vanished',
      after === before + 1, `${before} -> ${after}`);
    check('the pool recorded the block', pool.stats.blocks.length >= 1);
    pool.stop();
    await sleep(200);
  }

  console.log('\nthe payout address reported is the one that gets paid');
  {
    const pool = new Pool(cfg({ maxPayoutVariants: 2 }));
    await pool.start();

    const addrs = [];
    for (let i = 0; i < 4; i++) addrs.push(await rpc.call('getnewaddress'));

    const miners = [];
    for (const a of addrs) {
      const s = await connect(STRATUM_PORT);
      s.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['t'] }) + '\n');
      await sleep(80);
      s.write(JSON.stringify({ id: 2, method: 'mining.authorize', params: [a, 'x'] }) + '\n');
      await sleep(150);
      miners.push(s);
    }
    await sleep(300);

    const snap = pool.snapshot();
    check('all four workers connected', snap.workers.length === 4, String(snap.workers.length));

    // For every worker, the address the dashboard reports must be the address
    // the coinbase it is notified with actually pays.
    let mismatches = 0;
    for (const client of pool.clients.values()) {
      if (!client.authorized) continue;
      const job = pool.clientJob(client, pool.currentJob);
      const paidScript = client.payoutScript
        ? client.payoutScript.toString('hex')
        : pool.payoutScript.toString('hex');
      const reported = client.payoutAddress || pool.config.payoutAddress;
      const expectedScript = u.addressToScript(reported, pool.chain).toString('hex');
      const coinbaseHex = Buffer.concat([job.coinb1, job.coinb2]).toString('hex');
      if (expectedScript !== paidScript || !coinbaseHex.includes(paidScript)) mismatches++;
    }
    check('no worker is paid an address other than the one reported for it',
      mismatches === 0, `${mismatches} mismatch(es)`);

    const distinct = new Set(snap.workers.map((w) => w.payoutAddress));
    check('the payout-address limit is respected', distinct.size <= 3, String(distinct.size));

    for (const s of miners) s.destroy();
    pool.stop();
    await sleep(200);
  }

  console.log('\nthe status payload stays small after blocks are found');
  {
    const pool = new Pool(cfg({}));
    await pool.start();
    for (let i = 0; i < 50; i++) {
      pool.stats.blocks.push({
        height: i, hash: 'a'.repeat(64), worker: 'w', address: ADDRESS,
        reward: 1000000000000, at: Date.now(), status: 'accepted', accepted: true,
        error: null, blockHex: 'ab'.repeat(60000), // a realistic mainnet block
      });
    }
    const bytes = JSON.stringify(pool.snapshot()).length;
    check('the block hex is not served to the dashboard', bytes < 50000, `${bytes} bytes`);
    check('the hex is still retained in memory for a manual resubmit',
      typeof pool.stats.blocks[0].blockHex === 'string');
    pool.stop();
    await sleep(200);
  }

  console.log('\na stopped pool can be started again');
  {
    const pool = new Pool(cfg({}));
    await pool.start();
    pool.stop();
    await sleep(300);
    let restarted = false;
    try { await pool.start(); restarted = true; } catch { /* ignore */ }
    check('start() works again after stop()', restarted);
    check('the longpoll loop is not left disabled', pool.stopped === false);
    pool.stop();
    await sleep(200);
  }

  console.log('\na winning share is never discarded by our own clock');
  {
    const { Job, judgeShare } = require('../images/stratum/src/job');
    // A job whose network target is the easiest possible, so any hash wins.
    const job = { networkTarget: (1n << 256n) - 1n, serializeBlock: () => 'deadbeef' };
    const prepared = { header: Buffer.alloc(80), coinbase: Buffer.alloc(10), ntimeTooFarAhead: true };
    const powHash = Buffer.alloc(32, 0x11);
    const verdict = judgeShare(job, prepared, powHash, [1n]);
    check('a block candidate with an out-of-bounds ntime is still accepted',
      verdict.ok === true && verdict.isBlockCandidate === true, JSON.stringify(verdict.reason));
    check('and it is serialised for submission', verdict.blockHex === 'deadbeef', String(verdict.blockHex));

    // The same share, without the work, is refused for the right reason.
    const hardJob = { networkTarget: 1n, serializeBlock: () => 'x' };
    const refused = judgeShare(hardJob, prepared, powHash, [1n]);
    check('a non-winning share with a bad ntime is still refused',
      refused.ok === false && /ntime/.test(refused.reason), JSON.stringify(refused.reason));
  }

  console.log(failures === 0 ? '\nSECOND-ROUND FIXES VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
