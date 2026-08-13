'use strict';
//
// The node alarm.
//
// This is the suite for the thirteen hours: after an umbrelOS restart both node
// apps were down, the solo app kept answering its own healthcheck on :3000, and
// nothing was mined all night without a word. Every check below is a sentence
// from that story.
//
// The state machine is driven directly with hand-built snapshots and an
// explicit clock. Waiting three real minutes for a threshold would make this
// suite unrunnable in CI, and sleeping past it would make it flaky — while the
// thing actually worth testing is the arithmetic on the timestamps.
//

const { HealthMonitor } = require('../images/stratum/src/health');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const T0 = 1_786_000_000_000;
const MIN = 60000;

// A pool that is working perfectly.
function healthy(over = {}) {
  return {
    mergedMining: true,
    templateAgeMs: 1200,
    templateError: null,
    templateFailedAt: null,
    auxError: null,
    auxUnavailableSince: null,
    ...over,
  };
}

const monitor = (over = {}) => new HealthMonitor({
  alarmAfterMs: 3 * MIN,
  startupGraceMs: 5 * MIN,
  repeatMs: 6 * 3600 * 1000,
  startedAt: T0,
  ...over,
});

console.log('\na pool that is mining says nothing');
{
  const h = monitor();
  const r = h.evaluate(T0 + 60 * MIN, { snapshot: healthy() });
  check('no alerts', r.alerts.length === 0, JSON.stringify(r.alerts));
  check('level is ok', r.level === 'ok', r.level);
  check('the signature is empty', r.signature === '', r.signature);
}

console.log('\nthe pool that never started — the thirteen hours');
{
  const h = monitor();
  // Startup takes minutes on this hardware. Alarming here would train the user
  // to ignore the alarm, which is worse than not having one.
  const early = h.evaluate(T0 + 2 * MIN, { startupError: 'cannot reach the Dogecoin node', snapshot: null });
  check('silent during the startup grace', early.alerts.length === 0, JSON.stringify(early.alerts));

  const late = h.evaluate(T0 + 13 * 60 * MIN, { startupError: 'cannot reach the Dogecoin node', snapshot: null });
  check('after the grace it is an alarm', late.alerts.length === 1, JSON.stringify(late.alerts));
  check('at level down', late.level === 'down', late.level);
  check('keyed as a startup failure', late.alerts[0].key === 'startup', late.alerts[0].key);
  check('it says nothing is being mined',
    /Nothing is being mined/.test(late.alerts[0].text), late.alerts[0].text);
  check('and how long it has been going on',
    /13 hours/.test(late.alerts[0].text), late.alerts[0].text);
  // The whole point: this branch has no snapshot to read, so a monitor that
  // lived inside Pool could not produce it at all.
  check('it needs no snapshot to fire', late.alerts[0].since === T0, String(late.alerts[0].since));
}

console.log('\na single failed poll is not an outage');
{
  const h = monitor();
  // The node failed one call two seconds ago and the pool has recorded it.
  const blip = h.evaluate(T0 + 10 * MIN, {
    snapshot: healthy({ templateError: 'socket hang up', templateFailedAt: T0 + 10 * MIN - 2000 }),
  });
  check('nothing is raised', blip.alerts.length === 0, JSON.stringify(blip.alerts));

  // Measured from the pool's own record of when it began failing, not from
  // when this monitor first happened to look.
  const out = h.evaluate(T0 + 10 * MIN, {
    snapshot: healthy({ templateError: 'connect ECONNREFUSED', templateFailedAt: T0 + 6 * MIN }),
  });
  check('four minutes of failure is an alarm', out.alerts.length === 1, JSON.stringify(out.alerts));
  check('keyed as the parent node', out.alerts[0].key === 'parent', out.alerts[0].key);
}

console.log('\nthe threshold is exact');
{
  const h = monitor();
  const at = (ms) => h.evaluate(T0 + 60 * MIN, {
    snapshot: healthy({ templateError: 'x', templateFailedAt: T0 + 60 * MIN - ms }),
  }).alerts.length;
  check('one millisecond under the threshold is silent', at(3 * MIN - 1) === 0, String(at(3 * MIN - 1)));
  check('exactly the threshold alarms', at(3 * MIN) === 1, String(at(3 * MIN)));
}

console.log('\nit names the right node');
{
  const h = monitor();
  const merged = h.evaluate(T0 + 60 * MIN, {
    snapshot: healthy({ mergedMining: true, templateError: 'x', templateFailedAt: T0 }),
  });
  // In merged mode the templates come from LITECOIN. Sending someone to the
  // Dogecoin app for a Litecoin outage costs an hour at three in the morning.
  check('merged mode blames the Litecoin node',
    /Litecoin node has been unreachable/.test(merged.alerts[0].text), merged.alerts[0].text);

  const solo = h.evaluate(T0 + 60 * MIN, {
    snapshot: healthy({ mergedMining: false, templateError: 'x', templateFailedAt: T0 }),
  });
  check('Dogecoin-only mode blames the Dogecoin node',
    /Dogecoin node has been unreachable/.test(solo.alerts[0].text), solo.alerts[0].text);
}

console.log('\nhalf a pool is not a whole one');
{
  const h = monitor();
  const r = h.evaluate(T0 + 60 * MIN, {
    snapshot: healthy({ auxError: 'unreachable', auxUnavailableSince: T0 + 50 * MIN }),
  });
  check('the aux chain being down is raised', r.alerts.length === 1, JSON.stringify(r.alerts));
  check('as a warning, not a stoppage', r.level === 'warn', r.level);
  check('it says Litecoin mining continues',
    /Litecoin mining continues/.test(r.alerts[0].text), r.alerts[0].text);
  // Only in merged mode: a Dogecoin-only pool has no aux chain to lose, and a
  // stale auxError from a previous configuration must not haunt it.
  const solo = h.evaluate(T0 + 60 * MIN, {
    snapshot: healthy({ mergedMining: false, auxError: 'unreachable', auxUnavailableSince: T0 }),
  });
  check('and never in Dogecoin-only mode', solo.alerts.length === 0, JSON.stringify(solo.alerts));
}

console.log('\nthe wedge: no error, and no work either');
{
  const h = monitor();
  const r = h.evaluate(T0 + 60 * MIN, { snapshot: healthy({ templateAgeMs: 9 * MIN }) });
  check('a silent stall is an alarm', r.alerts.length === 1, JSON.stringify(r.alerts));
  check('keyed as stale', r.alerts[0].key === 'stale', r.alerts[0].key);
  check('it is a stoppage', r.level === 'down', r.level);
  check('it says the node is not complaining',
    /not reporting an error/.test(r.alerts[0].text), r.alerts[0].text);

  // With an error present this is the `parent` alert instead — one problem
  // reported once, not the same outage described twice.
  const both = h.evaluate(T0 + 60 * MIN, {
    snapshot: healthy({ templateAgeMs: 9 * MIN, templateError: 'x', templateFailedAt: T0 }),
  });
  check('an unreachable node is not also reported as a wedge',
    both.alerts.length === 1 && both.alerts[0].key === 'parent',
    both.alerts.map((a) => a.key).join(','));
}

console.log('\nworst wins');
{
  const h = monitor();
  const r = h.evaluate(T0 + 60 * MIN, {
    snapshot: healthy({
      templateError: 'x', templateFailedAt: T0,
      auxError: 'y', auxUnavailableSince: T0,
    }),
  });
  check('both chains are reported', r.alerts.length === 2, String(r.alerts.length));
  check('one down among warnings is down', r.level === 'down', r.level);
}

console.log('\nnotifying: once per episode, not once per tick');
{
  const h = monitor();
  const down = { snapshot: healthy({ templateError: 'x', templateFailedAt: T0 }) };
  const first = h.sample(T0 + 10 * MIN, down);
  check('the first tick of an outage notifies', !!first.notify, JSON.stringify(first.notify));
  check('as an alarm', first.notify.kind === 'alarm', first.notify.kind);

  let repeats = 0;
  // Two hours of ticks, every fifteen seconds, as the real watchdog runs.
  for (let t = 10 * MIN + 15000; t <= 130 * MIN; t += 15000) {
    if (h.sample(T0 + t, down).notify) repeats++;
  }
  // The text carries a duration that grows every single tick. Comparing texts
  // instead of keys would make every tick a new problem — 480 notifications in
  // those two hours, which is how you get a phone put face-down.
  check('and then goes quiet, apart from the six-hourly repeat',
    repeats === 0, `${repeats} extra notifications in two hours`);

  // Recovery is debounced exactly as the alarm is: the first healthy tick is
  // not an announcement, because a node that comes back for twenty seconds and
  // falls over again has not recovered.
  const first_ok = h.sample(T0 + 140 * MIN, { snapshot: healthy() });
  check('the first healthy tick is not yet a recovery', !first_ok.notify, JSON.stringify(first_ok.notify));
  const back = h.sample(T0 + 143 * MIN, { snapshot: healthy() });
  check('recovery is announced once it holds', !!back.notify && back.notify.kind === 'recovery',
    JSON.stringify(back.notify));
  const quiet = h.sample(T0 + 150 * MIN, { snapshot: healthy() });
  check('but only once', !quiet.notify, JSON.stringify(quiet.notify));
}

console.log('\na flapping node does not buzz the phone every cycle');
{
  // Down 3.5 minutes, up 30 seconds, over and over: an out-of-memory restart
  // loop, or a node thrashing on initial download. Without a debounce on the
  // recovery this produced an alarm AND a recovery per cycle — measured at
  // sixty pushes in two hours, which is how a phone ends up face-down.
  const h = monitor();
  const down = { snapshot: healthy({ templateError: 'x', templateFailedAt: T0 }) };
  const up = { snapshot: healthy() };
  let pushes = 0;
  let t = 0;
  // Two hours of the real fifteen second tick.
  for (let cycle = 0; cycle < 30; cycle++) {
    for (let i = 0; i < 14; i++, t += 15000) if (h.sample(T0 + 10 * MIN + t, down).notify) pushes++;
    for (let i = 0; i < 2; i++, t += 15000) if (h.sample(T0 + 10 * MIN + t, up).notify) pushes++;
  }
  check('one alarm, and no recovery for a node that never stays up',
    pushes === 1, `${pushes} pushes in two hours`);
}

console.log('\nthe pool that is running but cannot describe itself');
{
  // snapshot() threw. Reported as "never started" this sends the user to node
  // apps that are perfectly healthy, and it is also the one no-snapshot case
  // where restarting the process is the right answer.
  const h = monitor({ restartAfterMs: 15 * MIN });
  const r = h.evaluate(T0 + 60 * MIN, { snapshot: null, poolExists: true, uptimeMs: 60 * MIN });
  check('it is reported as a fault in the app', r.alerts.length === 1 && r.alerts[0].key === 'snapshot',
    JSON.stringify(r.alerts));
  check('not as a node that is down',
    !/node app/i.test(r.alerts[0].text) && /fault in the app/.test(r.alerts[0].text), r.alerts[0].text);
  check('and it is the one no-snapshot case worth restarting for',
    h.shouldRestart(T0 + 60 * MIN, { snapshot: null, poolExists: true, pending: 0, uptimeMs: 60 * MIN }) === true);
  check('while a pool that never started is not',
    h.shouldRestart(T0 + 60 * MIN, { snapshot: null, poolExists: false, pending: 0, uptimeMs: 60 * MIN }) === false);
}

console.log('\na clock that steps cannot manufacture or erase an outage');
{
  // The Umbrel has no real-time clock. umbrelOS restores an approximate time at
  // boot and NTP corrects it — by hours — with the apps already running. Every
  // age is therefore capped by the process uptime, which is monotonic.
  const h = monitor();

  // Forward step: the wall clock says three hours, the process has been up for
  // ninety seconds. The node is still legitimately loading its block index.
  const forward = h.evaluate(T0 + 3 * 60 * MIN, {
    startupError: 'connect ECONNREFUSED', snapshot: null, uptimeMs: 90 * 1000,
  });
  check('a forward clock step does not fire the startup alarm',
    forward.alerts.length === 0, JSON.stringify(forward.alerts));

  const staleByClock = h.evaluate(T0 + 3 * 60 * MIN, {
    snapshot: healthy({ templateAgeMs: 3 * 60 * MIN }), uptimeMs: 90 * 1000,
  });
  check('nor the stale-template alarm', staleByClock.alerts.length === 0, JSON.stringify(staleByClock.alerts));

  const staleReally = h.evaluate(T0 + 3 * 60 * MIN, {
    snapshot: healthy({ templateAgeMs: 9 * MIN }), uptimeMs: 60 * MIN,
  });
  check('but a real stall still fires', staleReally.alerts.length === 1, JSON.stringify(staleReally.alerts));

  // Backward step during an outage. The grace window reopens, so there are no
  // alerts — but that is "not yet", not "all clear", and announcing a recovery
  // here would be a lie about a pool that has never started.
  const h2 = monitor();
  h2.sample(T0 + 30 * MIN, { startupError: 'x', snapshot: null, uptimeMs: 30 * MIN });
  const stepped = h2.sample(T0 + 1 * MIN, { startupError: 'x', snapshot: null, uptimeMs: 60 * 1000 });
  check('a backward clock step does not announce a recovery',
    !stepped.notify, JSON.stringify(stepped.notify));
  check('and the standing alarm is not forgotten', h2.lastSignature === 'startup', h2.lastSignature);

  // The restart watchdog must not be reachable through the same door.
  const h3 = monitor({ restartAfterMs: 15 * MIN });
  check('a clock step cannot trigger a restart either',
    h3.shouldRestart(T0 + 3 * 60 * MIN, {
      snapshot: healthy({ templateAgeMs: 3 * 60 * MIN }), pending: 0, uptimeMs: 90 * 1000,
    }) === false);
}

console.log('\na standing alarm is repeated, rarely');
{
  const h = monitor({ repeatMs: 6 * 3600 * 1000 });
  const down = { snapshot: healthy({ templateError: 'x', templateFailedAt: T0 }) };
  h.sample(T0 + 10 * MIN, down);
  let repeats = 0;
  for (let t = 10 * MIN + MIN; t <= 10 * MIN + 25 * 3600 * 1000; t += MIN) {
    if (h.sample(T0 + t, down).notify) repeats++;
  }
  check('four times in a day, not fourteen hundred', repeats === 4, String(repeats));
}

console.log('\na changing problem is a new notification');
{
  const h = monitor();
  const parentDown = { snapshot: healthy({ templateError: 'x', templateFailedAt: T0 }) };
  h.sample(T0 + 10 * MIN, parentDown);
  const worse = h.sample(T0 + 11 * MIN, {
    snapshot: healthy({
      templateError: 'x', templateFailedAt: T0,
      auxError: 'y', auxUnavailableSince: T0,
    }),
  });
  check('the second chain going down is worth saying', !!worse.notify, JSON.stringify(worse.notify));
}

console.log('\nrestarting: narrow on purpose');
{
  const h = monitor({ restartAfterMs: 15 * MIN });
  const wedged = { snapshot: healthy({ templateAgeMs: 20 * MIN }), pending: 0 };
  check('a long silent stall restarts', h.shouldRestart(T0 + 60 * MIN, wedged) === true);

  check('a short one does not',
    h.shouldRestart(T0 + 60 * MIN, { snapshot: healthy({ templateAgeMs: 9 * MIN }), pending: 0 }) === false);

  // Restarting cannot reach a node app that is switched off, and a process
  // that exits every quarter hour during a real outage restart-loops all night
  // — re-arming its own alarm each time.
  check('an unreachable node never triggers a restart',
    h.shouldRestart(T0 + 60 * MIN, {
      snapshot: healthy({ templateAgeMs: 40 * MIN, templateError: 'x', templateFailedAt: T0 }),
      pending: 0,
    }) === false);

  // The one bug in this app that costs real money.
  check('never while a block submission is in flight',
    h.shouldRestart(T0 + 60 * MIN, { ...wedged, pending: 1 }) === false);

  check('never when there is no pool to restart',
    h.shouldRestart(T0 + 60 * MIN, { snapshot: null, pending: 0 }) === false);

  const off = monitor({ restartAfterMs: 0 });
  check('and never at all when it is switched off',
    off.shouldRestart(T0 + 60 * MIN, wedged) === false);

  // A process that exits before the alarm it is meant to follow would restart,
  // clear its own state and never tell anyone anything.
  const silly = monitor({ alarmAfterMs: 10 * MIN, restartAfterMs: MIN });
  check('the restart delay can never undercut the alarm',
    silly.restartAfterMs === 20 * MIN, String(silly.restartAfterMs / MIN));
}

console.log(failures === 0 ? '\nNODE ALARM VERIFIED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
