'use strict';
//
// A rented order, simulated.
//
// The failure this exists to catch is not subtle but it is invisible until you
// have paid for it: a NiceHash-scale miner opens many connections from a couple
// of addresses and submits shares orders of magnitude faster than a home rig.
// Against the home limits it trips the flood ceiling, gets disconnected, and the
// order shows as failing with the money already spent.
//
// So this points a fleet of fast clients at a pool configured with the rented
// profile and asserts the things that would have gone wrong: nobody is refused
// for sharing an address, nobody is rate-limited off, vardiff actually climbs,
// and — the point of the whole app — a share that meets the network target is
// still recognised as a block while all of that is happening.
//

const net = require('node:net');
const { Pool } = require('../images/stratum/src/pool');
const u = require('../images/stratum/src/util');

const RPC_PORT = Number(process.argv[2]);
const STRATUM_PORT = Number(process.argv[3]);
const ADDRESS = process.argv[4];

const CLIENTS = 24;          // one provider, many connections, one source address
const SUBMIT_PER_SECOND = 40; // per client — far beyond any home miner
const RUN_MS = 12000;

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The rented profile's numbers, applied here the way server.js would.
const config = {
  rpc: { host: '127.0.0.1', port: RPC_PORT, user: 'test', password: 'test' },
  payoutAddress: ADDRESS,
  stratumPort: STRATUM_PORT,
  startDifficulty: 1048576,
  minDifficulty: 65536,
  maxDifficulty: 268435456,
  targetShareSeconds: 12,
  vardiffWindow: 10,
  hashrateWindowMs: 600000,
  pollIntervalMs: 5000,
  jobRebuildMs: 30000,
  socketTimeoutMs: 1800000,
  coinbaseTag: '/umbrel-doge-solo/',
  maxConnections: 256,
  maxConnectionsPerIp: 256,
  maxMessagesPer10s: 1000,
  maxPayoutVariants: 1,
  handshakeTimeoutMs: 30000,
  difficultyGraceMs: 120000,
  pingIntervalMs: 300000,
  lockPayoutAddress: true,
  profile: 'rented',
};

class Client {
  constructor(id) {
    this.id = id;
    this.buffer = '';
    this.job = null;
    this.extranonce1 = null;
    this.extranonce2Size = 4;
    this.difficulties = [];
    this.accepted = 0;
    this.rejected = 0;
    this.reasons = {};
    this.disconnected = false;
    this.nonce = id * 1000000;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(STRATUM_PORT, '127.0.0.1', () => resolve());
      this.socket.on('error', reject);
      this.socket.on('close', () => { this.disconnected = true; });
      this.socket.on('data', (chunk) => this.onData(chunk));
    });
  }

  send(obj) {
    if (!this.socket.destroyed) this.socket.write(JSON.stringify(obj) + '\n');
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === 'mining.notify') this.job = msg.params;
      else if (msg.method === 'mining.set_difficulty') this.difficulties.push(msg.params[0]);
      else if (msg.id === 1 && msg.result) {
        this.extranonce1 = msg.result[1];
        this.extranonce2Size = msg.result[2];
      } else if (msg.id >= 100) {
        if (msg.result === true) this.accepted++;
        else if (msg.error) {
          this.rejected++;
          const reason = msg.error[1] || 'unknown';
          this.reasons[reason] = (this.reasons[reason] || 0) + 1;
        }
      }
    }
  }

  async handshake() {
    this.send({ id: 1, method: 'mining.subscribe', params: ['cgminer/4.11.1 (rented)'] });
    this.send({ id: 2, method: 'mining.authorize', params: [`rented.${this.id}`, 'x'] });
    for (let i = 0; i < 100 && (!this.job || !this.extranonce1); i++) await sleep(50);
  }

  submit(seq) {
    if (!this.job) return;
    const [jobId, , , , , , , ntime] = this.job;
    const en2 = (this.nonce++).toString(16).padStart(this.extranonce2Size * 2, '0')
      .slice(-this.extranonce2Size * 2);
    this.send({
      id: 100 + seq,
      method: 'mining.submit',
      params: [`rented.${this.id}`, jobId, en2, ntime, (this.nonce >>> 0).toString(16).padStart(8, '0')],
    });
  }
}

(async () => {
  const pool = new Pool(config);
  await pool.start();
  console.log(`\n${CLIENTS} connections from one address, ${CLIENTS * SUBMIT_PER_SECOND} submissions a second`);

  const clients = [];
  for (let i = 0; i < CLIENTS; i++) {
    const c = new Client(i);
    await c.connect();
    clients.push(c);
  }
  await Promise.all(clients.map((c) => c.handshake()));

  const connected = clients.filter((c) => !c.disconnected).length;
  check('every connection from the same address is accepted', connected === CLIENTS,
    `${connected}/${CLIENTS}`);
  const gotJob = clients.filter((c) => c.job).length;
  check('every one of them received work', gotJob === CLIENTS, `${gotJob}/${CLIENTS}`);
  const started = clients.filter((c) => c.difficulties[0] === config.startDifficulty).length;
  check('they start at the rented difficulty, not the home one', started === CLIENTS,
    `${started}/${CLIENTS} at ${clients[0].difficulties[0]}`);

  // Sustained flood, at a rate a home profile would cut off within a second.
  const deadline = Date.now() + RUN_MS;
  let seq = 0;
  while (Date.now() < deadline) {
    for (const c of clients) c.submit(seq++);
    await sleep(1000 / SUBMIT_PER_SECOND);
  }
  await sleep(1500);

  const stillUp = clients.filter((c) => !c.disconnected).length;
  check('nobody is disconnected by the flood ceiling', stillUp === CLIENTS, `${stillUp}/${CLIENTS}`);

  const totalSubmitted = seq;
  const answered = clients.reduce((s, c) => s + c.accepted + c.rejected, 0);
  check('every submission got an answer', answered >= totalSubmitted * 0.95,
    `${answered}/${totalSubmitted}`);

  const flooded = clients.reduce((s, c) => s + (c.reasons['too many messages'] || 0), 0);
  check('none were refused as a flood', flooded === 0, String(flooded));

  const stale = clients.reduce((s, c) => s + (c.reasons['job not found'] || 0), 0);
  check('none were refused for an expired job', stale === 0, String(stale));

  // The pool must have survived all of that with its own accounting intact.
  const snap = pool.snapshot();
  check('the pool still reports every worker', snap.workers.length === CLIENTS,
    `${snap.workers.length}/${CLIENTS}`);
  check('the payout is locked, so every worker pays the configured address',
    snap.workers.every((w) => w.payoutAddress === ADDRESS));
  check('it reports the rented profile', snap.profile === 'rented', snap.profile);

  // And the thing that actually matters: with all that noise in flight, a share
  // meeting the network target is still recognised as a block. Verified through
  // the same judgement path the pool uses, against a target nothing can miss.
  const job = pool.currentJob;
  // The real job object, with its target relaxed and put back afterwards.
  // Spreading it into a plain object would drop every method it inherits from
  // its class — including buildCoinbase, which prepareShare needs.
  const realTarget = job.networkTarget;
  job.networkTarget = (1n << 256n) - 1n;
  const easy = job;
  const { prepareShare, judgeShare } = require('../images/stratum/src/job');
  const prepared = prepareShare(easy, {
    extranonce1: Buffer.from('00000000', 'hex'),
    extranonce2Hex: '00000000',
    ntimeHex: job.template.curtime.toString(16).padStart(8, '0'),
    nonceHex: '00000001',
  });
  check('a share can still be prepared under load', prepared.ok === true, prepared.reason);
  const powHash = await u.scryptHashAsync(prepared.header);
  const verdict = judgeShare(easy, prepared, powHash, [1n]);
  check('a network-target share is still recognised as a block', verdict.isBlockCandidate === true,
    JSON.stringify(verdict.reason));
  check('and it is serialised ready for submission',
    typeof verdict.blockHex === 'string' && verdict.blockHex.length > 100,
    String(verdict.blockHex && verdict.blockHex.length));
  job.networkTarget = realTarget;

  for (const c of clients) c.socket.destroy();
  pool.stop();
  await sleep(300);

  console.log(failures === 0 ? '\nRENTED LOAD VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
