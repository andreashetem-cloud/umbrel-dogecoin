'use strict';
//
// Web Push, verified end to end against a push service I control.
//
// The parts that can silently not work are exactly the parts a user cannot
// check: whether the VAPID token really verifies, whether an expired
// subscription is dropped, whether a push service being down can take the app
// with it. So a local HTTPS-shaped stand-in stands in for Google's endpoint and
// every one of those paths is exercised.
//

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PushService, MAX_SUBSCRIPTIONS } = require('../images/stratum/src/push');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-push-'));
const statePath = path.join(dir, 'push.json');

const fromB64Url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

(async () => {
  console.log('\nkeys and identity');
  const push = new PushService(statePath, () => {});
  check('load() succeeds and enables the service', push.load() === true);
  check('the state file was written', fs.existsSync(statePath));
  check('the private key is not world-readable',
    (fs.statSync(statePath).mode & 0o077) === 0, (fs.statSync(statePath).mode & 0o777).toString(8));

  const pub = push.publicKeyBase64();
  const rawPub = fromB64Url(pub);
  check('the public key is an uncompressed P-256 point', rawPub.length === 65 && rawPub[0] === 0x04,
    `${rawPub.length} bytes, first ${rawPub[0]}`);
  check('the key is base64url, not base64', !/[+/=]/.test(pub), pub.slice(0, 12));

  // Keys must survive a restart, or every phone silently stops receiving.
  const reopened = new PushService(statePath, () => {});
  reopened.load();
  check('the keypair is stable across restarts', reopened.publicKeyBase64() === pub);

  console.log('\nthe VAPID token');
  const endpoint = 'https://push.example.com/fcm/send/abc123';
  const jwt = push.jwtFor(endpoint);
  const [h, b, sig] = jwt.split('.');
  const header = JSON.parse(fromB64Url(h));
  const body = JSON.parse(fromB64Url(b));
  check('header names ES256', header.alg === 'ES256' && header.typ === 'JWT', JSON.stringify(header));
  check('audience is the push service ORIGIN, not the full URL',
    body.aud === 'https://push.example.com', body.aud);
  check('it carries a subject', typeof body.sub === 'string' && body.sub.length > 0, body.sub);
  // Apple rejects a mailto: at a non-routable domain with BadJwtToken, which
  // would mean an iPhone never receives a block notification. https: is the
  // other form RFC 8292 allows and is accepted everywhere.
  check('the subject is one real push services accept',
    /^https:\/\//.test(body.sub) || /^mailto:[^@]+@[^@.]+\.[a-z]{2,}$/i.test(body.sub), body.sub);
  const ttl = body.exp - Math.floor(Date.now() / 1000);
  check('it expires within the 24h a push service allows', ttl > 0 && ttl <= 86400, String(ttl));

  // The signature must verify against the advertised public key — this is the
  // whole point of VAPID, and a wrong signature encoding (DER instead of raw
  // r||s) still produces a token that LOOKS right and is always rejected.
  const verified = crypto.verify(
    null,
    Buffer.from(`${h}.${b}`),
    { key: push.keys.publicKey, dsaEncoding: 'ieee-p1363' },
    fromB64Url(sig)
  );
  check('the signature verifies against the advertised key', verified);
  check('the signature is raw r||s (64 bytes), not DER', fromB64Url(sig).length === 64,
    String(fromB64Url(sig).length));

  const other = push.jwtFor('https://other.example.org/x');
  check('a different service gets a different audience',
    JSON.parse(fromB64Url(other.split('.')[1])).aud === 'https://other.example.org');

  console.log('\nsubscriptions');
  check('http endpoints are refused', push.subscribe('http://insecure.example/x').ok === false);
  check('nonsense is refused', push.subscribe('not a url').ok === false);
  check('a null endpoint is refused', push.subscribe(null).ok === false);
  check('an https endpoint is accepted', push.subscribe(endpoint).ok === true);
  check('subscribing twice does not duplicate', push.subscribe(endpoint).already === true
    && push.subscriptions.length === 1, String(push.subscriptions.length));
  for (let i = 0; i < MAX_SUBSCRIPTIONS + 5; i++) push.subscribe(`https://push.example.com/e/${i}`);
  check('the list is capped', push.subscriptions.length === MAX_SUBSCRIPTIONS,
    String(push.subscriptions.length));
  check('the cap drops the OLDEST, keeping the newest device',
    push.subscriptions[push.subscriptions.length - 1].endpoint.endsWith(`/e/${MAX_SUBSCRIPTIONS + 4}`),
    push.subscriptions[push.subscriptions.length - 1].endpoint);

  console.log('\ndelivery, against a stand-in push service');
  const seen = [];
  let behaviour = 201;
  const service = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers });
    if (behaviour === 'hang') return; // never answers
    res.writeHead(behaviour);
    res.end();
  });
  await new Promise((r) => service.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${service.address().port}`;

  // The service is plain http here, so the endpoint check is bypassed by
  // writing the list directly — the transport is not what is under test.
  const local = new PushService(path.join(dir, 'local.json'), () => {});
  local.load();
  local.subscriptions = [{ endpoint: `${base}/push/one`, addedAt: Date.now() }];

  let result = await local.notifyAll('test');
  check('a 201 counts as delivered', result.sent === 1 && result.failed === 0, JSON.stringify(result));
  const req1 = seen[0];
  check('it is a POST', req1.method === 'POST');
  check('it carries a VAPID Authorization header', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(req1.headers.authorization || ''),
    (req1.headers.authorization || '').slice(0, 40));
  check('it declares a TTL', req1.headers.ttl === '86400', req1.headers.ttl);
  // Note this is a weak check on its own — a bodyless POST gets
  // content-length: 0 from the HTTP client anyway. What it is really asserting
  // is the absence of a body; the Content-Encoding check below is the one that
  // distinguishes a payloadless push from an (unimplemented) encrypted one.
  check('it sends no payload', req1.headers['content-length'] === '0', req1.headers['content-length']);
  check('there is no Content-Encoding, which would imply a payload',
    req1.headers['content-encoding'] === undefined);

  behaviour = 410;
  result = await local.notifyAll('test');
  check('410 Gone removes the subscription', result.removed === 1 && local.subscriptions.length === 0,
    JSON.stringify(result));

  local.subscriptions = [{ endpoint: `${base}/push/two`, addedAt: Date.now() }];
  behaviour = 500;
  result = await local.notifyAll('test');
  check('a 500 is a failure but NOT an unsubscribe', result.failed === 1 && local.subscriptions.length === 1,
    JSON.stringify(result));

  // Two subscriptions where one is dead: the live one must still be delivered.
  local.subscriptions = [
    { endpoint: `${base}/push/dead`, addedAt: Date.now() },
    { endpoint: `${base}/push/live`, addedAt: Date.now() },
  ];
  let n = 0;
  const mixed = async (endpoint, opts) => {
    n++;
    if (endpoint.endsWith('/dead')) return { status: 410 };
    return { status: 201 };
  };
  result = await local.notifyAll('test', mixed);
  check('one dead subscription does not stop the others',
    result.sent === 1 && result.removed === 1 && local.subscriptions.length === 1,
    JSON.stringify(result));
  check('the surviving subscription is the live one',
    local.subscriptions[0].endpoint.endsWith('/live'), local.subscriptions[0].endpoint);

  console.log('\na push service that never answers');
  behaviour = 'hang';
  local.subscriptions = [{ endpoint: `${base}/push/hang`, addedAt: Date.now() }];
  const startedAt = Date.now();
  // The block path awaits nothing from this, but it must still terminate on its
  // own rather than holding a socket open until the process exits.
  const hung = await local.notifyAll('test');
  const waited = Date.now() - startedAt;
  // Bounded on BOTH sides: a regression that raised the timeout to 19 s would
  // still satisfy a bare "under 20 seconds".
  check('a hung push service is abandoned, not waited on forever',
    hung.failed === 1 && waited >= 14000 && waited < 17000, `${waited}ms ${JSON.stringify(hung)}`);
  check('and it is not treated as an unsubscribe', local.subscriptions.length === 1);
  behaviour = 201;

  console.log('\nendpoints that would break the sender');
  // The regex this used to rely on accepts strings new URL() rejects, which
  // threw inside notifyAll and rejected the promise the block path had created.
  check('an unparseable https string is refused', push.subscribe('https://[').ok === false);
  check('a loopback endpoint is refused', push.subscribe('https://127.0.0.1/x').ok === false);
  check('a private-network endpoint is refused', push.subscribe('https://192.168.1.9/x').ok === false);
  check('a .local endpoint is refused', push.subscribe('https://umbrel.local/x').ok === false);
  check('a CGNAT/tailscale endpoint is refused', push.subscribe('https://100.101.102.103/x').ok === false);
  // The same addresses written as IPv4-mapped IPv6 reach the same hosts.
  check('an IPv4-mapped loopback endpoint is refused',
    push.subscribe('https://[::ffff:127.0.0.1]/x').ok === false);
  check('an IPv4-mapped LAN endpoint is refused',
    push.subscribe('https://[::ffff:c0a8:101]/x').ok === false);
  check('a .lan endpoint is refused', push.subscribe('https://box.lan/x').ok === false);
  check('a real push service host is still accepted',
    push.subscribe('https://fcm.googleapis.com/fcm/send/xyz').ok === true);

  const poisoned = new PushService(path.join(dir, 'poison.json'), () => {});
  poisoned.load();
  poisoned.subscriptions = [{ endpoint: 'https://[', addedAt: Date.now() }];
  let poisonThrew = false;
  try { await poisoned.notifyAll('test'); } catch (e) { poisonThrew = true; }
  check('an unparseable endpoint already on disk cannot reject the send', !poisonThrew);

  console.log('\nfailures must never propagate');
  local.subscriptions = [{ endpoint: 'https://127.0.0.1:1/never', addedAt: Date.now() }];
  let threw = false;
  try {
    result = await local.notifyAll('test');
  } catch (e) { threw = true; }
  check('an unreachable push service does not throw', !threw);
  check('it is counted as a failure, not an unsubscribe',
    result.failed === 1 && local.subscriptions.length === 1, JSON.stringify(result));

  const noPath = new PushService(null, () => {});
  check('without a data directory the service disables itself', noPath.load() === false);
  const quiet = await noPath.notifyAll('test');
  check('a disabled service sends nothing and does not throw', quiet.sent === 0, JSON.stringify(quiet));

  // A corrupt state file must cost notifications, never the process.
  const brokenPath = path.join(dir, 'broken.json');
  fs.writeFileSync(brokenPath, '{ this is not json');
  const broken = new PushService(brokenPath, () => {});
  check('a corrupt state file still loads with fresh keys', broken.load() === true);
  check('and it produced a usable key', (broken.publicKeyBase64() || '').length > 80);

  service.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nPUSH VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
