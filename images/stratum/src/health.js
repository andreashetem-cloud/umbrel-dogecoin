'use strict';
//
// Is this pool actually mining?
//
// The app used to answer that question with "my web server is up". After an
// umbrelOS restart both node apps stayed down, the stratum server kept serving
// a perfectly green dashboard on :3000, its healthcheck kept passing, and
// thirteen hours went by with nothing mined and nothing said. Everything in
// this file exists because of those thirteen hours.
//
// The rules are deliberately kept away from the pool and away from the HTTP
// server, for one reason: the worst case is the one where THERE IS NO POOL.
// When dogecoind is unreachable at startup, startMerged() refuses to start —
// on purpose, see pool.js — and server.js retries forever. A monitor that
// lived inside Pool would never run in exactly the situation that cost the
// thirteen hours. So this takes a plain description of the world, including
// "the pool never started", and decides from that alone.
//
// Two functions, split on purpose:
//
//   evaluate()  pure. Same input, same answer, no bookkeeping. The HTTP
//               handlers call this on every request.
//   sample()    evaluate() plus the decision to notify, which is stateful
//               (notify once per episode, repeat rarely, announce recovery).
//               Exactly one caller: the watchdog timer.
//

const OK = 'ok';
const WARN = 'warn';
const DOWN = 'down';

// How long a condition must hold before it is worth waking somebody. Three
// minutes is chosen against Dogecoin's one-minute block interval: a node that
// misses a single template, or a restart that takes a moment, must not buzz a
// phone, while a node that is genuinely gone is caught long before it costs a
// night.
const DEFAULT_ALARM_AFTER_MS = 180000;
// A standing alarm is repeated this rarely. The first notification is the one
// that matters; this exists so a phone that was face-down in a drawer for a day
// still gets told, without turning a week-long outage into a week of buzzing.
const DEFAULT_REPEAT_MS = 6 * 3600 * 1000;
// Grace after this process starts before "the pool has not started" is treated
// as an alarm. umbrelOS starts every app at once and a Dogecoin node loading
// its block index from an SD card is legitimately unreachable for minutes;
// alarming inside that window would train the user to ignore the alarm.
const DEFAULT_STARTUP_GRACE_MS = 300000;

class HealthMonitor {
  constructor({
    alarmAfterMs = DEFAULT_ALARM_AFTER_MS,
    repeatMs = DEFAULT_REPEAT_MS,
    startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
    restartAfterMs = 0,
    startedAt = Date.now(),
  } = {}) {
    // Values are taken as given. Bounding what a person may type into .env is
    // the caller's job — see server.js, where the environment is parsed — and
    // doing it in both places means two floors that can disagree about what is
    // sane. What is enforced here is only the fallback for a value that is not
    // a usable number at all.
    this.alarmAfterMs = positive(alarmAfterMs, DEFAULT_ALARM_AFTER_MS);
    this.repeatMs = Math.max(0, Number(repeatMs) || 0);
    this.startupGraceMs = Math.max(0, Number(startupGraceMs) || 0);
    // 0 disables the restart entirely. Everything else is floored at twice the
    // alarm threshold — not as input validation but as an invariant of this
    // state machine: a process that exits before the alarm it is supposed to
    // follow would restart, clear its own alarm state, and never tell anyone
    // anything.
    const restart = Number(restartAfterMs) || 0;
    this.restartAfterMs = restart > 0 ? Math.max(restart, this.alarmAfterMs * 2) : 0;
    this.startedAt = startedAt;
    this.lastSignature = '';
    this.lastNotifiedAt = 0;
    // When the pool last became healthy, or null. Only used to debounce the
    // recovery message; see sample().
    this.healthySince = null;
  }

  /**
   * What is wrong right now, if anything.
   *
   * @param {number} now
   * @param {object} input
   * @param {string|null} input.startupError  set while the pool has never started
   * @param {object|null} input.snapshot      pool.snapshot(), or null
   * @returns {{level: string, alerts: Array, signature: string}}
   */
  evaluate(now, input = {}) {
    const alerts = [];
    const snap = input.snapshot || null;
    const startupError = input.startupError || null;
    // How long this process has been running, from a clock that cannot step.
    //
    // Every duration below is otherwise a difference of two Date.now() values,
    // and on an Umbrel that is not a safe assumption: the machine has no
    // real-time clock, umbrelOS restores an approximate time at boot and NTP
    // corrects it — by hours — minutes later, with the apps already running.
    // A forward step would make a node that has been unreachable for ninety
    // seconds look unreachable for three hours and fire a false alarm during
    // the exact window a node legitimately takes to load its block index.
    //
    // Nothing here can be older than this process, so uptime is a ceiling on
    // every age, and it comes from a monotonic source.
    const uptimeMs = Number.isFinite(input.uptimeMs) ? input.uptimeMs : Infinity;
    // Negative is a backwards step; clamp rather than let it read as "fine".
    const aged = (ms) => Math.min(Math.max(0, ms), uptimeMs);

    if (!snap) {
      // Two very different situations reach here.
      if (input.poolExists) {
        // A pool exists but would not describe itself: snapshot() threw. Saying
        // "the pool never started" would send the user to node apps that are
        // perfectly healthy — and it is also the one failure an in-process
        // restart can genuinely fix, so it must not be reported as the case
        // where restarting is pointless.
        alerts.push({
          key: 'snapshot',
          level: DOWN,
          since: now - aged(uptimeMs),
          text:
            'The pool is running but cannot report its own status, so whether it is mining ' +
            'cannot be established. This is a fault in the app rather than in a node.',
        });
        return finish(alerts);
      }
      // No pool. Either it is still coming up — normal for the first minutes
      // after a reboot — or it cannot come up at all, which is the thirteen
      // hour case and the single most important thing this file detects.
      const waiting = aged(now - this.startedAt);
      if (waiting >= this.startupGraceMs) {
        alerts.push({
          key: 'startup',
          level: DOWN,
          since: now - waiting,
          text:
            `The pool has not been able to start for ${describeAge(waiting)}` +
            (startupError ? `: ${startupError}` : '') +
            '. Nothing is being mined.',
        });
        return finish(alerts);
      }
      // Silent, but NOT healthy: the grace has simply not run out. sample()
      // needs to know the difference, or a clock that steps backwards during an
      // outage would announce a recovery that never happened.
      return finish(alerts, true);
    }

    // Which node the template comes from. In merged mode the parent chain is
    // Litecoin and it is the one being hashed; saying "Dogecoin node" there
    // would send the user to the wrong app.
    const parent = snap.mergedMining ? 'Litecoin' : 'Dogecoin';

    if (snap.templateError) {
      // Measured from the pool's own record of when it started failing, not
      // from when this monitor first noticed. A single failed poll between two
      // good ones is not an outage and must not become one.
      const since = Number(snap.templateFailedAt) || now;
      const failedFor = aged(now - since);
      if (failedFor >= this.alarmAfterMs) {
        alerts.push({
          key: 'parent',
          level: DOWN,
          since: now - failedFor,
          // Two very different failures, and the wording has to match, or the
          // alarm sends someone to restart a node app that is answering
          // perfectly well.
          text: snap.templateErrorKind === 'unusable'
            ? `For ${describeAge(failedFor)} the ${parent} node's block templates could not be ` +
              `turned into work for the miners (${snap.templateError}). Nothing is being mined.`
            : `The ${parent} node has been unreachable for ${describeAge(failedFor)} ` +
              `(${snap.templateError}). Nothing is being mined.`,
        });
      }
    } else if (Number.isFinite(snap.templateAgeMs) && aged(snap.templateAgeMs) >= this.alarmAfterMs) {
      // Nothing is reporting an error and yet no work has arrived. This is the
      // wedge: a poll that never settled, a longpoll loop that stopped looping.
      // It is the only failure here that restarting the process can fix, and
      // the only one shouldRestart() acts on.
      const staleFor = aged(snap.templateAgeMs);
      alerts.push({
        key: 'stale',
        level: DOWN,
        since: now - staleFor,
        text:
          `No new block template has arrived for ${describeAge(staleFor)}, ` +
          `although the ${parent} node is not reporting an error. Miners are working on stale work.`,
      });
    }

    // The aux chain half-down. Litecoin keeps being mined, so this is not
    // "nothing is happening" — but every Dogecoin block found in this state is
    // refused, and Dogecoin is what this app is for.
    if (snap.mergedMining && snap.auxError) {
      const since = Number(snap.auxUnavailableSince) || now;
      const goneFor = aged(now - since);
      if (goneFor >= this.alarmAfterMs) {
        alerts.push({
          key: 'aux',
          level: WARN,
          since: now - goneFor,
          text:
            `The Dogecoin node has been unreachable for ${describeAge(goneFor)}. ` +
            'Litecoin mining continues; any Dogecoin block found now would be refused.',
        });
      }
    }

    return finish(alerts);
  }

  /**
   * evaluate(), plus the one stateful decision: does this deserve a push?
   *
   * Notifies when the set of problems CHANGES, not on every tick — and once
   * more every repeatMs while a problem stands, so a phone that was away still
   * learns about it. Recovery is announced too: an alarm you are never told
   * ended is an alarm you stop trusting.
   */
  sample(now, input = {}) {
    const report = this.evaluate(now, input);
    let notify = null;

    if (report.signature) {
      const changed = report.signature !== this.lastSignature;
      const due = this.repeatMs > 0 && now - this.lastNotifiedAt >= this.repeatMs;
      if (changed || due) {
        notify = {
          kind: 'alarm',
          level: report.level,
          text: report.alerts.map((a) => a.text).join(' '),
        };
        this.lastNotifiedAt = now;
      }
      this.healthySince = null;
    } else if (report.pending) {
      // No alerts, but only because a grace period has not run out. This is not
      // recovery and must not be announced as such — a clock that steps
      // backwards mid-outage lands here, and "mining is running again" while
      // nothing is running is worse than silence.
      //
      // Returned early, deliberately: falling through to the bottom would
      // overwrite lastSignature with the empty one and forget the alarm that is
      // still standing, so the next tick would announce it all over again.
      this.healthySince = null;
      return { ...report, notify: null };
    } else if (this.lastSignature || this.healthySince !== null) {
      // Recovery is debounced exactly as the alarm is.
      //
      // Without this, a node that restarts in a loop — out of memory, thrashing
      // on initial download — alarms and recovers on every cycle. At a fifteen
      // second tick and a three minute threshold that is roughly thirty pushes
      // an hour, which is how a phone ends up face-down. "Recovered" has to
      // mean it stayed recovered.
      if (this.healthySince === null) this.healthySince = now;
      if (now - this.healthySince >= this.alarmAfterMs) {
        notify = { kind: 'recovery', level: OK, text: 'Mining is running again.' };
        this.lastNotifiedAt = 0;
        this.healthySince = null;
        this.lastSignature = '';
        return { ...report, notify };
      }
      // Still inside the debounce: keep remembering that an alarm is standing,
      // so a node that flaps back down does not read as a brand new problem.
      return { ...report, notify: null };
    }

    this.lastSignature = report.signature;
    return { ...report, notify };
  }

  /**
   * Should this process exit so the container's `restart: on-failure` gives us
   * a clean one?
   *
   * Deliberately narrow, on three grounds that are each worth stating:
   *
   *   * Only for the `stale` alert. Docker does NOT restart a container because
   *     its healthcheck fails — restart policies react to the container
   *     EXITING, and health-based replacement exists only in Swarm. So a
   *     failing healthcheck alone changes nothing and exiting is the only way
   *     to get a restart at all.
   *   * Never when the node is reporting an error. Restarting cannot reach a
   *     node app that is switched off, and a process that exits every quarter
   *     of an hour during a real outage would restart-loop for as long as the
   *     outage lasts — re-arming the alarm each time and buzzing the phone all
   *     night. server.js already retries a failed start forever, quietly.
   *   * Never with work in flight. `pending` counts block submissions, whose
   *     retry schedule runs to about two minutes. Exiting there is the one bug
   *     in this app that costs real money.
   */
  shouldRestart(now, input = {}) {
    if (!this.restartAfterMs) return false;
    if ((input.pending || 0) > 0) return false;
    const uptimeMs = Number.isFinite(input.uptimeMs) ? input.uptimeMs : Infinity;
    // A restart cannot help before this process has even been up that long,
    // and a clock step must not be able to manufacture the condition.
    if (uptimeMs < this.restartAfterMs) return false;
    const snap = input.snapshot;
    if (!snap) {
      // A pool that exists but cannot describe itself is the one no-snapshot
      // case where a clean process would plausibly help. A pool that never
      // started is not: server.js is already retrying it, quietly, forever.
      return !!input.poolExists;
    }
    if (snap.templateError) return false;
    if (!Number.isFinite(snap.templateAgeMs)) return false;
    return Math.min(snap.templateAgeMs, uptimeMs) >= this.restartAfterMs;
  }
}

function positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function finish(alerts, pending = false) {
  // Worst wins: one DOWN among warnings is still down.
  const level = alerts.some((a) => a.level === DOWN)
    ? DOWN
    : alerts.length
      ? WARN
      : OK;
  // The signature is what "has anything changed?" is decided on. Keys only —
  // the texts carry a duration that grows every tick, and comparing those
  // would make every single tick look like a new problem and notify forever.
  const signature = alerts.map((a) => a.key).sort().join(',');
  // `pending` means "nothing to report YET" rather than "nothing wrong": a
  // grace period that has not run out. The difference only matters to the
  // recovery message, which must not fire for a problem that was never
  // announced in the first place.
  return { level, alerts, signature, pending };
}

function describeAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h} hours`;
}

module.exports = {
  HealthMonitor,
  describeAge,
  OK,
  WARN,
  DOWN,
  DEFAULT_ALARM_AFTER_MS,
  DEFAULT_REPEAT_MS,
  DEFAULT_STARTUP_GRACE_MS,
};
