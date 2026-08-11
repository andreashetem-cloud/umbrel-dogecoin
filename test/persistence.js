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
  // The destructive branch: the timestamps must straddle the REAL wall clock,
  // which the fixed base above never does.
  {
    const s2 = new Store(path.join(dir4, 'clock.json'));
    s2.load();
    const now = Date.now();
    s2.recordSample(now - 120000, 1000);
    s2.recordSample(now - 60000, 1100);
    // One reading from a clock that is a year fast.
    s2.recordSample(now + 365 * 86400000, 5000);
    const stored = s2.state.minuteSamples.length;
    // Fourteen more real samples: still refused, nothing deleted yet.
    for (let i = 0; i < 14; i++) s2.recordSample(now + i * 60000, 1200);
    check('a single wrong-clock sample does not delete history immediately',
      s2.state.minuteSamples.length === stored, String(s2.state.minuteSamples.length));
    check('and the real samples are refused while the disagreement is young',
      s2.state.minuteSamples[s2.state.minuteSamples.length - 1][1] === 5000);
    // Past the re-anchor threshold the present wins and the future-dated
    // sample is dropped — without taking the genuine history with it.
    for (let i = 0; i < 4; i++) s2.recordSample(now + (14 + i) * 60000, 1300);
    check('after a sustained disagreement the timeline re-anchors',
      s2.state.minuteSamples.some((p) => p[1] === 1300), 'no recent sample accepted');
    check('the future-dated sample is gone',
      !s2.state.minuteSamples.some((p) => p[1] === 5000));
    check('the genuine older history survived the re-anchor',
      s2.state.minuteSamples.some((p) => p[1] === 1000) &&
      s2.state.minuteSamples.some((p) => p[1] === 1100),
      JSON.stringify(s2.state.minuteSamples.map((p) => p[1])));

    // The per-worker series shares the timeline and must not stay frozen.
    const s3 = new Store(path.join(dir4, 'clock2.json'));
    s3.load();
    s3.recordWorkerSamples(now + 365 * 86400000, new Map([['rig', 5000]]));
    for (let i = 0; i < 20; i++) s3.recordWorkerSamples(now + i * 60000, new Map([['rig', 200]]));
    // length > 0 first: `every` on an empty array is true, so without it this
    // would also pass if the re-anchor had deleted the entire series — the
    // opposite failure.
    check('a worker series does not stay frozen in the future',
      s3.state.workers.rig.samples.length > 0 &&
      s3.state.workers.rig.samples.every((p) => p[0] < Math.round((now + 86400000) / 1000)),
      JSON.stringify(s3.state.workers.rig.samples.length));
  }

  // Nine workers: none of them may be permanently starved of samples.
  {
    const s4 = new Store(path.join(dir4, 'many.json'));
    s4.load();
    const base = Date.now();
    for (let tick = 0; tick < 10; tick++) {
      const m = new Map();
      for (let i = 1; i <= 9; i++) m.set(`rig${i}`, 1000 * i);
      s4.recordWorkerSamples(base + tick * 60000, m);
    }
    const counts = Object.fromEntries(Object.entries(s4.state.workers).map(([n, w]) => [n, w.samples.length]));
    check('with nine workers every one of them keeps samples',
      Object.keys(counts).length === 9 && Object.values(counts).every((c) => c > 0),
      JSON.stringify(counts));
  }

  // The sample budget: enough ticks to actually cross it, which the nine-worker
  // block above never does.
  {
    const s5 = new Store(path.join(dir4, 'budget.json'));
    s5.load();
    const base = Date.now();
    // Eight steady miners, a full day of sampling.
    for (let tick = 0; tick < 1440; tick++) {
      const m = new Map();
      for (let i = 1; i <= 8; i++) m.set(`rig${i}`, 1000);
      s5.recordWorkerSamples(base + tick * 60000, m);
    }
    const steady = Object.values(s5.state.workers).map((w) => w.samples.length);
    check('eight steady miners each keep a long series', Math.min(...steady) >= 1400,
      JSON.stringify(steady));

    // A laptop connects for one minute. The real miners must not be gutted.
    const m9 = new Map();
    for (let i = 1; i <= 8; i++) m9.set(`rig${i}`, 1000);
    m9.set('visitor', 500);
    s5.recordWorkerSamples(base + 1441 * 60000, m9);
    const after = Object.entries(s5.state.workers)
      .filter(([n]) => n !== 'visitor').map(([, w]) => w.samples.length);
    check('a one-minute visitor does not gut the established miners',
      Math.min(...after) >= 1300, JSON.stringify(after));

    // Fifty miners: the file must still be bounded.
    const s6 = new Store(path.join(dir4, 'fifty.json'));
    s6.load();
    for (let tick = 0; tick < 400; tick++) {
      const m = new Map();
      for (let i = 1; i <= 50; i++) m.set(`rig${i}`, 1000);
      s6.recordWorkerSamples(base + tick * 60000, m);
    }
    const size = JSON.stringify(s6.state).length;
    check('fifty miners still fit in a small file', size < 600000, `${size} bytes`);
    const fifty = Object.values(s6.state.workers).map((w) => w.samples.length);
    check('and every one of the fifty still has a series', Math.min(...fifty) > 0,
      `${Math.min(...fifty)}..${Math.max(...fifty)}`);
  }

  // The re-anchor decision must survive restarts, or a box that reboots often
  // never recovers from a bad clock at all.
  {
    const p6 = path.join(dir4, 'restart.json');
    const now = Date.now();
    let s7 = new Store(p6); s7.load();
    s7.recordSample(now + 365 * 86400000, 5000);
    s7.save(true);
    // Ten "restarts", each writing one real sample a couple of minutes apart.
    for (let i = 0; i < 10; i++) {
      s7 = new Store(p6); s7.load();
      s7.recordSample(now + i * 120000, 1000);
      s7.save(true);
    }
    s7 = new Store(p6); s7.load();
    s7.recordSample(now + 20 * 60000, 1000);
    check('a restarting process still re-anchors after a bad clock',
      s7.state.minuteSamples.some((p) => p[1] === 1000),
      JSON.stringify(s7.state.minuteSamples.map((p) => p[1])));
    check('and the future-dated sample is gone',
      !s7.state.minuteSamples.some((p) => p[1] === 5000));
  }

  fs.rmSync(dir4, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PERSISTENCE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
