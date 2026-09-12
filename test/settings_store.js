'use strict';
//
// The Settings class (images/stratum/src/settings.js) — persistence for the
// one thing the dashboard can change at runtime: the mining profile.
//
// Same durability bar as store.js, deliberately, and tested the same way:
// losing this file must never stop the app from mining, and a write must
// never leave a half-written file behind. What is NOT covered here is
// applyMiningProfile() itself (the interlock, the live pool.config mutation,
// the HTTP wiring) — that needs a running Pool and is covered by
// test/profile.js's spawn-based approach and by manual verification against
// docker-compose.yml, not by a unit test of this class.
//

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Settings, VALID_PROFILES } = require('../images/stratum/src/settings');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-settings-'));

console.log('\nno path configured');
{
  const s = new Settings(null, () => {});
  check('load() returns null rather than throwing', s.load() === null);
  check('saveProfile() reports failure rather than throwing', s.saveProfile('rented') === false);
}

console.log('\na fresh file');
{
  const file = path.join(dir, 'fresh', 'settings.json');
  const s = new Settings(file, () => {});
  check('nothing to load yet', s.load() === null);
  check('the directory is created for it', fs.existsSync(path.dirname(file)));
  check('and it is writable', s.writable === true);
}

console.log('\nsave, then load in a fresh instance');
{
  const file = path.join(dir, 'roundtrip.json');
  const a = new Settings(file, () => {});
  a.load();
  check('saveProfile reports success', a.saveProfile('rented') === true);

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('the file holds the profile', raw.miningProfile === 'rented', JSON.stringify(raw));
  check('and when it was saved', typeof raw.savedAt === 'string', String(raw.savedAt));

  const b = new Settings(file, () => {});
  check('a new instance reads it back', b.load() === 'rented');

  check('and switching again overwrites it', a.saveProfile('home') === true);
  check('the new instance sees the new value on a fresh load', b.load() === 'home');
}

console.log('\nwhat must never happen: a bad file stopping the app');
{
  const file = path.join(dir, 'corrupt.json');
  fs.writeFileSync(file, '{ not json');
  const s = new Settings(file, () => {});
  check('a corrupt file is ignored, not thrown', s.load() === null);
  // It probed writability during that same load() — losing the file must not
  // also cost the ability to write a new one.
  check('but the path is still usable afterwards', s.writable === true);
  check('a fresh save overwrites the corruption', s.saveProfile('rented') === true);
  check('and a reload now sees the good value', s.load() === 'rented');
}

console.log('\na profile this build does not recognise');
{
  const file = path.join(dir, 'unknown-profile.json');
  fs.writeFileSync(file, JSON.stringify({ miningProfile: 'moon' }));
  const s = new Settings(file, () => {});
  check('an unrecognised profile is treated as none saved', s.load() === null);
  check('VALID_PROFILES is exactly home and rented',
    VALID_PROFILES.has('home') && VALID_PROFILES.has('rented') && VALID_PROFILES.size === 2,
    JSON.stringify(Array.from(VALID_PROFILES)));
}

console.log('\nan unwritable directory');
{
  // Root can write anywhere, which would make this check pass for the wrong
  // reason inside a container that runs as root; skip it there rather than
  // assert something that is not actually being tested.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('  skip  (running as root; permissions are not enforced)');
  } else {
    const roDir = path.join(dir, 'readonly');
    fs.mkdirSync(roDir, { recursive: true });
    fs.chmodSync(roDir, 0o555);
    const file = path.join(roDir, 'settings.json');
    const s = new Settings(file, () => {});
    check('load() still returns cleanly', s.load() === null);
    check('but reports itself as not writable', s.writable === false);
    check('and a save is refused rather than throwing', s.saveProfile('rented') === false);
    fs.chmodSync(roDir, 0o755);
  }
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nSETTINGS STORE VERIFIED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
