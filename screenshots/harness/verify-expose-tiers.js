// Verification driver for the Exposé size ladder. The node tests
// (test/expose-density.test.mjs) cover the ladder's arithmetic; this covers the
// WIRING — that both inputs reach it and that the grid really re-lays-out:
//
//   1. ⌃⌥E cycles closed → 2×2 → 3×3 → closed (one key, so it wraps).
//   2. A trackpad SPREAD opens Exposé at 2×2, and a second spread grows it to 3×3
//      instead of doing nothing (it used to open-or-nothing).
//   3. A third spread stays at 3×3 — growing never wraps round to dismissing.
//   4. A PINCH steps back to 2×2 rather than closing outright, and only the next
//      pinch closes it. A further pinch with nothing open is a no-op.
//   5. The density attribute is not just bookkeeping: the tiles' on-screen width
//      really changes between the rungs.
//
// The gesture is Mac-gated (IS_MAC in os.js, read at module load from
// navigator.userAgentData.platform / navigator.platform), and this container's
// Chromium is Linux — so an init script forges a Mac platform before any page
// script runs. A userAgent override alone would NOT do it: Chromium answers
// userAgentData.platform from the real OS and os.js consults that first.
//
// A trackpad pinch arrives as a `wheel` with ctrlKey set (deltaY < 0 = spread).
// The handler treats a >250ms pause as a fresh gesture and acts once per gesture,
// so each step here is one event with a pause after it — the same rhythm as
// lifting your fingers and doing it again.
//
// Run exactly like run.sh does, with DRIVER=verify-expose-tiers.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// The overlay lives one shadow root down, so document.querySelector never sees it.
// `level` is the ladder's own vocabulary: 0 closed, else the N of the N×N block.
const level = () => page.evaluate(() => {
  const n = document.querySelector('webtmux-expose');
  return n.open ? (n.density || 2) : 0;
});

// The width of a real tile, to prove the rung reached the layout and not just the
// attribute. Null when nothing is on screen.
const tileWidth = () => page.evaluate(() => {
  const rr = document.querySelector('webtmux-expose').shadowRoot;
  const tile = rr.querySelector('.grid > *');
  return tile ? Math.round(tile.getBoundingClientRect().width) : null;
});

// One decisive pinch gesture. dir = +1 spread (fingers apart), -1 pinch together.
// 40 is comfortably past the handler's threshold of 12; the wait after it is the
// >250ms pause that ends the gesture, so the next call is a NEW one.
async function pinch(dir) {
  await page.evaluate((d) => {
    window.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -40 * d, ctrlKey: true, bubbles: true, cancelable: true,
    }));
  }, dir);
  await sleep(900);
}

async function chordE() {
  await page.keyboard.press('Control+Alt+e');
  await sleep(900);
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  // Forge a Mac client so the gesture handler installs at all (see the header).
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { get: () => ({ platform: 'macOS' }) });
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  const isMac = await page.evaluate(() => /Mac/i.test(
    (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform));
  check('the page believes it is on a Mac, so the pinch handler is installed', isMac);

  // ---- 1. the single key still cycles -----------------------------------------
  await chordE();
  const k1 = await level();
  await chordE();
  const k2 = await level();
  await chordE();
  const k3 = await level();
  check('⌃⌥E cycles closed → 2×2 → 3×3 → closed',
    k1 === 2 && k2 === 3 && k3 === 0, `levels ${k1}, ${k2}, ${k3}`);

  // ---- 2/3. spreading walks UP and then stops ---------------------------------
  await pinch(+1);
  const s1 = await level();
  const w1 = await tileWidth();
  check('a spread opens Exposé at 2×2', s1 === 2, `level ${s1}`);

  await pinch(+1);
  const s2 = await level();
  const w2 = await tileWidth();
  check('a second spread grows it to 3×3', s2 === 3, `level ${s2}`);

  check('and the tiles really got smaller, not just the attribute',
    w1 !== null && w2 !== null && w2 < w1, `tile width ${w1} → ${w2}`);

  await pinch(+1);
  const s3 = await level();
  check('a third spread stays at 3×3 — growing never dismisses', s3 === 3, `level ${s3}`);

  // ---- 4. pinching walks back DOWN, one rung at a time ------------------------
  await pinch(-1);
  const p1 = await level();
  const w3 = await tileWidth();
  check('a pinch steps back to 2×2 instead of closing', p1 === 2, `level ${p1}`);
  check('and the tiles grew back to their 2×2 size',
    w3 !== null && Math.abs(w3 - w1) <= 2, `tile width ${w1} → ${w3}`);

  await pinch(-1);
  const p2 = await level();
  check('the next pinch closes Exposé', p2 === 0, `level ${p2}`);

  await pinch(-1);
  const p3 = await level();
  check('a pinch with nothing open is a no-op', p3 === 0, `level ${p3}`);

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
