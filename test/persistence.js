'use strict';
//
// The statistics must survive a restart, must never be left half-written, and
// must never stop the app from mining when the disk says no.
//

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../images/stratum/src/store');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-store-'));
const file = path.join(dir, 'stats.json');

console.log('\nhistory survives a restart');
{
  const s = new Store(file);
  s.load();
  check('a fresh store is writable', s.writable);
  s.recordShare(1700000000000, 12345.6, 2048, 'worker-a');
  s.recordShare(1700000060000, 999999, 4096, 'worker-a');
  s.recordReject('stale job', 'worker-a');
  s.recordSample(1700000000000, 11_000_000);
  s.recordSample(1700000060000, 12_000_000);
  s.recordBlock({ height: 6327333, hash: 'ab', worker: 'worker-a', address: 'D...', reward: 1e12, at: Date.now(), status: 'submitting', accepted: null, error: null, blockHex: 'ff'.repeat(100000) });
  check('the block hex is NOT persisted', s.state.blocks[0].blockHex === undefined);
  s.updateBlock('ab', { status: 'accepted', accepted: true });
  check('blocksFound is derived from the stored blocks', s.blocksFound() === 1, String(s.blocksFound()));
  check('the file was written', s.save(true) && fs.existsSync(file));

  const again = new Store(file);
  const state = again.load();
  check('shares restored', state.accepted === 2, String(state.accepted));
  check('rejects restored', state.rejected === 1, String(state.rejected));
  check('reject reasons restored', state.rejectReasons['stale job'] === 1);
  check('best share restored', state.bestShareDiff === 999999, String(state.bestShareDiff));
  check('blocks restored', again.blocksFound() === 1 && state.blocks.length === 1);
  check('the restored block carries no hex', state.blocks[0].blockHex === undefined);
  check('hashrate samples restored', state.minuteSamples.length === 2);
  check('share log restored', state.shareLog.length === 2);
  check('per-worker totals restored', state.workers['worker-a'].accepted === 2);
  check('firstStartedAt is preserved, not reset',
    state.firstStartedAt === again.state.firstStartedAt && !!state.firstStartedAt);
}

console.log('\nbounded growth');
{
  const s = new Store(path.join(dir, 'bounded.json'));
  s.load();
  for (let i = 0; i < 5000; i++) s.recordSample(1700000000000 + i * 60000, 1_000_000);
  check('minute samples are capped', s.state.minuteSamples.length <= 48 * 60, String(s.state.minuteSamples.length));
  for (let i = 0; i < 2000; i++) s.recordShare(1700000000000 + i * 1000, 10, 1024, 'w' + (i % 80));
  check('share log is capped', s.state.shareLog.length <= 600, String(s.state.shareLog.length));
  check('worker history is capped', Object.keys(s.state.workers).length <= 50,
    String(Object.keys(s.state.workers).length));
  for (let i = 0; i < 120; i++) s.recordBlock({ height: i, at: Date.now() });
  check('block log is capped', s.state.blocks.length <= 50, String(s.state.blocks.length));

  s.save(true);
  const bytes = fs.statSync(path.join(dir, 'bounded.json')).size;
  check('the file stays a sensible size', bytes < 2_000_000, `${Math.round(bytes/1024)} KB`);
}

console.log('\nfailure modes');
{
  // A corrupt file must not be fatal and must not be silently destroyed.
  const corruptPath = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corruptPath, '{ this is not json');
  const s = new Store(corruptPath);
  const state = s.load();
  check('a corrupt file yields a usable empty state', state.accepted === 0);
  check('the corrupt file is kept for inspection', fs.existsSync(corruptPath + '.corrupt'));

  // An unwritable location must be reported, not crash. A chmod-ed directory
  // would not do: this suite may run as root, and root ignores permissions.
  // Putting the stats file "inside" a regular file fails with ENOTDIR for
  // everyone, and exercises exactly the same code path.
  const blocker = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  const ro = new Store(path.join(blocker, 'stats.json'));
  let threw = false;
  try { ro.load(); } catch { threw = true; }
  check('an unwritable path does not throw', !threw);
  check('an unwritable path is reported', ro.writable === false && !!ro.lastError, ro.lastError);
  ro.recordShare(Date.now(), 1, 1024, 'w');
  check('saving to an unwritable path fails quietly', ro.save(true) === false);
  check('an unwritable path still records in memory', ro.state.accepted === 1);

  // No path at all: the app must still run.
  const none = new Store(null);
  none.load();
  none.recordShare(Date.now(), 1, 1024, 'w');
  check('a store with no path still records in memory', none.state.accepted === 1);
  check('a store with no path reports save as a no-op', none.save(true) === false);
}

console.log('\nno half-written files');
{
  const p = path.join(dir, 'atomic.json');
  const s = new Store(p);
  s.load();
  for (let i = 0; i < 50; i++) {
    s.recordShare(Date.now(), i, 1024, 'w');
    s.save(true);
    // After every save the file must parse. A non-atomic writer would leave a
    // truncated file behind at some point in this loop.
    JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  check('the file parses after every one of 50 saves', true);
  check('no temporary file is left behind', !fs.existsSync(p + '.tmp'));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('\na file from a newer version is never destroyed');
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-store2-'));
  const p2 = path.join(dir2, 'stats.json');
  fs.writeFileSync(p2, JSON.stringify({ version: 99, accepted: 123456, futureField: true }));
  const s = new Store(p2);
  s.load();
  check('a newer file leaves the store read-only', s.writable === false, String(s.writable));
  check('the newer file is still on disk, untouched',
    JSON.parse(fs.readFileSync(p2, 'utf8')).accepted === 123456);
  s.recordShare(Date.now(), 1, 1024, 'w');
  check('saving refuses rather than overwriting it', s.save(true) === false);
  check('the file is still intact after a forced save',
    JSON.parse(fs.readFileSync(p2, 'utf8')).accepted === 123456);

  // An older version is archived, not silently replaced.
  const p3 = path.join(dir2, 'old.json');
  fs.writeFileSync(p3, JSON.stringify({ version: 0, accepted: 7 }));
  const s3 = new Store(p3);
  s3.load();
  check('an older file is archived alongside', fs.existsSync(p3 + '.v0'));
  check('an older file leaves the store writable', s3.writable === true);
  fs.rmSync(dir2, { recursive: true, force: true });
}

console.log('\na file with the right version but wrong shapes cannot break mining');
{
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-store3-'));
  const p4 = path.join(dir3, 'stats.json');
  fs.writeFileSync(p4, JSON.stringify({
    version: 1, accepted: 'lots', rejected: null, shareLog: {}, minuteSamples: null,
    hourSamples: 'no', workers: [], rejectReasons: null, bestShareDiff: null, blocks: 'nope',
  }));
  const s = new Store(p4);
  s.load();
  let threw = null;
  try {
    s.recordShare(Date.now(), 5, 1024, 'w');
    s.recordSample(Date.now(), 1000);
    s.recordReject('stale job', 'w');
  } catch (e) { threw = e.message; }
  check('recording works despite a malformed file', threw === null, threw);
  check('bad scalars are coerced', s.state.accepted === 1, String(s.state.accepted));
  check('bad arrays are replaced', Array.isArray(s.state.shareLog) && s.state.shareLog.length === 1);
  fs.rmSync(dir3, { recursive: true, force: true });
}

console.log('\nclock steps and reject-only workers');
{
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-store4-'));
  const s = new Store(path.join(dir4, 'stats.json'));
  s.load();
  const base = 1700000000000;
  s.recordSample(base, 1000);
  s.recordSample(base + 60000, 1100);
  s.recordSample(base - 7200000, 9999); // NTP steps the clock two hours back
  check('a backwards clock step is ignored', s.state.minuteSamples.length === 2,
    String(s.state.minuteSamples.length));
  const hours = s.state.hourSamples.map((h) => h[0]);
  check('no duplicate hourly buckets', new Set(hours).size === hours.length);
  check('hourly buckets stay in order',
    hours.every((h, i) => i === 0 || h >= hours[i-1]));

  // A worker that only ever produces rejects must still be visible.
  s.recordReject('low difficulty share', 'broken-miner');
  check('a reject-only worker gets an entry',
    !!s.state.workers['broken-miner'] && s.state.workers['broken-miner'].rejected === 1);
  fs.rmSync(dir4, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PERSISTENCE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
