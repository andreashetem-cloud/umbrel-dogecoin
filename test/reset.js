'use strict';
//
// Resetting the counters.
//
// The reason this exists: a reject rate only means anything as a rate SINCE
// something. After a day of changing miner settings the record held 25,338
// rejects against 16,330 accepted shares — 60.8% — and from that point on a
// genuinely new problem moves the headline figure by a fraction of a percent
// and is invisible. The number had stopped answering the only question anyone
// asks it: is this happening now.
//
// What must be impossible is more interesting than what must work. A "reset"
// that also cleared the block records would not be zeroing a counter, it would
// be deleting the evidence that a block was ever mined — blocksFound() is
// DERIVED from those records, and reconciliation compares them against the node
// at every startup.
//

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../images/stratum/src/store');
const { Pool } = require('../images/stratum/src/pool');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-reset-'));
const file = path.join(dir, 'stats.json');

function populated() {
  // A fresh file every time. Without this each case would load the previous
  // one's already-reset state, and "the block records survive" would be
  // counting two blocks from two runs — a check that passes or fails for
  // reasons that have nothing to do with reset().
  fs.rmSync(file, { force: true });
  const s = new Store(file, () => {});
  s.load();
  s.state.firstStartedAt = 1_700_000_000_000;
  s.recordShare(1_786_000_000_000, 790, 2048, 'dogexus');
  s.recordShare(1_786_000_001_000, 12, 2048, 'dogexus');
  for (let i = 0; i < 5; i++) s.recordReject('low difficulty share', 'dogexus');
  s.recordSample(1_786_000_002_000, 20_000_000);
  // Per-worker series too. Without this, `workers.dogexus.samples` is empty
  // before any reset, and the check that it is empty afterwards passes whether
  // reset() clears it or not — a vacuous assertion hidden among real ones.
  s.recordWorkerSamples(1_786_000_002_000, new Map([['dogexus', 20_000_000]]));
  s.recordBlock({ chain: 'DOGE', height: 6330327, hash: 'ab'.repeat(32), accepted: true, at: 1_786_000_003_000 });
  s.save(true);
  return s;
}

console.log('\nwhat a reset clears');
{
  const s = populated();
  const before = { accepted: s.state.accepted, rejected: s.state.rejected };
  const out = s.reset({ counters: true, best: true });

  check('it reports what it did',
    out.ok && out.cleared.join(', ') === 'counters, best share', JSON.stringify(out));
  check('the accepted counter is zero', s.state.accepted === 0, String(s.state.accepted));
  check('the rejected counter is zero', s.state.rejected === 0, String(s.state.rejected));
  check('the reject reasons are gone',
    Object.keys(s.state.rejectReasons).length === 0, JSON.stringify(s.state.rejectReasons));
  check('the best share is zero', s.state.bestShareDiff === 0, String(s.state.bestShareDiff));
  check('and its timestamp with it', s.state.bestShareAt === null, String(s.state.bestShareAt));
  check('per-worker counters go too',
    s.state.workers.dogexus.accepted === 0 && s.state.workers.dogexus.rejected === 0 &&
      s.state.workers.dogexus.bestShareDiff === 0,
    JSON.stringify(s.state.workers.dogexus));
  check('it says what was cleared', out.before.accepted === before.accepted &&
    out.before.rejected === before.rejected, JSON.stringify(out.before));
  check('and stamps when', Number.isFinite(s.state.resetAt), String(s.state.resetAt));
}

console.log('\nwhat a reset must never touch');
{
  const s = populated();
  s.reset({ counters: true, best: true, history: true });
  check('the block records survive', s.state.blocks.length === 1, String(s.state.blocks.length));
  // blocksFound() counts accepted records rather than reading a stored
  // counter, so clearing the records would not zero a number — it would erase
  // the only proof a block was mined, and reconciliation would stop being able
  // to ask the node about it.
  check('and so does the block count', s.blocksFound() === 1, String(s.blocksFound()));
  check('how long this pool has been mining is untouched',
    s.state.firstStartedAt === 1_700_000_000_000, String(s.state.firstStartedAt));

  // The cumulative work per worker, which is NOT a share counter: it is the
  // denominator of the "work done" tile and of the luck percentage, and its
  // natural partner is the block count that is deliberately kept. Zeroing it
  // while keeping blocksFound leaves the dashboard reading "1 block found,
  // 8.0e+10% luck" — a figure that is not merely reset but wrong, and that
  // takes as long to rebuild as the pool has been running.
  check('and so is the cumulative work each worker has done',
    s.state.workers.dogexus.work === 4096, String(s.state.workers.dogexus.work));
}

console.log('\nthe charts are only cleared when asked for');
{
  const s = populated();
  s.reset({ counters: true, best: true });
  check('the hashrate history is kept by default',
    s.state.minuteSamples.length === 1, String(s.state.minuteSamples.length));
  check('and so is the share log', s.state.shareLog.length === 2, String(s.state.shareLog.length));

  const s2 = populated();
  s2.reset({ counters: true, best: true, history: true });
  check('history: true clears them',
    s2.state.minuteSamples.length === 0 && s2.state.hourSamples.length === 0 &&
      s2.state.shareLog.length === 0 && s2.state.workers.dogexus.samples.length === 0,
    `${s2.state.minuteSamples.length}/${s2.state.hourSamples.length}/${s2.state.shareLog.length}`);
}

console.log('\nan empty scope is refused rather than silently doing nothing');
{
  const s = populated();
  const out = s.reset({});
  check('it says no', out.ok === false, JSON.stringify(out));
  check('and changes nothing', s.state.accepted === 2 && s.state.resetAt === null,
    `${s.state.accepted} / ${s.state.resetAt}`);
}

console.log('\nthe reset survives a restart');
{
  const s = populated();
  s.reset({ counters: true, best: true });
  const at = s.state.resetAt;

  const reloaded = new Store(file, () => {});
  reloaded.load();
  check('the counters are still zero after reload',
    reloaded.state.accepted === 0 && reloaded.state.rejected === 0,
    `${reloaded.state.accepted}/${reloaded.state.rejected}`);
  // Without this the dashboard would present freshly reset counters as
  // lifetime totals again the moment the app restarted, which is worse than
  // not labelling them at all.
  check('and the page can still say what they are counted since',
    reloaded.state.resetAt === at, `${reloaded.state.resetAt} vs ${at}`);
}

console.log('\nthe live counters go with them');
{
  // The store holds the durable copy, but the pool's are what the dashboard
  // reads. Clearing one and not the other shows a zero for five seconds and
  // then the old number again — which looks exactly like a broken button.
  const p = {
    stats: {
      accepted: 16330, rejected: 25338, rejectReasons: { 'low difficulty share': 25338 },
      bestShareDiff: 790, bestShareAt: 1_786_000_000_000, blocksFound: 1,
      blocks: [{ height: 6330327 }],
    },
    clients: new Map([
      ['a', { accepted: 100, rejected: 900, rejectReasons: { x: 900 }, bestShareDiff: 790,
              shareTimes: [{ at: 1, difficulty: 2048 }, { at: 2, difficulty: 2048 }] }],
    ]),
  };
  Pool.prototype.resetStats.call(p, { counters: true, best: true });
  check('the live totals are zero', p.stats.accepted === 0 && p.stats.rejected === 0);
  check('the live best share is zero', p.stats.bestShareDiff === 0 && p.stats.bestShareAt === null);
  check('per-connection counters are zero',
    p.clients.get('a').accepted === 0 && p.clients.get('a').rejected === 0 &&
      p.clients.get('a').bestShareDiff === 0);
  check('the blocks found figure is untouched', p.stats.blocksFound === 1 && p.stats.blocks.length === 1);
  // shareTimes is not a statistic — it is the input to the hashrate estimate
  // and to vardiff. Clearing it would drop every worker to 0 H/s for minutes
  // and hand vardiff a two-sample guess to retune from.
  check('but the hashrate window is left alone',
    p.clients.get('a').shareTimes.length === 2, String(p.clients.get('a').shareTimes.length));
  check('and the reset is stamped', Number.isFinite(p.stats.resetAt), String(p.stats.resetAt));
}

console.log('\na reset that clears nothing marks nothing');
{
  // The store refuses an empty scope with a 400. If the live half stamped
  // `resetAt` anyway, the dashboard would start labelling untouched lifetime
  // counters "since reset" — disagreeing with /api/history, and believed,
  // because a label like that is not something anyone re-checks.
  const p = { stats: { accepted: 5, rejected: 1, rejectReasons: {}, bestShareDiff: 9 }, clients: new Map() };
  const out = Pool.prototype.resetStats.call(p, {});
  check('it declines', out === false, String(out));
  check('and stamps nothing', p.stats.resetAt === undefined, String(p.stats.resetAt));
  check('leaving the counters alone', p.stats.accepted === 5 && p.stats.bestShareDiff === 9);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nSTATISTICS RESET VERIFIED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
