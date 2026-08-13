// Verification driver for "the strip is fitted, not scrolled".
//
// The node tests (test/recents-strip.test.mjs) pin the arithmetic — how many tabs fit
// in N pixels. They cannot see the thing that was actually wrong: the strip used to
// hand its overflow to a horizontal SCROLLBAR, so tabs went off the left edge of the
// toolbar, out of sight, still counted as tabs. A window flashing for attention could
// sit out there unseen, because the overflow arrow only speaks for windows with no tab
// at all.
//
// What this covers, against a real toolbar in a real browser at real widths:
//
//   1. At a wide viewport the strip draws the user's cap and NOTHING overflows —
//      scrollWidth === clientWidth, i.e. there is no scrollbar because there is
//      nothing to scroll.
//   2. Narrowing the window drops tabs until they fit, and never scrolls instead.
//   3. What was dropped is QUEUED, not closed: the remembered list is untouched.
//   4. Widening puts them back, in the same order they were in before.
//   5. The user's cap is untouched throughout — the width is a second, separate
//      constraint, and a narrow window must not rewrite a shared preference.
//   6. The terminal's own dead scrollbar is gone too (the white bar down the side of
//      the sidebar): the xterm viewport reserves no scrollbar width.
//
// Run exactly like run.sh does, with DRIVER=verify-recents-fit.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const SHOTS = '/src/screenshots/tmp-verify-fit';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Shadow-root reach-ins: every control is one shadow root down, so a document-level
// querySelector never sees it.
const toolbar = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-toolbar');
  return eval(f)(el, el.shadowRoot, a);
}, [fn.toString(), arg]);
const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);

// Drawn, remembered, waiting — plus both caps, because the whole point is that they
// are two different numbers that can disagree.
const strip = () => mgr((m) => ({
  tabs: (m.toolbar.recent || []).map((e) => e.id),
  entries: m.recentWindows.map((e) => e.id),
  queued: m.offStripRecents().map((e) => e.id),
  max: m.recentsMax,
  fit: m.recentsFit,
  cap: m.recentsCap(),
}));

// The strip's box, measured in the DOM. `over` is the number of pixels of tab that
// have nowhere to go — the scrollbar's reason to exist, and what must always be 0.
// The spare (the invisible width probe) is excluded: it is absolutely positioned, so
// it contributes nothing to scrollWidth, and it must not be counted as a drawn tab.
const stripBox = () => toolbar((el, rr) => {
  const tabs = rr.querySelector('.tabs');
  const drawn = [...rr.querySelectorAll('.rtab:not(.spare)')];
  return {
    client: tabs.clientWidth,
    scroll: tabs.scrollWidth,
    over: Math.max(0, tabs.scrollWidth - tabs.clientWidth),
    drawn: drawn.length,
    spares: rr.querySelectorAll('.rtab.spare').length,
    // Right edge of the last tab vs the right edge of the box: a tab that is clipped
    // rather than dropped would still pass a scrollWidth check on some engines.
    lastRight: drawn.length
      ? Math.round(drawn[drawn.length - 1].getBoundingClientRect().right)
      : 0,
    boxRight: Math.round(tabs.getBoundingClientRect().right),
  };
});

async function visitFresh(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const landed = await mgr(async (m) => {
      const held = new Set(m.recentWindows.map((e) => e.id));
      held.add(m.focusedUnit?.layout?.activeWindowId);
      const fresh = (m._placements || []).find((p) => !held.has(p.id));
      if (!fresh) return null;
      m.goToWindow(fresh.id, fresh.session);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (m.focusedUnit?.layout?.activeWindowId === fresh.id) break;
      }
      return fresh.id;
    });
    await sleep(800);
    if (landed) ids.push(landed);
  }
  return ids;
}

// Resize and let the ResizeObserver -> _fitStrip -> setRecentsFit round trip settle.
async function widen(width) {
  await page.setViewportSize({ width, height: 900 });
  await sleep(1500);
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  // Everything here rides the shared @wt_state blob, so start from a known state
  // rather than from whatever the last driver left in tmux.
  await mgr((m) => {
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    for (const e of [...m.recentWindows]) m.removeRecent(e);
    m.setRecentsMax(5);
  });
  await sleep(800);

  // ---- 1. wide: the cap is what limits the strip, and nothing overflows ---------
  const seen = await visitFresh(7);
  check('setup: seven distinct windows visited',
    seen.length === 7 && new Set(seen).size === 7, seen.join(' '));

  const wide = await strip();
  const wideBox = await stripBox();
  check('wide window: the strip draws the cap',
    wide.tabs.length === 5 && wideBox.drawn === 5,
    `cap=${wide.max} fit=${wide.fit} drawn=${wideBox.drawn}`);
  check('wide window: nothing to scroll',
    wideBox.over === 0 && wideBox.lastRight <= wideBox.boxRight,
    `scroll=${wideBox.scroll} client=${wideBox.client} lastRight=${wideBox.lastRight} boxRight=${wideBox.boxRight}`);
  check('the queued windows are probed for width, one at a time',
    wideBox.spares === 0 || wideBox.spares === 1, `${wideBox.spares} spares`);
  await page.screenshot({ path: `${SHOTS}/wide.png` });

  // ---- 2/3. narrow: tabs are dropped, not scrolled, and not closed --------------
  await widen(760);
  const narrow = await strip();
  const narrowBox = await stripBox();
  check('narrow window: fewer tabs than the cap',
    narrow.tabs.length < 5 && narrow.tabs.length >= 1,
    `${narrow.tabs.length} tabs at 760px (fit=${narrow.fit})`);
  check('narrow window: STILL nothing to scroll',
    narrowBox.over === 0 && narrowBox.lastRight <= narrowBox.boxRight,
    `scroll=${narrowBox.scroll} client=${narrowBox.client} lastRight=${narrowBox.lastRight} boxRight=${narrowBox.boxRight}`);
  check('the tabs that no longer fit are queued, not closed',
    narrow.entries.length === 7 && narrow.queued.length === 7 - narrow.tabs.length,
    `entries=${narrow.entries.length} queued=${narrow.queued.length}`);
  check('the drawn tabs are the head of the strip, in order',
    narrow.tabs.every((id, i) => id === wide.tabs[i]),
    `${narrow.tabs.join(' ')} vs ${wide.tabs.join(' ')}`);
  check('the user\'s own cap is untouched by the width',
    narrow.max === 5, `max=${narrow.max}`);
  await page.screenshot({ path: `${SHOTS}/narrow.png` });

  // ---- 4. widen: they come back, in the same order ------------------------------
  await widen(1600);
  const back = await strip();
  const backBox = await stripBox();
  check('widening puts the tabs back, unchanged and in order',
    back.tabs.length === 5 && back.tabs.every((id, i) => id === wide.tabs[i]),
    `${back.tabs.join(' ')} vs ${wide.tabs.join(' ')}`);
  check('…and still nothing to scroll', backBox.over === 0,
    `scroll=${backBox.scroll} client=${backBox.client}`);

  // ---- 5. the terminal's dead scrollbar ----------------------------------------
  const viewport = await page.evaluate(() => {
    const el = document.querySelector('.xterm-viewport');
    if (!el) return null;
    return { reserved: el.offsetWidth - el.clientWidth, colorScheme: getComputedStyle(document.documentElement).colorScheme };
  });
  check('the terminal viewport reserves no scrollbar width',
    viewport && viewport.reserved === 0, viewport ? `${viewport.reserved}px reserved` : 'no viewport found');
  check('the page declares a dark colour scheme (so any scrollbar left is dark)',
    viewport && /dark/.test(viewport.colorScheme || ''), viewport?.colorScheme);
  await page.screenshot({ path: `${SHOTS}/final.png` });

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
