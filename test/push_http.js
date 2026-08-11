'use strict';
//
// The notification plumbing as the browser sees it: the endpoints, the service
// worker registration under a strict CSP, and the states the panel can show.
//
// Actually subscribing needs a real push service on the internet, so that step
// is not attempted here — everything up to and including registering the worker
// is, because that is where a Content-Security-Policy mistake would silently
// stop notifications from ever working.
//

const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://127.0.0.1:3010';

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  // --- the HTTP surface, without a browser -------------------------------
  console.log('\nendpoints');
  const keyRes = await fetch(`${BASE}/api/push/key`, { cache: 'no-store' });
  const key = await keyRes.json();
  check('GET /api/push/key answers', keyRes.status === 200, String(keyRes.status));
  check('it advertises a key', key.ok && typeof key.key === 'string' && key.key.length > 80,
    JSON.stringify(key).slice(0, 80));
  // Whatever is already subscribed on this instance. Everything below is
  // measured against it rather than against zero.
  const baseline = key.subscriptions;

  const swRes = await fetch(`${BASE}/sw.js`);
  const swBody = await swRes.text();
  check('GET /sw.js is served as JavaScript',
    swRes.status === 200 && /javascript/.test(swRes.headers.get('content-type') || ''),
    swRes.headers.get('content-type'));
  check('its scope is allowed to be the root',
    swRes.headers.get('service-worker-allowed') === '/', swRes.headers.get('service-worker-allowed'));
  check('it handles the push event', /addEventListener\('push'/.test(swBody));

  const icon = await fetch(`${BASE}/icon-192.png`);
  check('the notification icon exists', icon.status === 200 && icon.headers.get('content-type') === 'image/png',
    `${icon.status} ${icon.headers.get('content-type')}`);

  const post = (path, body) => fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });

  let r = await post('/api/push/subscribe', JSON.stringify({ endpoint: 'http://nope.example/x' }));
  check('an http endpoint is refused with 400', r.status === 400, String(r.status));

  r = await post('/api/push/subscribe', 'not json at all');
  check('a non-JSON body is refused', r.status === 400, String(r.status));

  // A body larger than the cap must be refused by the READER, not merely fail
  // validation afterwards. The padding field keeps the endpoint itself short
  // and valid, so the only thing that can reject this is the size limit.
  r = await post('/api/push/subscribe', JSON.stringify({
    endpoint: 'https://fcm.googleapis.com/fcm/send/ok', padding: 'a'.repeat(20000),
  })).catch(() => ({ status: 'connection closed' }));
  check('an oversized body is refused by the size limit, not accepted',
    r.status !== 200, String(r.status));
  const afterBig = await (await fetch(`${BASE}/api/push/key`, { cache: 'no-store' })).json();
  // A delta, not an absolute count: run against the user's own instance with a
  // phone already subscribed, `=== 0` would fail for the wrong reason.
  check('and nothing was subscribed as a side effect', afterBig.subscriptions === baseline,
    `${afterBig.subscriptions} vs ${baseline}`);

  // Endpoints the sender could not use must never reach the stored list.
  for (const bad of ['https://[', 'https://127.0.0.1/x', 'https://192.168.1.9/x', 'https://umbrel.local/x']) {
    const res = await post('/api/push/subscribe', JSON.stringify({ endpoint: bad }));
    check(`refused: ${bad}`, res.status === 400, String(res.status));
  }

  r = await post('/api/push/subscribe', JSON.stringify({ endpoint: 'https://push.example.com/test-endpoint' }));
  const sub = await r.json();
  check('a valid https endpoint is accepted', r.status === 200 && sub.ok, JSON.stringify(sub));

  const after = await (await fetch(`${BASE}/api/push/key`, { cache: 'no-store' })).json();
  check('the subscription is reflected in the key endpoint', after.subscriptions === baseline + 1,
    `${after.subscriptions} vs ${baseline}`);

  r = await post('/api/push/unsubscribe', JSON.stringify({ endpoint: 'https://push.example.com/test-endpoint' }));
  const un = await r.json();
  check('it can be removed again', un.ok && un.removed === 1, JSON.stringify(un));

  // Cross-site posts. Umbrel authenticates with a cookie, which a browser also
  // attaches to requests made by OTHER sites, so without an origin check any
  // page the user has open could register its own endpoint here and be told the
  // moment a block is found.
  const evil = 'https://fcm.googleapis.com/fcm/send/evil';
  let x = await fetch(`${BASE}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ endpoint: evil }),
  });
  check('a cross-site POST is refused', x.status === 403, String(x.status));

  x = await fetch(`${BASE}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ endpoint: evil }),
  });
  check('a foreign Origin is refused even without Sec-Fetch-Site', x.status === 403, String(x.status));

  // text/plain is what makes a cross-origin POST a CORS "simple request" — one
  // the browser sends without asking permission first.
  x = await fetch(`${BASE}/api/push/subscribe`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ endpoint: evil }),
  });
  check('a non-JSON content type is refused', x.status === 403, String(x.status));

  const afterEvil = await (await fetch(`${BASE}/api/push/key`, { cache: 'no-store' })).json();
  check('none of that registered anything', afterEvil.subscriptions === baseline,
    `${afterEvil.subscriptions} vs ${baseline}`);

  const del = await fetch(`${BASE}/api/push/subscribe`, { method: 'DELETE' });
  check('other methods are still rejected', del.status === 405, String(del.status));

  const notFound = await fetch(`${BASE}/api/push/nonsense`, { method: 'POST', body: '{}' });
  check('an unknown push path is not treated as an endpoint', notFound.status === 405 || notFound.status === 404,
    String(notFound.status));

  // --- the process must survive hostile requests ---------------------------
  console.log('\nrequests that must not kill the app');
  const net = require('node:net');
  const raw = (text) => new Promise((resolve) => {
    const socket = net.connect(Number(new URL(BASE).port), new URL(BASE).hostname, () => socket.write(text));
    let out = '';
    socket.on('data', (c) => { out += c; });
    socket.on('close', () => resolve(out));
    socket.on('error', () => resolve(''));
    setTimeout(() => { socket.destroy(); resolve(out); }, 2000);
  });

  // An absolute-form target that new URL() rejects. Unguarded this is an
  // uncaught exception, and this process answers those by exiting — taking any
  // block that is mid-submission with it.
  const bad = await raw('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n');
  check('a malformed request target gets an answer, not a crash', /^HTTP\/1\.1 400/.test(bad), bad.slice(0, 40));
  const alive = await fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0);
  check('the app is still running afterwards', alive === 200 || alive === 503, String(alive));

  const bad2 = await raw('GET //\\ HTTP/1.1\r\nHost: x\r\n\r\n');
  check('a nonsense path does not crash it either', bad2.length > 0, String(bad2.length));
  const alive2 = await fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0);
  check('and it is still running after that', alive2 === 200 || alive2 === 503, String(alive2));

  // --- and now in a real browser ------------------------------------------
  console.log('\nin the browser');
  const browser = await chromium.launch();
  const problems = [];
  // 127.0.0.1 is a secure context in Chromium, which is what lets the service
  // worker register here at all — the same code over a LAN http address is
  // exactly the case the panel has to explain instead of failing.
  // Headless Chromium reports Notification.permission as 'denied' no matter what
  // is granted to the context, so the "not yet asked" state — the one a real
  // phone starts in — is reproduced by reporting 'default' to the page. That
  // exercises this dashboard's branch, which is what is under test here; the
  // browser's own permission machinery is not.
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  const secure = await page.evaluate(() => window.isSecureContext);
  check('the test page is a secure context', secure === true);

  await page.waitForFunction(() => {
    const t = document.getElementById('pushState').textContent;
    return t && t !== 'Checking…';
  }, { timeout: 15000 }).catch(() => problems.push('the notification panel never resolved'));

  const ui = await page.evaluate(() => ({
    state: document.getElementById('pushState').textContent,
    aside: document.getElementById('pushAside').textContent,
    enable: !document.getElementById('pushEnable').hidden,
    disable: !document.getElementById('pushDisable').hidden,
  }));
  check('the panel offers to enable notifications', ui.enable && !ui.disable, JSON.stringify(ui));
  check('the heading says they are off', ui.aside === 'off', ui.aside);

  // The registration itself — this is the CSP-sensitive step.
  const reg = await page.evaluate(async () => {
    try {
      const r = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      return { ok: true, scope: r.scope };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  check('the service worker registers under the strict CSP', reg.ok, reg.error);
  check('its scope covers the whole dashboard', (reg.scope || '').endsWith('/'), reg.scope);

  // A browser that has blocked notifications must say so, and must NOT offer a
  // button that cannot work.
  const denied = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page2 = await denied.newPage();
  await page2.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page2.waitForFunction(() => {
    const t = document.getElementById('pushState').textContent;
    return t && t !== 'Checking…';
  }, { timeout: 15000 }).catch(() => problems.push('the blocked-state panel never resolved'));
  const blocked = await page2.evaluate(() => ({
    aside: document.getElementById('pushAside').textContent,
    state: document.getElementById('pushState').textContent,
    enable: !document.getElementById('pushEnable').hidden,
    help: document.getElementById('pushHelp').textContent,
  }));
  check('a browser that blocks notifications is told so', blocked.aside === 'blocked', JSON.stringify(blocked));
  check('and is not offered a button that cannot work', blocked.enable === false);
  check('and is told where to change it', /site settings/i.test(blocked.help), blocked.help);
  await denied.close();

  check('no console or page errors', problems.length === 0, problems.slice(0, 4).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nPUSH HTTP VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
