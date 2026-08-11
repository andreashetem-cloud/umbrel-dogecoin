'use strict';
//
// Durable statistics.
//
// A solo miner runs for years and finds a block on a timescale of decades. If
// the numbers reset every time the container restarts — an update, a reboot, a
// power cut — the dashboard can only ever describe the last few hours, which is
// the least interesting window there is. This module keeps the history on disk.
//
// Design rules, in order of importance:
//   1. Losing the file must never stop the app from mining. Every failure here
//      is logged and swallowed.
//   2. Never destroy history we cannot read. A corrupt file, or one written by
//      a newer version, is preserved and the store goes read-only rather than
//      overwriting years of records.
//   3. A write must never publish a half-written file: temp, fsync, rename.
//   4. Nothing grows without bound — not the file, not memory, not the log.
//

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;

// 48 hours of one-minute samples, then 180 days of hourly averages. Enough to
// see last night's dropout and last quarter's trend.
const MINUTE_SAMPLES = 48 * 60;
const HOUR_SAMPLES = 180 * 24;
const SHARE_LOG = 600;
const BLOCK_LOG = 50;
const WORKER_HISTORY = 50;
// How far back to look for an existing hourly bucket. A clock that steps
// backwards must not open a duplicate bucket for an hour we already have.
const BUCKET_LOOKBACK = 4;

function emptyState() {
  return {
    version: VERSION,
    firstStartedAt: null,
    accepted: 0,
    rejected: 0,
    rejectReasons: {},
    blocks: [],
    bestShareDiff: 0,
    bestShareAt: null,
    minuteSamples: [], // [tsSeconds, hashrate]
    hourSamples: [], // [hourTsSeconds, meanHashrate, count]
    shareLog: [], // [tsSeconds, shareDiff, stratumDifficulty]
    workers: {},
  };
}

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

class Store {
  constructor(filePath, log = () => {}) {
    this.path = filePath;
    this.rawLog = log;
    this.state = emptyState();
    this.dirty = false;
    this.writable = false;
    this.lastError = null;
    this.lastLoggedError = null;
    this.tmpPath = filePath ? `${filePath}.${process.pid}.tmp` : null;
  }

  log(msg) {
    this.rawLog(msg);
  }

  // Repeated identical failures are logged once. A volume that goes read-only
  // would otherwise write 2880 identical lines a day into a rotating log and
  // push out the block-recovery hex, which is the one line that matters.
  logError(msg) {
    if (msg === this.lastLoggedError) return;
    this.lastLoggedError = msg;
    this.rawLog(msg);
  }

  load() {
    if (!this.path) {
      this.log('no stats path configured; history will not survive a restart');
      this.state.firstStartedAt = Date.now();
      return this.state;
    }
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
    } catch {
      /* usually already exists; the probe below is what decides */
    }

    let parsed = null;
    let readError = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') readError = err;
    }

    if (readError) {
      // Unreadable, but not necessarily worthless. Keep it and start fresh.
      this.log(`stats file unreadable (${readError.message}); starting fresh`);
      this.preserve('corrupt');
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const version = Number(parsed.version);
      if (version === VERSION) {
        this.adopt(parsed);
      } else if (version > VERSION) {
        // A downgrade. Writing here would destroy a newer, richer file, so the
        // store stays read-only and says why. Mining is unaffected.
        this.log(
          `stats file was written by a newer version (${version}); running without ` +
            `persistence so it is not overwritten`
        );
        this.readOnlyReason = `file is version ${version}, this build understands ${VERSION}`;
      } else {
        // Note the explicit finite check: version 0 is a perfectly real value
        // and `|| 'unknown'` would rename the archive to the wrong name.
        const label = Number.isFinite(version) ? String(version) : 'unknown';
        this.log(`stats file has version ${label}; starting fresh`);
        this.preserve(`v${label}`);
      }
    }

    // Probe once, at startup, so a permissions problem is reported immediately
    // rather than discovered at the first save an hour later.
    if (this.readOnlyReason) {
      this.writable = false;
      this.lastError = this.readOnlyReason;
    } else {
      try {
        const probe = `${this.path}.probe`;
        fs.writeFileSync(probe, 'x');
        fs.unlinkSync(probe);
        this.writable = true;
      } catch (err) {
        this.writable = false;
        this.lastError = err.message;
        this.log(`WARNING: cannot write ${this.path} (${err.message}); statistics will reset on restart`);
      }
    }

    if (!this.state.firstStartedAt) this.state.firstStartedAt = Date.now();
    return this.state;
  }

  // Copy a file we are about to stop using, so nothing is ever lost silently.
  preserve(suffix) {
    try {
      const kept = `${this.path}.${suffix}`;
      fs.renameSync(this.path, kept);
      this.log(`the previous file was kept as ${kept}`);
    } catch {
      /* if we cannot even rename it, there is nothing further to try */
    }
  }

  // Type-coerce every field. A file that parses as JSON is not necessarily a
  // file with the right shapes in it, and `shareLog: {}` would otherwise throw
  // on the first share — which surfaces to miners as a 100% reject rate.
  adopt(parsed) {
    const s = emptyState();
    s.firstStartedAt = num(parsed.firstStartedAt, null) || null;
    s.accepted = Math.max(0, Math.floor(num(parsed.accepted)));
    s.rejected = Math.max(0, Math.floor(num(parsed.rejected)));
    s.bestShareDiff = Math.max(0, num(parsed.bestShareDiff));
    s.bestShareAt = num(parsed.bestShareAt, null) || null;

    for (const [k, v] of Object.entries(obj(parsed.rejectReasons))) {
      if (typeof k === 'string' && Number.isFinite(v)) s.rejectReasons[k.slice(0, 64)] = Math.floor(v);
    }
    s.blocks = arr(parsed.blocks).filter((b) => b && typeof b === 'object').slice(0, BLOCK_LOG);
    s.minuteSamples = arr(parsed.minuteSamples)
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .slice(-MINUTE_SAMPLES);
    s.hourSamples = arr(parsed.hourSamples)
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => [p[0], p[1], Number.isFinite(p[2]) ? p[2] : 1])
      .slice(-HOUR_SAMPLES);
    s.shareLog = arr(parsed.shareLog)
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .slice(-SHARE_LOG);
    for (const [name, w] of Object.entries(obj(parsed.workers))) {
      if (!w || typeof w !== 'object') continue;
      s.workers[String(name).slice(0, 64)] = {
        accepted: Math.max(0, Math.floor(num(w.accepted))),
        rejected: Math.max(0, Math.floor(num(w.rejected))),
        bestShareDiff: Math.max(0, num(w.bestShareDiff)),
        firstSeen: num(w.firstSeen, Date.now()),
        lastSeen: num(w.lastSeen, Date.now()),
        work: Math.max(0, num(w.work)),
      };
    }
    this.state = s;
    this.log(
      `restored history: ${s.accepted} shares, ${this.blocksFound()} block(s), ` +
        `best share ${Number(s.bestShareDiff || 0).toPrecision(4)}`
    );
  }

  // Derived, never stored as an independent counter. A process that dies
  // between recording a block and confirming it would otherwise leave the two
  // permanently out of step.
  blocksFound() {
    return this.state.blocks.filter((b) => b && b.accepted === true).length;
  }

  markDirty() {
    this.dirty = true;
  }

  save(force = false) {
    if (!this.path || !this.writable) return false;
    if (!this.dirty && !force) return false;
    try {
      const json = JSON.stringify(this.state);
      const fd = fs.openSync(this.tmpPath, 'w');
      try {
        fs.writeFileSync(fd, json);
        // Without the fsync a power cut can leave an empty file behind even
        // though the rename succeeded.
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(this.tmpPath, this.path);
      // Fsync the directory so the rename itself is durable, not just the
      // bytes it points at.
      try {
        const dirFd = fs.openSync(path.dirname(this.path), 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch { /* not supported everywhere; the data is already safe */ }
      this.dirty = false;
      this.lastError = null;
      this.lastLoggedError = null;
      return true;
    } catch (err) {
      this.lastError = err.message;
      this.logError(`could not save statistics: ${err.message}`);
      try { fs.unlinkSync(this.tmpPath); } catch { /* ignore */ }
      return false;
    }
  }

  // ---------------------------------------------------------------- recording

  recordShare(at, shareDiff, stratumDifficulty, workerName) {
    const s = this.state;
    s.accepted++;
    if (shareDiff > s.bestShareDiff) {
      s.bestShareDiff = shareDiff;
      s.bestShareAt = at;
    }
    s.shareLog.push([Math.round(at / 1000), shareDiff, stratumDifficulty]);
    while (s.shareLog.length > SHARE_LOG) s.shareLog.shift();

    const w = this.worker(workerName, at);
    w.accepted++;
    w.lastSeen = at;
    w.work += stratumDifficulty;
    if (shareDiff > w.bestShareDiff) w.bestShareDiff = shareDiff;

    this.trimWorkers();
    this.dirty = true;
  }

  recordReject(reason, workerName) {
    const s = this.state;
    s.rejected++;
    s.rejectReasons[reason] = (s.rejectReasons[reason] || 0) + 1;
    // Create the entry if it does not exist. A worker that produces nothing but
    // rejects — wrong algorithm, broken firmware — is exactly the one you need
    // to see in the table, and it would never appear if only shares created it.
    if (workerName) {
      const w = this.worker(workerName, Date.now());
      w.rejected++;
      w.lastSeen = Date.now();
      this.trimWorkers();
    }
    this.dirty = true;
  }

  worker(name, at) {
    const key = String(name || 'worker').slice(0, 64);
    if (!this.state.workers[key]) {
      this.state.workers[key] = {
        accepted: 0, rejected: 0, bestShareDiff: 0, firstSeen: at, lastSeen: at, work: 0,
      };
    }
    return this.state.workers[key];
  }

  // The caller keeps its own record with the block hex on it; the store must
  // NOT hold that. Fifty mainnet blocks of hex is tens of megabytes, and the
  // file is serialised synchronously on the event loop every time it is saved.
  recordBlock(record) {
    const s = this.state;
    const { blockHex, ...withoutHex } = record;
    s.blocks.unshift(withoutHex);
    while (s.blocks.length > BLOCK_LOG) s.blocks.pop();
    this.dirty = true;
    return withoutHex;
  }

  // Reflect a later status change (accepted / stale / rejected) onto the stored
  // copy, matched by hash so it works after a restart too.
  updateBlock(hash, fields) {
    const found = this.state.blocks.find((b) => b && b.hash === hash);
    if (!found) return false;
    Object.assign(found, fields);
    this.dirty = true;
    return true;
  }

  recordSample(at, hashrate) {
    const s = this.state;
    const ts = Math.round(at / 1000);

    // Refuse a sample that goes backwards. A machine without a real-time clock
    // steps its clock on every boot once NTP catches up, and a backwards step
    // would otherwise plant duplicate buckets and scramble the chart's x-axis.
    const lastMinute = s.minuteSamples[s.minuteSamples.length - 1];
    if (lastMinute && ts < lastMinute[0]) {
      this.logError(`ignoring a sample dated ${lastMinute[0] - ts}s before the previous one (clock step?)`);
      return;
    }

    s.minuteSamples.push([ts, Math.round(hashrate)]);
    while (s.minuteSamples.length > MINUTE_SAMPLES) s.minuteSamples.shift();

    const hour = Math.floor(ts / 3600) * 3600;
    // Look back a few buckets rather than only at the last one, so a sample
    // that lands slightly out of order still updates the right hour.
    let bucket = null;
    for (let i = s.hourSamples.length - 1; i >= 0 && i >= s.hourSamples.length - BUCKET_LOOKBACK; i--) {
      if (s.hourSamples[i][0] === hour) { bucket = s.hourSamples[i]; break; }
    }
    if (bucket) {
      bucket[2] = (bucket[2] || 1) + 1;
      bucket[1] = Math.round(bucket[1] + (hashrate - bucket[1]) / bucket[2]);
    } else {
      s.hourSamples.push([hour, Math.round(hashrate), 1]);
      s.hourSamples.sort((a, b) => a[0] - b[0]);
      while (s.hourSamples.length > HOUR_SAMPLES) s.hourSamples.shift();
    }
    this.dirty = true;
  }

  // Keep only the most recently seen workers, so a rotating cast of worker
  // names cannot grow the file forever.
  trimWorkers() {
    const names = Object.keys(this.state.workers);
    if (names.length <= WORKER_HISTORY) return;
    names
      .sort((a, b) => this.state.workers[b].lastSeen - this.state.workers[a].lastSeen)
      .slice(WORKER_HISTORY)
      .forEach((n) => delete this.state.workers[n]);
  }
}

module.exports = { Store, VERSION, MINUTE_SAMPLES, HOUR_SAMPLES, SHARE_LOG, BLOCK_LOG };
