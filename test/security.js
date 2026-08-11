'use strict';
//
// Adversarial tests. Stratum is unauthenticated by design, so every one of
// these is something a person on the same network can actually do.
//

const net = require('node:net');
const { Pool } = require('../images/stratum/src/pool');
const u = require('../images/stratum/src/util');

const RPC_PORT = Number(process.argv[2]);
const STRATUM_PORT = Number(process.argv[3]);
const ADDRESS = process.argv[4];
const OTHER = process.argv[5];

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

function connect(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s));
    // Resume the stream and swallow errors. A Node socket with no 'data'
    // listener stays paused, never reads, and therefore never notices that the
    // peer hung up — which makes a correctly-disconnecting server look broken.
    s.on('data', () => {});
    s.on('error', () => {});
    s.once('error', (err) => { if (!s.connecting) return; reject(err); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pool = new Pool({
    rpc: { host: '127.0.0.1', port: RPC_PORT, user: 'test', password: 'test' },
    payoutAddress: ADDRESS,
    stratumPort: STRATUM_PORT,
    startDifficulty: 0.0009765625,
    minDifficulty: 0.0009765625,
    maxDifficulty: 1000,
    targetShareSeconds: 10,
    vardiffWindow: 8,
    hashrateWindowMs: 300000,
    pollIntervalMs: 60000,
    jobRebuildMs: 30000,
    socketTimeoutMs: 600000,
    coinbaseTag: '/umbrel-doge-solo/',
    maxConnections: 5,
    maxMessagesPer10s: 20,
    maxPayoutVariants: 2,
  });
  await pool.start();

  console.log('\nlimits hold against a hostile client');

  // --- connection ceiling ---
  const sockets = [];
  for (let i = 0; i < 5; i++) sockets.push(await connect(STRATUM_PORT));
  await sleep(200);
  check('accepts up to the connection limit', pool.clients.size === 5, String(pool.clients.size));

  const extra = await connect(STRATUM_PORT);
  await sleep(300);
  check('refuses connections beyond the limit', pool.clients.size === 5, String(pool.clients.size));
  check('the refused socket is closed, not left hanging', extra.destroyed || !extra.writable);

  for (const s of sockets) s.destroy();
  await sleep(300);
  check('closing frees the slots again', pool.clients.size === 0, String(pool.clients.size));

  // --- message flood ---
  const flood = await connect(STRATUM_PORT);
  let closed = false;
  flood.on('close', () => { closed = true; });
  for (let i = 0; i < 60; i++) {
    flood.write(JSON.stringify({ id: i, method: 'mining.subscribe', params: [] }) + '\n');
  }
  for (let i = 0; i < 30 && !closed && !flood.destroyed; i++) await sleep(100);
  check('a message flood gets disconnected', closed || flood.destroyed);

  // --- oversized line ---
  const big = await connect(STRATUM_PORT);
  let bigClosed = false;
  big.on('close', () => { bigClosed = true; });
  big.write('{"id":1,"method":"mining.subscribe","params":["' + 'A'.repeat(40000) + '"]}\n');
  for (let i = 0; i < 20 && !bigClosed && !big.destroyed; i++) await sleep(100);
  check('an oversized message gets disconnected', bigClosed || big.destroyed);

  // --- payout variant ceiling ---
  const job = pool.currentJob;
  check('a job exists to test against', !!job);
  const fakeClients = [ADDRESS, OTHER, ADDRESS, OTHER].map((addr) => ({
    payoutScript: u.addressToScript(addr, pool.chain),
  }));
  // Two distinct scripts, requested repeatedly: must produce two variants.
  for (const c of fakeClients) pool.jobForClient(job, c);
  check('variants are shared between clients with the same address',
    job.variants.size === 2, String(job.variants.size));

  // A third distinct address is past maxPayoutVariants and must not allocate.
  const thirdScript = Buffer.from('76a914' + 'ab'.repeat(20) + '88ac', 'hex');
  const fallback = pool.jobForClient(job, { payoutScript: thirdScript });
  check('beyond the variant ceiling it falls back instead of allocating',
    job.variants.size === 2 && fallback === job, String(job.variants.size));

  // --- malformed input must not crash the process ---
  const junk = await connect(STRATUM_PORT);
  const payloads = [
    'not json at all',
    '{"id":1}',
    '{"id":2,"method":"mining.submit"}',
    '{"id":3,"method":"mining.submit","params":"not-an-array"}',
    '{"id":4,"method":"mining.authorize","params":[null]}',
    '{"id":5,"method":"__proto__","params":[]}',
    '{"id":6,"method":"mining.suggest_difficulty","params":[-1]}',
    '{"id":7,"method":"mining.suggest_difficulty","params":["NaN"]}',
    '[]',
    'null',
  ];
  let junkClosed = false;
  junk.on('close', () => { junkClosed = true; });
  for (const p of payloads) { junk.write(p + '\n'); await sleep(20); }
  await sleep(400);
  check('malformed input does not take the server down', pool.server.listening);
  // Junk must be ignored, not punished: a firmware quirk should not cost a
  // miner its connection. If this fails while the check above passes, the
  // outer safety net is catching what the parser should have rejected.
  check('malformed input is ignored rather than disconnecting the miner',
    !junkClosed && !junk.destroyed);

  // --- prototype pollution attempt ---
  junk.write('{"id":8,"method":"mining.authorize","params":["__proto__"]}\n');
  await sleep(200);
  check('Object.prototype is intact', ({}).polluted === undefined);

  // --- unauthorized submit ---
  const sneaky = await connect(STRATUM_PORT);
  let sneakyReply = '';
  sneaky.on('data', (d) => { sneakyReply += d.toString(); });
  await sleep(50);
  sneaky.write('{"id":1,"method":"mining.submit","params":["x","' + (job ? job.id : '0') + '","00000000","00000000","00000000"]}\n');
  await sleep(300);
  check('submitting without authorizing is refused',
    /unauthorized/.test(sneakyReply), sneakyReply.slice(0, 120));

  // --- the status snapshot must not leak credentials ---
  const snap = JSON.stringify(pool.snapshot());
  check('the status payload contains no RPC password', !snap.includes('test') || !snap.includes('password'));
  check('the status payload has no rpc section at all', !/"rpc"/.test(snap));

  for (const s of [flood, big, junk, sneaky, extra]) s.destroy();
  pool.stop();

  console.log(failures === 0 ? '\nSECURITY CHECKS PASSED' : `\n${failures} SECURITY CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
