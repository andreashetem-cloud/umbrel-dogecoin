'use strict';
//
// Renders the real dashboard against a realistic mainnet-scale payload to
// produce the App Store gallery images. The HTML, CSS and JavaScript are the
// shipped ones — only the numbers are supplied, so the screenshots cannot
// drift away from what the app actually looks like.
//

const { chromium } = require('playwright');
const fs = require('node:fs');

const BASE = process.argv[2] || 'http://127.0.0.1:3010';
const OUT = process.argv[3] || '/tmp/gallery';

const now = Date.now();
const minutes = (m) => now - m * 60000;

function shareHistory(perMinute, spanMinutes, jitter) {
  const out = [];
  for (let i = spanMinutes * 60; i > 0; i -= 60 / perMinute) {
    out.push(Math.round(now - i * 1000 + (Math.sin(i) * jitter * 1000)));
  }
  return out.slice(-48);
}

const NETWORK_DIFFICULTY = 40148086;

const SCENES = {
  // The everyday view: two miners, running for days, no block yet. This is
  // what the app looks like 99.99% of the time, so it leads the gallery.
  running: {
    ok: true, chain: 'main', stratumPort: 22557,
    payoutAddress: 'DHh2vimDCkdpZqMRVtcr8CLWPZeXYBVYcL',
    startedAt: minutes(60 * 71), height: 6327333,
    networkDifficulty: NETWORK_DIFFICULTY, coinbaseValue: 1000415111991,
    templateAgeMs: 3400, templateError: null,
    accepted: 41207, rejected: 6, rejectReasons: { 'stale job': 6 },
    bestShareDiff: 3187442, bestShareAt: minutes(1400),
    blocksFound: 0, blocks: [],
    workers: [
      { id: 1, worker: 'DHh2vimDCkdpZqMRVtcr8CLWPZeXYBVYcL', userAgent: 'cgminer/4.11.1 (Dogexus)',
        remote: '192.168.1.44', difficulty: 16384, hashrate: 70_400_000,
        accepted: 29184, rejected: 4, bestShareDiff: 3187442,
        payoutAddress: 'DHh2vimDCkdpZqMRVtcr8CLWPZeXYBVYcL',
        connectedAt: minutes(60 * 71), lastShareAt: now - 4000,
        shareHistory: shareHistory(4.3, 10, 2) },
      { id: 2, worker: 'lg07.shed', userAgent: 'cgminer/4.10.0 (LuckyMiner LG07)',
        remote: '192.168.1.51', difficulty: 2048, hashrate: 12_900_000,
        accepted: 12023, rejected: 2, bestShareDiff: 741903,
        payoutAddress: 'DHh2vimDCkdpZqMRVtcr8CLWPZeXYBVYcL',
        connectedAt: minutes(60 * 62), lastShareAt: now - 9000,
        shareHistory: shareHistory(5.1, 10, 3) },
    ],
    totalHashrate: 83_300_000,
  },
};

// The day it pays off.
SCENES.block = JSON.parse(JSON.stringify(SCENES.running));
SCENES.block.blocksFound = 1;
SCENES.block.bestShareDiff = NETWORK_DIFFICULTY * 1.02;
SCENES.block.blocks = [{
  height: 6327301, hash: '4a1f2c9e7b0d5a63c8f1e2d4b6a70983c5d1e2f4a6b8c0d2e4f6a8b0c2d4e6f8',
  worker: 'DHh2vimDCkdpZqMRVtcr8CLWPZeXYBVYcL', address: 'DHh2vimDCkdpZqMRVtcr8CLWPZeXYBVYcL',
  reward: 1000221430000, at: minutes(37), status: 'accepted', accepted: true, error: null,
}];

// Nothing connected yet — the first thing a new user sees.
SCENES.empty = JSON.parse(JSON.stringify(SCENES.running));
SCENES.empty.workers = [];
SCENES.empty.totalHashrate = 0;
SCENES.empty.accepted = 0;
SCENES.empty.rejected = 0;
SCENES.empty.rejectReasons = {};
SCENES.empty.bestShareDiff = 0;
SCENES.empty.startedAt = minutes(2);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  const shots = [
    { scene: 'running', name: '1', width: 1440, height: 900 },
    { scene: 'block', name: '2', width: 1440, height: 900 },
    { scene: 'empty', name: '3', width: 1440, height: 900 },
    { scene: 'running', name: 'phone', width: 390, height: 844 },
  ];

  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: { width: shot.width, height: shot.height },
      deviceScaleFactor: 1.5,
    });
    const page = await context.newPage();
    await page.route('**/api/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SCENES[shot.scene]),
      })
    );
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('hr').textContent !== '—', { timeout: 15000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/${shot.name}.png`, fullPage: shot.width < 600 });
    await context.close();
    console.log(`  wrote ${OUT}/${shot.name}.png (${shot.scene})`);
  }

  await browser.close();
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
