// Verification driver for "the preview bar's ORDER is yours — drag a tile where you
// want it".
//
// The node tests (test/preview-slots.test.mjs) pin dropInBar's arithmetic in the
// abstract. This driver covers the half they cannot reach: that the arithmetic is fed
// by a real pointer over real tiles, on both of the bar's axes, and that what comes out
// is what the bar DRAWS and what the shared blob keeps.
//
//   1. The bar draws its tiles in set order, and a drag moves one: dropped on the front
//      gap a tile is first, dropped past the last it is last.
//   2. The insertion line marks the gap the drop will land in — the promise the drop
//      then has to keep, including the "one lower" translation for a tile dragged
//      RIGHTWARDS past its own old place, which is where an off-by-one would live.
//   3. Dropping a tile back where it already is changes nothing (and writes nothing).
//   4. The axis follows the dock: a LEFT-docked bar is a column, and the same drag is
//      read from clientY. A driver that only ever tested a row would pass with the
//      coordinate hard-coded.
//   5. A floating corner box dragged onto the bar docks AT the gap it was dropped in —
//      the drag's other half, and the one the ▬ button cannot express.
//   6. The pinned windows are left pinned and are not renumbered by a bar reorder.
//   7. The order rides @wt_state: it survives a reload.
//   8. The drag is ours alone — a private MIME type, so the terminal regions (which
//      accept a RECENTS tab drop) do not light up for it and cannot swallow it.
//   9. And the whole gesture done once with a REAL pointer, because every check above
//      dispatches the events itself and so cannot see whether a .ptile starts a native
//      drag in the first place.
//
// Run exactly like run.sh does, with DRIVER=verify-preview-reorder.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);
const pip = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-pip');
  return eval(f)(el, el.shadowRoot, a);
}, [fn.toString(), arg]);

// The claim, read off the LIVE DOM rather than off the property bag: the bar's tiles in
// the order they are DRAWN, plus the marks a drag paints on them.
const drawn = () => pip((el, rr) => {
  const host = rr.querySelector('.tiles[data-slot="bar"]');
  const tiles = [...(host?.children || [])];
  return {
    edge: el.edge,
    bar: tiles.map((t) => t.dataset.window),
    // What the SET says, which is what gets persisted — asserted against `bar` so a
    // reorder that only moved DOM (or only moved state) cannot pass.
    set: (el._wins || []).map((w) => `${w.windowId}:${w.slot}`),
    dragging: tiles.filter((t) => t.classList.contains('dragging')).map((t) => t.dataset.window),
    before: tiles.filter((t) => t.classList.contains('drop-before')).map((t) => t.dataset.window),
    end: tiles.filter((t) => t.classList.contains('drop-end')).map((t) => t.dataset.window),
    barLit: !!rr.querySelector('.bar.dragging'),
  };
});

const slotsOf = () => pip((el) => Object.fromEntries((el._wins || []).map((w) => [w.windowId, w.slot])));

// A real HTML5 drag is not synthesisable with mouse events alone (Chromium's drag
// source is native), so the drag is driven by dispatching the events the handlers
// listen for, with one DataTransfer carried across all of them — the same technique
// verify-recents-target.js uses.
//
// `gap` names an insertion gap between the bar's tiles; the pointer is placed just
// past the near edge of the tile that follows it (or past the far edge of the last
// tile for the end gap), on whichever axis the bar is docked, so the coordinate the
// handler reads is a real position over real tiles and not an index we handed it.
async function dragTileToGap(id, gap, { drop = true } = {}) {
  return page.evaluate(([wid, g, doDrop]) => {
    const el = document.querySelector('webtmux-pip');
    const rr = el.shadowRoot;
    const bar = rr.querySelector('.bar');
    const host = rr.querySelector('.tiles[data-slot="bar"]');
    const tiles = [...(host?.children || [])];
    const src = rr.querySelector(`.ptile[data-window="${wid}"]`);
    if (!src) return { ok: false, why: 'no tile' };
    const vertical = el.edge === 'left' || el.edge === 'right';
    let x;
    let y;
    if (g < tiles.length) {
      const r = tiles[g].getBoundingClientRect();
      x = vertical ? r.left + r.width / 2 : r.left + 4;
      y = vertical ? r.top + 4 : r.top + r.height / 2;
    } else {
      const r = tiles[tiles.length - 1].getBoundingClientRect();
      x = vertical ? r.left + r.width / 2 : r.right - 4;
      y = vertical ? r.bottom - 4 : r.top + r.height / 2;
    }
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const types = [...dt.types];
    bar.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, dataTransfer: dt, clientX: x, clientY: y,
    }));
    if (!doDrop) return { ok: true, types, held: true };
    bar.dispatchEvent(new DragEvent('drop', {
      bubbles: true, dataTransfer: dt, clientX: x, clientY: y,
    }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return { ok: true, types };
  }, [id, gap, drop]);
}

// The one drag driven by the REAL mouse: pick the last bar tile up and drop it on the
// left half of the first one. Playwright turns this into a genuine HTML5 drag through
// Chromium's drag interception, so it is the only check here that exercises the
// browser's own decision to make a .ptile a drag source.
//
// A failure prints WHICH native events reached the shadow tree, because "timed out" on
// its own does not distinguish "the tile never became a drag source" from "the bar
// never accepted the drop".
async function nativeDragToFront(bar) {
  await pip((el, rr) => {
    window.__dragLog = [];
    for (const t of ['dragstart', 'dragover', 'drop', 'dragend']) {
      rr.addEventListener(t, () => {
        if (window.__dragLog[window.__dragLog.length - 1] !== t) window.__dragLog.push(t);
      }, true);
    }
  });
  const dst = `webtmux-pip .ptile[data-window="${bar[0]}"] .plabel`;
  try {
    const box = await page.locator(dst).boundingBox();
    await page.dragAndDrop(
      `webtmux-pip .ptile[data-window="${bar[bar.length - 1]}"] .pframe`,
      dst,
      { timeout: 20000, targetPosition: { x: 4, y: box.height / 2 } },
    );
    return true;
  } catch (e) {
    let log = [];
    try { log = await page.evaluate(() => window.__dragLog || []); } catch (_) {}
    check('setup: the real-pointer drag ran', false,
      `${String(e).split('\n')[0]} — native events seen: ${JSON.stringify(log)}`);
    return false;
  }
}

// End a drag that was deliberately left in the air (see the insertion-line checks).
const endDrag = (id) => pip((el, rr, a) => {
  const src = rr.querySelector(`.ptile[data-window="${a}"]`);
  src?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }));
  return true;
}, id);

// Does a terminal region claim a PREVIEW drag? It claims a recents-tab one, and the two
// must stay told apart — see PREVIEW_DRAG_TYPE / RECENT_DRAG_TYPE.
const offerToRegion = (id) => page.evaluate((wid) => {
  const rr = document.querySelector('webtmux-pip').shadowRoot;
  const src = rr.querySelector(`.ptile[data-window="${wid}"]`);
  const region = document.querySelector('#app .region');
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  region.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
  const marked = region.classList.contains('drop-target') || document.querySelector('#app').classList.contains('recent-drag');
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return marked;
}, id);

// SHOTS=1 writes the bar mid-drag into screenshots/verify/ (gitignored). Whether a 3px
// line inside a tile's edge reads as "it lands HERE" is not a DOM assertion — see the
// icon/colour gotchas in the harness README.
const shot = async (name, clip) => {
  if (!process.env.SHOTS) return;
  require('fs').mkdirSync('/src/screenshots/verify', { recursive: true });
  await page.screenshot({ path: `/src/screenshots/verify/reorder-${name}.png`, ...(clip ? { clip } : {}) });
};

// Put a window that is NOT previewed into the bar. Named rather than walked, because
// every check below turns on knowing exactly which tiles are in the bar and in what
// order.
async function addToBar(n) {
  const added = [];
  for (let i = 0; i < n; i++) {
    const id = await mgr(async (m) => {
      const inPip = new Set(m.pip.windowIds());
      const cur = m.focusedUnit?.layout?.activeWindowId;
      const p = (m._placements || []).find((x) => !inPip.has(x.id) && x.id !== cur);
      if (!p) return null;
      m.pip.addWindow(p.id, { index: p.index, name: p.name, session: p.session });
      return p.id;
    });
    if (!id) break;
    added.push(id);
    await sleep(600);
  }
  return added;
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

  // A previous run's preview rides the shared @wt_state blob, so start from a known
  // one: nothing previewed, bar docked at the bottom, and the right-edge sidebar
  // overlay parked so it cannot sit on the bar.
  await mgr((m) => {
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    m.pip.setEdge('bottom');
    for (const sb of document.querySelectorAll('webtmux-sidebar')) { sb.collapsed = true; sb.overlay = true; }
  });
  await sleep(800);

  const staged = await addToBar(4);
  check('setup: four windows in the docked bar', staged.length === 4, JSON.stringify(staged));
  let d = await drawn();
  check('the bar draws its tiles in set order',
    JSON.stringify(d.bar) === JSON.stringify(staged), `${JSON.stringify(d.bar)} vs ${JSON.stringify(staged)}`);

  // ---- 0. the gesture, once, from a REAL pointer ------------------------------
  // Every check below dispatches the drag events itself, which exercises the handlers
  // but takes for granted the one thing they cannot see: that the browser ever calls
  // dragstart on a .ptile at all. A tile whose frame is pointer-transparent over a live
  // xterm is exactly where that would fail — so the gesture is done once with the real
  // mouse, through Chromium's own drag interception.
  //
  // FIRST, deliberately: a native drag is the flakiest thing in this harness (a later
  // one, over a page also holding a floating corner box, crashed the renderer outright),
  // so it runs while the page is at its simplest and everything after it is driven the
  // way the rest of the harness drives a drag.
  await nativeDragToFront(staged);
  await sleep(1200);
  d = await drawn();
  const ids = d.bar;
  check('a REAL pointer drag — not a dispatched event — picks a tile up and moves it',
    JSON.stringify(ids) === JSON.stringify([staged[3], staged[0], staged[1], staged[2]]),
    `${JSON.stringify(staged)} -> ${JSON.stringify(ids)}`);

  // ---- 1. the insertion line, before any drop --------------------------------
  let r = await dragTileToGap(ids[3], 1, { drop: false });
  check('setup: a drag is in the air', r.ok, JSON.stringify(r));
  d = await drawn();
  check('the dragged tile is marked as being in the air', d.dragging.join() === ids[3], JSON.stringify(d.dragging));
  check('the bar says it is the target for the length of the drag', d.barLit);
  check('the insertion line marks the GAP the drop would land in',
    d.before.join() === ids[1] && d.end.length === 0, JSON.stringify({ before: d.before, end: d.end }));
  await shot('insertion-line');
  await endDrag(ids[3]);
  await sleep(400);
  d = await drawn();
  check('…and a drag that ends with no drop leaves no marks and no move',
    d.dragging.length === 0 && d.before.length === 0 && JSON.stringify(d.bar) === JSON.stringify(ids),
    JSON.stringify(d));

  // ---- 2. a tile dragged BACKWARDS lands in the gap the line promised --------
  r = await dragTileToGap(ids[3], 1);
  check('setup: dropped the last tile into the second gap', r.ok, JSON.stringify(r));
  await sleep(700);
  d = await drawn();
  let want = [ids[0], ids[3], ids[1], ids[2]];
  check('a tile dropped in an earlier gap lands in it',
    JSON.stringify(d.bar) === JSON.stringify(want), `${JSON.stringify(d.bar)} want ${JSON.stringify(want)}`);
  check('…and the SET agrees with what the bar drew',
    JSON.stringify(d.set) === JSON.stringify(want.map((i) => `${i}:bar`)), JSON.stringify(d.set));

  // ---- 3. …and FORWARDS, where the off-by-one lives -------------------------
  // Gap 3 counts the tiles as they are drawn NOW (…so "between the 3rd and the 4th").
  // Removing the dragged tile first shifts its followers down one, so the tile must
  // land 3rd — not 4th, which is where an untranslated gap would put it.
  r = await dragTileToGap(want[1], 3);
  check('setup: dragged a tile rightwards past two neighbours', r.ok, JSON.stringify(r));
  await sleep(700);
  d = await drawn();
  want = [want[0], want[2], want[1], want[3]];
  check('a tile dragged forwards lands in the gap the line promised, not one past it',
    JSON.stringify(d.bar) === JSON.stringify(want), `${JSON.stringify(d.bar)} want ${JSON.stringify(want)}`);

  // ---- 4. the end gap ---------------------------------------------------------
  r = await dragTileToGap(want[0], 4);
  check('setup: dragged the first tile past the last', r.ok, JSON.stringify(r));
  await sleep(700);
  d = await drawn();
  want = [want[1], want[2], want[3], want[0]];
  check('a tile dropped past the last one goes to the end',
    JSON.stringify(d.bar) === JSON.stringify(want), `${JSON.stringify(d.bar)} want ${JSON.stringify(want)}`);

  // ---- 5. a drop that changes nothing ----------------------------------------
  // Marked on the SET ITSELF rather than counted in the store: dropInBar answers a
  // no-op with null, and every write path downstream (the persist, the shared blob's
  // rev, the tile rebuild) hangs off _wins being replaced. If the array the mark was
  // stamped on is still there, none of it ran.
  await pip((el) => { el._wins.__mark = 'noop'; });
  r = await dragTileToGap(want[2], 2);
  check('setup: dropped a tile back into its own gap', r.ok, JSON.stringify(r));
  await sleep(700);
  d = await drawn();
  check('a tile dropped where it already is does not move',
    JSON.stringify(d.bar) === JSON.stringify(want), `${JSON.stringify(d.bar)} want ${JSON.stringify(want)}`);
  check('…and rewrites nothing (a no-op drag is not an edit to publish)',
    (await pip((el) => el._wins.__mark || null)) === 'noop');

  // ---- 6. the drag is ours alone ---------------------------------------------
  check('the drag rides its own private MIME type',
    (r.types || []).join() === 'application/x-webtmux-preview', JSON.stringify(r.types));
  check('a terminal region does not light up for a preview drag (it is not a recents tab)',
    (await offerToRegion(want[0])) === false);

  // ---- 7. a LEFT-docked bar is a column, read from clientY --------------------
  await mgr((m) => m.pip.setEdge('left'));
  await sleep(1200);
  d = await drawn();
  check('setup: the bar is docked to the left edge', d.edge === 'left' && d.bar.length === 4, JSON.stringify(d.bar));
  r = await dragTileToGap(want[3], 0);
  check('setup: dragged the bottom tile to the top of the column', r.ok, JSON.stringify(r));
  await sleep(700);
  d = await drawn();
  want = [want[3], want[0], want[1], want[2]];
  check('a column bar reorders on the vertical axis',
    JSON.stringify(d.bar) === JSON.stringify(want), `${JSON.stringify(d.bar)} want ${JSON.stringify(want)}`);
  await shot('column-bar');
  await mgr((m) => m.pip.setEdge('bottom'));
  await sleep(1200);

  // ---- 8. a corner box dragged onto the bar docks where it is dropped ---------
  const pinned = want[3];
  await pip((el, rr, a) => el.setSlot(a, 'tr'), pinned);
  await sleep(1200);
  let slots = await slotsOf();
  check('setup: one window pinned to a corner', slots[pinned] === 'tr', JSON.stringify(slots));
  d = await drawn();
  check('…and it left the bar', d.bar.length === 3 && !d.bar.includes(pinned), JSON.stringify(d.bar));

  r = await dragTileToGap(pinned, 1);
  check('setup: dragged the corner box onto the bar', r.ok, JSON.stringify(r));
  await sleep(900);
  d = await drawn();
  want = [want[0], pinned, want[1], want[2]];
  check('a corner box dropped on the bar docks AT the gap, not at the end',
    JSON.stringify(d.bar) === JSON.stringify(want), `${JSON.stringify(d.bar)} want ${JSON.stringify(want)}`);
  slots = await slotsOf();
  check('…and it is a bar tile now', slots[pinned] === 'bar', JSON.stringify(slots));

  // ---- 9. a reorder leaves the pinned windows pinned --------------------------
  const stillPinned = want[3];
  await pip((el, rr, a) => el.setSlot(a, 'bl'), stillPinned);
  await sleep(1200);
  r = await dragTileToGap(want[2], 0);
  check('setup: reordered the bar while one window sits in a corner', r.ok, JSON.stringify(r));
  await sleep(700);
  d = await drawn();
  want = [want[2], want[0], want[1]];
  check('reordering the bar leaves a pinned window pinned',
    JSON.stringify(d.bar) === JSON.stringify(want) && (await slotsOf())[stillPinned] === 'bl',
    `${JSON.stringify(d.bar)} want ${JSON.stringify(want)} / ${JSON.stringify(await slotsOf())}`);

  // ---- 10. the order rides @wt_state ------------------------------------------
  const beforeReload = (await drawn()).bar;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(6000);
  d = await drawn();
  check('the arranged order survives a reload',
    JSON.stringify(d.bar) === JSON.stringify(beforeReload),
    `before ${JSON.stringify(beforeReload)} after ${JSON.stringify(d.bar)}`);
  check('…and so does the window that was pinned',
    (await slotsOf())[stillPinned] === 'bl', JSON.stringify(await slotsOf()));

  await browser.close();
  const bad = results.filter((r2) => !r2.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
