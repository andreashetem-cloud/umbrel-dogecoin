'use strict';
//
// End-to-end test of the stratum wire protocol.
//
// The fake miner below deliberately does NOT reuse the Job class. It rebuilds
// the coinbase, merkle root and header from nothing but the mining.notify
// parameters, exactly as real firmware does. If our notify format were subtly
// wrong — the prevhash word-swap being the classic one — this test fails while
// a test built on shared internals would happily pass.
//

const net = require('node:net');
const crypto = require('node:crypto');

const { Pool } = require('../images/stratum/src/pool');
const { RpcClient } = require('../images/stratum/src/rpc');
const u = require('../images/stratum/src/util');

const RPC_PORT = Number(process.argv[2] || 18332);
const STRATUM_PORT = Number(process.argv[3] || 23456);
const ADDRESS = process.argv[4];

if (!ADDRESS) {
  console.error('usage: node test/stratum_e2e.js <rpc-port> <stratum-port> <address>');
  process.exit(2);
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Reverse the bytes within each 4-byte word.
function wordSwap(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < buf.length; i += 4) {
    out[i] = buf[i + 3];
    out[i + 1] = buf[i + 2];
    out[i + 2] = buf[i + 1];
    out[i + 3] = buf[i];
  }
  return out;
}

class FakeMiner {
  constructor(port, username) {
    this.port = port;
    this.username = username;
    this.buffer = '';
    this.handlers = new Map();
    this.nextId = 1;
    this.notifications = [];
    this.difficulty = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(this.port, '127.0.0.1', resolve);
      this.socket.on('error', reject);
      this.socket.on('data', (chunk) => this.onData(chunk));
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== null && msg.id !== undefined && this.handlers.has(msg.id)) {
        const { resolve } = this.handlers.get(msg.id);
        this.handlers.delete(msg.id);
        resolve(msg);
      } else if (msg.method === 'mining.notify') {
        this.notifications.push(msg.params);
      } else if (msg.method === 'mining.set_difficulty') {
        this.difficulty = msg.params[0];
      }
    }
  }

  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.handlers.set(id, { resolve });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  waitForNotify(timeoutMs = 10000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.notifications.length) return resolve(this.notifications.shift());
        if (Date.now() - started > timeoutMs) return reject(new Error('no mining.notify'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }
}

(async () => {
  const rpc = new RpcClient({
    host: '127.0.0.1',
    port: RPC_PORT,
    user: 'test',
    password: 'test',
  });

  const pool = new Pool({
    rpc: { host: '127.0.0.1', port: RPC_PORT, user: 'test', password: 'test' },
    payoutAddress: ADDRESS,
    stratumPort: STRATUM_PORT,
    startDifficulty: 0.0009765625, // 2^-10, low enough that regtest yields shares fast
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
  console.log('\nstratum protocol handshake');

  const miner = new FakeMiner(STRATUM_PORT, ADDRESS);
  await miner.connect();

  const sub = await miner.call('mining.subscribe', ['test-miner/1.0']);
  check('subscribe returns subscriptions, extranonce1, extranonce2 size',
    Array.isArray(sub.result) && sub.result.length === 3 && sub.result[2] === 4,
    JSON.stringify(sub.result));
  const extranonce1 = Buffer.from(sub.result[1], 'hex');
  check('extranonce1 is 4 bytes', extranonce1.length === 4);

  const auth = await miner.call('mining.authorize', [ADDRESS, 'x']);
  check('authorize succeeds', auth.result === true);

  const params = await miner.waitForNotify();
  check('set_difficulty was sent before the job', miner.difficulty !== null, String(miner.difficulty));

  const [jobId, prevHashStratum, coinb1, coinb2, branch, versionHex, nbitsHex, ntimeHex, cleanJobs] = params;
  check('notify carries nine parameters', params.length === 9);
  check('cleanJobs is set for a fresh job', cleanJobs === true);
  check('version is 8 hex chars', /^[0-9a-f]{8}$/.test(versionHex), versionHex);
  check('nbits is 8 hex chars', /^[0-9a-f]{8}$/.test(nbitsHex), nbitsHex);
  check('merkle branch is an array', Array.isArray(branch));

  // Independently recover the internal prevhash from the stratum encoding and
  // compare it against what the node says the tip is.
  const recovered = u.reverseBuffer(wordSwap(u.reverseBuffer(Buffer.from(prevHashStratum, 'hex'))));
  const tip = await rpc.call('getbestblockhash');
  check('prevhash round-trips to the real chain tip',
    recovered.toString('hex') === u.reverseHex(tip),
    `${recovered.toString('hex')} vs ${u.reverseHex(tip)}`);

  console.log('\nmining a real block through the wire protocol');

  const prevInternal = recovered;
  const version = parseInt(versionHex, 16);
  const nbits = parseInt(nbitsHex, 16);
  const ntime = parseInt(ntimeHex, 16);
  const networkTarget = u.targetFromBits(nbitsHex);

  let solution = null;
  outer: for (let e2 = 0; e2 < 32; e2++) {
    const extranonce2 = Buffer.alloc(4);
    extranonce2.writeUInt32BE(e2, 0);

    // Rebuild the coinbase the way firmware does: concatenate the four pieces.
    const coinbase = Buffer.concat([
      Buffer.from(coinb1, 'hex'),
      extranonce1,
      extranonce2,
      Buffer.from(coinb2, 'hex'),
    ]);
    let root = u.sha256d(coinbase);
    for (const step of branch) {
      root = u.sha256d(Buffer.concat([root, Buffer.from(step, 'hex')]));
    }

    for (let nonce = 0; nonce < 300000; nonce++) {
      const header = Buffer.alloc(80);
      header.writeInt32LE(version, 0);
      prevInternal.copy(header, 4);
      root.copy(header, 36);
      header.writeUInt32LE(ntime, 68);
      header.writeUInt32LE(nbits, 72);
      header.writeUInt32LE(nonce, 76);

      const pow = u.bufferToBigInt(u.reverseBuffer(u.scryptHash(header)));
      if (pow <= networkTarget) {
        solution = { extranonce2: extranonce2.toString('hex'), nonce, header };
        break outer;
      }
    }
  }

  check('the fake miner found a block-level solution', solution !== null);
  if (!solution) throw new Error('no solution');

  const before = await rpc.call('getblockcount');
  const submit = await miner.call('mining.submit', [
    ADDRESS,
    jobId,
    solution.extranonce2,
    ntimeHex,
    solution.nonce.toString(16).padStart(8, '0'),
  ]);
  check('share accepted by the pool', submit.result === true, JSON.stringify(submit.error));

  await new Promise((r) => setTimeout(r, 1500));
  const after = await rpc.call('getblockcount');
  check('the node accepted the block', after === before + 1, `${before} -> ${after}`);

  const snap = pool.snapshot();
  check('pool counted the block', snap.blocksFound === 1, String(snap.blocksFound));
  check('block record marked accepted', snap.blocks[0] && snap.blocks[0].accepted === true);
  check('worker shows up in the snapshot', snap.workers.length === 1);
  check('worker payout address taken from the username',
    snap.workers[0].payoutAddress === ADDRESS, snap.workers[0].payoutAddress);

  console.log('\nrejection paths');
  const dup = await miner.call('mining.submit', [
    ADDRESS, jobId, solution.extranonce2, ntimeHex, solution.nonce.toString(16).padStart(8, '0'),
  ]);
  check('duplicate share is rejected', dup.result === null && /duplicate/.test(dup.error[1]), JSON.stringify(dup.error));

  const badJob = await miner.call('mining.submit', [ADDRESS, 'ffffffff', '00000000', ntimeHex, '00000000']);
  check('unknown job is rejected', badJob.result === null && /job not found/.test(badJob.error[1]));

  const badNonce = await miner.call('mining.submit', [ADDRESS, jobId, '00000000', ntimeHex, 'zz']);
  check('malformed nonce is rejected', badNonce.result === null && /nonce/.test(badNonce.error[1]));

  const badTime = await miner.call('mining.submit', [ADDRESS, jobId, '00000000', '00000000', '00000000']);
  check('ntime below mintime is rejected', badTime.result === null && /ntime/.test(badTime.error[1]));

  // An unauthorized connection must not be able to submit.
  const stranger = new FakeMiner(STRATUM_PORT, 'x');
  await stranger.connect();
  await stranger.call('mining.subscribe', ['x']);
  const unauth = await stranger.call('mining.submit', ['x', jobId, '00000000', ntimeHex, '00000000']);
  check('unauthorized submit is refused', unauth.result === null && /unauthorized/.test(unauth.error[1]));
  stranger.socket.destroy();

  console.log('\nfallback behaviour');
  const junk = new FakeMiner(STRATUM_PORT, 'not-an-address');
  await junk.connect();
  await junk.call('mining.subscribe', ['x']);
  await junk.call('mining.authorize', ['not-an-address', 'x']);
  await junk.waitForNotify();
  const snap2 = pool.snapshot();
  const junkWorker = snap2.workers.find((w) => w.worker === 'not-an-address');
  check('a non-address username falls back to the configured payout address',
    junkWorker && junkWorker.payoutAddress === ADDRESS, junkWorker && junkWorker.payoutAddress);
  junk.socket.destroy();

  miner.socket.destroy();
  pool.stop();

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nfatal:', err.stack || err.message);
  process.exit(1);
});
