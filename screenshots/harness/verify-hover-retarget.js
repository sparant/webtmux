// Verification driver for "the preview follows the pointer, not the mouse events".
//
// A recents tab is a SLOT. The strip re-renders on every layout push and lit reuses
// the tab elements positionally, so the window a tab stands for changes underneath a
// motionless pointer — most obviously when × on a tab lets the head of the off-strip
// queue slide into the slot the pointer is already sitting on.
//
// Nothing in the DOM event model reports that: the pointer crossed no boundary, so
// no mouseleave/mouseenter fires, and the strip went on telling HoverPreview about
// the window that used to be there. The symptom is the one that was reported — after
// closing a tab you have to move the pointer OFF the tab that took its place and back
// again before it will preview.
//
// This driver is the only place that can catch it: the bug is entirely in the gap
// between the browser's hover state and the app's idea of it, so it needs a real
// pointer over a real strip. It never moves the mouse after the first hover — every
// assertion after that is about what the app does while the pointer sits still.
//
//   1. Baseline: pointing at a tab previews that window (in a real region, not just
//      as a recorded target). Without this the rest would pass on a dead strip.
//   2. × on the hovered tab, pointer left where it is: the queued window that takes
//      the slot is previewed, with no pointer movement at all.
//   3. A tab OTHER than the hovered one is removed, shifting the strip sideways under
//      the pointer: the preview follows the window that slid into the slot.
//   4. The strip shrinks past the pointer (nothing left to hover): the preview is
//      dropped rather than left up, held open by a hover that no longer exists.
//
// Run exactly like run.sh does, with DRIVER=verify-hover-retarget.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Longer than HoverPreview's ENTER_DELAY_MS plus a capture round trip, so a preview
// that is going to open has opened by the time anything is read.
const SETTLE_MS = 1400;

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

// What the strip holds, and what the preview controller is pointing at. `unit` is the
// evidence that a preview is really UP: a region has been lent to it and marked, which
// only happens once a fresh capture has landed.
const state = () => mgr((m) => ({
  tabs: (m.toolbar.recent || []).map((e) => e.id),
  queued: m.offStripRecents().map((e) => e.id),
  target: m.hover.windowId,
  unit: !!m.hover.activeUnit,
}));

// The tab elements the user can actually point at (the width probe is invisible and
// pointer-events: none, so it is not one of them).
const tabCentre = (i) => toolbar((el, rr, k) => {
  const t = rr.querySelectorAll('.rtab:not(.spare)')[k];
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}, i);

// The × inside a tab. Only rendered while the tab is hovered, so this must be read
// with the pointer already on it — which is exactly the situation under test.
const closeCentre = (i) => toolbar((el, rr, k) => {
  const c = rr.querySelectorAll('.rtab:not(.spare)')[k]?.querySelector('.close');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}, i);

// Visit `n` windows the strip does not already hold, newest last. Driven through
// goToWindow rather than the sidebar so no stray hover is involved in the setup.
async function visitFresh(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const landed = await mgr(async (m) => {
      const held = new Set(m.recentWindows.map((e) => e.id));
      held.add(m.focusedUnit?.layout?.activeWindowId);
      const fresh = (m._placements || []).find((p) => !held.has(p.id));
      if (!fresh) return null;
      m.goToWindow(fresh.id, fresh.session);
      for (let k = 0; k < 30; k++) {
        await new Promise((r) => setTimeout(r, 200));
        if (m.focusedUnit?.layout?.activeWindowId === fresh.id) break;
      }
      return fresh.id;
    });
    await sleep(700);
    if (landed) ids.push(landed);
  }
  return ids;
}

// A tab index that is safe to park the pointer on for the whole run:
//   • not the window the focused region already shows, and not one another region
//     holds — a preview of a window that is on screen deliberately draws nothing, so
//     it would prove only half of what these checks are about;
//   • its RIGHT-HAND NEIGHBOUR is previewable too, because that is the window that
//     slides into this slot when the strip closes up;
//   • not the first slot, so there is an earlier tab to remove in check 3.
async function hoverableIndex() {
  return mgr((m) => {
    const active = m.focusedUnit?.layout?.activeWindowId;
    const tabs = m.toolbar.recent || [];
    const free = (e) => e && e.id !== active && !e.disabled;
    for (let i = 1; i < tabs.length - 1; i++) if (free(tabs[i]) && free(tabs[i + 1])) return i;
    return tabs.findIndex(free);
  });
}

// "The preview is pointing at `want`" — and, unless `want` is the window the focused
// region is showing anyway, that it really opened in a region.
function previews(s, want, active) {
  return s.target === want && (s.unit || want === active);
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

  // The strip, the preview and the cap all ride the shared @wt_state blob, so start
  // from a known state rather than from whatever the last driver left in tmux.
  await mgr((m) => {
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    for (const e of [...m.recentWindows]) m.removeRecent(e);
    m.setRecentsMax(5);
  });
  await sleep(800);
  // More windows than the cap, so there is a queue to slide into a freed slot.
  await visitFresh(7);
  const filled = await state();
  check('setup: a full strip with windows queued behind it',
    filled.tabs.length === 5 && filled.queued.length >= 1,
    `tabs=${filled.tabs.length} queued=${filled.queued.length}`);

  // ---- 1. pointing at a tab previews it ---------------------------------------
  const active = await mgr((m) => m.focusedUnit?.layout?.activeWindowId);
  const idx = await hoverableIndex();
  const spot = await tabCentre(idx);
  await page.mouse.move(spot.x, spot.y);
  await sleep(SETTLE_MS);
  const hovered = await state();
  const wanted = filled.tabs[idx];
  check('pointing at a tab shows that window in a region',
    previews(hovered, wanted, active) && hovered.unit,
    `slot=${idx} target=${hovered.target} want=${wanted} region=${hovered.unit}`);

  // ---- 2. × on the hovered tab, pointer never moves ---------------------------
  // The × sits under the pointer that is already on this tab, so clicking it leaves
  // the pointer exactly where it was — on the slot the queued window is about to
  // take. Everything from here on is asserted with the mouse standing still.
  const x = await closeCentre(idx);
  check('the hovered tab shows its × (the control the report starts from)', !!x,
    x ? `${x.x},${x.y}` : 'not rendered');
  await page.mouse.move(x.x, x.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(SETTLE_MS);
  const after = await state();
  const slid = after.tabs[idx];
  // The strip closes UP: every later tab moves one slot left and the queue's head
  // takes the last slot. So the window now under the pointer is the one that was to
  // its right, and the strip is still full.
  check('the strip closes up under the pointer and the queue refills the last slot',
    slid === filled.tabs[idx + 1] && after.tabs.length === filled.tabs.length
      && after.tabs[after.tabs.length - 1] === filled.queued[0],
    `slot=${slid} want=${filled.tabs[idx + 1]} last=${after.tabs[after.tabs.length - 1]} queued=${filled.queued.join(' ')}`);
  check('…and the window that landed under the pointer is previewed, with no pointer movement',
    previews(after, slid, active),
    `target=${after.target} want=${slid} region=${after.unit}`);

  // ---- 3. the strip rearranges under a still pointer ---------------------------
  // Not the hovered tab this time: removing an EARLIER one shifts every later tab
  // one slot left, so the window under the pointer changes without the pointer or
  // the hovered tab being touched at all.
  const before3 = await state();
  const victim = await mgr((m, i) => {
    const gone = (m.toolbar.recent || [])[0];
    const e = gone && i > 0 ? m.recentWindows.find((r) => r.id === gone.id) : null;
    if (!e) return null;
    m.removeRecent(e);
    return e.id;
  }, idx);
  check('setup: an earlier tab was removed, shifting the strip', !!victim, `removed=${victim}`);
  await sleep(SETTLE_MS);
  const shifted = await state();
  const nowHere = shifted.tabs[idx];
  const active3 = await mgr((m) => m.focusedUnit?.layout?.activeWindowId);
  check('a sideways shift re-points the preview at whatever slid under the pointer',
    nowHere && nowHere !== before3.target && previews(shifted, nowHere, active3),
    `slot=${nowHere} was=${before3.target} target=${shifted.target} region=${shifted.unit}`);

  // ---- 4. the strip shrinks past the pointer -----------------------------------
  // Lowering the tab count takes the slot the pointer is on out of the strip
  // entirely: nothing is left under the pointer, and no element survives to fire a
  // mouseleave. A preview held open by a hover that has ceased to exist is the
  // mirror image of the reported bug, and the same sync has to catch it.
  await mgr((m) => m.setRecentsMax(1));
  await sleep(SETTLE_MS + 400);
  const shrunk = await state();
  check('a strip that shrinks past the pointer drops the preview instead of leaving it up',
    shrunk.tabs.length === 1 && !shrunk.target && !shrunk.unit,
    `tabs=${shrunk.tabs.length} target=${shrunk.target} region=${shrunk.unit}`);

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
