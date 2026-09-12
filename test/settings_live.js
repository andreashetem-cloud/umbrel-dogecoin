'use strict';
//
// The mining-profile switch, against a pool that is actually running.
//
// test/settings_store.js covers the Settings class in isolation. That leaves
// the part most likely to be wrong untested: Pool copies the config object it
// is given — `this.config = { ...DEFAULT_LIMITS, ...config }` in pool.js — so
// mutating the module-level `config` in server.js after startup reaches
// nothing already connected. applyMiningProfile() has to mutate pool.config
// itself. The proof used here is /api/status, which is served from
// pool.snapshot() and therefore from pool.config: if a future change went back
// to mutating only the outer config, GET /api/status would keep reporting the
// old profile after a successful POST /api/settings, and this test would catch
// exactly that.
//
//   node test/settings_live.js
//

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MockNode } = require('./mock-node');

const BASE_PORT = Number(process.argv[2] || 23291);
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

// One MockNode is reused across every child in this file: none of these cases
// touch mining itself, only the config surface, and starting a fresh pair of
// HTTP servers per case would slow the suite down for nothing.
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

(async () => {
  await doge.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-settings-live-'));

  // --- unlocked: switching, persistence, validation -----------------------
  console.log('\nswitching profile on a running pool');
  const port1 = BASE_PORT;
  const base1 = `http://127.0.0.1:${port1}`;
  const dir1 = path.join(dir, 'case1');
  fs.mkdirSync(dir1, { recursive: true });
  let s1 = startServer(port1, { LOCK_PAYOUT_ADDRESS: '1' }, dir1);
  check('it comes up', !!(await waitUp(base1)), s1.log.slice(-400));

  let r = await (await fetch(`${base1}/api/settings`, { cache: 'no-store' })).json();
  check('starts on the home profile', r.profile === 'home', JSON.stringify(r));
  check('not locked (MINING_PROFILE was not set)', r.locked === false, JSON.stringify(r));
  check('rented is allowed (the payout is locked)', r.canRent === true, JSON.stringify(r));

  const post = (base, body) => fetch(`${base}/api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  let res = await post(base1, { profile: 'rented' });
  let body = await res.json();
  check('the switch succeeds', res.status === 200 && body.ok === true, JSON.stringify(body));
  check('and reports itself persisted', body.persisted === true, JSON.stringify(body));

  r = await (await fetch(`${base1}/api/settings`, { cache: 'no-store' })).json();
  check('GET /api/settings reflects it immediately', r.profile === 'rented', JSON.stringify(r));

  // The check described at the top of this file: proof the LIVE pool, not
  // just the module-level config object, picked up the change.
  const status = await (await fetch(`${base1}/api/status`, { cache: 'no-store' })).json();
  check('the running pool itself reports the new profile (not just /api/settings)',
    status.profile === 'rented', JSON.stringify(status).slice(0, 200));

  res = await post(base1, { profile: 'not-a-real-profile' });
  check('an unknown profile is refused with 400', res.status === 400, String(res.status));
  r = await (await fetch(`${base1}/api/settings`, { cache: 'no-store' })).json();
  check('and nothing changed', r.profile === 'rented', JSON.stringify(r));

  const settingsFile = path.join(dir1, 'settings.json');
  check('the choice is on disk', fs.existsSync(settingsFile));
  const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  check('with the right profile in it', onDisk.miningProfile === 'rented', JSON.stringify(onDisk));

  console.log('\ncross-site posts are refused, like the other endpoints');
  res = await fetch(`${base1}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ profile: 'home' }),
  });
  check('refused with 403', res.status === 403, String(res.status));
  r = await (await fetch(`${base1}/api/settings`, { cache: 'no-store' })).json();
  check('and nothing changed', r.profile === 'rented', JSON.stringify(r));

  console.log('\nit survives a restart, the same way .env-configured settings do');
  kill(s1.child);
  await sleep(300);
  s1 = startServer(port1, { LOCK_PAYOUT_ADDRESS: '1' }, dir1);
  check('it comes back up', !!(await waitUp(base1)), s1.log.slice(-400));
  r = await (await fetch(`${base1}/api/settings`, { cache: 'no-store' })).json();
  check('and remembers the profile chosen before the restart', r.profile === 'rented', JSON.stringify(r));
  kill(s1.child);

  // --- the safety interlock also applies to a live switch, not just startup
  console.log('\nswitching to rented without a locked payout is refused, live, the same as at startup');
  const port2 = BASE_PORT + 10;
  const base2 = `http://127.0.0.1:${port2}`;
  const dir2 = path.join(dir, 'case2');
  fs.mkdirSync(dir2, { recursive: true });
  const s2 = startServer(port2, {}, dir2); // LOCK_PAYOUT_ADDRESS left unset
  check('it comes up', !!(await waitUp(base2)), s2.log.slice(-400));

  r = await (await fetch(`${base2}/api/settings`, { cache: 'no-store' })).json();
  check('canRent is false', r.canRent === false, JSON.stringify(r));

  res = await post(base2, { profile: 'rented' });
  body = await res.json();
  check('the switch is refused', res.status === 409 && body.ok === false, JSON.stringify(body));
  check('and explains LOCK_PAYOUT_ADDRESS', /LOCK_PAYOUT_ADDRESS=1/.test(body.error || ''), body.error);
  r = await (await fetch(`${base2}/api/settings`, { cache: 'no-store' })).json();
  check('the pool stays on home', r.profile === 'home', JSON.stringify(r));
  kill(s2.child);

  // --- locked by the environment: the dashboard control goes read-only ----
  console.log('\nMINING_PROFILE set in .env locks the dashboard out');
  const port3 = BASE_PORT + 20;
  const base3 = `http://127.0.0.1:${port3}`;
  const dir3 = path.join(dir, 'case3');
  fs.mkdirSync(dir3, { recursive: true });
  const s3 = startServer(port3, { MINING_PROFILE: 'rented', LOCK_PAYOUT_ADDRESS: '1' }, dir3);
  check('it comes up', !!(await waitUp(base3)), s3.log.slice(-400));

  r = await (await fetch(`${base3}/api/settings`, { cache: 'no-store' })).json();
  check('reports itself locked', r.locked === true, JSON.stringify(r));
  check('names the reason', /MINING_PROFILE/.test(r.lockedReason || ''), String(r.lockedReason));
  check('but still reports the active profile', r.profile === 'rented', JSON.stringify(r));

  res = await post(base3, { profile: 'home' });
  body = await res.json();
  check('a switch is refused with 409', res.status === 409 && body.ok === false, JSON.stringify(body));
  r = await (await fetch(`${base3}/api/settings`, { cache: 'no-store' })).json();
  check('and the environment still wins', r.profile === 'rented', JSON.stringify(r));
  kill(s3.child);

  await doge.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nLIVE SETTINGS SWITCH VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.log(`  FAIL  the suite threw: ${err.stack}`);
  await doge.close().catch(() => {});
  process.exit(1);
});
