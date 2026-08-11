'use strict';
//
// Regression guards for the findings from the independent review. Each test
// here exists because a reviewer found a way to lose a block, lose a miner, or
// lose the node's RPC capacity.
//

const net = require('node:net');
const { Pool } = require('../images/stratum/src/pool');
const { Job, validateShare } = require('../images/stratum/src/job');
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

const baseConfig = (extra) => ({
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
  const template = await rpc.call('getblocktemplate', [{ rules: [] }]);
  const script = u.addressToScript(ADDRESS, 'regtest');

  console.log('\nntime bounds must never discard a winning share');
  {
    // A template whose curtime is stale, as happens when the node stops
    // answering while miners keep rolling ntime forward.
    const stale = { ...template, curtime: template.curtime - 3600, mintime: template.mintime - 3600 };
    const job = new Job('a', stale, script);
    const ntime = stale.curtime + 1800; // half an hour past the template
    const res = validateShare(job, {
      extranonce1: Buffer.from('00000000', 'hex'),
      extranonce2Hex: '00000000',
      ntimeHex: ntime.toString(16).padStart(8, '0'),
      nonceHex: '00000001',
      shareTarget: job.networkTarget,
    });
    check('an ntime 30 minutes past a stale template is not refused outright',
      res.reason !== 'ntime too far in the future' && !/beyond the 2-hour/.test(res.reason || ''),
      res.reason);

    const absurd = Math.floor(Date.now() / 1000) + 10800; // 3 hours ahead
    const res2 = validateShare(job, {
      extranonce1: Buffer.from('00000000', 'hex'),
      extranonce2Hex: '00000000',
      ntimeHex: absurd.toString(16).padStart(8, '0'),
      nonceHex: '00000001',
      shareTarget: job.networkTarget,
    });
    check('an ntime beyond the 2-hour consensus limit is still refused',
      /consensus limit/.test(res2.reason || ''), res2.reason);
  }

  console.log('\nvardiff must not reject work already handed out');
  {
    const pool = new Pool(baseConfig({ difficultyGraceMs: 60000 }));
    await pool.start();
    const miner = await connect(STRATUM_PORT);
    miner.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['t'] }) + '\n');
    await sleep(150);
    miner.write(JSON.stringify({ id: 2, method: 'mining.authorize', params: ['w', 'x'] }) + '\n');
    await sleep(250);

    const client = [...pool.clients.values()][0];
    const easyTarget = client.target;
    pool.setDifficulty(client, client.difficulty * 8); // a big tightening
    check('the previous target is retained after a difficulty rise',
      client.previousTarget === easyTarget);
    check('the grace period is in the future', client.previousTargetUntil > Date.now());
    check('the new target really is harder', client.target < easyTarget);
    miner.destroy();
    pool.stop();
    await sleep(150);
  }

  console.log('\nre-authorizing must not swap the coinbase under in-flight work');
  {
    const pool = new Pool(baseConfig({}));
    await pool.start();
    const miner = await connect(STRATUM_PORT);
    miner.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['t'] }) + '\n');
    await sleep(150);
    miner.write(JSON.stringify({ id: 2, method: 'mining.authorize', params: [ADDRESS, 'x'] }) + '\n');
    await sleep(250);
    const client = [...pool.clients.values()][0];
    const firstScript = client.payoutScript && client.payoutScript.toString('hex');
    check('the first authorize took the address from the username', !!firstScript);

    miner.write(JSON.stringify({ id: 3, method: 'mining.authorize', params: ['plain-worker', 'x'] }) + '\n');
    await sleep(250);
    const secondScript = client.payoutScript && client.payoutScript.toString('hex');
    check('a second authorize does not change the payout script',
      secondScript === firstScript, `${firstScript} -> ${secondScript}`);
    check('the reported address still matches the script in use',
      client.payoutAddress === ADDRESS, client.payoutAddress);
    miner.destroy();
    pool.stop();
    await sleep(150);
  }

  console.log('\nstart() must not stack background work');
  {
    const pool = new Pool(baseConfig({}));
    await pool.start();
    let threw = false;
    try { await pool.start(); } catch { threw = true; }
    check('a second start() on the same instance is refused', threw);

    // A port clash must leave nothing running behind.
    const blocker = new Pool(baseConfig({}));
    let blockerFailed = false;
    try { await blocker.start(); } catch { blockerFailed = true; }
    check('a second pool on the same port fails to start', blockerFailed);
    check('the failed pool armed no poll timer', !blocker.pollTimer);
    check('the failed pool is not marked started', !blocker.started);
    blocker.stop();
    pool.stop();
    await sleep(150);
  }

  console.log('\nper-source connection cap');
  {
    const pool = new Pool(baseConfig({ maxConnections: 32, maxConnectionsPerIp: 3, handshakeTimeoutMs: 800 }));
    await pool.start();
    const sockets = [];
    for (let i = 0; i < 6; i++) sockets.push(await connect(STRATUM_PORT));
    await sleep(400);
    check('one host cannot exceed the per-IP cap', pool.clients.size === 3, String(pool.clients.size));

    // And silent connections must not hold their slots indefinitely.
    await sleep(1400);
    check('connections that never authorize are dropped', pool.clients.size === 0, String(pool.clients.size));
    for (const s of sockets) s.destroy();
    pool.stop();
    await sleep(150);
  }

  console.log('\nunits reported to the widgets');
  {
    const pool = new Pool(baseConfig({}));
    await pool.start();
    pool.stats.bestShareDiff = 0.03125; // a healthy share at stratum difficulty 2048
    const snap = pool.snapshot();
    check('the stratum-space best share is not rounded away to zero',
      Math.round(snap.bestShareStratum) === 2048, String(snap.bestShareStratum));
    check('the consensus-space value is kept for the network comparison',
      snap.bestShareDiff === 0.03125, String(snap.bestShareDiff));
    pool.stop();
    await sleep(150);
  }

  console.log('\nblock submission survives a failing node');
  {
    const pool = new Pool(baseConfig({}));
    await pool.start();
    let attempts = 0;
    pool.submitRpc = {
      submitBlock: async () => {
        attempts++;
        if (attempts < 3) throw new Error('Work queue depth exceeded');
        return null;
      },
    };
    const started = Date.now();
    const result = await pool.submitWithRetries('00', 1);
    check('submitblock is retried until it succeeds', attempts === 3, String(attempts));
    check('the retry actually succeeded', result === null);
    check('retries are spaced, not spun', Date.now() - started >= 900);
    pool.stop();
    await sleep(150);
  }

  console.log(failures === 0 ? '\nREVIEW FIXES VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
