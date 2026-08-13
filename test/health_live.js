'use strict';
//
// The healthcheck, against a pool that is actually running.
//
// test/health_http.js covers the case where the pool never starts. That leaves
// the headline claim of this release untested: that `/health` now answers "is
// this pool getting work?" rather than "is my own web server up?". A reviewer
// showed how much that mattered by reverting `/health` to its 1.3.x form —
// every suite stayed green, because none of them ever had a running pool.
//
// So this one starts the real server against mock nodes, waits for it to be
// healthy, then switches the nodes off and watches the healthcheck fail.
//
//   node test/health_live.js
//

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MockNode } = require('./mock-node');

const PORT = Number(process.argv[2] || 23191);
const BASE = `http://127.0.0.1:${PORT}`;
// The server floors this at ten seconds.
const ALARM_S = 10;

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => {
  const res = await fetch(BASE + p, { cache: 'no-store' });
  return { status: res.status, body: await res.json() };
};
async function until(fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-live-'));
let child = null;
const doge = new MockNode({ chain: 'main', aux: true });
const ltc = new MockNode({ chain: 'main' });

const stop = async () => {
  if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  await doge.close().catch(() => {});
  await ltc.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
};

(async () => {
  await doge.listen();
  await ltc.listen();

  let log = '';
  child = spawn(process.execPath, [path.join(__dirname, '..', 'images/stratum/src/server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      STRATUM_PORT: '23192',
      STATS_PATH: path.join(dir, 'stats.json'),
      PAYOUT_ADDRESS: 'DU4KTk97aC46ZbXjdTpP9tFNYCrmuLZXLd',
      LTC_PAYOUT_ADDRESS: 'LdAEjWgrrUjyV6Cy3DTKZ3uBNmG3FQhXsj',
      MERGED_MINING: '1',
      RPC_HOST: '127.0.0.1',
      RPC_PORT: String(doge.port),
      LTC_RPC_HOST: '127.0.0.1',
      LTC_RPC_PORT: String(ltc.port),
      POLL_INTERVAL_SECONDS: '1',
      ALARM_AFTER_SECONDS: String(ALARM_S),
      STARTUP_GRACE_SECONDS: String(ALARM_S),
      // Off: this suite deliberately holds the nodes down for longer than any
      // sane restart delay, and a process that exits mid-suite proves nothing.
      STALL_RESTART_MINUTES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  console.log('\na pool that is mining');
  const healthy = await until(async () => {
    const r = await get('/health');
    return r.status === 200 ? r : null;
  }, 20000);
  check('the healthcheck passes', !!healthy, log.slice(-400));
  if (!healthy) { await stop(); process.exit(1); }
  check('with no alerts', healthy.body.alerts.length === 0, JSON.stringify(healthy.body.alerts));

  const status = await get('/api/status');
  check('the status reports a running merged pool',
    status.body.ok === true && status.body.mergedMining === true, JSON.stringify(status.body).slice(0, 160));
  check('and level ok', status.body.health === 'ok', String(status.body.health));

  console.log('\nboth nodes go away, as they did after the umbrelOS restart');
  doge.down = true;
  ltc.down = true;

  // Long enough for the threshold, plus one watchdog tick.
  const failed = await until(async () => {
    const r = await get('/health');
    return r.status === 503 ? r : null;
  }, (ALARM_S + 20) * 1000);
  check('the healthcheck now fails', !!failed, JSON.stringify((await get('/health')).body));
  if (failed) {
    check('and says which node', /Litecoin node has been unreachable/.test(JSON.stringify(failed.body.alerts)),
      JSON.stringify(failed.body.alerts));
    check('at level down', failed.body.level === 'down', failed.body.level);
  }

  const down = await get('/api/status');
  // The distinction that matters: this is a RUNNING pool reporting that it is
  // not mining, which is the state no in-pool check could ever have flagged
  // and the state the healthcheck used to call healthy.
  check('the pool is still running while it says so', down.body.ok === true, String(down.body.ok));
  check('the dashboard gets the alert', (down.body.alerts || []).some((a) => a.key === 'parent'),
    JSON.stringify(down.body.alerts));

  // Polled, not asserted at an instant: the notification is sent by the
  // watchdog on its own fifteen second timer, so a fixed sleep here would be a
  // race that passes on a fast machine and fails on an Umbrel.
  await until(async () => /\[health\]/.test(log), 30000);
  check('the phone is told', /\[health\].*Nothing is being mined/.test(log), log.slice(-300));
  check('exactly once', (log.match(/\[health\]/g) || []).length === 1,
    String((log.match(/\[health\]/g) || []).length));

  console.log('\nand when they come back');
  doge.down = false;
  ltc.down = false;
  const recovered = await until(async () => {
    const r = await get('/health');
    return r.status === 200 ? r : null;
  }, (ALARM_S + 20) * 1000);
  check('the healthcheck passes again', !!recovered, JSON.stringify((await get('/health')).body));
  // The recovery is debounced by the same threshold as the alarm, then waits
  // for the next tick.
  await until(async () => /Mining is running again/.test(log), (ALARM_S + 25) * 1000);
  check('the recovery is announced, once the pool has stayed up',
    /\[health\] Mining is running again/.test(log), log.slice(-300));

  await stop();
  console.log(failures === 0 ? '\nLIVE HEALTHCHECK VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.log(`  FAIL  the suite threw: ${err.stack}`);
  await stop();
  process.exit(1);
});
