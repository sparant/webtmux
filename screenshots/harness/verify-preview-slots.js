// Verification driver for "where a previewed window is drawn is a per-window CHOICE,
// not a function of how many windows are previewed".
//
// The node tests (test/preview-slots.test.mjs) pin the placement rules in the abstract.
// This driver covers the half they cannot reach: that the rules are wired to real
// surfaces, real controls and a real persisted blob, against a real tmux server.
//
//   1. ⌃⌥I on ONE window makes a BAR tile — the old preview drew a corner box here,
//      because one window was the only way to get one. The bar reserves its edge.
//   2. That single window can be pinned to a corner from the tile's own hover controls,
//      and the reserved edge is handed back when the bar empties.
//   3. A second window joins the BAR while the first stays pinned: both surfaces are on
//      screen at once, which the count-derived preview could never do.
//   4. TWO windows in TWO different corners at the same time.
//   5. Only VALID placements are offered: a corner another window holds is not drawn at
//      all, and a tile's own corner is drawn as the active one.
//   6. A pinned tile offers the way back to the bar; a bar tile does not (it is there).
//   7. ONE CODE PATH: the control cluster on a bar tile and on a corner box is the same
//      element, built by the same builder, with the same classes — asserted by moving
//      one window and comparing the DOM it produces on each surface.
//   8. ⌃⌥⇧I pins the focused window to a free corner, and unpins it back to the bar.
//   9. A corner box holding the window the focused pane is showing shrinks to the mini
//      self-preview hint; moving away restores it.
//  10. A corner box at the bar's edge clears the space the bar reserved, rather than
//      floating over the one surface built to cover nothing.
//  11. Placements survive a reload (they ride the shared @wt_state blob).
//
// Run exactly like run.sh does, with DRIVER=verify-preview-slots.js.
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

const current = () => mgr((m) => m.focusedUnit?.layout?.activeWindowId);

// Everything the feature is about, read off the LIVE DOM rather than off the property
// bag: which surface each window is drawn on, which surfaces exist, what the bar
// reserved, and — the assertion that matters most here — the exact control cluster each
// tile is showing.
const state = () => pip((el, rr) => {
  const cluster = (tile) => [...tile.querySelectorAll('.tctl .tbtn')].map((b) => ({
    cls: b.className, glyph: b.textContent, title: b.title,
  }));
  const tiles = {};
  for (const tile of rr.querySelectorAll('.ptile')) {
    const surface = tile.closest('.pipbox') ? tile.closest('.pipbox').getAttribute('corner') : 'bar';
    const box = tile.getBoundingClientRect();
    tiles[tile.dataset.window] = {
      surface, buttons: cluster(tile),
      rect: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
    };
  }
  const css = getComputedStyle(document.documentElement);
  return {
    mode: el.mode,
    edge: el.edge,
    slots: Object.fromEntries((el._wins || []).map((w) => [w.windowId, w.slot])),
    barOn: !!rr.querySelector('.bar.on'),
    boxesOn: [...rr.querySelectorAll('.pipbox.on')].map((b) => b.getAttribute('corner')),
    mini: [...rr.querySelectorAll('.pipbox.mini.on')].map((b) => b.getAttribute('corner')),
    tiles,
    reserved: {
      top: css.getPropertyValue('--wt-preview-top').trim(),
      bottom: css.getPropertyValue('--wt-preview-bottom').trim(),
      left: css.getPropertyValue('--wt-preview-left').trim(),
      right: css.getPropertyValue('--wt-preview-right').trim(),
    },
    viewportH: window.innerHeight,
  };
});

// The corner buttons a tile is offering, in order, with the active one flagged.
const offered = (s, id) => (s.tiles[id]?.buttons || [])
  .filter((b) => b.cls.includes('corner'))
  .map((b) => `${b.cls.match(/\b(tl|tr|bl|br)\b/)?.[1]}${b.cls.includes('active') ? '*' : ''}`);
const has = (s, id, cls) => (s.tiles[id]?.buttons || []).some((b) => b.cls.includes(cls));

// SHOTS=1 writes what the checks above can only describe into screenshots/verify/ (which
// is gitignored). Whether a cluster of six buttons is legible on a 300×160 bar tile, and
// whether "▬ back to the bar" reads as anything at all, are not claims a DOM assertion
// can make — see the icon/colour gotchas in the harness README.
const shot = async (name, clip) => {
  if (!process.env.SHOTS) return;
  require('fs').mkdirSync('/src/screenshots/verify', { recursive: true });
  await page.screenshot({ path: `/src/screenshots/verify/slots-${name}.png`, ...(clip ? { clip } : { fullPage: false }) });
};
// Park the pointer on a tile so its hover controls are up, then shoot just that tile.
// The tile is re-measured AFTER the hover: a mini self-preview box grows from 90px to
// 360 under the pointer, so a clip taken from the resting size would crop the very
// cluster the shot exists to show.
async function shotTileHovered(name, id) {
  if (!process.env.SHOTS) return;
  const sel = `webtmux-pip .ptile[data-window="${id}"]`;
  const at = await page.locator(sel).boundingBox();
  if (!at) return;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await sleep(1400);   // the mini box's 0.55s control delay + its 0.2s grow, plus slack
  const box = await page.locator(sel).boundingBox() || at;
  await shot(name, { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 });
  await page.mouse.move(4, 4);
  await sleep(400);
}

// Press a tile's button. Real DOM clicks, because a control that is only reachable by
// calling setSlot() directly is not the control the user has.
const clickBtn = (id, cls) => pip((el, rr, a) => {
  const b = rr.querySelector(`.ptile[data-window="${a.id}"] .tctl .tbtn.${a.cls}`);
  if (!b) return false;
  b.click();
  return true;
}, { id, cls });

// Go to a window that is NOT in the preview and not the one we're on. Named rather
// than walked (the sidebar's ↓ lands wherever it happens to point) because several
// checks below turn on exactly which window the focused pane is showing — the mini
// self-preview hint is the whole reason that matters.
async function goToFresh() {
  const landed = await mgr(async (m) => {
    const inPip = new Set(m.pip.windowIds());
    const cur = m.focusedUnit?.layout?.activeWindowId;
    const p = (m._placements || []).find((x) => !inPip.has(x.id) && x.id !== cur);
    if (!p) return null;
    m.goToWindow(p.id, p.session);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (m.focusedUnit?.layout?.activeWindowId === p.id) break;
    }
    return p.id;
  });
  await sleep(900);
  return landed;
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
  // one. The sidebar defaults to a right-edge hover overlay and would sit on top of a
  // right-docked bar; park it out of the way and dock the bar at the bottom.
  await mgr((m) => {
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    m.pip.setEdge('bottom');
    for (const sb of document.querySelectorAll('webtmux-sidebar')) { sb.collapsed = true; sb.overlay = true; }
  });
  await sleep(800);

  // ---- 1. one window, and it is a BAR tile ------------------------------------
  const a = await current();
  await page.keyboard.press('Control+Alt+i');
  await sleep(1200);
  let s = await state();
  check('⌃⌥I puts a SINGLE window in the docked bar, not a corner box',
    s.slots[a] === 'bar' && s.barOn && s.boxesOn.length === 0, JSON.stringify({ slots: s.slots, barOn: s.barOn, boxesOn: s.boxesOn }));
  check('…and the bar reserves its edge for it',
    s.reserved.bottom === '200px', JSON.stringify(s.reserved));
  check('…drawn as a real tile on the bar surface', s.tiles[a]?.surface === 'bar', JSON.stringify(Object.keys(s.tiles)));

  // ---- 2. its controls offer all four corners, and no way "back" to where it is --
  check('a bar tile offers all four corners', JSON.stringify(offered(s, a)) === JSON.stringify(['tl', 'tr', 'bl', 'br']),
    JSON.stringify(offered(s, a)));
  check('…none of them marked active (it is not in a corner)', !offered(s, a).some((c) => c.endsWith('*')));
  check('…and no "back to the bar" button, because it is in the bar', !has(s, a, 'tobar'));
  check('…but a close, always', has(s, a, 'close'));
  await shotTileHovered('bar-tile-controls', a);

  // ---- 2b. pin that one window to a corner from its own hover controls ---------
  check('setup: the tile\'s top-right button clicked', await clickBtn(a, 'tr'));
  await sleep(1400);
  s = await state();
  check('a SINGLE window can be a floating corner box',
    s.slots[a] === 'tr' && s.boxesOn.join() === 'tr' && !s.barOn, JSON.stringify({ slots: s.slots, boxesOn: s.boxesOn, barOn: s.barOn }));
  check('…and the emptied bar hands its reserved edge back',
    s.reserved.bottom === '0px', JSON.stringify(s.reserved));
  check('a pinned tile marks its own corner active and offers the way back',
    offered(s, a).includes('tr*') && has(s, a, 'tobar'), JSON.stringify(offered(s, a)));

  // ---- 3. a second window in the BAR while the first stays pinned -------------
  const b = await goToFresh();
  check('setup: went to a second window', !!b && b !== a, `${a} -> ${b}`);
  await page.keyboard.press('Control+Alt+i');
  await sleep(1400);
  s = await state();
  check('a bar tile and a corner box are on screen AT THE SAME TIME',
    s.slots[a] === 'tr' && s.slots[b] === 'bar' && s.barOn && s.boxesOn.join() === 'tr',
    JSON.stringify({ slots: s.slots, barOn: s.barOn, boxesOn: s.boxesOn }));

  // ---- 5/6. only valid placements are offered ---------------------------------
  check('the bar tile is NOT offered the corner the other window holds',
    JSON.stringify(offered(s, b)) === JSON.stringify(['tl', 'bl', 'br']), JSON.stringify(offered(s, b)));
  check('…and the pinned tile still sees its own corner, as the active one',
    JSON.stringify(offered(s, a)) === JSON.stringify(['tl', 'tr*', 'bl', 'br']), JSON.stringify(offered(s, a)));

  // ---- 7. ONE CODE PATH: the same cluster, moved between surfaces --------------
  // Record what the bar tile is showing, move that very window to a corner, and compare
  // the cluster it shows there. Same element, same classes, same glyphs, same titles —
  // only the placement-dependent parts (which corner is active, and the appearance of
  // "back to the bar") may differ, and they are exactly what the shared model computes.
  const kinds = (btns) => btns.map((x) => `${x.cls.replace(' active', '')}|${x.glyph}`).join(' ');
  const closeOf = (t) => JSON.stringify((t.buttons || []).find((x) => x.cls.includes('close')));
  const barCluster = kinds(s.tiles[b].buttons);
  const barClose = closeOf(s.tiles[b]);
  check('setup: the bar tile\'s bottom-left button clicked', await clickBtn(b, 'bl'));
  await sleep(1400);
  s = await state();
  const boxCluster = kinds(s.tiles[b].buttons);
  check('TWO windows pipped at once, in two different corners',
    s.slots[a] === 'tr' && s.slots[b] === 'bl' && s.boxesOn.sort().join() === 'bl,tr',
    JSON.stringify({ slots: s.slots, boxesOn: s.boxesOn }));
  // Same window, other surface: the cluster is identical except for the one button the
  // shared model says should appear — "back to the bar", which a bar tile has no use for.
  check('the corner box\'s controls are the bar tile\'s cluster plus exactly "back to the bar"',
    boxCluster === barCluster.replace('tbtn close|✕', 'tbtn tobar|▬ tbtn close|✕'),
    `bar: ${barCluster}\n      box: ${boxCluster}`);
  check('…and the close button is byte-identical on both surfaces',
    closeOf(s.tiles[b]) === barClose, `${barClose} vs ${closeOf(s.tiles[b])}`);
  check('…with the corner it now sits in marked active',
    offered(s, b).includes('bl*'), JSON.stringify(offered(s, b)));
  check('…drawn on the corner surface it names', s.tiles[b]?.surface === 'bl', JSON.stringify(s.tiles[b]?.surface));
  check('neither pipped tile offers the other\'s corner',
    !offered(s, a).includes('bl') && !offered(s, b).includes('tr'),
    `${JSON.stringify(offered(s, a))} / ${JSON.stringify(offered(s, b))}`);
  await shot('two-corners');            // two boxes, two corners, no bar
  await shotTileHovered('box-controls', b);

  // ---- 6b. "back to the bar" really goes back ---------------------------------
  check('setup: the "back to the bar" button clicked', await clickBtn(b, 'tobar'));
  await sleep(1400);
  s = await state();
  check('a pinned window goes back to the bar from its own controls',
    s.slots[b] === 'bar' && s.barOn && s.boxesOn.join() === 'tr' && s.reserved.bottom === '200px',
    JSON.stringify({ slots: s.slots, boxesOn: s.boxesOn, reserved: s.reserved.bottom }));

  // ---- 10. a corner box clears the space the bar reserved ---------------------
  check('setup: pinned to the bottom-left, over the bottom-docked bar', await clickBtn(a, 'bl'));
  await sleep(1400);
  s = await state();
  const box = s.tiles[a]?.rect;
  check('a corner box at the bar\'s edge sits ABOVE the bar, not on top of it',
    !!box && box.bottom <= s.viewportH - 200 + 1,
    `box bottom ${box && Math.round(box.bottom)} of ${s.viewportH}, bar reserves ${s.reserved.bottom}`);
  await shot('box-over-bar');           // a corner box and the docked bar, together

  // ---- 8. ⌃⌥⇧I pins and unpins the focused window ----------------------------
  // Go to a THIRD window and pin it straight from the keyboard.
  const c = await goToFresh();
  check('setup: went to a third window', !!c && c !== a && c !== b, `${c}`);
  await page.keyboard.press('Control+Alt+Shift+I');
  await sleep(1400);
  s = await state();
  check('⌃⌥⇧I pins the focused window straight to a free corner',
    ['tl', 'tr', 'br'].includes(s.slots[c]) && s.boxesOn.includes(s.slots[c]),
    JSON.stringify({ slots: s.slots, boxesOn: s.boxesOn }));
  check('…and the corner it took is not one already in use',
    s.slots[c] !== s.slots[a] && s.boxesOn.length === new Set(s.boxesOn).size, JSON.stringify(s.boxesOn));
  // 9. …and because we are LOOKING at that window, its box is the mini hint.
  check('a corner box of the window you are already looking at shrinks to the mini hint',
    s.mini.join() === s.slots[c], `mini=${JSON.stringify(s.mini)} focused slot=${s.slots[c]}`);

  await page.keyboard.press('Control+Alt+Shift+I');
  await sleep(1400);
  s = await state();
  check('⌃⌥⇧I again sends it back to the bar', s.slots[c] === 'bar' && s.barOn, JSON.stringify(s.slots));

  // 9b. …and a box holding a window you are NOT looking at is full size. Deliberately
  // moved to a window that is in no corner, so "not mini" is a claim about the hint and
  // not an accident of where a walk landed.
  const away = await goToFresh();
  check('setup: moved to a window that is not previewed', !!away && away !== a, `${away}`);
  s = await state();
  check('a corner box of a window you are not looking at is not mini',
    s.boxesOn.length > 0 && s.mini.length === 0, JSON.stringify({ boxesOn: s.boxesOn, mini: s.mini }));

  // ---- 11. placements survive a reload ---------------------------------------
  const sorted = (o) => JSON.stringify(Object.entries(o).sort());
  const before = (await state()).slots;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(6000);
  s = await state();
  check('every window comes back on the surface it was drawn on',
    sorted(s.slots) === sorted(before),
    `before ${JSON.stringify(before)} after ${JSON.stringify(s.slots)}`);
  check('…with both surfaces rebuilt', s.barOn && s.boxesOn.length > 0,
    JSON.stringify({ barOn: s.barOn, boxesOn: s.boxesOn }));

  // ---- 4b. ✕ takes a window out of the preview from either surface ------------
  const pinnedId = Object.keys(s.slots).find((id) => s.slots[id] !== 'bar');
  const barId = Object.keys(s.slots).find((id) => s.slots[id] === 'bar');
  check('setup: ✕ on a corner box', await clickBtn(pinnedId, 'close'));
  await sleep(1000);
  check('setup: ✕ on a bar tile', await clickBtn(barId, 'close'));
  await sleep(1000);
  s = await state();
  check('the same ✕ removes a window from either surface',
    !(pinnedId in s.slots) && !(barId in s.slots), JSON.stringify(s.slots));

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
