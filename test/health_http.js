'use strict';
//
// The alarm as the outside world sees it: the healthcheck, the status endpoint
// and the reset button, against a REAL process that cannot reach its node.
//
// This is deliberately the scenario that cost thirteen hours — the pool never
// starts at all — because it is the one where most of the app does not exist.
// There is no Pool, so there is no snapshot, and anything that reads the state
// through the pool has nothing to read. Everything here therefore runs against
// a server started with an RPC port that nothing is listening on.
//
// It needs no daemon, which is the point: it runs in CI.
//
//   node test/health_http.js [port]
//

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.argv[2] || 23181);
const BASE = `http://127.0.0.1:${PORT}`;
// Short enough to run in CI, long enough that the "not yet" checks below are
// not a race. The server floors both of these at ten seconds.
const GRACE_S = 10;

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-health-'));

const child = spawn(process.execPath, [path.join(__dirname, '..', 'images/stratum/src/server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    STRATUM_PORT: '23182',
    STATS_PATH: path.join(dir, 'stats.json'),
    PAYOUT_ADDRESS: 'DU4KTk97aC46ZbXjdTpP9tFNYCrmuLZXLd',
    // Port 1: nothing is listening, so every RPC fails immediately. This is a
    // node app that is switched off, which is exactly the case.
    RPC_HOST: '127.0.0.1',
    RPC_PORT: '1',
    ALARM_AFTER_SECONDS: String(GRACE_S),
    STARTUP_GRACE_SECONDS: String(GRACE_S),
    // The restart watchdog must stay out of a test that deliberately keeps the
    // pool down — and it would not fire here anyway, since the nodes ARE
    // reporting an error. Off, so a failure here can only mean one thing.
    STALL_RESTART_MINUTES: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

const stop = () => {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  fs.rmSync(dir, { recursive: true, force: true });
};

(async () => {
  // Wait for the web server, which comes up long before any pool does.
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { await fetch(`${BASE}/health`); up = true; } catch { await sleep(100); }
  }
  if (!up) {
    console.log('  FAIL  the dashboard never started');
    console.log(log.slice(0, 2000));
    stop();
    process.exit(1);
  }

  console.log('\nbefore the grace has run out');
  {
    const res = await fetch(`${BASE}/health`);
    const body = await res.json();
    // Already 503 today, because there is no pool — that part is not new. What
    // matters is that it is not yet SHOUTING: an alarm that fires while the
    // node is still loading its block index is an alarm people learn to ignore.
    check('the healthcheck fails', res.status === 503, String(res.status));
    check('but nothing is alarming yet', Array.isArray(body.alerts) && body.alerts.length === 0,
      JSON.stringify(body.alerts));

    const status = await (await fetch(`${BASE}/api/status`)).json();
    check('the status endpoint answers even with no pool', status.ok === false, JSON.stringify(status).slice(0, 120));
    // The dashboard must be able to draw the bar in this branch; without a
    // snapshot there is nothing else to hang it off.
    check('and carries an alerts array regardless', Array.isArray(status.alerts), JSON.stringify(status.alerts));
    check('with a health level', status.health === 'ok', String(status.health));
  }

  console.log(`\nafter ${GRACE_S} seconds of not starting`);
  await sleep((GRACE_S + 2) * 1000);
  {
    const res = await fetch(`${BASE}/health`);
    const body = await res.json();
    check('the healthcheck still fails', res.status === 503, String(res.status));
    check('now with a reason', body.alerts.length === 1, JSON.stringify(body.alerts));
    check('and the level says nothing is mining', body.level === 'down', body.level);

    const status = await (await fetch(`${BASE}/api/status`)).json();
    check('the status endpoint agrees', status.health === 'down', String(status.health));
    check('the alert is keyed as a startup failure',
      status.alerts[0] && status.alerts[0].key === 'startup', JSON.stringify(status.alerts[0]));
    check('and says so in a sentence',
      /Nothing is being mined/.test(status.alerts[0].text), status.alerts[0].text);
  }

  console.log('\nthe reset endpoint');
  {
    // There is no resource to GET here, and saying 404 rather than 405 keeps
    // the endpoint from advertising itself to anything crawling the dashboard.
    const res = await fetch(`${BASE}/api/reset`, { method: 'GET' });
    check('GET finds nothing', res.status === 404, String(res.status));
  }
  {
    const res = await fetch(`${BASE}/api/status`, { method: 'PUT' });
    check('a write method elsewhere is refused', res.status === 405, String(res.status));
  }
  {
    // Umbrel's proxy authenticates with a cookie, and a browser attaches that
    // to cross-site requests too. Without this guard any page the user has open
    // could wipe their statistics with one fetch.
    const res = await fetch(`${BASE}/api/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: '{}',
    });
    check('a cross-site POST is refused', res.status === 403, String(res.status));
  }
  {
    // A form post from another origin cannot set this content type without
    // becoming a preflighted request, so requiring it is what stops a plain
    // <form> from reaching this endpoint at all.
    const res = await fetch(`${BASE}/api/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    check('a form-style content type is refused', res.status === 403, String(res.status));
  }
  {
    const res = await fetch(`${BASE}/api/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ counters: true, best: true }),
    });
    const body = await res.json();
    check('a same-origin reset is accepted', res.status === 200 && body.ok === true, JSON.stringify(body));
    check('it reports what it cleared', Array.isArray(body.cleared) && body.cleared.length === 2,
      JSON.stringify(body.cleared));
    check('it says whether it reached the disk', body.persisted === true, String(body.persisted));
    check('and when', Number.isFinite(body.resetAt), String(body.resetAt));
    // Works with no pool: the store is the durable half and it exists from the
    // first moment. A reset that needed a running pool would be unavailable in
    // exactly the state where someone is fiddling with settings.
    check('even though no pool has ever started', /"ok":true/.test(JSON.stringify(body)));
  }

  console.log('\nthe log says what happened');
  check('the failure to start is reported', /start failed/.test(log), log.slice(-200));
  // The watchdog runs on its own fifteen second timer, so this is polled rather
  // than asserted at an instant — a fixed sleep here would be a race that
  // passes on a fast machine and fails on the Umbrel.
  const deadline = Date.now() + 25000;
  while (!/\[health\]/.test(log) && Date.now() < deadline) await sleep(500);
  check('and the alarm is written to the container log',
    /\[health\].*Nothing is being mined/.test(log), log.slice(-400));

  stop();
  console.log(failures === 0 ? '\nALARM HTTP SURFACE VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`  FAIL  the suite threw: ${err.message}`);
  console.log(log.slice(0, 2000));
  stop();
  process.exit(1);
});
