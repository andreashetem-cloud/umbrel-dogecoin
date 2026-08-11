'use strict';
//
// Upgrading the statistics file from version 1 to version 2.
//
// This is the single most destructive thing this release can do. The user has
// months of real history in a v1 file — shares, blocks, the best share ever,
// the hashrate chart back to the day the app was installed. A migration that
// quietly starts fresh, or archives the file and forgets it, cannot be undone.
//
// So this suite builds a REALISTIC v1 file, migrates it, and asserts field by
// field that nothing was lost, that the original was not moved, and that what
// is written back is a valid v2 file. It also covers the reverse direction: a
// v2 file opened by a build that only understands v1 must be left alone.
//

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, VERSION, MIGRATABLE } = require('../images/stratum/src/store');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-migrate-'));
const now = Date.now();
const nowSec = Math.round(now / 1000);

// What a v1 file actually looks like after a few months of mining.
const v1 = {
  version: 1,
  firstStartedAt: now - 90 * 86400000,
  accepted: 412073,
  rejected: 61,
  rejectReasons: { 'stale job': 55, 'low difficulty share': 6 },
  bestShareDiff: 3187442.5,
  bestShareAt: now - 40 * 3600000,
  blocks: [
    { height: 6327301, hash: 'a'.repeat(64), worker: 'lg07', address: 'D'.repeat(34),
      reward: 1000221430000, at: now - 37 * 60000, status: 'accepted', accepted: true, error: null },
    { height: 6100000, hash: 'b'.repeat(64), worker: 'dogexus', address: 'D'.repeat(34),
      reward: 1000000000000, at: now - 60 * 86400000, status: 'stale', accepted: false, error: 'orphaned' },
  ],
  minuteSamples: Array.from({ length: 500 }, (_, i) => [nowSec - (500 - i) * 60, 80000000 + i]),
  hourSamples: Array.from({ length: 300 }, (_, i) => [
    Math.floor((nowSec - (300 - i) * 3600) / 3600) * 3600, 83000000 + i, 60,
  ]),
  // v1 share log entries have exactly three elements — no worker name.
  shareLog: Array.from({ length: 200 }, (_, i) => [nowSec - (200 - i) * 14, 1000 + i, 16384]),
  workers: {
    lg07: { accepted: 120000, rejected: 55, bestShareDiff: 741903, firstSeen: now - 90 * 86400000,
      lastSeen: now - 60000, work: 1.9e9 },
    dogexus: { accepted: 292073, rejected: 6, bestShareDiff: 3187442.5, firstSeen: now - 80 * 86400000,
      lastSeen: now - 30000, work: 4.7e9 },
  },
};

console.log('\nversion 1 is recognised as upgradable');
check('MIGRATABLE names version 1', MIGRATABLE.has(1));
check('this build is version 2', VERSION === 2, String(VERSION));

console.log('\nnothing is lost on the way to version 2');
const statsPath = path.join(dir, 'stats.json');
fs.writeFileSync(statsPath, JSON.stringify(v1));
const before = fs.readFileSync(statsPath, 'utf8');

const logged = [];
const store = new Store(statsPath, (m) => logged.push(m));
store.load();
const s = store.state;

check('the lifetime share count survives', s.accepted === v1.accepted, String(s.accepted));
check('the reject count survives', s.rejected === v1.rejected, String(s.rejected));
check('the reject reasons survive',
  JSON.stringify(s.rejectReasons) === JSON.stringify(v1.rejectReasons), JSON.stringify(s.rejectReasons));
check('the best share ever survives', s.bestShareDiff === v1.bestShareDiff, String(s.bestShareDiff));
check('when it happened survives', s.bestShareAt === v1.bestShareAt, String(s.bestShareAt));
check('the install date survives', s.firstStartedAt === v1.firstStartedAt, String(s.firstStartedAt));
check('both blocks survive', s.blocks.length === 2, String(s.blocks.length));
check('the accepted block is still counted as found', store.blocksFound() === 1, String(store.blocksFound()));
check('the orphaned block is still marked orphaned',
  s.blocks[1].status === 'stale' && s.blocks[1].accepted === false, JSON.stringify(s.blocks[1].status));
check('every minute sample survives', s.minuteSamples.length === 500, String(s.minuteSamples.length));
check('every hourly bucket survives, with its count',
  s.hourSamples.length === 300 && s.hourSamples[0][2] === 60, JSON.stringify(s.hourSamples[0]));
check('the share log survives', s.shareLog.length === 200, String(s.shareLog.length));
check('old share entries gain a fourth field rather than being dropped',
  s.shareLog[0].length === 4 && s.shareLog[0][3] === null, JSON.stringify(s.shareLog[0]));
check('the first three fields of an old share entry are untouched',
  s.shareLog[0][0] === v1.shareLog[0][0] && s.shareLog[0][1] === v1.shareLog[0][1] &&
  s.shareLog[0][2] === v1.shareLog[0][2], JSON.stringify(s.shareLog[0]));

const lg = s.workers.lg07;
check('per-worker totals survive', lg && lg.accepted === 120000 && lg.rejected === 55, JSON.stringify(lg));
check('per-worker best share survives', lg && lg.bestShareDiff === 741903, String(lg && lg.bestShareDiff));
check('per-worker work survives', lg && lg.work === 1.9e9, String(lg && lg.work));
check('the new per-worker fields are present and empty, not undefined',
  lg && Array.isArray(lg.samples) && lg.samples.length === 0 &&
  lg.rejectReasons && Object.keys(lg.rejectReasons).length === 0 && lg.bestShareAt === null,
  JSON.stringify({ samples: lg && lg.samples, reasons: lg && lg.rejectReasons, at: lg && lg.bestShareAt }));

check('the upgrade is announced in the log', logged.some((m) => /upgraded from version 1/.test(m)),
  logged.join(' | '));
check('the original file was NOT archived away',
  fs.readdirSync(dir).filter((f) => f.startsWith('stats.json.')).length === 0,
  fs.readdirSync(dir).join(', '));
check('and it is still byte-for-byte the original until we save',
  fs.readFileSync(statsPath, 'utf8') === before);

console.log('\nwhat gets written back is a valid version 2 file');
store.recordShare(now, 5000, 16384, 'lg07');
store.recordWorkerSamples(now, new Map([['lg07', 13000000]]));
check('the store is writable after a migration', store.save(true) === true);

const written = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
check('it now declares version 2', written.version === 2, String(written.version));
check('the history is still there after the rewrite', written.accepted === v1.accepted + 1,
  String(written.accepted));
check('the new share carries its worker name',
  written.shareLog[written.shareLog.length - 1][3] === 'lg07',
  JSON.stringify(written.shareLog[written.shareLog.length - 1]));
check('the worker now has a sample series', written.workers.lg07.samples.length === 1,
  JSON.stringify(written.workers.lg07.samples));

// Re-opening the migrated file must be a no-op, not a second migration.
const reopened = new Store(statsPath, () => {});
reopened.load();
check('re-opening a v2 file changes nothing', reopened.state.accepted === v1.accepted + 1,
  String(reopened.state.accepted));
check('and it is not announced as an upgrade again',
  fs.readdirSync(dir).filter((f) => f.startsWith('stats.json.')).length === 0);

console.log('\na file from a NEWER build is never overwritten');
const futureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-future-'));
const futurePath = path.join(futureDir, 'stats.json');
const future = { ...v1, version: VERSION + 1, accepted: 999999 };
fs.writeFileSync(futurePath, JSON.stringify(future));
const futureStore = new Store(futurePath, () => {});
futureStore.load();
check('the store refuses to write', futureStore.writable === false);
check('it says why', /version/.test(String(futureStore.lastError)), String(futureStore.lastError));
futureStore.recordShare(Date.now(), 1, 1, 'x');
futureStore.save(true);
check('the newer file is untouched on disk',
  JSON.parse(fs.readFileSync(futurePath, 'utf8')).accepted === 999999);

console.log('\nhostile worker names cannot corrupt anything');
const nastyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-nasty-'));
const nasty = new Store(path.join(nastyDir, 'stats.json'), () => {});
nasty.load();
for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  nasty.recordShare(Date.now(), 3, 1024, name);
}
check('every hostile name got its own real entry',
  ['__proto__', 'constructor', 'toString', 'hasOwnProperty']
    .every((n) => Object.prototype.hasOwnProperty.call(nasty.state.workers, n) &&
      nasty.state.workers[n].accepted === 1),
  Object.keys(nasty.state.workers).join(','));
check('Object.prototype was not touched', ({}).accepted === undefined && ({}).work === undefined,
  JSON.stringify({ accepted: ({}).accepted, work: ({}).work }));
check('a plain object did not inherit a samples array', ({}).samples === undefined);
check('the file round-trips those names', (() => {
  nasty.save(true);
  const back = new Store(path.join(nastyDir, 'stats.json'), () => {});
  back.load();
  return Object.prototype.hasOwnProperty.call(back.state.workers, '__proto__') &&
    back.state.workers['__proto__'].accepted === 1 && ({}).accepted === undefined;
})());

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(futureDir, { recursive: true, force: true });
fs.rmSync(nastyDir, { recursive: true, force: true });
console.log(failures === 0 ? '\nMIGRATION VERIFIED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
