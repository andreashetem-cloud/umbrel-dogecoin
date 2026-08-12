'use strict';
//
// The mining profile, and the interlock that guards it.
//
// MINING_PROFILE=rented exists for one situation: the stratum port is reachable
// from the internet. That is also the situation in which an unlocked payout
// address hands your block to whoever asks, so the app must refuse to start in
// that combination rather than warn about it in a log nobody reads at 2am.
//
// The profile is checked by starting the real entry point as a child process
// and reading what it decided, because a unit test of a config object would not
// catch the entry point failing to apply it.
//

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const RPC_PORT = process.argv[2] || '18332';
const ADDRESS = process.argv[3];

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const SERVER = path.join(__dirname, '..', 'images', 'stratum', 'src', 'server.js');

// Print the effective config and exit, without binding anything.
const PROBE = `
process.env.PORT = '0';
const path = require('node:path');
// Stop main() from running: require the module for its config only.
const original = require('node:http').createServer;
require('node:http').createServer = function () {
  const server = original.apply(this, arguments);
  server.listen = function () { return server; };
  return server;
};
`;

function runWith(env) {
  const res = spawnSync(process.execPath, ['-e', `
    ${PROBE}
    const m = require(${JSON.stringify(SERVER)});
  `], {
    env: {
      ...process.env,
      PATH: process.env.PATH,
      STATS_PATH: '',
      RPC_PORT,
      RPC_USER: 'test',
      RPC_PASSWORD: 'test',
      PAYOUT_ADDRESS: ADDRESS,
      DUMP_CONFIG: '1',
      ...env,
    },
    encoding: 'utf8',
    timeout: 20000,
  });
  return res;
}

console.log('\nthe profile changes the numbers that matter');
{
  const home = runWith({ MINING_PROFILE: 'home' });
  const rented = runWith({ MINING_PROFILE: 'rented', LOCK_PAYOUT_ADDRESS: '1' });

  const parse = (out) => {
    const line = (out || '').split('\n').find((l) => l.startsWith('CONFIG '));
    return line ? JSON.parse(line.slice(7)) : null;
  };
  const h = parse(home.stdout);
  const r = parse(rented.stdout);

  check('the home profile reports itself', h && h.profile === 'home', JSON.stringify(h && h.profile));
  check('the rented profile reports itself', r && r.profile === 'rented', JSON.stringify(r && r.profile));

  check('home keeps the small-miner starting difficulty', h && h.startDifficulty === 2048,
    String(h && h.startDifficulty));
  check('rented starts far higher', r && r.startDifficulty === 1048576, String(r && r.startDifficulty));
  check('rented raises the message ceiling', r && r.maxMessagesPer10s === 1000,
    String(r && r.maxMessagesPer10s));
  check('rented raises the per-IP connection cap', r && r.maxConnectionsPerIp === 256,
    String(r && r.maxConnectionsPerIp));
  check('rented lengthens the socket timeout', r && r.socketTimeoutMs === 1800000,
    String(r && r.socketTimeoutMs));
  check('rented widens the difficulty grace', r && r.difficultyGraceMs === 120000,
    String(r && r.difficultyGraceMs));

  // The whole point of a profile is that it does not take away control.
  const override = parse(runWith({
    MINING_PROFILE: 'rented', LOCK_PAYOUT_ADDRESS: '1', START_DIFFICULTY: '4096',
  }).stdout);
  check('an explicit setting still beats the profile', override && override.startDifficulty === 4096,
    String(override && override.startDifficulty));

  const unknown = runWith({ MINING_PROFILE: 'banana' });
  const u = parse(unknown.stdout);
  check('an unknown profile falls back to home rather than to nothing',
    u && u.profile === 'home' && u.startDifficulty === 2048, JSON.stringify(u && u.profile));
  check('and it says so', /unknown MINING_PROFILE/.test(unknown.stderr || ''),
    (unknown.stderr || '').slice(0, 60));
}

console.log('\nthe interlock');
{
  const unsafe = runWith({ MINING_PROFILE: 'rented', LOCK_PAYOUT_ADDRESS: '0' });
  check('rented without a locked payout REFUSES to start', unsafe.status === 1, String(unsafe.status));
  check('and explains what to do',
    /LOCK_PAYOUT_ADDRESS=1/.test(unsafe.stderr || ''), (unsafe.stderr || '').slice(0, 120));

  const missing = runWith({ MINING_PROFILE: 'rented' });
  check('an unset lock is treated as off, not as permission', missing.status === 1, String(missing.status));

  // The home profile is for a LAN port, where per-worker payout addresses are a
  // feature rather than a hole, so it must NOT be blocked by the interlock.
  const home = runWith({ MINING_PROFILE: 'home', LOCK_PAYOUT_ADDRESS: '0' });
  check('the home profile still starts with the payout unlocked', home.status !== 1, String(home.status));
}

console.log('\nthe shipped compose file must not disable the profile');
{
  // The failure this guards against is silent and total: every value the
  // profile sets is also a value the compose file COULD set, and an explicit
  // value wins. Ship both and switching to the rented profile changes nothing,
  // the order floods the rate limit, and the only symptom is a failed order.
  const fs = require('node:fs');
  const compose = fs.readFileSync(
    path.join(__dirname, '..', 'doge-dogecoin-solo', 'docker-compose.yml'), 'utf8');

  // Keys the rented profile changes. Kept here rather than imported, so that
  // adding a key to the profile without thinking about the compose file makes
  // this test fail rather than pass quietly.
  const PROFILE_KEYS = [
    'START_DIFFICULTY', 'MIN_DIFFICULTY', 'MAX_DIFFICULTY', 'MAX_MESSAGES_PER_10S',
    'MAX_CONNECTIONS', 'MAX_CONNECTIONS_PER_IP', 'DIFFICULTY_GRACE_SECONDS',
    'SOCKET_TIMEOUT_SECONDS', 'PING_INTERVAL_SECONDS', 'MAX_PAYOUT_VARIANTS',
  ];
  const active = compose.split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const shadowed = PROFILE_KEYS.filter((k) => new RegExp(`^\\s*${k}\\s*:`, 'm').test(active));
  check('no profile-controlled setting is also written out explicitly',
    shadowed.length === 0, shadowed.join(', '));

  check('the profile itself IS set, so the choice is visible',
    /^\s*MINING_PROFILE\s*:/m.test(active));
  check('and it ships as home', /MINING_PROFILE:\s*"home"/.test(active));
  check('the payout lock ships on', /LOCK_PAYOUT_ADDRESS:\s*"1"/.test(active));

  // Every key the profile sets must be one the app actually reads.
  const server = fs.readFileSync(
    path.join(__dirname, '..', 'images', 'stratum', 'src', 'server.js'), 'utf8');
  const unread = PROFILE_KEYS.filter((k) => !server.includes(`'${k}'`));
  check('every profile key is one the app reads', unread.length === 0, unread.join(', '));
}

console.log(failures === 0 ? '\nPROFILE VERIFIED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
