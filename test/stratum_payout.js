'use strict';
//
// Regression test for per-worker payout addresses.
//
// A worker whose stratum username is a DIFFERENT address than the app's
// configured one must be notified with, and validated against, its own
// coinbase. If those two ever diverge the worker's shares all reject as "low
// difficulty" — a failure that looks like broken hardware, not broken software.
//

const net = require('node:net');
const { Pool } = require('../images/stratum/src/pool');
const { RpcClient } = require('../images/stratum/src/rpc');
const u = require('../images/stratum/src/util');

const RPC_PORT = Number(process.argv[2]);
const STRATUM_PORT = Number(process.argv[3]);
const CONFIG_ADDRESS = process.argv[4];
const WORKER_ADDRESS = process.argv[5];

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

function wordSwap(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < buf.length; i += 4) {
    out[i] = buf[i + 3]; out[i + 1] = buf[i + 2];
    out[i + 2] = buf[i + 1]; out[i + 3] = buf[i];
  }
  return out;
}

class Miner {
  constructor(port) { this.port = port; this.buf = ''; this.h = new Map(); this.id = 1; this.notes = []; }
  connect() {
    return new Promise((res, rej) => {
      this.s = net.connect(this.port, '127.0.0.1', res);
      this.s.on('error', rej);
      this.s.on('data', (c) => {
        this.buf += c.toString();
        const lines = this.buf.split('\n'); this.buf = lines.pop();
        for (const l of lines) {
          if (!l.trim()) continue;
          const m = JSON.parse(l);
          if (m.id != null && this.h.has(m.id)) { this.h.get(m.id)(m); this.h.delete(m.id); }
          else if (m.method === 'mining.notify') this.notes.push(m.params);
        }
      });
    });
  }
  call(method, params) {
    const id = this.id++;
    return new Promise((res) => { this.h.set(id, res); this.s.write(JSON.stringify({ id, method, params }) + '\n'); });
  }
  notify(timeout = 10000) {
    const t0 = Date.now();
    return new Promise((res, rej) => {
      const tick = () => {
        if (this.notes.length) return res(this.notes.shift());
        if (Date.now() - t0 > timeout) return rej(new Error('no notify'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }
}

(async () => {
  const rpc = new RpcClient({ host: '127.0.0.1', port: RPC_PORT, user: 'test', password: 'test' });

  const pool = new Pool({
    rpc: { host: '127.0.0.1', port: RPC_PORT, user: 'test', password: 'test' },
    payoutAddress: CONFIG_ADDRESS,
    stratumPort: STRATUM_PORT,
    startDifficulty: 0.0009765625,
    minDifficulty: 0.0009765625,
    maxDifficulty: 1000000,
    targetShareSeconds: 10,
    vardiffWindow: 8,
    hashrateWindowMs: 300000,
    pollIntervalMs: 5000,
    jobRebuildMs: 30000,
    socketTimeoutMs: 600000,
    coinbaseTag: '/umbrel-doge-solo/',
  });
  await pool.start();

  console.log('\nworker mining to its own address');
  check('the two addresses really are different', CONFIG_ADDRESS !== WORKER_ADDRESS);

  const miner = new Miner(STRATUM_PORT);
  await miner.connect();
  const sub = await miner.call('mining.subscribe', ['payout-test/1.0']);
  const extranonce1 = Buffer.from(sub.result[1], 'hex');
  await miner.call('mining.authorize', [WORKER_ADDRESS, 'x']);

  const [jobId, prevStr, coinb1, coinb2, branch, versionHex, nbitsHex, ntimeHex] = await miner.notify();

  // Prove the notified coinbase pays the WORKER's address, not the app's.
  const cbSample = Buffer.concat([
    Buffer.from(coinb1, 'hex'), extranonce1, Buffer.alloc(4), Buffer.from(coinb2, 'hex'),
  ]).toString('hex');
  const workerScript = u.addressToScript(WORKER_ADDRESS, 'regtest').toString('hex');
  const configScript = u.addressToScript(CONFIG_ADDRESS, 'regtest').toString('hex');
  check('notified coinbase contains the worker address script', cbSample.includes(workerScript));
  check('notified coinbase does NOT contain the app address script', !cbSample.includes(configScript));

  const prevInternal = u.reverseBuffer(wordSwap(u.reverseBuffer(Buffer.from(prevStr, 'hex'))));
  const version = parseInt(versionHex, 16);
  const nbits = parseInt(nbitsHex, 16);
  const ntime = parseInt(ntimeHex, 16);
  const target = u.targetFromBits(nbitsHex);

  let sol = null;
  outer: for (let e2 = 0; e2 < 32; e2++) {
    const en2 = Buffer.alloc(4); en2.writeUInt32BE(e2, 0);
    const cb = Buffer.concat([Buffer.from(coinb1, 'hex'), extranonce1, en2, Buffer.from(coinb2, 'hex')]);
    let root = u.sha256d(cb);
    for (const step of branch) root = u.sha256d(Buffer.concat([root, Buffer.from(step, 'hex')]));
    for (let nonce = 0; nonce < 300000; nonce++) {
      const hdr = Buffer.alloc(80);
      hdr.writeInt32LE(version, 0); prevInternal.copy(hdr, 4); root.copy(hdr, 36);
      hdr.writeUInt32LE(ntime, 68); hdr.writeUInt32LE(nbits, 72); hdr.writeUInt32LE(nonce, 76);
      if (u.bufferToBigInt(u.reverseBuffer(u.scryptHash(hdr))) <= target) {
        // The hash of the header THE MINER built. The pool must end up
        // submitting exactly this block; if it validates against a different
        // coinbase, the tip will be some other hash.
        sol = {
          en2: en2.toString('hex'),
          nonce,
          expectedHash: u.reverseBuffer(u.sha256d(hdr)).toString('hex'),
        };
        break outer;
      }
    }
  }
  check('solution found', sol !== null);

  const before = await rpc.call('getblockcount');
  const submit = await miner.call('mining.submit', [
    WORKER_ADDRESS, jobId, sol.en2, ntimeHex, sol.nonce.toString(16).padStart(8, '0'),
  ]);
  check('share from a differently-addressed worker is ACCEPTED', submit.result === true,
    JSON.stringify(submit.error));

  await new Promise((r) => setTimeout(r, 1500));
  const after = await rpc.call('getblockcount');
  check('node accepted the block', after === before + 1, `${before} -> ${after}`);

  const tipHash = await rpc.call('getblockhash', [after]);
  check('the block on chain is byte-identical to what the miner solved',
    tipHash === sol.expectedHash, `${tipHash} vs ${sol.expectedHash}`);

  const block = await rpc.call('getblock', [tipHash, 2]);
  const addrs = block.tx[0].vout[0].scriptPubKey.addresses || [];
  check('block reward paid to the WORKER address', addrs.includes(WORKER_ADDRESS), JSON.stringify(addrs));
  check('block reward NOT paid to the app address', !addrs.includes(CONFIG_ADDRESS));

  miner.s.destroy();
  pool.stop();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('\nfatal:', e.stack || e.message); process.exit(1); });
