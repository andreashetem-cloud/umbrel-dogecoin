'use strict';
//
// Web Push, so a block reaches the phone in your pocket rather than a browser
// tab you closed hours ago.
//
// Two decisions shape this file:
//
//   1. The pushes carry NO payload. RFC 8291 payload encryption means ECDH,
//      HKDF, AES-128-GCM and a padding scheme, all hand-rolled — a lot of
//      cryptography to get subtly wrong for the sake of putting a block height
//      in a notification. A payloadless push is a permitted, ordinary "tickle":
//      the service worker wakes up, fetches /api/status from its own origin and
//      builds the notification from live data. Same result, an order of
//      magnitude less to break, and the block details are current rather than
//      whatever was true at send time.
//
//   2. Nothing here can stop the pool. Every send is best-effort, every failure
//      is logged once, and a push service that is down or unreachable — the
//      normal case for an Umbrel with no internet — must never delay or fail a
//      block submission.
//
// The VAPID half is still real: an ES256 JWT signed with a keypair generated on
// this machine, which is what lets a push service accept a message for a
// subscription it holds. That part is small enough to implement exactly.
//

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_SUBSCRIPTIONS = 20;
// Push services reject a JWT valid for more than 24 hours. Twelve leaves room
// for a clock that is off without ever crossing the limit.
const JWT_TTL_SECONDS = 12 * 3600;
const SEND_TIMEOUT_MS = 15000;

// Literal private, loopback, link-local and unique-local addresses. Hostnames
// are not resolved here: a DNS answer can change between the check and the
// request, so this is a cheap filter for the obvious case rather than a
// guarantee. The real barrier is that a subscription can only be added by
// someone already past the app's own front door.
function isPrivateHost(hostname) {
  let h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  for (const suffix of ['.local', '.internal', '.localhost', '.lan', '.home.arpa', '.home', '.intranet']) {
    if (h === suffix.slice(1) || h.endsWith(suffix)) return true;
  }
  if (h === 'localhost') return true;
  // An IPv4-mapped IPv6 address reaches the same host as the IPv4 address it
  // contains: ::ffff:127.0.0.1 connects to 127.0.0.1. WHATWG URL normalises the
  // dotted form to hex (::ffff:7f00:1), so both are unwrapped here before the
  // IPv4 rules are applied — otherwise the whole check is bypassed by writing
  // the same address a different way.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    const a = parseInt(mapped[1], 16), b = parseInt(mapped[2], 16);
    h = `${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`;
  } else if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(h)) {
    h = h.slice('::ffff:'.length);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p.some((n) => n > 255)) return true;
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT, incl. Tailscale
    return false;
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd]/.test(h)) return true; // unique-local
    if (/^fe80/.test(h)) return true; // link-local
    return false;
  }
  return false;
}

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A P-256 public key in the uncompressed form push services expect: 0x04 || X || Y.
function rawPublicKey(keyObject) {
  const der = keyObject.export({ type: 'spki', format: 'der' });
  // The uncompressed point is the last 65 bytes of the SPKI structure.
  return der.subarray(der.length - 65);
}

// Never throws. Used only for a log line, and a log line must not be able to
// reject the promise that is notifying the user about a block.
function hostOf(endpoint) {
  try { return new URL(endpoint).host; } catch { return 'the push service'; }
}

class PushService {
  constructor(filePath, log = () => {}) {
    this.path = filePath;
    this.rawLog = log;
    this.subscriptions = [];
    this.keys = null;
    this.lastError = null;
    this.lastLoggedError = null;
    this.enabled = false;
  }

  log(msg) { this.rawLog(msg); }

  logOnce(msg) {
    if (msg === this.lastLoggedError) return;
    this.lastLoggedError = msg;
    this.rawLog(msg);
  }

  // Load or create the keypair and the subscription list. A missing or broken
  // file costs notifications, never mining, so every failure here is swallowed
  // after being logged.
  load() {
    if (!this.path) {
      this.log('no stats path configured; push notifications are unavailable');
      return false;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`push state unreadable (${err.message}); starting fresh`);
    }

    if (parsed && typeof parsed === 'object' && typeof parsed.privateKey === 'string') {
      try {
        this.keys = {
          privateKey: crypto.createPrivateKey({ key: parsed.privateKey, format: 'pem' }),
          publicKey: crypto.createPublicKey({ key: parsed.publicKey, format: 'pem' }),
        };
      } catch (err) {
        this.log(`stored push keys are unusable (${err.message}); generating a new pair`);
        this.keys = null;
      }
      if (Array.isArray(parsed.subscriptions)) {
        this.subscriptions = parsed.subscriptions
          .filter((s) => s && PushService.parseEndpoint(s.endpoint))
          .map((s) => ({ endpoint: s.endpoint.slice(0, 1024), addedAt: Number(s.addedAt) || Date.now() }))
          .slice(0, MAX_SUBSCRIPTIONS);
      }
    }

    if (!this.keys) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      this.keys = { privateKey, publicKey };
      // Regenerating the keys invalidates every existing subscription: a push
      // service checks that the message is signed by the same key the browser
      // subscribed with. Dropping them is honest; keeping them would leave
      // permanently silent entries that look enabled.
      if (this.subscriptions.length) {
        this.log('push keys were regenerated; existing subscriptions can no longer be delivered to');
        this.subscriptions = [];
      }
      if (!this.save()) {
        // Without a durable key there is nothing to enable: every restart would
        // mint a new keypair, and a browser's subscription is bound to the key
        // it subscribed with. The dashboard would keep saying "on" while no
        // notification could ever be delivered again. Better to say so.
        this.enabled = false;
        this.lastError = this.lastError || 'the data directory is not writable';
        this.log('notifications are unavailable: push keys cannot be saved');
        return false;
      }
    }
    this.enabled = true;
    return true;
  }

  save() {
    if (!this.path) return false;
    try {
      const body = JSON.stringify({
        privateKey: this.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        publicKey: this.keys.publicKey.export({ type: 'spki', format: 'pem' }),
        subscriptions: this.subscriptions,
      });
      // Same durability discipline as the statistics file: without the fsync a
      // power cut can leave a zero-length file behind even though the rename
      // succeeded — and this file holds the private key. Losing it silently
      // invalidates every phone's subscription, which the user only discovers
      // when a block comes and goes without a notification.
      const tmp = `${this.path}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.path);
      try {
        const dirFd = fs.openSync(path.dirname(this.path), 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch { /* not supported everywhere; the bytes are already safe */ }
      return true;
    } catch (err) {
      this.lastError = err.message;
      this.logOnce(`could not save push state: ${err.message}`);
      return false;
    }
  }

  publicKeyBase64() {
    if (!this.keys) return null;
    return b64url(rawPublicKey(this.keys.publicKey));
  }

  // Accept only what every later step can also handle. A regex alone is not
  // that test: "https://[" matches it and then throws inside new URL() on the
  // send path, which is a rejection in the middle of the block notification.
  // Parsing here means a stored endpoint is always parseable.
  static parseEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 1000 || /\s/.test(endpoint)) return null;
    let url;
    try { url = new URL(endpoint); } catch { return null; }
    if (url.protocol !== 'https:') return null;
    // Refuse anything that is obviously not a public push service. Without
    // this the endpoint is a request the app will make on demand to any
    // address reachable from the container — a scanner for whatever else is
    // on the home network, with the success/failure counts as its output.
    if (isPrivateHost(url.hostname)) return null;
    return url;
  }

  subscribe(endpoint) {
    if (!PushService.parseEndpoint(endpoint)) {
      return { ok: false, error: 'endpoint must be a public https URL' };
    }
    if (this.subscriptions.some((s) => s.endpoint === endpoint)) return { ok: true, already: true };
    if (this.subscriptions.length >= MAX_SUBSCRIPTIONS) {
      // Drop the oldest rather than refuse: a phone that reinstalled its
      // browser leaves a dead entry behind, and refusing forever because of
      // twenty of those would be the wrong failure.
      this.subscriptions.shift();
    }
    this.subscriptions.push({ endpoint, addedAt: Date.now() });
    // Report whether it reached disk. A subscription held only in memory is
    // lost on the next restart while the browser still believes it is
    // subscribed, and the dashboard needs to be able to say so.
    const persisted = this.save();
    return { ok: true, persisted };
  }

  unsubscribe(endpoint) {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.subscriptions.length !== before) this.save();
    return { ok: true, removed: before - this.subscriptions.length };
  }

  // The VAPID JWT: audience is the push service's origin, expiry is short, and
  // the subject identifies the sender. Signed ES256 — note the conversion from
  // the DER signature Node produces to the raw r||s form JWS requires.
  jwtFor(endpoint, nowSeconds) {
    const origin = new URL(endpoint).origin;
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const now = nowSeconds || Math.floor(Date.now() / 1000);
    const body = b64url(JSON.stringify({
      aud: origin,
      exp: now + JWT_TTL_SECONDS,
      // RFC 8292 allows either a mailto: or an https: subject. An https: URL is
      // used because there is no real mailbox behind this app, and a made-up
      // one — "mailto:...@localhost" — is rejected outright by Apple's push
      // service with BadJwtToken, which would mean an iPhone silently never
      // receives a block notification.
      sub: 'https://github.com/andreashetem-cloud/umbrel-dogecoin',
    }));
    const signature = crypto.sign(null, Buffer.from(`${header}.${body}`), {
      key: this.keys.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${header}.${body}.${b64url(signature)}`;
  }

  headersFor(endpoint) {
    return {
      TTL: '86400',
      // No payload, so no Content-Encoding and no body. Some services insist on
      // an explicit zero length for that case.
      'Content-Length': '0',
      Authorization: `vapid t=${this.jwtFor(endpoint)}, k=${this.publicKeyBase64()}`,
      Urgency: 'high',
    };
  }

  // Deliver to one endpoint. Returns {ok, status, gone} — `gone` means the
  // subscription is dead and should be forgotten, which is the only response
  // that changes stored state.
  async sendOne(endpoint, fetchImpl) {
    const doFetch = fetchImpl || globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: this.headersFor(endpoint),
        signal: controller.signal,
      });
      // 404 and 410 are the push service saying this subscription no longer
      // exists. Anything else — including a 5xx — may be transient and is left
      // alone rather than quietly unsubscribing the user's phone.
      const gone = res.status === 404 || res.status === 410;
      return { ok: res.status >= 200 && res.status < 300, status: res.status, gone };
    } catch (err) {
      return { ok: false, status: 0, gone: false, error: err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  // Wake every subscribed device. Never throws and never rejects: this is called
  // from the block path, and a block must be submitted whatever the internet is
  // doing.
  async notifyAll(reason, fetchImpl) {
    if (!this.enabled || !this.subscriptions.length) return { sent: 0, failed: 0, removed: 0 };
    const targets = this.subscriptions.map((s) => s.endpoint);
    let sent = 0, failed = 0;
    const dead = [];
    await Promise.all(targets.map(async (endpoint) => {
      const r = await this.sendOne(endpoint, fetchImpl);
      if (r.ok) sent++;
      else {
        failed++;
        if (r.gone) dead.push(endpoint);
        else this.logOnce(`push to ${hostOf(endpoint)} failed (${r.status || r.error})`);
      }
    }));
    if (dead.length) {
      this.subscriptions = this.subscriptions.filter((s) => !dead.includes(s.endpoint));
      this.save();
    }
    this.log(`push (${reason}): ${sent} delivered, ${failed} failed, ${dead.length} expired`);
    return { sent, failed, removed: dead.length };
  }
}

module.exports = { PushService, MAX_SUBSCRIPTIONS, b64url, rawPublicKey };
