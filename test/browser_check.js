'use strict';
//
// Renders the dashboard in a real Chromium and fails on anything a user would
// notice: a console error, a Content-Security-Policy violation, a failed
// request, an unformatted number, or a layout that overflows on a phone.
//
// A dashboard that "looks right" in source and throws in the browser is the
// normal outcome of a strict CSP, so this is not optional.
//

const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://127.0.0.1:3010';
const OUT = process.argv[3] || '/tmp/shots';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

(async () => {
  const browser = await chromium.launch();
  const problems = [];

  const viewports = [
    { name: 'desktop', width: 1440, height: 1400, scale: 1.5 },
    { name: 'tablet', width: 900, height: 1300, scale: 1.5 },
    { name: 'phone', width: 390, height: 1500, scale: 2 },
  ];

  for (const vp of viewports) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.scale,
    });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        problems.push(`[${vp.name}] console.${msg.type()}: ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => problems.push(`[${vp.name}] pageerror: ${err.message}`));
    page.on('requestfailed', (req) => {
      problems.push(`[${vp.name}] request failed: ${req.url()} ${req.failure()?.errorText}`);
    });

    const response = await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    check(`${vp.name}: page loads with 200`, response.status() === 200, String(response.status()));

    const csp = response.headers()['content-security-policy'] || '';
    check(`${vp.name}: CSP header present with a nonce`, /script-src 'nonce-/.test(csp), csp.slice(0, 80));
    check(`${vp.name}: CSP forbids unsafe-inline`, !/unsafe-inline/.test(csp));

    // Wait for the first data render.
    await page.waitForFunction(() => {
      const el = document.getElementById('hr');
      return el && el.textContent !== '—';
    }, { timeout: 20000 }).catch(() => problems.push(`[${vp.name}] dashboard never rendered data`));

    // The nonce'd stylesheet must actually have applied. Check a property that
    // does NOT change with page state — the body background legitimately
    // differs once a block has been found.
    const styled = await page.evaluate(() => {
      const mast = document.querySelector('.mast');
      const s = getComputedStyle(mast);
      return { border: s.borderBottomColor, font: getComputedStyle(document.body).fontVariantNumeric };
    });
    check(`${vp.name}: nonce'd stylesheet applied`,
      styled.border === 'rgb(44, 37, 28)' && styled.font === 'tabular-nums', JSON.stringify(styled));

    // No element may overflow the viewport horizontally.
    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth - document.documentElement.clientWidth;
    });
    check(`${vp.name}: no horizontal overflow`, overflow <= 1, `${overflow}px`);

    // Every readout must be filled in, not left as a placeholder.
    const placeholders = await page.evaluate(() => {
      const ids = ['hr','fWorkers','fShares','fBlocks','fEta','nHeight','nDiff','nHash','cUrl','cUser'];
      return ids.filter((id) => {
        const el = document.getElementById(id);
        return !el || el.textContent.trim() === '' || el.textContent.trim() === '—';
      });
    });
    check(`${vp.name}: all readouts populated`, placeholders.length === 0, placeholders.join(', '));

    if (vp.name === 'desktop') {
      // The distance ruler is the signature element; prove it drew its ticks
      // and positioned the marker.
      const ruler = await page.evaluate(() => {
        const ticks = document.querySelectorAll('.ruler .tick').length;
        const you = document.getElementById('rulerYou');
        return { ticks, left: you ? you.style.left : null };
      });
      check('ruler drew its logarithmic ticks', ruler.ticks === 7, String(ruler.ticks));
      check('ruler positioned the marker', !!ruler.left, String(ruler.left));

      // Keyboard focus must be visible — checked by actually focusing a button.
      // It must be a VISIBLE one: the block-alarm dismiss button is first in the
      // DOM but hidden until a block is found, and a hidden element cannot take
      // focus, which would fail this check for the wrong reason.
      const focusVisible = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null);
        if (!btn) return false;
        btn.focus();
        const s = getComputedStyle(btn);
        return document.activeElement === btn && s.outlineStyle !== 'none';
      });
      check('buttons take visible keyboard focus', focusVisible);
    }

    await page.screenshot({ path: `${OUT}/${vp.name}.png`, fullPage: true });
    await context.close();
  }

  await browser.close();

  check('no console errors, page errors or failed requests', problems.length === 0,
    problems.slice(0, 6).join(' | '));

  console.log(failures === 0 ? '\nBROWSER CHECKS PASSED' : `\n${failures} BROWSER CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
