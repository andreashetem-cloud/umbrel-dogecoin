'use strict';
//
// Merged mining, end to end, THROUGH THE POOL.
//
// test/merged_regtest.js proves the auxpow rules against the two daemons using
// the helper directly. This one proves the thing the user actually runs: a
// stratum client connects, is handed work, finds one hash, and that single
// share becomes a Dogecoin block accepted by dogecoind AND a Litecoin block
// accepted by litecoind.
//
// The fake miner deliberately rebuilds the coinbase, merkle root and header
// from nothing but the mining.notify parameters, exactly as firmware does — so
// the aux commitment has to have survived the coinb1/coinb2 split, the
// extranonce splice and the wire encoding. Reusing MergedJob here would hide
// precisely the mistakes that matter.
//
// Usage: node test/merged_pool.js <ltcRpcPort> <dogeRpcPort> <stratumPort>
//

const net = require('node:net');

const { Pool } = require('../images/stratum/src/pool');
const { RpcClient } = require('../images/stratum/src/rpc');
const u = require('../images/stratum/src/util');
const aux = require('../images/stratum/src/auxpow');

const LTC_PORT = Number(process.argv[2] || 19332);
const DOGE_PORT = Number(process.argv[3] || 18332);
const STRATUM_PORT = Number(process.argv[4] || 23720);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const ltc = new RpcClient({ host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' });
const doge = new RpcClient({ host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' });

class FakeMiner {
  constructor(port) {
    this.port = port;
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
      } else if (msg.method === 'mining.notify') this.notifications.push(msg.params);
      else if (msg.method === 'mining.set_difficulty') this.difficulty = msg.params[0];
    }
  }
  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.handlers.set(id, { resolve });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  waitForNotify(timeoutMs = 15000) {
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

// Reverse the bytes within each 4-byte word — the other half of the stratum
// prevhash encoding.
function wordSwap(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < buf.length; i += 4) {
    out[i] = buf[i + 3]; out[i + 1] = buf[i + 2]; out[i + 2] = buf[i + 1]; out[i + 3] = buf[i];
  }
  return out;
}

(async () => {
  const ltcInfo = await ltc.call('getblockchaininfo');
  const dogeInfo = await doge.call('getblockchaininfo');
  console.log('\nboth chains are reachable');
  check('litecoind answers on regtest', ltcInfo.chain === 'regtest', ltcInfo.chain);
  check('dogecoind answers on regtest', dogeInfo.chain === 'regtest', dogeInfo.chain);

  const dogeAddress = await doge.call('getnewaddress');
  // Legacy: the coinbase builder emits P2PKH/P2SH scripts, and bech32 would
  // need a different output type.
  const ltcAddress = await ltc.call('getnewaddress', ['', 'legacy']);

  console.log('\nthe pool refuses to start when the parent side is not configured');
  // A real Dogecoin MAINNET address (version 0x1e), used as the Litecoin
  // payout. It decodes cleanly as base58check — only the version byte says it
  // belongs to the wrong chain, and that is the whole point of validating
  // against the Litecoin key rather than merely "is this an address".
  //
  // Stated on mainnet's version bytes too, because on regtest both chains
  // share 0x6f and the mistake is genuinely undetectable there.
  const DOGE_MAINNET = 'D8j25uHwZgyNYiSAG3UXNHyDu1coFAxxDf';
  let crossChain = null;
  try { u.addressToScript(DOGE_MAINNET, 'ltc-main'); } catch (err) { crossChain = err.message; }
  check('a Dogecoin mainnet address is not a valid Litecoin payout address',
    crossChain !== null && /not valid on ltc-main/.test(crossChain), String(crossChain));

  const badAddress = new Pool({
    rpc: { host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' },
    ltcRpc: { host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' },
    mergedMining: true,
    payoutAddress: dogeAddress,
    // The same wrong-chain address, now in front of the real startup path.
    ltcPayoutAddress: DOGE_MAINNET,
    stratumPort: STRATUM_PORT + 90,
    startDifficulty: 1, minDifficulty: 1, maxDifficulty: 1000,
    targetShareSeconds: 10, vardiffWindow: 8, hashrateWindowMs: 300000,
    pollIntervalMs: 5000, jobRebuildMs: 30000, socketTimeoutMs: 600000,
    coinbaseTag: '/umbrel-doge-solo/',
  });
  let refused = null;
  try { await badAddress.start(); } catch (err) { refused = err.message; }
  badAddress.stop();
  check('a wrong-chain LTC_PAYOUT_ADDRESS is refused at startup',
    refused !== null && /not valid on ltc/.test(refused), String(refused));

  const missing = new Pool({
    rpc: { host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' },
    ltcRpc: { host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' },
    mergedMining: true,
    payoutAddress: dogeAddress,
    ltcPayoutAddress: '',
    stratumPort: STRATUM_PORT + 91,
    startDifficulty: 1, minDifficulty: 1, maxDifficulty: 1000,
    targetShareSeconds: 10, vardiffWindow: 8, hashrateWindowMs: 300000,
    pollIntervalMs: 5000, jobRebuildMs: 30000, socketTimeoutMs: 600000,
    coinbaseTag: '/umbrel-doge-solo/',
  });
  let refusedMissing = null;
  try { await missing.start(); } catch (err) { refusedMissing = err.message; }
  missing.stop();
  check('a missing LTC_PAYOUT_ADDRESS is refused at startup',
    refusedMissing !== null && /LTC_PAYOUT_ADDRESS/.test(refusedMissing), String(refusedMissing));

  console.log('\nthe merged pool starts and builds a job on both chains');
  const pool = new Pool({
    rpc: { host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' },
    ltcRpc: { host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' },
    mergedMining: true,
    payoutAddress: dogeAddress,
    ltcPayoutAddress: ltcAddress,
    stratumPort: STRATUM_PORT,
    // 2^-10: low enough that a regtest share arrives immediately, so the block
    // paths are reached without minutes of hashing.
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

  const job = pool.currentJob;
  check('the job is built on the Litecoin template',
    job.template.previousblockhash === (await ltc.call('getbestblockhash')),
    job.template.previousblockhash);
  check('the job carries a Dogecoin aux block', /^[0-9a-f]{64}$/.test(job.auxHash || ''), job.auxHash);
  check('per-worker payout addresses are locked off in merged mode',
    pool.config.lockPayoutAddress === true);

  // Both targets from bits, never from the target strings the two daemons
  // report in opposite byte orders.
  const auxBlock = await doge.call('createauxblock', [dogeAddress]);
  check('dogecoind hands the pool and the test the same aux block',
    auxBlock.hash === job.auxHash, `${auxBlock.hash} vs ${job.auxHash}`);
  const auxTarget = u.targetFromBits(auxBlock.bits);
  check('the pool derived the aux target from bits', job.auxTarget === auxTarget,
    `${job.auxTarget} vs ${auxTarget}`);
  check('the pool derived the parent target from bits',
    job.networkTarget === u.targetFromBits(job.template.bits), String(job.networkTarget));

  console.log('\na stratum client is handed work carrying the commitment');
  const miner = new FakeMiner(STRATUM_PORT);
  await miner.connect();
  const sub = await miner.call('mining.subscribe', ['merged-test/1.0']);
  const extranonce1 = Buffer.from(sub.result[1], 'hex');
  const authorized = await miner.call('mining.authorize', ['merged-worker', 'x']);
  check('authorize succeeds', authorized.result === true);

  const params = await miner.waitForNotify();
  const [jobId, prevHashStratum, coinb1, coinb2, branch, versionHex, nbitsHex, ntimeHex] = params;

  const commitment = aux.auxCommitment(auxBlock.hash, 0).toString('hex');
  check('the aux commitment reaches the miner in coinb2',
    coinb2.includes(commitment), coinb2);
  check('the merged-mining magic appears exactly once in the work',
    (coinb1 + coinb2).split('fabe6d6d').length - 1 === 1);

  const prevInternal = u.reverseBuffer(wordSwap(u.reverseBuffer(Buffer.from(prevHashStratum, 'hex'))));
  check('prevhash on the wire is the LITECOIN tip',
    prevInternal.toString('hex') === u.reverseHex(await ltc.call('getbestblockhash')),
    prevInternal.toString('hex'));

  console.log('\none share, mined against the harder of the two targets');
  const version = parseInt(versionHex, 16);
  const nbits = parseInt(nbitsHex, 16);
  const ntime = parseInt(ntimeHex, 16);
  const ltcTarget = u.targetFromBits(nbitsHex);
  // Deliberately the harder target, so the share proves BOTH chains rather
  // than whichever happens to be easier on this regtest pair.
  const goal = auxTarget < ltcTarget ? auxTarget : ltcTarget;

  let solution = null;
  outer: for (let e2 = 0; e2 < 64; e2++) {
    const extranonce2 = Buffer.alloc(4);
    extranonce2.writeUInt32BE(e2, 0);
    const coinbase = Buffer.concat([
      Buffer.from(coinb1, 'hex'), extranonce1, extranonce2, Buffer.from(coinb2, 'hex'),
    ]);
    let root = u.sha256d(coinbase);
    for (const step of branch) root = u.sha256d(Buffer.concat([root, Buffer.from(step, 'hex')]));

    for (let nonce = 0; nonce < 400000; nonce++) {
      const header = Buffer.alloc(80);
      header.writeInt32LE(version, 0);
      prevInternal.copy(header, 4);
      root.copy(header, 36);
      header.writeUInt32LE(ntime, 68);
      header.writeUInt32LE(nbits, 72);
      header.writeUInt32LE(nonce, 76);
      const pow = u.bufferToBigInt(u.reverseBuffer(u.scryptHash(header)));
      if (pow <= goal) {
        solution = { extranonce2: extranonce2.toString('hex'), nonce, pow };
        break outer;
      }
    }
  }
  check('the fake miner found a hash meeting both targets', solution !== null);
  if (!solution) throw new Error('no solution');
  check('that hash meets the Dogecoin target', solution.pow <= auxTarget);
  check('that hash meets the Litecoin target', solution.pow <= ltcTarget);

  const dogeBefore = await doge.call('getblockcount');
  const ltcBefore = await ltc.call('getblockcount');

  const submitted = await miner.call('mining.submit', [
    'merged-worker', jobId, solution.extranonce2, ntimeHex,
    solution.nonce.toString(16).padStart(8, '0'),
  ]);
  check('the pool accepted the share', submitted.result === true, JSON.stringify(submitted.error));

  // Both submissions run off the share path without being awaited; drain waits
  // for exactly them.
  await pool.drain(60000);

  console.log('\ndogecoind accepted the merge-mined block');
  const dogeAfter = await doge.call('getblockcount');
  check('the Dogecoin chain grew by one', dogeAfter === dogeBefore + 1, `${dogeBefore} -> ${dogeAfter}`);
  const dogeTip = await doge.call('getblock', [await doge.call('getblockhash', [dogeAfter])]);
  check('the new Dogecoin tip is the aux block the pool committed to',
    dogeTip.hash === job.auxHash, `${dogeTip.hash} vs ${job.auxHash}`);
  check('it is recorded as an auxpow block', !!dogeTip.auxpow);
  const dogeCoinbase = await doge.call('getrawtransaction', [dogeTip.tx[0], 1]);
  const paidTo = dogeCoinbase.vout.flatMap((o) => o.scriptPubKey.addresses || []);
  check('the Dogecoin reward pays PAYOUT_ADDRESS', paidTo.includes(dogeAddress), JSON.stringify(paidTo));

  console.log('\nlitecoind accepted the very same header');
  const ltcAfter = await ltc.call('getblockcount');
  check('the Litecoin chain grew by one', ltcAfter === ltcBefore + 1, `${ltcBefore} -> ${ltcAfter}`);
  const ltcTip = await ltc.call('getblock', [await ltc.call('getblockhash', [ltcAfter]), 2]);
  // The whole claim of merged mining, stated as one equality: the header
  // Dogecoin accepted as its parent IS the block Litecoin accepted.
  const parentHeader = Buffer.from(dogeTip.auxpow.parentblock, 'hex');
  check('the parent header inside the Dogecoin block hashes to the Litecoin tip',
    u.reverseBuffer(u.sha256d(parentHeader)).toString('hex') === ltcTip.hash,
    `${u.reverseBuffer(u.sha256d(parentHeader)).toString('hex')} vs ${ltcTip.hash}`);
  const ltcCoinbase = ltcTip.tx[0];
  const ltcPaidTo = ltcCoinbase.vout.flatMap((o) => {
    const spk = o.scriptPubKey;
    return spk.addresses || (spk.address ? [spk.address] : []);
  });
  check('the Litecoin reward pays LTC_PAYOUT_ADDRESS', ltcPaidTo.includes(ltcAddress),
    JSON.stringify(ltcPaidTo));
  check('the Litecoin coinbase carries the aux commitment',
    ltcCoinbase.vin[0].coinbase.includes(commitment), ltcCoinbase.vin[0].coinbase);

  console.log('\nthe pool recorded one block per chain');
  const snap = pool.snapshot();
  check('merged mode is visible in the status', snap.mergedMining === true);
  check('the parent chain is reported separately',
    snap.merged && snap.merged.parentChain === 'LTC' &&
      snap.merged.parentPayoutAddress === ltcAddress, JSON.stringify(snap.merged));
  // Dogecoin's height, not Litecoin's: this is a Dogecoin app. Read off the
  // current job rather than the block just found, because both chains have
  // already moved on by now.
  check('the headline height is DOGECOIN\'s', snap.height === pool.currentJob.auxHeight,
    `${snap.height} vs ${pool.currentJob.auxHeight}`);
  check('two blocks were found', snap.blocksFound === 2, String(snap.blocksFound));
  const dogeRecord = snap.blocks.find((b) => b.chain === 'DOGE');
  const ltcRecord = snap.blocks.find((b) => b.chain === 'LTC');
  check('there is a DOGE record, accepted, at the aux height',
    !!dogeRecord && dogeRecord.accepted === true && dogeRecord.hash === job.auxHash &&
      dogeRecord.address === dogeAddress, JSON.stringify(dogeRecord));
  check('there is an LTC record, accepted, at the parent height',
    !!ltcRecord && ltcRecord.accepted === true && ltcRecord.height === job.height &&
      ltcRecord.address === ltcAddress, JSON.stringify(ltcRecord));
  check('the two records are for different chains at different heights',
    dogeRecord && ltcRecord && dogeRecord.hash !== ltcRecord.hash);

  console.log('\nthe templates followed both tips');
  // Both chains moved because of the block just submitted, so the job must
  // have been rebuilt on both sides.
  const rebuilt = await waitFor(() =>
    pool.currentJob &&
    pool.currentJob.auxHash !== job.auxHash &&
    pool.currentJob.template.previousblockhash !== job.template.previousblockhash, 20000);
  check('a new job was built after both chains advanced', rebuilt,
    pool.currentJob && `${pool.currentJob.auxHash} / ${pool.currentJob.template.previousblockhash}`);

  // A Dogecoin block alone must also move the job, which is the path the
  // Litecoin longpoll cannot cover.
  const before = pool.currentJob.auxHash;
  await doge.call('generatetoaddress', [1, dogeAddress]);
  const auxFollowed = await waitFor(() => pool.currentJob && pool.currentJob.auxHash !== before, 20000);
  check('a Dogecoin-only tip change rebuilds the job too', auxFollowed,
    pool.currentJob && pool.currentJob.auxHash);

  miner.socket.destroy();
  pool.stop();

  console.log(failures === 0 ? '\nMERGED POOL VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
