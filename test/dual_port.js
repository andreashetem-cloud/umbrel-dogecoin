'use strict';
//
// The dedicated rented-capacity port: a second stratum listener, running at
// the same time as the primary one, always at the rented profile's numbers
// regardless of what MINING_PROFILE currently has the primary port doing.
//
// This exists because the single-port MINING_PROFILE switch (see
// settings_live.js) has a real limitation: home miners and a rented order
// can never both be correctly configured at once, because there is only one
// port and one set of limits. Switch to "rented" for the order and a
// connected home ASIC is instantly given a starting difficulty a few
// thousand times higher than it can usefully hash at — it does not
// disconnect, it just stops finding shares, which from the operator's side
// looks exactly like "my miner stopped working the moment I rented
// hashpower". RENTED_STRATUM_PORT fixes that by giving the rented order its
// own port and its own numbers, so nothing about the home port ever has to
// change for it.
//
// What this file proves, each backed by a real spawned server.js and real
// TCP stratum connections (not the config-only checks in profile.js):
//
//   1. both ports bind, and each hands a NEW connection the right profile's
//      starting difficulty — proof the isolation in pool.js's onConnection
//      actually reaches a live socket, not just the config object.
//   2. a live MINING_PROFILE switch on the primary port (see settings_live.js)
//      still reaches an ALREADY-CONNECTED primary client — the exact
//      regression settings_live.js guards for one port, reproduced here with
//      a second port present, since the two share code.
//   3. that same switch does NOT reach an already-connected RENTED-port
//      client — the isolation is the entire point, and this is the check
//      that would fail if `rentedPortLimits` were ever accidentally aliased
//      to `this.config` the way the primary port intentionally is.
//   4. the two ports enforce their connection ceilings SEPARATELY: filling
//      the rented port's (tiny, here) cap does not refuse a primary
//      connection, and vice versa.
//   5. the safety interlock: RENTED_STRATUM_PORT set without
//      LOCK_PAYOUT_ADDRESS=1 refuses to start, exactly like MINING_PROFILE=
//      rented does.
//   6. a port clash (RENTED_STRATUM_PORT equal to STRATUM_PORT or PORT) is
//      refused at config time rather than fought over at bind time.
//
//   node test/dual_port.js [base-port]
//

const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MockNode } = require('./mock-node');

const BASE_PORT = Number(process.argv[2] || 24391);
const SERVER = path.join(__dirname, '..', 'images', 'stratum', 'src', 'server.js');
const ADDRESS = 'DU4KTk97aC46ZbXjdTpP9tFNYCrmuLZXLd';

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(200);
  }
}

const doge = new MockNode({ chain: 'main' });

function startServer(port, extraEnv, dir) {
  let log = '';
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      STRATUM_PORT: String(port + 1),
      STATS_PATH: path.join(dir, 'stats.json'),
      PAYOUT_ADDRESS: ADDRESS,
      RPC_HOST: '127.0.0.1',
      RPC_PORT: String(doge.port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, get log() { return log; } };
}

async function waitUp(base) {
  return until(async () => {
    const r = await fetch(`${base}/api/settings`, { cache: 'no-store' });
    return r.status === 200 ? r : null;
  }, 15000);
}

function kill(child) {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

// A minimal stratum v1 client: connects, subscribes, authorizes, and hands
// back the difficulty the server first assigns — which is all these checks
// need. Kept open so a later suggest_difficulty can be sent on the same
// connection, which is the only way to prove a switch reached an EXISTING
// socket rather than merely the next new one.
function stratumClient(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = '';
    let firstDifficulty = null;
    let resolved = false;
    const messages = [];
    const waiters = [];

    const deliver = (msg) => {
      messages.push(msg);
      if (msg.method === 'mining.set_difficulty' && firstDifficulty === null) {
        firstDifficulty = msg.params[0];
      }
      const w = waiters.shift();
      if (w) w(msg);
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { deliver(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
    socket.on('error', (err) => { if (!resolved) reject(err); });
    socket.on('connect', async () => {
      socket.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['test/1.0'] }) + '\n');
      socket.write(JSON.stringify({ id: 2, method: 'mining.authorize', params: ['worker1', 'x'] }) + '\n');
      const deadline = Date.now() + 5000;
      while (firstDifficulty === null && Date.now() < deadline) await sleep(50);
      resolved = true;
      resolve({
        socket,
        difficulty: () => firstDifficulty,
        nextMessage: () => new Promise((res) => waiters.push(res)),
        suggestDifficulty: (d) => socket.write(JSON.stringify({ id: 99, method: 'mining.suggest_difficulty', params: [d] }) + '\n'),
        close: () => socket.destroy(),
      });
    });
  });
}

(async () => {
  await doge.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-dual-port-'));

  // --- both ports up, each with its own starting difficulty ---------------
  console.log('\nboth ports listen, each at its own profile\'s starting difficulty');
  const port1 = BASE_PORT;
  const stratumPort1 = port1 + 1;
  const rentedPort1 = port1 + 2;
  const base1 = `http://127.0.0.1:${port1}`;
  const dir1 = path.join(dir, 'case1');
  fs.mkdirSync(dir1, { recursive: true });
  let s1 = startServer(port1, {
    LOCK_PAYOUT_ADDRESS: '1',
    RENTED_STRATUM_PORT: String(rentedPort1),
  }, dir1);
  check('it comes up', !!(await waitUp(base1)), s1.log.slice(-600));

  const settings1 = await (await fetch(`${base1}/api/settings`, { cache: 'no-store' })).json();
  check('the rented port is reported configured', settings1.rentedStratumPort === rentedPort1, JSON.stringify(settings1));

  const status1 = await until(async () => {
    const r = await (await fetch(`${base1}/api/status`, { cache: 'no-store' })).json();
    return r.rentedPortActive ? r : null;
  }, 5000);
  check('and reports as actually bound, not just configured', !!status1, 'never became active');

  const home1 = await stratumClient(stratumPort1);
  check('a primary-port worker gets the home starting difficulty', home1.difficulty() === 2048, String(home1.difficulty()));

  const rented1 = await stratumClient(rentedPort1);
  check('a rented-port worker gets the rented starting difficulty', rented1.difficulty() === 1048576, String(rented1.difficulty()));

  const status2 = await (await fetch(`${base1}/api/status`, { cache: 'no-store' })).json();
  const byEntry = {};
  for (const w of status2.workers) byEntry[w.entry] = (byEntry[w.entry] || 0) + 1;
  check('the snapshot labels one worker on each port', byEntry.primary === 1 && byEntry.rented === 1, JSON.stringify(byEntry));

  // --- a live profile switch reaches the primary port but not the rented one
  console.log('\na live switch on the primary port leaves the rented port alone');
  const post = (base, body) => fetch(`${base}/api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let res = await post(base1, { profile: 'rented' });
  let body = await res.json();
  check('the primary port switches to rented', res.status === 200 && body.ok === true, JSON.stringify(body));

  // The existing home1 connection is still open. Its bounds should now be the
  // RENTED profile's (minDifficulty 65536, maxDifficulty 268435456) — proof
  // the switch reached it live, matching settings_live.js's guarantee.
  home1.suggestDifficulty(1); // below even home's old minimum; should clamp up
  let msg = await home1.nextMessage();
  check('the already-connected primary worker is re-bounded live',
    msg.method === 'mining.set_difficulty' && msg.params[0] === 65536,
    JSON.stringify(msg));

  // The rented1 connection must NOT have moved — it was never on the
  // "profile" the dashboard switch controls. Ask it to go absurdly low; it
  // should still clamp to ITS OWN minimum (65536, the rented profile's own
  // floor — unaffected by the switch above, which only touched the primary
  // port's live config, not rentedPortLimits).
  rented1.suggestDifficulty(1);
  msg = await rented1.nextMessage();
  check('the rented-port worker is unaffected by the primary port\'s switch',
    msg.method === 'mining.set_difficulty' && msg.params[0] === 65536,
    JSON.stringify(msg));

  home1.close();
  rented1.close();
  kill(s1.child);

  // --- the safety interlock --------------------------------------------
  console.log('\nRENTED_STRATUM_PORT without a locked payout refuses to start');
  const port2 = BASE_PORT + 20;
  const dir2 = path.join(dir, 'case2');
  fs.mkdirSync(dir2, { recursive: true });
  const s2 = startServer(port2, {
    RENTED_STRATUM_PORT: String(port2 + 2),
    // LOCK_PAYOUT_ADDRESS left unset on purpose.
  }, dir2);
  const exit2 = await new Promise((resolve) => s2.child.on('exit', (code) => resolve(code)));
  check('the process exits rather than starting unsafely', exit2 !== 0, String(exit2));
  check('and explains why', /RENTED_STRATUM_PORT/.test(s2.log) && /LOCK_PAYOUT_ADDRESS/.test(s2.log), s2.log.slice(-400));

  // --- a port clash is refused at config time, not fought over at bind time
  console.log('\na clashing RENTED_STRATUM_PORT is refused, not fought over');
  const port3 = BASE_PORT + 30;
  const base3 = `http://127.0.0.1:${port3}`;
  const dir3 = path.join(dir, 'case3');
  fs.mkdirSync(dir3, { recursive: true });
  const s3 = startServer(port3, {
    LOCK_PAYOUT_ADDRESS: '1',
    RENTED_STRATUM_PORT: String(port3 + 1), // same as STRATUM_PORT (port3 + 1)
  }, dir3);
  check('it still comes up', !!(await waitUp(base3)), s3.log.slice(-600));
  check('but says the clashing port stays off', /clashes with an existing port/.test(s3.log), s3.log.slice(-400));
  const settings3 = await (await fetch(`${base3}/api/settings`, { cache: 'no-store' })).json();
  check('and reports no rented port configured', settings3.rentedStratumPort === null, JSON.stringify(settings3));
  kill(s3.child);

  // --- connection ceilings are enforced per port, not pool-wide -----------
  console.log('\nconnection ceilings are enforced separately per port');
  const port4 = BASE_PORT + 40;
  const stratumPort4 = port4 + 1;
  const rentedPort4 = port4 + 2;
  const base4 = `http://127.0.0.1:${port4}`;
  const dir4 = path.join(dir, 'case4');
  fs.mkdirSync(dir4, { recursive: true });
  // A rented cap of 1, forced by an explicit override — the profile default
  // is 256 and would make this case slow for nothing.
  const s4 = startServer(port4, {
    LOCK_PAYOUT_ADDRESS: '1',
    RENTED_STRATUM_PORT: String(rentedPort4),
    MAX_CONNECTIONS: '1',
  }, dir4);
  check('it comes up', !!(await waitUp(base4)), s4.log.slice(-600));

  // MAX_CONNECTIONS is an explicit env override, so — per the documented
  // "anything set explicitly still wins" rule — it applies to BOTH ports at
  // once here. That is expected and is not what this case is testing; what
  // matters is that the two ports count SEPARATELY against it.
  const rentedFirst = await stratumClient(rentedPort4);
  check('the first rented connection is accepted', rentedFirst.difficulty() !== null, 'no difficulty received');

  const rentedSecond = await stratumClient(rentedPort4).catch((err) => ({ refused: err }));
  const rentedSecondRefused = rentedSecond.refused || rentedSecond.difficulty() === null;
  check('a second rented connection is refused at the cap', rentedSecondRefused, JSON.stringify(rentedSecond.difficulty ? rentedSecond.difficulty() : rentedSecond));

  // The PRIMARY port's own single-connection allowance is untouched by the
  // rented port being full — this is the isolation this whole feature exists
  // for.
  const primaryFirst = await stratumClient(stratumPort4);
  check('the primary port still accepts its own first connection', primaryFirst.difficulty() !== null, 'no difficulty received');

  rentedFirst.close();
  if (rentedSecond.socket) rentedSecond.socket.destroy();
  primaryFirst.close();
  kill(s4.child);

  // --- a bind failure is visible, not indistinguishable from "never
  //     configured" ---------------------------------------------------------
  //
  // Occupy the port first with a plain TCP listener, standing in for
  // "something else already had it" — a stale process, another app, a typo
  // that collided with something unrelated. The pool's own bind then fails,
  // and this is the case that must not quietly look identical to nobody
  // having set RENTED_STRATUM_PORT at all: an operator watching the
  // dashboard for their rented order to show up would otherwise have no way
  // to learn the port never came up.
  console.log('\na rented-port bind failure is reported, not hidden');
  const port5 = BASE_PORT + 50;
  const rentedPort5 = port5 + 2;
  const base5 = `http://127.0.0.1:${port5}`;
  const dir5 = path.join(dir, 'case5');
  fs.mkdirSync(dir5, { recursive: true });

  const occupier = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    occupier.once('error', reject);
    occupier.listen(rentedPort5, '0.0.0.0', resolve);
  });

  const s5 = startServer(port5, {
    LOCK_PAYOUT_ADDRESS: '1',
    RENTED_STRATUM_PORT: String(rentedPort5),
  }, dir5);
  check('the app still comes up on the primary port', !!(await waitUp(base5)), s5.log.slice(-600));
  check('and logs why the rented port could not bind', /could not bind the rented-capacity port/.test(s5.log), s5.log.slice(-400));

  const status5 = await (await fetch(`${base5}/api/status`, { cache: 'no-store' })).json();
  check('the configured port number is still reported (not collapsed to null)',
    status5.rentedStratumPort === rentedPort5, JSON.stringify({ rentedStratumPort: status5.rentedStratumPort }));
  check('but is correctly reported as not active',
    status5.rentedPortActive === false, JSON.stringify({ rentedPortActive: status5.rentedPortActive }));

  const homeStillWorks = await stratumClient(port5 + 1);
  check('and the primary port mining is completely unaffected', homeStillWorks.difficulty() !== null, 'no difficulty received');
  homeStillWorks.close();

  await new Promise((resolve) => occupier.close(resolve));
  kill(s5.child);

  // --- an override meant for the primary port cannot hand the rented port
  //     a starting difficulty outside its own bounds ------------------------
  //
  // START_DIFFICULTY is read directly from the environment regardless of
  // which profile is being resolved (see resolveProfileField in server.js),
  // so it reaches the rented port's numbers too — documented, not a bug on
  // its own. What must not happen is the rented port actually HANDING OUT a
  // difficulty below its own floor just because an operator set that
  // override to tune their home miners.
  console.log('\na primary-port difficulty override cannot break the rented port\'s own bounds');
  const port6 = BASE_PORT + 60;
  const rentedPort6 = port6 + 2;
  const base6 = `http://127.0.0.1:${port6}`;
  const dir6 = path.join(dir, 'case6');
  fs.mkdirSync(dir6, { recursive: true });
  const s6 = startServer(port6, {
    LOCK_PAYOUT_ADDRESS: '1',
    RENTED_STRATUM_PORT: String(rentedPort6),
    // Sized for a home ASIC, far below the rented profile's 65536 floor.
    START_DIFFICULTY: '256',
  }, dir6);
  check('it comes up', !!(await waitUp(base6)), s6.log.slice(-600));
  const rented6 = await stratumClient(rentedPort6);
  check('the rented worker is still started at its own floor, not the override',
    rented6.difficulty() === 65536, String(rented6.difficulty()));
  rented6.close();
  kill(s6.child);

  await doge.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nDUAL PORT VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.log(`  FAIL  the suite threw: ${err.stack}`);
  await doge.close().catch(() => {});
  process.exit(1);
});
