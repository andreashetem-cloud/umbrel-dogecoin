'use strict';
//
// Entry point: starts the solo pool and serves the dashboard + Umbrel widgets.
//
// Zero dependencies, same as the node's dashboard app. Everything the browser
// needs is served from this process.
//

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Pool } = require('./pool');
const { Store } = require('./store');
const { PushService } = require('./push');

const PORT = Number(process.env.PORT || 3000);
const STRATUM_PORT = Number(process.env.STRATUM_PORT || 3333);

// Two very different machines point at this pool, and one set of numbers cannot
// serve both.
//
// A home miner does tens of megahashes. A rented order does tens of GIGAhashes
// — three to four orders of magnitude more — and every limit that protects the
// app from a stranger becomes the thing that refuses the hashpower you paid for.
// At the home defaults a 100 GH/s order starts by submitting roughly 750 shares
// a second, trips the flood limit, and is disconnected before vardiff has had a
// chance to raise its difficulty. The order shows as failing and the money is
// spent either way.
//
// So the profile is one setting rather than a dozen. Anything set explicitly in
// the environment still wins over the profile — see num() below.
const PROFILES = {
  home: {},
  rented: {
    // Start where a rented order belongs: one share every few seconds, not
    // hundreds a second. Vardiff still tunes from here.
    START_DIFFICULTY: 1048576,
    // A brief dip in delivered hashrate must not drop it back into the flood.
    MIN_DIFFICULTY: 65536,
    // The home ceiling silently pins a large order at four times the intended
    // share rate.
    MAX_DIFFICULTY: 268435456,
    // Headroom for the first seconds, before vardiff has settled.
    MAX_MESSAGES_PER_10S: 1000,
    // An order arrives as many connections from a handful of the provider's own
    // addresses, so the per-IP cap is what would lock it out.
    MAX_CONNECTIONS: 256,
    MAX_CONNECTIONS_PER_IP: 256,
    // Their aggregator applies a difficulty change slowly, and work handed out
    // before it lands must still be accepted.
    DIFFICULTY_GRACE_SECONDS: 120,
    // A connection at high difficulty is legitimately quiet for minutes.
    SOCKET_TIMEOUT_SECONDS: 1800,
    PING_INTERVAL_SECONDS: 300,
    // With the payout locked there is no reason to build coinbase variants.
    MAX_PAYOUT_VARIANTS: 1,
  },
};

const PROFILE_NAME = (process.env.MINING_PROFILE || 'home').trim().toLowerCase();
const PROFILE = PROFILES[PROFILE_NAME] || {};
if (!PROFILES[PROFILE_NAME]) {
  console.error(`[config] unknown MINING_PROFILE "${PROFILE_NAME}"; using the home profile`);
}

function num(name, fallback) {
  const raw = process.env[name];
  // An explicit value always beats the profile, which always beats the default.
  if (raw === undefined || raw === '') {
    return Object.prototype.hasOwnProperty.call(PROFILE, name) ? PROFILE[name] : fallback;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    console.error(`[config] ${name}="${raw}" is not a number; using ${fallback}`);
    return fallback;
  }
  return v;
}

const config = {
  rpc: {
    host: process.env.RPC_HOST || '127.0.0.1',
    port: num('RPC_PORT', 22555),
    user: process.env.RPC_USER || 'umbrel',
    password: process.env.RPC_PASSWORD || '',
  },
  payoutAddress: (process.env.PAYOUT_ADDRESS || '').trim(),

  // --- merged mining ------------------------------------------------------
  // Off unless MERGED_MINING=1. With it on, miners hash LITECOIN headers that
  // carry a commitment to a Dogecoin block, and one share can win on both
  // chains — see auxpow.js. It needs a second node and a second payout
  // address, on the second chain, and refuses to start without them.
  mergedMining: process.env.MERGED_MINING === '1',
  ltcRpc: {
    host: process.env.LTC_RPC_HOST || '127.0.0.1',
    port: num('LTC_RPC_PORT', 9332),
    user: process.env.LTC_RPC_USER || 'umbrel',
    password: process.env.LTC_RPC_PASSWORD || '',
  },
  // A LITECOIN address. Validated against Litecoin's version bytes at startup:
  // a Dogecoin address here decodes perfectly well and would silently pay a
  // hash160 nobody on Litecoin can spend.
  ltcPayoutAddress: (process.env.LTC_PAYOUT_ADDRESS || '').trim(),

  stratumPort: STRATUM_PORT,
  // Stratum-space difficulties (scrypt, so one share costs D * 2^16 hashes).
  // 2048 lands a 11 MH/s miner at ~12s per share and a 70 MH/s miner at ~2s,
  // from where vardiff climbs within seconds.
  startDifficulty: num('START_DIFFICULTY', 2048),
  minDifficulty: num('MIN_DIFFICULTY', 64),
  maxDifficulty: num('MAX_DIFFICULTY', 4194304),
  targetShareSeconds: num('TARGET_SHARE_SECONDS', 12),
  vardiffWindow: num('VARDIFF_WINDOW', 10),
  hashrateWindowMs: num('HASHRATE_WINDOW_SECONDS', 600) * 1000,
  // Two seconds, matching the compose default: in merged mode this poll is the
  // ONLY way a new Dogecoin tip is noticed — createauxblock has no longpoll —
  // so the interval is the average amount of doomed Dogecoin hashing per block.
  //
  // Floored at half a second. The value is settable from a hand-edited .env,
  // and 0 would turn setInterval into a ~1ms loop: an unbounded
  // getblocktemplate flood against the very node whose RPC threads everything
  // else here is careful to protect.
  pollIntervalMs: Math.max(0.5, num('POLL_INTERVAL_SECONDS', 2)) * 1000,
  jobRebuildMs: num('JOB_REBUILD_SECONDS', 30) * 1000,
  socketTimeoutMs: num('SOCKET_TIMEOUT_SECONDS', 900) * 1000,
  coinbaseTag: process.env.COINBASE_TAG || '/umbrel-doge-solo/',

  // --- limits -------------------------------------------------------------
  // Stratum is unauthenticated by design, so every unbounded resource is a
  // denial-of-service path for anyone who can reach the port.
  maxConnections: num('MAX_CONNECTIONS', 64),
  maxConnectionsPerIp: num('MAX_CONNECTIONS_PER_IP', 8),
  maxMessagesPer10s: num('MAX_MESSAGES_PER_10S', 300),
  maxPayoutVariants: num('MAX_PAYOUT_VARIANTS', 16),
  minLongpollIntervalMs: num('MIN_LONGPOLL_INTERVAL_MS', 250),
  handshakeTimeoutMs: num('HANDSHAKE_TIMEOUT_SECONDS', 30) * 1000,
  difficultyGraceMs: num('DIFFICULTY_GRACE_SECONDS', 60) * 1000,
  pingIntervalMs: num('PING_INTERVAL_SECONDS', 60) * 1000,
  lockPayoutAddress: process.env.LOCK_PAYOUT_ADDRESS === '1',
  profile: PROFILE_NAME in PROFILES ? PROFILE_NAME : 'home',
};

// A safety interlock, not a warning.
//
// The rented profile exists for one situation: the stratum port is reachable
// from the internet. On that port there is no authentication and no way to tell
// a paying customer from anyone else, and with the payout unlocked a stranger
// simply puts their own address in the username and your node's next block pays
// them. That is not a hypothetical — it was demonstrated against this app
// during review. Refusing to start is the only response that cannot be missed
// at two in the morning.
if (config.profile === 'rented' && !config.lockPayoutAddress) {
  console.error(
    '[config] MINING_PROFILE=rented is meant for a stratum port that is reachable from ' +
      'the internet, where anyone can mine to their own address unless the payout is locked. ' +
      'Set LOCK_PAYOUT_ADDRESS=1, or switch back to MINING_PROFILE=home.'
  );
  process.exit(1);
}

// A way to read the effective configuration without starting anything. The
// profile is only useful if it actually reaches the pool, and asserting that
// from outside the process is the only test that proves it.
if (process.env.DUMP_CONFIG === '1') {
  // ltcRpc goes the same way as rpc: it carries a password.
  const { rpc, payoutAddress, ltcRpc, ltcPayoutAddress, ...safe } = config;
  console.log(`CONFIG ${JSON.stringify(safe)}`);
  process.exit(0);
}

// Half an hour of minute samples before a per-worker average is used to judge
// anything. Below that it is a measure of how long the worker has been back,
// not of how it normally performs.
const MIN_SAMPLES_FOR_AVERAGE = 30;

const SYNC_REFRESH = '10s';
const STATS_REFRESH = '10s';

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const SERVICE_WORKER = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
const ICON_PNG = fs.readFileSync(path.join(__dirname, 'icon-192.png'));

let pool = null;
let startupError = null;

// STATS_PATH empty disables persistence entirely, which is what the test
// suites want: they must not write to the developer's disk.
const store = new Store(
  process.env.STATS_PATH === '' ? null : process.env.STATS_PATH || '/data/stats.json',
  (msg) => console.log(`[store] ${msg}`)
);
store.load();

// Push state lives beside the statistics but in its own file: it holds a
// private key, it is written on a different schedule, and a corrupt stats file
// must not cost the user their notification subscriptions or vice versa.
const push = new PushService(
  store.path ? path.join(path.dirname(store.path), 'push.json') : null,
  (msg) => console.log(`[push] ${msg}`)
);
push.load();

// Is this POST from our own page, or from some other site the user happens to
// have open?
//
// It matters because Umbrel's proxy authenticates with a cookie, which the
// browser attaches to cross-site requests as well. Without this check any page
// the user visits could register ITS push endpoint with this app and be told
// the moment a block is found, or evict the user's own phone from the list.
//
// Two independent gates, because browsers vary in what they send:
//   - Sec-Fetch-Site must be same-origin (Chrome, Firefox, Safari all send it,
//     and a page cannot forge it).
//   - Origin, when present, must match the Host header.
// A request with neither header is not a browser form post at all; requiring
// the JSON content type stops it from being a CORS "simple request".
function sameOriginPost(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  // Sec-Fetch-Site: same-origin is conclusive on its own — a page cannot forge
  // it. Checking Origin against Host as well would break any deployment whose
  // reverse proxy rewrites the Host header (nginx does by default), turning
  // notifications into a blanket 403 with nothing in the log to explain it.
  if (site !== 'same-origin') {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const host = new URL(origin).host;
        // x-forwarded-host is what a proxy that rewrites Host leaves behind.
        const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
        if (host !== req.headers.host && host !== forwarded) return false;
      } catch { return false; }
    }
  }
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

async function handlePushPost(req, res, pathname) {
  const reply = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!sameOriginPost(req)) {
    // Drain nothing and answer immediately; there is no reason to read a body
    // we have already decided not to act on.
    return reply(403, { ok: false, error: 'cross-site request refused' });
  }
  if (!push.enabled) return reply(503, { ok: false, error: 'notifications are unavailable' });

  const body = await readJsonBody(req);
  if (!body) return reply(400, { ok: false, error: 'expected a small JSON object' });

  if (pathname === '/api/push/test') {
    const result = await push.notifyAll('test');
    return reply(200, { ok: true, ...result });
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : null;
  if (pathname === '/api/push/unsubscribe') {
    return reply(200, push.unsubscribe(endpoint));
  }
  const result = push.subscribe(endpoint);
  return reply(result.ok ? 200 : 400, { ...result, subscriptions: push.subscriptions.length });
}

function fmtHashrate(h) {
  if (!h) return { value: '0', unit: 'H/s' };
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let i = 0;
  let v = h;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return { value: v >= 100 ? v.toFixed(0) : v.toFixed(2), unit: units[i] };
}

function snapshotOrNull() {
  try {
    return pool ? pool.snapshot() : null;
  } catch {
    return null;
  }
}

// Reads a small JSON body. Bounded before anything is parsed: this is the only
// endpoint that accepts input from a browser, and an unbounded read is a way to
// exhaust the process's memory with a single request.
const MAX_BODY_BYTES = 4096;
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Destroy rather than merely stop reading, so the sender cannot hold
        // the connection open streaming into a socket we are ignoring.
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer((req, res) => {
  // llhttp accepts an absolute-form request target, so req.url can be a string
  // new URL() rejects — "GET http://[ HTTP/1.1" is enough. Unguarded, that is
  // an uncaught exception in the request handler, which this process answers by
  // exiting. Any device on the home network could therefore kill the app in the
  // middle of submitting a block.
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad request target');
    return;
  }

  // The dashboard sits behind Umbrel's authenticating proxy, but defence in
  // depth costs nothing here. POST is allowed only for the notification
  // endpoints, which need it to receive a subscription.
  const PUSH_POST_PATHS = new Set(['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/test']);
  if (req.method === 'POST' && PUSH_POST_PATHS.has(url.pathname)) {
    // A rejection here would leave the request hanging open forever and, with
    // no handler, take the process down as an unhandled rejection.
    handlePushPost(req, res, url.pathname).catch((err) => {
      console.error('[push]', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal error' }));
      } else {
        res.end();
      }
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    const healthy = pool !== null && !startupError;
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: healthy, error: startupError }));
    return;
  }

  // History is served separately from status: it is far larger and changes far
  // more slowly, so the dashboard polls it every 30 seconds instead of every 5.
  if (url.pathname === '/api/history') {
    const s = store.state;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        ok: true,
        persistent: store.writable,
        storeError: store.lastError,
        firstStartedAt: s.firstStartedAt,
        minuteSamples: s.minuteSamples,
        hourSamples: s.hourSamples.map(([ts, hr]) => [ts, hr]),
        shareLog: s.shareLog,
        // Without the per-worker sample series. Two workers with a day of
        // minutes each is ~60 kB, and this endpoint is polled every 30
        // seconds — on a phone over mobile data that is the whole budget for
        // a chart nobody has opened. The series is fetched per worker from
        // /api/worker when the detail panel is actually shown.
        workers: Object.fromEntries(
          Object.entries(s.workers).map(([name, w]) => {
            const { samples, ...rest } = w;
            const list = Array.isArray(samples) ? samples : [];
            // The one number the summary view needs from the series: this
            // worker's own 24-hour mean, which is what "it is running at half
            // its normal rate" is measured against. Computed here so the
            // series itself does not have to travel.
            // Windowed by timestamp and suppressed until there is enough of it.
            // The health badge compares live hashrate against this and says
            // "N% of its own 24h average"; the mean of three ramp-up samples
            // is not a 24-hour average and would make that warning fire on a
            // miner that just reconnected.
            const dayAgo = Math.round(Date.now() / 1000) - 86400;
            const recent = list.filter((p) => p[0] >= dayAgo);
            const avg24h = recent.length >= MIN_SAMPLES_FOR_AVERAGE
              ? Math.round(recent.reduce((sum, p) => sum + p[1], 0) / recent.length)
              : 0;
            return [name, { ...rest, sampleCount: list.length, avg24h }];
          })
        ),
        lifetime: {
          accepted: s.accepted,
          rejected: s.rejected,
          rejectReasons: s.rejectReasons,
          blocksFound: store.blocksFound(),
          bestShareDiff: s.bestShareDiff,
          bestShareAt: s.bestShareAt,
        },
      })
    );
    return;
  }

  // The VAPID public key the browser needs to subscribe, plus whether anything
  // is subscribed at all so the UI can show the real state rather than a
  // checkbox that remembers nothing.
  if (url.pathname === '/api/push/key') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: push.enabled,
      key: push.publicKeyBase64(),
      subscriptions: push.subscriptions.length,
      error: push.enabled ? null : 'notifications are unavailable without a writable data directory',
    }));
    return;
  }

  // The notification icon. Small, cached, and the only binary this app serves.
  if (url.pathname === '/icon-192.png') {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': ICON_PNG.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(req.method === 'HEAD' ? undefined : ICON_PNG);
    return;
  }

  if (url.pathname === '/sw.js') {
    // Served from the root so its scope covers the whole dashboard.
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/',
    });
    res.end(SERVICE_WORKER);
    return;
  }

  // One worker's own history, fetched when its detail panel is opened.
  if (url.pathname === '/api/worker') {
    const name = url.searchParams.get('name') || '';
    // hasOwnProperty, not a bare lookup: `?name=constructor` would otherwise
    // resolve through the prototype chain and return a truthy function, which
    // JSON.stringify drops — producing a 200 with no worker in it.
    const w = Object.prototype.hasOwnProperty.call(store.state.workers, name)
      ? store.state.workers[name] : null;
    if (!w || typeof w !== 'object') {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'unknown worker' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, name, worker: w }));
    return;
  }

  if (url.pathname === '/api/status') {
    const snap = snapshotOrNull();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(snap ? { ok: true, ...snap } : { ok: false, error: startupError }));
    return;
  }

  // ---- Umbrel widgets ----
  // umbrelOS runs ms(widgetData.refresh) on every response, and ms() throws on
  // undefined. Every return path below must carry `refresh`, including the
  // degraded ones.
  if (url.pathname === '/api/widget/hashrate') {
    const snap = snapshotOrNull();
    const hr = fmtHashrate(snap ? snap.totalHashrate : 0);

    // Progress on the same logarithmic scale the dashboard uses: how close the
    // best share came to a block, across six decades. A linear ratio would sit
    // at zero forever and say nothing.
    let progress = 0;
    let progressLabel = 'no shares yet';
    if (snap && snap.bestShareDiff > 0 && snap.networkDifficulty > 0) {
      const fraction = snap.bestShareDiff / snap.networkDifficulty;
      progress = Math.max(0, Math.min(1, (Math.log10(fraction) + 6) / 6));
      const pct = fraction * 100;
      progressLabel =
        fraction >= 1
          ? 'a share met the full difficulty'
          : `best share ${pct >= 1 ? pct.toFixed(1) : pct.toPrecision(2)}%`;
    } else if (snap && !snap.workers.length) {
      progressLabel = 'no miners connected';
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        type: 'text-with-progress',
        refresh: SYNC_REFRESH,
        link: '',
        title: 'Solo hashrate',
        text: `${hr.value} ${hr.unit}`,
        progressLabel,
        progress,
      })
    );
    return;
  }

  if (url.pathname === '/api/widget/stats') {
    const snap = snapshotOrNull();
    const hr = fmtHashrate(snap ? snap.totalHashrate : 0);
    // Stratum units here, matching what a miner reports. The consensus-space
    // figure is a fraction for any realistic share and renders as "0".
    const best = snap && snap.bestShareStratum ? snap.bestShareStratum : 0;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        type: 'four-stats',
        refresh: STATS_REFRESH,
        link: '',
        items: [
          { title: 'Hashrate', text: hr.value, subtext: hr.unit },
          { title: 'Workers', text: String(snap ? snap.workers.length : 0), subtext: 'connected' },
          {
            title: 'Best share',
            text: best >= 1000000 ? `${(best / 1000000).toFixed(1)}M` : best >= 1000 ? `${(best / 1000).toFixed(1)}k` : best.toFixed(0),
            subtext: 'difficulty',
          },
          { title: 'Blocks', text: String(snap ? snap.blocksFound : 0), subtext: 'found' },
        ],
      })
    );
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const nonce = crypto.randomBytes(16).toString('base64');
    const body = INDEX_HTML.replaceAll('__NONCE__', nonce);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
        // worker-src is NOT covered by the nonce: a service worker is fetched
        // by URL, so without this the registration is refused by the policy and
        // notifications silently never work.
        `connect-src 'self'; img-src 'self' data:; worker-src 'self'; ` +
        `base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

async function main() {
  if (!config.payoutAddress) {
    startupError =
      'PAYOUT_ADDRESS is not set. Set it to the Dogecoin address that should receive block rewards.';
    console.error(`[config] ${startupError}`);
  }

  // The same refusal for the parent chain. Checked here rather than in the
  // retry loop below: a missing address is not something retrying fixes, and
  // mining Litecoin blocks that pay nobody is worse than not starting.
  if (config.mergedMining && !config.ltcPayoutAddress && !startupError) {
    startupError =
      'MERGED_MINING=1 but LTC_PAYOUT_ADDRESS is not set. Set it to the Litecoin address that ' +
      'should receive the parent block rewards.';
    console.error(`[config] ${startupError}`);
  }

  // Without this an EADDRINUSE is an uncaught exception rather than a message.
  server.on('error', (err) => {
    console.error(`[web] cannot serve on port ${PORT}: ${err.message}`);
    startupError = `the dashboard could not start: ${err.message}`;
  });
  server.listen(PORT, () => console.log(`[web] dashboard on :${PORT}`));

  if (startupError) return;

  // The node may still be starting; keep retrying rather than crash-looping,
  // which would make the container's restart policy fight the node's startup.
  //
  // A FRESH Pool per attempt. Retrying start() on the same instance would leave
  // the previous attempt's poll timer and longpoll loop running, and after a
  // minute of retries there would be a dozen of each competing for the node's
  // RPC threads — starving the very call that submits a found block.
  for (let attempt = 1; ; attempt++) {
    const p = new Pool(config, store);
    p.on('error', (err) => console.error('[pool]', err.message));
    // Wake subscribed phones. Both events fire for the same block — found, then
    // accepted — and the service worker uses one notification tag, so the
    // second replaces the first instead of buzzing twice.
    //
    // The catch is not decoration: this runs on the block path, and an
    // unhandled rejection here would take down the process that is in the
    // middle of submitting the block.
    const announce = (reason) => (record) => {
      push.notifyAll(`${reason} ${record && record.height}`)
        .catch((err) => console.error('[push]', err.message));
    };
    p.on('blockfound', announce('block found'));
    p.on('block', announce('block accepted'));
    try {
      await p.start();
      pool = p;
      startupError = null;
      return;
    } catch (err) {
      p.stop();
      startupError = err.message;
      const wait = Math.min(30000, attempt * 3000);
      console.error(`[pool] start failed (${err.message}); retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// A solo pool holds no state on disk, so a restart costs one reconnect. Losing
// the process to an unhandled rejection while miners sit idle costs more, so
// these are logged loudly rather than fatal.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  // Something got past every guard. Save what we have — this is the one path
  // where losing the last half minute of history would hurt most — then log it
  // in full and let the container's restart policy give us a clean process.
  console.error('[fatal] uncaught exception:', err && err.stack ? err.stack : err);
  try { store.save(true); } catch { /* nothing left to try */ }
  process.exit(1);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    if (!pool) {
      store.save(true);
      process.exit(0);
      return;
    }
    // Close the stratum port FIRST and refuse new submissions, so the drain
    // below can actually reach zero instead of chasing a moving target.
    pool.beginShutdown();
    // Then wait for work already in progress. This includes block submissions,
    // whose retry schedule runs to about two minutes: exiting while one is
    // pending is the one bug here that costs real money.
    try {
      const clean = await pool.drain(130000);
      if (!clean) console.error('[shutdown] gave up waiting; some work was still in progress');
    } catch { /* fall through and save anyway */ }
    pool.stop();
    try { store.save(true); } catch { /* nothing left to try */ }
    process.exit(0);
  });
}

main();
