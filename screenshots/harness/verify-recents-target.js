// Verification driver for "which SPLIT does this recents tab go to?".
//
// The node tests pin the pure halves — planRegionMove's exchange (test/region-move.mjs)
// and HoverPreview's named-region rules (test/hover-preview.test.mjs). This covers the
// half they can't reach: that a real toolbar, a real split and a real tmux server are
// wired to those rules.
//
// The gap it exists for: with the view split, the strip could say WHICH window but
// never WHICH PANE. Worse, a window already on screen in the other split could not be
// brought over at all — clicking its tab resolved to "that window is over there" and
// jumped you to it, which is the opposite of what was asked.
//
//   1. Splitting the view makes a hovered tab grow a region picker, one chip per pane,
//      and single view does not (there is nothing to choose).
//   2. Hovering a chip previews that window IN THAT PANE — including a window the
//      other pane is already showing, which the plain hover refuses to draw.
//   3. Clicking a chip lands the window in that pane.
//   4. Clicking the chip of a pane whose window is held by the OTHER pane trades the
//      two views: no pane ends up blank, and neither ends up mirroring the other.
//   5. Doing it again puts both panes back — the gesture is its own inverse.
//   6. Dropping the tab on a pane does the same thing as its chip, and every pane
//      advertises itself as a target for the length of the drag.
//
// Run exactly like run.sh does, with DRIVER=verify-recents-target.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Shadow-root reach-ins: every toolbar control is one shadow root down, so a
// document-level querySelector never sees it.
const toolbar = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-toolbar');
  return eval(f)(el, el.shadowRoot, a);
}, [fn.toString(), arg]);
const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);

// What each pane is showing, straight off the live layouts.
const panes = () => mgr((m) => m.units.map((u) => u._targetWindowId || u.layout?.activeWindowId));
// …and which pane, if any, is currently lent to a preview.
const previewing = () => mgr((m) => m.units.findIndex((u) => u === m.hover.activeUnit));

// Point at the tab for `id` the way a pointer does — hover() fires the real
// mouseenter, which is what opens the picker.
async function hoverTab(id) {
  const i = await mgr((m, wid) => (m.toolbar.recent || []).findIndex((e) => e.id === wid), id);
  if (i < 0) return false;
  const box = await toolbar((el, rr, n) => {
    const r = rr.querySelectorAll('.rtab:not(.spare)')[n].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, i);
  await page.mouse.move(box.x, box.y);
  return true;
}

const pickerChips = () => toolbar((el, rr) => {
  const p = rr.querySelector('.rpick');
  if (!p) return null;
  return [...p.querySelectorAll('.rslot')].map((b) => ({
    label: b.textContent.replace(/\s+/g, ' ').trim(),
    here: b.classList.contains('here'),
  }));
});

// Hover / click a chip through the real DOM, so the wiring is under test too.
const chipBox = (n) => toolbar((el, rr, i) => {
  const b = rr.querySelectorAll('.rpick .rslot')[i];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, n);

// Visit a window the strip does not hold yet, in the focused pane, and return its id.
async function visitFresh() {
  return mgr(async (m) => {
    const held = new Set(m.recentWindows.map((e) => e.id));
    for (const u of m.units) held.add(u.layout?.activeWindowId);
    const fresh = (m._placements || []).find((p) => !held.has(p.id));
    if (!fresh) return null;
    m.goToWindow(fresh.id, fresh.session);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (m.focusedUnit?.layout?.activeWindowId === fresh.id) break;
    }
    return fresh.id;
  });
}

// A real HTML5 drag is not synthesisable with mouse events alone (Chromium's drag
// source is native), so the drag is driven by dispatching the events the handlers
// listen for, with a DataTransfer that carries the same payload the tab writes.
async function dragTabOntoPane(id, paneIndex) {
  return page.evaluate(([wid, n]) => {
    const el = document.querySelector('webtmux-toolbar');
    const rr = el.shadowRoot;
    const m = window.splitManager;
    const i = (m.toolbar.recent || []).findIndex((e) => e.id === wid);
    if (i < 0) return { ok: false, why: 'no tab' };
    const tab = rr.querySelectorAll('.rtab:not(.spare)')[i];
    const dt = new DataTransfer();
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const lit = document.querySelector('#app').classList.contains('recent-drag');
    const region = document.querySelectorAll('#app .region')[n];
    region.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    const marked = region.classList.contains('drop-target');
    region.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return { ok: true, lit, marked, types: [...dt.types] };
  }, [id, paneIndex]);
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

  // The split, the strip and the preview all ride the shared @wt_state blob, so start
  // from a known state rather than from whatever the last driver left in tmux.
  await mgr((m) => {
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    for (const u of m.units.slice(1)) m.removeUnit(u);
    for (const e of [...m.recentWindows]) m.removeRecent(e);
    m.setRecentsMax(5);
  });
  await sleep(1200);

  // ---- 1. no split, no picker ------------------------------------------------
  // Four windows, not two: the split about to be added auto-picks a most-recently-used
  // window of its own, and the checks below need one left over that NEITHER pane has.
  const solo = await visitFresh();
  for (let i = 0; i < 3; i++) await visitFresh();
  await sleep(600);
  await hoverTab(solo);
  await sleep(700);
  check('single view offers no region picker — there is nothing to choose',
    (await pickerChips()) === null);
  await page.mouse.move(800, 700);
  await sleep(500);

  // ---- split the view --------------------------------------------------------
  await mgr((m) => m.splitAdd());
  await sleep(3500);
  const two = await panes();
  check('setup: the view is split across two panes showing different windows',
    two.length === 2 && two[0] && two[1] && two[0] !== two[1], two.join(' '));

  // A window neither pane is showing, to send around.
  const spare = await mgr((m) => {
    const shown = new Set(m.units.map((u) => u.layout?.activeWindowId));
    const e = m.recentWindows.find((x) => !shown.has(x.id));
    return e ? e.id : null;
  });

  check('setup: a window neither pane is showing is in the strip', !!spare, String(spare));
  await hoverTab(spare);
  await sleep(900);
  const chips = await pickerChips();
  check('a hovered tab now offers one chip per pane',
    Array.isArray(chips) && chips.length === 2, chips ? chips.map((c) => c.label).join(' | ') : 'no picker');

  // ---- 2. a chip previews in ITS pane ----------------------------------------
  const box1 = await chipBox(1);
  await page.mouse.move(box1.x, box1.y);
  await sleep(900);
  check('hovering the second chip previews the window in the SECOND pane',
    (await previewing()) === 1, `previewing pane ${await previewing()}`);

  // ---- 3. clicking a chip lands it there -------------------------------------
  await page.mouse.click(box1.x, box1.y);
  await sleep(2500);
  const landed = await panes();
  check('clicking that chip puts the window in that pane, leaving the other alone',
    landed[1] === spare && landed[0] === two[0], landed.join(' '));

  // ---- 4. a window the OTHER pane has is exchanged, not followed --------------
  // `spare` is now in pane 1. Ask for it in pane 0 — the case that had no answer.
  const before = await panes();
  await hoverTab(spare);
  await sleep(900);
  const heldChips = await pickerChips();
  check('the picker marks the pane that already has it',
    Array.isArray(heldChips) && heldChips[1]?.here === true && heldChips[0]?.here === false,
    heldChips ? heldChips.map((c) => `${c.label}${c.here ? '*' : ''}`).join(' | ') : 'no picker');
  const box0 = await chipBox(0);
  await page.mouse.click(box0.x, box0.y);
  await sleep(3000);
  const swapped = await panes();
  check('sending it to the other pane TRADES the two views',
    swapped[0] === spare && swapped[1] === before[0],
    `${before.join(' ')} -> ${swapped.join(' ')}`);
  check('…so neither pane is left blank and neither mirrors the other',
    swapped[0] && swapped[1] && swapped[0] !== swapped[1], swapped.join(' '));

  // ---- 5. the exchange is its own inverse ------------------------------------
  await hoverTab(spare);
  await sleep(900);
  const box1b = await chipBox(1);
  await page.mouse.click(box1b.x, box1b.y);
  await sleep(3000);
  check('doing it again puts both panes back exactly where they were',
    (await panes()).join() === before.join(), `${(await panes()).join(' ')} vs ${before.join(' ')}`);

  // ---- 6. dragging the tab onto a pane does the same ---------------------------
  await page.mouse.move(800, 700);
  await sleep(600);
  const preDrag = await panes();
  const drag = await dragTabOntoPane(spare, 0);
  await sleep(3000);
  check('every pane advertises itself as a target while a tab is in flight',
    drag.ok && drag.lit === true, JSON.stringify(drag));
  check('…and the pane under the pointer marks itself the drop target',
    drag.marked === true, JSON.stringify(drag));
  check('the drag carries a private type, not text/plain',
    Array.isArray(drag.types) && drag.types.includes('application/x-webtmux-recent')
      && !drag.types.includes('text/plain'), (drag.types || []).join(' '));
  const dropped = await panes();
  check('dropping the tab on a pane moves the window there, trading as the chip does',
    dropped[0] === spare && dropped[1] === preDrag[0],
    `${preDrag.join(' ')} -> ${dropped.join(' ')}`);

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
