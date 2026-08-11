'use strict';
//
// The worker detail panel, driven the way a user drives it: click the row, read
// the numbers, close it again. A panel that renders only when you open it by
// hand is a panel that breaks silently, so this is checked in a real browser.
//
// It also covers the phone case specifically. Below 640px the numeric columns
// are not rendered at all, and the per-worker line that replaces them is the
// only place difficulty, ping and best share appear.
//

const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://127.0.0.1:3010';

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  const browser = await chromium.launch();
  const problems = [];

  for (const vp of [
    { name: 'desktop', width: 1440, height: 1200 },
    { name: 'phone', width: 390, height: 1400 },
  ]) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${vp.name}] ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`[${vp.name}] pageerror: ${e.message}`));

    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.wrow', { timeout: 20000 });

    // The columns are hidden on a phone; the meta line must carry the same
    // facts, otherwise this is exactly the "I cannot see difficulty" complaint
    // that prompted the panel in the first place.
    const meta = await page.evaluate(() => {
      const row = document.querySelector('.wrow');
      const el = row.querySelector('.wmeta');
      return { text: el ? el.textContent : null, shown: el ? getComputedStyle(el).display !== 'none' : false };
    });
    if (vp.name === 'phone') {
      check('phone: the per-worker line is visible', meta.shown, JSON.stringify(meta));
      check('phone: it carries difficulty', /diff /.test(meta.text || ''), meta.text);
      check('phone: it carries the best share', /best /.test(meta.text || ''), meta.text);
      check('phone: it carries a ping', /ms|no ping/.test(meta.text || ''), meta.text);
    } else {
      check('desktop: the per-worker line is hidden (columns show it)', !meta.shown);
      const headers = await page.$$eval('.wtab thead th', (th) => th.map((t) => t.textContent));
      check('desktop: there is a best-share column', headers.includes('Best share'), headers.join('|'));
      const bestCells = await page.$$eval('.wtab tbody tr', (rows) =>
        rows.map((r) => r.children[4] && r.children[4].textContent.trim()));
      check('desktop: every worker shows its own best share',
        bestCells.length > 0 && bestCells.every((c) => c && c !== ''), JSON.stringify(bestCells));
    }

    // Open the panel by clicking, not by calling a function.
    const name = await page.$eval('.wrow', (r) => r.getAttribute('data-worker'));
    await page.click('.wrow');
    await page.waitForFunction(() => !document.getElementById('wdetail').hidden, { timeout: 10000 });
    await page.waitForTimeout(700);

    const panel = await page.evaluate(() => ({
      name: document.getElementById('wdName').textContent,
      best: document.getElementById('wdBest').textContent,
      shares: document.getElementById('wdShares').textContent,
      since: document.getElementById('wdSince').textContent,
      chartPaths: document.querySelectorAll('#wdChart path, #wdChart text').length,
      rejects: document.getElementById('wdRejects').textContent,
    }));
    check(`${vp.name}: the panel shows the worker that was clicked`, panel.name === name, `${panel.name} vs ${name}`);
    check(`${vp.name}: best share is filled in`, panel.best !== '—' && panel.best !== '', panel.best);
    check(`${vp.name}: share count is filled in`, panel.shares !== '—' && panel.shares !== '', panel.shares);
    check(`${vp.name}: known-since is filled in`, panel.since !== '—', panel.since);
    check(`${vp.name}: the chart drew something`, panel.chartPaths > 0, String(panel.chartPaths));
    check(`${vp.name}: reject reasons are addressed`, /reject/i.test(panel.rejects), panel.rejects.slice(0, 60));

    // A second worker replaces the contents rather than opening a second panel.
    const rows = await page.$$('.wrow');
    if (rows.length > 1) {
      const other = await rows[1].getAttribute('data-worker');
      await rows[1].click();
      await page.waitForTimeout(600);
      const now = await page.$eval('#wdName', (e) => e.textContent);
      check(`${vp.name}: clicking another worker switches the panel`, now === other, `${now} vs ${other}`);
      check(`${vp.name}: still exactly one panel`, (await page.$$('#wdetail')).length === 1);
    }

    // Escape closes it, and so does the button.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check(`${vp.name}: Escape closes the panel`, await page.$eval('#wdetail', (e) => e.hidden));
    await page.click('.wrow');
    await page.waitForTimeout(300);
    await page.click('#wdClose');
    await page.waitForTimeout(200);
    check(`${vp.name}: the Close button closes it`, await page.$eval('#wdetail', (e) => e.hidden));

    // The row is reachable and operable from the keyboard alone.
    const viaKeyboard = await page.evaluate(async () => {
      const row = document.querySelector('.wrow');
      row.focus();
      const focused = document.activeElement === row;
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      return { focused, open: !document.getElementById('wdetail').hidden };
    });
    check(`${vp.name}: a row takes focus`, viaKeyboard.focused);
    check(`${vp.name}: Enter opens the panel`, viaKeyboard.open);

    await context.close();
  }

  await browser.close();
  check('no console errors or page errors', problems.length === 0, problems.slice(0, 4).join(' | '));
  console.log(failures === 0 ? '\nWORKER PANEL VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
