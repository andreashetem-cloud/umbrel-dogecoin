'use strict';
//
// Runtime-editable settings — currently just the mining profile.
//
// Everything in docker-compose.yml and .env is fixed for the life of the
// container. This file exists so MINING_PROFILE can be flipped from the
// dashboard (home <-> rented) without an SSH session and without restarting
// the process — see server.js's applyMiningProfile(), which is what actually
// pushes a change into the live Pool. This module only persists the choice
// across restarts and app updates, the same role .env plays for the settings
// that still require one.
//
// Same durability rules as store.js, deliberately: losing this file must
// never stop the app from mining — it falls back to whatever the environment
// already picked — and a write must never leave a half-written file behind.

const fs = require('node:fs');
const path = require('node:path');

const VALID_PROFILES = new Set(['home', 'rented']);

class Settings {
  constructor(filePath, log) {
    this.path = filePath || null;
    this.log = log || (() => {});
    this.tmpPath = this.path ? `${this.path}.tmp` : null;
    this.writable = false;
    this.lastError = null;
  }

  // Returns the persisted profile name, or null if there is none, the file is
  // unreadable, or it names something this build does not recognise. Also
  // probes whether the file is writable, so a save later does not have to
  // discover a permissions problem on the request that triggered it.
  load() {
    if (!this.path) return null;
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
    } catch {
      /* usually already exists */
    }

    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log(`settings file unreadable (${err.message}); ignoring it`);
      }
    }

    try {
      const probe = `${this.path}.probe`;
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
      this.writable = true;
    } catch (err) {
      this.writable = false;
      this.lastError = err.message;
      this.log(
        `WARNING: cannot write ${this.path} (${err.message}); a profile ` +
          'change from the dashboard will not survive a restart'
      );
    }

    if (parsed && typeof parsed === 'object' && VALID_PROFILES.has(parsed.miningProfile)) {
      return parsed.miningProfile;
    }
    return null;
  }

  // temp, fsync, rename — same three-step publish store.js uses, so a crash
  // mid-write leaves either the old file or the new one, never a truncated
  // one.
  saveProfile(name) {
    if (!this.path || !this.writable) return false;
    try {
      const json = JSON.stringify({ miningProfile: name, savedAt: new Date().toISOString() });
      const fd = fs.openSync(this.tmpPath, 'w');
      try {
        fs.writeFileSync(fd, json);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(this.tmpPath, this.path);
      try {
        const dirFd = fs.openSync(path.dirname(this.path), 'r');
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        /* not supported everywhere; the data is already safe */
      }
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = err.message;
      this.log(`could not save settings: ${err.message}`);
      return false;
    }
  }
}

module.exports = { Settings, VALID_PROFILES };
