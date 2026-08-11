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

const PORT = Number(process.env.PORT || 3000);
const STRATUM_PORT = Number(process.env.STRATUM_PORT || 3333);

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
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
  pollIntervalMs: num('POLL_INTERVAL_SECONDS', 5) * 1000,
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
};

const SYNC_REFRESH = '10s';
const STATS_REFRESH = '10s';

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

let pool = null;
let startupError = null;

// STATS_PATH empty disables persistence entirely, which is what the test
// suites want: they must not write to the developer's disk.
const store = new Store(
  process.env.STATS_PATH === '' ? null : process.env.STATS_PATH || '/data/stats.json',
  (msg) => console.log(`[store] ${msg}`)
);
store.load();

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

const server = http.createServer((req, res) => {
  // The dashboard sits behind Umbrel's authenticating proxy, but defence in
  // depth costs nothing here.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

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
        workers: s.workers,
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
        `connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
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
