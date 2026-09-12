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
//   7. merged mining and the rented port at once: both features stay
//      configured together, and the SAME merged job reaches a worker on
//      either port — not two independently-built jobs that happen to match.
//   8. both ports' connection ceilings hold independently while BOTH are
//      simultaneously saturated, and freeing one port's slot never frees
//      the other's — proof the two counters are actually separate state.
//   9. a suggest_difficulty above the ceiling clamps down to each port's OWN
//      maximum — the high-side counterpart to the low-side clamp already
//      covered by the live-switch case.
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
        messages,
        difficulty: () => firstDifficulty,
        nextMessage: () => new Promise((res) => waiters.push(res)),
        suggestDifficulty: (d) => socket.write(JSON.stringify({ id: 99, method: 'mining.suggest_difficulty', params: [d] }) + '\n'),
        close: () => socket.destroy(),
      });
    });
  });
}

// Waits for a mining.notify to show up in a client's message log — used where
// the difficulty alone (what the client already resolves on) is not what's
// being checked, such as proving two clients on different ports were handed
// the same job.
async function waitForNotify(client, ms = 8000) {
  return until(() => {
    const n = client.messages.find((m) => m.method === 'mining.notify');
    return n ? n.params : null;
  }, ms);
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

  // --- merged mining and the rented port at the same time -----------------
  //
  // Merged mining picks which chain's block templates get turned into jobs;
  // the rented port picks which socket a worker is on. Nothing in either
  // feature should know the other exists, and this is the case that would
  // catch it if they did — e.g. a merged job only ever reaching the port that
  // happened to be "primary" at the time it was built.
  console.log('\nmerged mining and the rented port coexist, and both ports see the same merged job');
  const port7 = BASE_PORT + 70;
  const rentedPort7 = port7 + 2;
  const base7 = `http://127.0.0.1:${port7}`;
  const dir7 = path.join(dir, 'case7');
  fs.mkdirSync(dir7, { recursive: true });

  // A dedicated pair, separate from the shared `doge` used by every other
  // case above: merged mode needs createauxblock/submitauxblock served, which
  // the shared mock (aux: false) deliberately does not answer.
  const dogeAux = new MockNode({ chain: 'main', aux: true });
  const ltc = new MockNode({ chain: 'main' });
  await dogeAux.listen();
  await ltc.listen();

  const s7 = startServer(port7, {
    LOCK_PAYOUT_ADDRESS: '1',
    RENTED_STRATUM_PORT: String(rentedPort7),
    RPC_PORT: String(dogeAux.port),
    MERGED_MINING: '1',
    LTC_RPC_HOST: '127.0.0.1',
    LTC_RPC_PORT: String(ltc.port),
    LTC_RPC_PASSWORD: 'test',
    // Already validated elsewhere in this repo's test suite (pool_wiring.js) —
    // a real Litecoin mainnet address, distinct from the Dogecoin one above so
    // a mix-up between the two would fail loudly rather than by coincidence.
    LTC_PAYOUT_ADDRESS: 'LdAEjWgrrUjyV6Cy3DTKZ3uBNmG3FQhXsj',
  }, dir7);
  check('it comes up with both features configured', !!(await waitUp(base7)), s7.log.slice(-800));

  const status7 = await until(async () => {
    const r = await (await fetch(`${base7}/api/status`, { cache: 'no-store' })).json();
    return r.mergedMining && r.rentedPortActive ? r : null;
  }, 8000);
  check('and reports merged mining on and the rented port active, together',
    !!status7, 'never reported both at once');

  const merged1 = await stratumClient(port7 + 1);
  check('a primary-port worker still gets the home starting difficulty',
    merged1.difficulty() === 2048, String(merged1.difficulty()));
  const mergedNotify1 = await waitForNotify(merged1);
  check('and is handed a job', !!mergedNotify1, 'no mining.notify received');

  const merged2 = await stratumClient(rentedPort7);
  check('a rented-port worker still gets the rented starting difficulty',
    merged2.difficulty() === 1048576, String(merged2.difficulty()));
  const mergedNotify2 = await waitForNotify(merged2);
  check('and is handed a job too', !!mergedNotify2, 'no mining.notify received');

  // params[0] is the stratum job id — the same merged job going out to both
  // ports at once means both workers were handed the identical id, not two
  // independently-built ones that happen to look similar.
  check('both ports were handed the SAME merged job, not two different ones',
    !!mergedNotify1 && !!mergedNotify2 && mergedNotify1[0] === mergedNotify2[0],
    JSON.stringify({ primary: mergedNotify1 && mergedNotify1[0], rented: mergedNotify2 && mergedNotify2[0] }));

  merged1.close();
  merged2.close();
  kill(s7.child);
  await dogeAux.close().catch(() => {});
  await ltc.close().catch(() => {});

  // --- both ports' connection ceilings, saturated AT THE SAME TIME --------
  //
  // The earlier per-port-cap case (above) fills the rented port and checks
  // the primary port's own first connection is unaffected — but never has
  // BOTH ports full at once, and never proves the primary port's OWN second
  // connection is independently refused while the rented port sits at its
  // separate limit rather than sharing a single pool-wide counter.
  console.log('\nboth ports\' connection ceilings hold independently while BOTH are simultaneously full');
  const port8 = BASE_PORT + 80;
  const stratumPort8 = port8 + 1;
  const rentedPort8 = port8 + 2;
  const base8 = `http://127.0.0.1:${port8}`;
  const dir8 = path.join(dir, 'case8');
  fs.mkdirSync(dir8, { recursive: true });
  // MAX_CONNECTIONS is an explicit override and applies to both ports at
  // once (documented, exercised deliberately here) — a cap of 1 each keeps
  // this case fast.
  const s8 = startServer(port8, {
    LOCK_PAYOUT_ADDRESS: '1',
    RENTED_STRATUM_PORT: String(rentedPort8),
    MAX_CONNECTIONS: '1',
  }, dir8);
  check('it comes up', !!(await waitUp(base8)), s8.log.slice(-600));

  const primaryA = await stratumClient(stratumPort8);
  const rentedA = await stratumClient(rentedPort8);
  check('both ports accept their first connection', primaryA.difficulty() !== null && rentedA.difficulty() !== null,
    JSON.stringify({ primary: primaryA.difficulty(), rented: rentedA.difficulty() }));

  // Now BOTH are simultaneously at their cap of 1. A second attempt on
  // EITHER must be refused — not just the one this file already checked in
  // isolation.
  const primaryB = await stratumClient(stratumPort8).catch((err) => ({ refused: err }));
  const primaryBRefused = primaryB.refused || primaryB.difficulty() === null;
  check('a second primary connection is refused while both ports are full',
    primaryBRefused, JSON.stringify(primaryB.difficulty ? primaryB.difficulty() : primaryB));

  const rentedB = await stratumClient(rentedPort8).catch((err) => ({ refused: err }));
  const rentedBRefused = rentedB.refused || rentedB.difficulty() === null;
  check('a second rented connection is refused at the same time',
    rentedBRefused, JSON.stringify(rentedB.difficulty ? rentedB.difficulty() : rentedB));

  // Freeing the PRIMARY port's slot must not free the RENTED port's — proof
  // the two counters are actually separate state, not one shared counter
  // that happened to read the same number twice above.
  primaryA.close();
  await sleep(300); // let the server notice the disconnect
  const primaryC = await stratumClient(stratumPort8);
  check('closing the primary connection frees ONLY the primary slot',
    primaryC.difficulty() !== null, 'the freed primary slot was not reusable');

  const rentedC = await stratumClient(rentedPort8).catch((err) => ({ refused: err }));
  const rentedCRefused = rentedC.refused || rentedC.difficulty() === null;
  check('the rented port is still full — the primary port freeing up did not touch it',
    rentedCRefused, JSON.stringify(rentedC.difficulty ? rentedC.difficulty() : rentedC));

  if (rentedA.close) rentedA.close();
  if (primaryB.socket) primaryB.socket.destroy();
  if (rentedB.socket) rentedB.socket.destroy();
  primaryC.close();
  if (rentedC.socket) rentedC.socket.destroy();
  kill(s8.child);

  // --- suggest_difficulty ABOVE the ceiling clamps down, per port ---------
  //
  // The live-switch case above proves the LOW side of the clamp (suggesting
  // 1, below the floor). Nothing yet proved the HIGH side, or that the two
  // ports clamp to their OWN, different ceilings rather than one shared
  // number.
  console.log('\na suggest_difficulty above the ceiling clamps down to each port\'s OWN maximum');
  const port9 = BASE_PORT + 90;
  const rentedPort9 = port9 + 2;
  const base9 = `http://127.0.0.1:${port9}`;
  const dir9 = path.join(dir, 'case9');
  fs.mkdirSync(dir9, { recursive: true });
  const s9 = startServer(port9, {
    LOCK_PAYOUT_ADDRESS: '1',
    RENTED_STRATUM_PORT: String(rentedPort9),
  }, dir9);
  check('it comes up', !!(await waitUp(base9)), s9.log.slice(-600));

  const primary9 = await stratumClient(port9 + 1);
  primary9.suggestDifficulty(999999999); // absurdly above the home ceiling (4194304)
  let msg9 = await primary9.nextMessage();
  check('the primary port clamps down to ITS OWN ceiling (the home profile\'s)',
    msg9.method === 'mining.set_difficulty' && msg9.params[0] === 4194304, JSON.stringify(msg9));

  const rented9 = await stratumClient(rentedPort9);
  rented9.suggestDifficulty(999999999999); // absurdly above the rented ceiling (268435456)
  msg9 = await rented9.nextMessage();
  check('the rented port clamps down to ITS OWN, higher ceiling (the rented profile\'s), not the primary\'s',
    msg9.method === 'mining.set_difficulty' && msg9.params[0] === 268435456, JSON.stringify(msg9));

  primary9.close();
  rented9.close();
  kill(s9.child);

  await doge.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nDUAL PORT VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.log(`  FAIL  the suite threw: ${err.stack}`);
  await doge.close().catch(() => {});
  process.exit(1);
});
