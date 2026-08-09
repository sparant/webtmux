// Verification driver for "a previewed window does not also spend a recents tab".
//
// The node tests (test/recents-strip.test.mjs) pin the pure rules — what is hidden,
// what the cap counts, what a drag means in tab coordinates. This driver covers the
// half they cannot reach: that the rules are wired to the controls the user presses,
// against a real tmux server and a real preview with real captures in it.
//
//   1. ⌃⌥I on the focused window takes its tab out of the strip — and the ENTRY is
//      still there, in place, held for later.
//   2. ⌃⌥H (tuck the preview away) brings every held tab straight back; showing the
//      preview again takes them away again. "In the preview" means SHOWING, not
//      "in its set".
//   3. ⌃⌥I again releases the window, and its tab comes back in the position it left
//      from — the arrangement is not re-derived, it was never lost.
//   4. The cap counts TABS: with one window previewed, visiting another refills the
//      strip to a full five tabs rather than settling for four.
//   5. ⌃⌥L still walks to a previewed window. Only the strip stands down; the MRU
//      chord walks the whole server, which is the entire point of it.
//   6. ⌃⌥N/P — the walk ALONG the strip — skips previewed windows, because a stop on
//      a tab that isn't there reads as a dropped keypress.
//   7. Previewing every recent window at once leaves the "Recent ▾" menu on screen
//      (it is the only way back to the tab-count control) and it says where the tabs
//      went.
//
// Run exactly like run.sh does, with DRIVER=verify-recents-preview.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
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

// What the user can see and what the app is holding — the whole feature is the gap
// between the two, so every assertion below reads both.
const strip = () => mgr((m) => ({
  tabs: (m.toolbar.recent || []).map((e) => e.id),          // drawn
  entries: m.recentWindows.map((e) => e.id),                // durable
  held: m.toolbar.recentHeld,
  previewed: m.pip.windowIds(),
}));
// …and the DOM, so a strip that only exists in the property bag can't pass.
const rtabs = () => toolbar((el, rr) => rr.querySelectorAll('.rtab').length);
const current = () => mgr((m) => m.focusedUnit?.layout?.activeWindowId);

// The staged tmux has 9 windows over 3 sessions; ↓ wraps within one session's list,
// so hop with → every few steps or the strip tops out at one session's windows.
async function walk(steps) {
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Control+Alt+w');
    await sleep(500);
    if (i % 3 === 2) { await page.keyboard.press('ArrowRight'); await sleep(900); }
    await page.keyboard.press('ArrowDown');
    await sleep(700);
    await page.keyboard.press('Enter');
    await sleep(700);
  }
}

// Go to a window the strip does NOT already hold, so "a new access" really is one.
// Walking the sidebar would land wherever ↓ happens to point, which is fine for
// filling the strip and useless for asserting that the strip GREW.
async function visitFresh() {
  const landed = await mgr(async (m) => {
    const held = new Set(m.recentWindows.map((e) => e.id));
    const fresh = (m._placements || []).find((p) => !held.has(p.id));
    if (!fresh) return null;
    m.goToWindow(fresh.id, fresh.session);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (m.focusedUnit?.layout?.activeWindowId === fresh.id) break;
    }
    return fresh.id;
  });
  await sleep(900);
  return landed;
}
// Hold ⌃⌥ and tap L `n` times, then release — ONE alt-tab run, returning the landing
// after each tap. It has to be one held run: the release commits the landing window's
// recency (_endMruCycle), so tap-release-tap-release only ping-pongs between the two
// most recent windows and never gets down the list.
async function walkMru(n) {
  const stops = [];
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('KeyL');
    await sleep(500);
    stops.push(await current());
  }
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(700);
  return stops;
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

  // A previous run's preview and strip ride the shared @wt_state blob, so start from
  // a known one rather than from whatever the last driver left in tmux.
  await mgr((m) => {
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    for (const e of [...m.recentWindows]) m.removeRecent(e);
  });
  await sleep(600);

  await walk(6);
  const full = await strip();
  check('setup: the strip is full at the default cap of 5',
    full.tabs.length === 5 && full.entries.length === 5, JSON.stringify(full));

  // ---- 1. ⌃⌥I: the tab stands down, the entry stays --------------------------
  const pinned = await current();
  await page.keyboard.press('Control+Alt+i');
  await sleep(900);
  const one = await strip();
  const domOne = await rtabs();
  check('previewing the focused window takes its tab out of the strip',
    !one.tabs.includes(pinned) && one.previewed.includes(pinned),
    `tabs=${one.tabs.length} previewed=${JSON.stringify(one.previewed)}`);
  check('and the DOM agrees — four tabs drawn, not five',
    domOne === 4 && one.tabs.length === 4, `${domOne} .rtab drawn`);
  check('the entry itself is untouched: held, not evicted',
    one.entries.includes(pinned) && one.entries.length === 5 && one.held === 1,
    `entries=${one.entries.length} held=${one.held}`);

  // ---- 2. tucking the preview away hands the tabs back -----------------------
  await page.keyboard.press('Control+Alt+h');
  await sleep(800);
  const hidden = await strip();
  check('hiding the preview brings the held tab straight back',
    hidden.tabs.includes(pinned) && hidden.tabs.length === 5 && hidden.held === 0,
    `tabs=${hidden.tabs.length} held=${hidden.held}`);
  await page.keyboard.press('Control+Alt+h');
  await sleep(800);
  const shown = await strip();
  check('and showing it again stands the tab down again',
    !shown.tabs.includes(pinned) && shown.held === 1, `tabs=${shown.tabs.length}`);

  // ---- 4. the cap counts TABS, not entries -----------------------------------
  // (Out of order deliberately: it needs the window still in the preview.)
  const fresh = await visitFresh();
  const refilled = await strip();
  const domRefilled = await rtabs();
  check('a window the strip did not hold refills it to five DRAWN tabs',
    !!fresh && refilled.tabs.includes(fresh) && refilled.tabs.length === 5 && domRefilled === 5,
    `${domRefilled} drawn, new=${fresh}`);
  check('…by growing the strip, not by evicting the held entry',
    refilled.entries.includes(pinned) && refilled.entries.length === 6,
    `entries=${refilled.entries.length}`);

  // ---- 5. ⌃⌥L still reaches a previewed window -------------------------------
  // Walk a whole held run and record every landing: the previewed window has to be
  // one of them. (One tap could land there by luck; a full run cannot miss it.)
  const seen = new Set(await walkMru(8));
  check('⌃⌥L still walks to the previewed window',
    seen.has(pinned), `landed on ${seen.size} windows: ${[...seen].join(' ')}`);

  // ---- 6. ⌃⌥N/P walk only the tabs -------------------------------------------
  const walked = new Set();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Control+Alt+n');
    await sleep(700);
    walked.add(await current());
  }
  check('⌃⌥N never stops on a window with no tab',
    !walked.has(pinned), `stops: ${walked.size}`);
  const tabsNow = (await strip()).tabs;
  check('…and it does reach the tabs that are there',
    [...walked].every((id) => tabsNow.includes(id)) && walked.size > 1,
    `${walked.size} stops among ${tabsNow.length} tabs`);

  // ---- 3. releasing the window puts the tab back where it was ----------------
  const beforeRelease = (await strip()).entries.indexOf(pinned);
  await mgr(async (m, id) => {
    const e = m.recentWindows.find((x) => x.id === id);
    m.goToWindow(id, e ? e.session : '');
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (m.focusedUnit?.layout?.activeWindowId === id) break;
    }
  }, pinned);
  await sleep(900);
  await page.keyboard.press('Control+Alt+i');
  await sleep(900);
  const released = await strip();
  check('releasing it from the preview brings its tab back',
    released.tabs.includes(pinned) && released.held === 0, JSON.stringify(released.tabs));
  check('…in the slot it left from, not appended',
    released.tabs.indexOf(pinned) === released.entries.indexOf(pinned)
    && released.entries.indexOf(pinned) === beforeRelease,
    `was ${beforeRelease}, now ${released.entries.indexOf(pinned)}`);

  // ---- 7. previewing EVERY recent window -------------------------------------
  // The "Recent ▾" button only renders when the strip has something in it, and it is
  // the only way to the tab-count control — so an all-previewed strip must keep it.
  const all = await mgr(async (m) => {
    for (const e of [...m.recentWindows]) {
      if (m.pip.hasWindow(e.id)) continue;
      m.goToWindow(e.id, e.session);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (m.focusedUnit?.layout?.activeWindowId === e.id) break;
      }
      m.toggleFocusedInPreview();
      await new Promise((r) => setTimeout(r, 300));
    }
    return { previewed: m.pip.windowIds().length, entries: m.recentWindows.length };
  });
  await sleep(1200);
  const empty = await strip();
  const domEmpty = await rtabs();
  const label = await toolbar((el, rr) => !!rr.querySelector('.label'));
  check('previewing every recent window empties the strip',
    domEmpty === 0 && empty.tabs.length === 0 && empty.held === empty.entries.length,
    `${domEmpty} tabs, held=${empty.held}/${empty.entries.length} (previewed ${all.previewed})`);
  check('and the "Recent ▾" menu is still on screen to explain it', label === true);

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
