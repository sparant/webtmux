// Verification driver for the split view: views split left | right AND top / bottom,
// the focused one wears a frame, each has a header strip whose controls appear when the
// pointer nears the top of the view (move the view left / right / up / down, close it),
// and picking a window always changes the FOCUSED view.
//
// The node tests pin the pure halves — the tree (test/split-tree.test.mjs) and the
// preview's "the focused view, nothing else" rule (test/hover-preview.test.mjs). This
// covers the wiring: a real toolbar, real regions and a real tmux server.
//
//   1. Single view: no header strip, no focus dots, and the split button is a ▾ menu
//      offering left | right and top / bottom.
//   2. Splitting from the menu and from ⌃⌥" builds row[ A, col[ B, C ] ], the newest
//      view focused and the only one framed. Once split, the menu also adds a view
//      across the whole screen: full width puts it under everything.
//   3. The header strip takes its own height (the terminal starts below it, nothing
//      overlaps), its controls are invisible until the pointer nears the top of the
//      view, and it offers exactly the directions there is a view in.
//   4. ↑ swaps the bottom-right view with the one above it; both keep their windows and
//      the moved view keeps the focus. (And in 2b: ↑ on a full-width bottom view moves
//      it to the top with the split beneath, every view keeping its size.)
//   5. A recents tab never grows a pane picker, previews in the FOCUSED view even for a
//      window last shown in another, and clicking a window another view shows trades
//      it into the focused view (no focus jump, no mirror).
//   6. A tab dropped on a view still puts the window there.
//   7. Dragging a top/bottom divider resizes vertically.
//   8. A reload brings the same shape back.
//   9. ✕ on a view closes it and focuses the next one; ✕ on the FIRST (primary) view
//      closes that view too — the primary moves into the next view's slot and shows its
//      window — down to one view, which has no ✕ at all.
//
// Run exactly like run.sh does, with DRIVER=verify-split-view.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const toolbar = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-toolbar');
  return eval(f)(el, el.shadowRoot, a);
}, [fn.toString(), arg]);
const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);

// What each unit shows, in `units` order, and the reading order of the views on screen.
const panes = () => mgr((m) => m.units.map((u) => u._targetWindowId || u.layout?.activeWindowId));
const order = () => mgr((m) => [...document.querySelectorAll('#app .region')].map((r) => m.units.findIndex((u) => u.region === r)));
const focusedIdx = () => mgr((m) => m.units.indexOf(m.focusedUnit));
const previewing = () => mgr((m) => m.units.findIndex((u) => u === m.hover.activeUnit));
// The shape as saved: nested {dir, kids} by unit index.
const shape = () => mgr((m) => m._splitView().tree);

// A view's header: its box, whether its controls are showing, and which it offers.
const head = (i) => mgr((m, n) => {
  const u = m.units[n];
  const h = u?.head;
  if (!h) return null;
  const hr = h.getBoundingClientRect();
  const tr = u.region.querySelector('.region-term').getBoundingClientRect();
  const btns = [...h.shadowRoot.querySelectorAll('.tbtn')];
  return {
    shown: getComputedStyle(h).display !== 'none' && hr.height > 0,
    top: hr.top, bottom: hr.bottom, left: hr.left, right: hr.right,
    termTop: tr.top,
    near: h.near,
    opacity: btns[0] ? getComputedStyle(btns[0]).opacity : null,
    buttons: btns.map((b) => b.className.replace('tbtn', '').trim()),
    label: h.shadowRoot.querySelector('.label')?.textContent || '',
    // The stoplight sits left of the label, and wears the same class as the window's dot
    // in the server-wide working map the recents tabs read.
    light: (() => {
      const d = h.shadowRoot.querySelector('.stoplight');
      const l = h.shadowRoot.querySelector('.label');
      if (!d || !l) return null;
      const id = u.layout?.activeWindowId;
      const want = m._work?.workingById?.get(id) ?? '';
      return { left: d.getBoundingClientRect().right <= l.getBoundingClientRect().left, cls: d.className, want };
    })(),
  };
}, i);
const headBtn = (i, cls) => mgr((m, [n, c]) => {
  const b = m.units[n].head.shadowRoot.querySelector(`.tbtn.${c}`);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, [i, cls]);
const framed = () => mgr(() => [...document.querySelectorAll('#app .region')].map(
  (r) => getComputedStyle(r, '::before').content !== 'none'));

async function hoverTab(id) {
  const i = await mgr((m, wid) => (m.toolbar.recent || []).findIndex((e) => e.id === wid), id);
  if (i < 0) return null;
  const box = await toolbar((el, rr, n) => {
    const r = rr.querySelectorAll('.rtab:not(.spare)')[n].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, i);
  await page.mouse.move(box.x, box.y);
  return box;
}

// Visit a window none of the views shows, in the focused view, and return its id.
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

// Hold ⌃⌥ and tap L, then release — the release commits the walk (_endMruCycle).
async function tapMru() {
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyL');
  await sleep(400);
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(1500);
}

async function clickView(i) {
  const c = await mgr((m, n) => {
    const r = m.units[n].region.querySelector('.region-term').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, i);
  await page.mouse.click(c.x, c.y);
  await sleep(400);
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

  // Start from a known state: no preview, no split, an empty strip — and the sidebar
  // collapsed (a fresh browser opens it floating over the right of the screen, on top of
  // the right-hand view's header).
  await mgr((m) => {
    m.sidebar.collapsed = true;
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    for (const u of m.units.slice(1)) m.removeUnit(u);
    for (const e of [...m.recentWindows]) m.removeRecent(e);
    m.setRecentsMax(5);
  });
  await sleep(1200);
  const visited = [];
  for (let i = 0; i < 5; i++) visited.push(await visitFresh());
  await sleep(600);

  // ---- 1. single view ------------------------------------------------------------
  check('single view: no header strip', (await head(0))?.shown === false);
  check('no focus dots on the toolbar', await toolbar((el, rr) => !rr.querySelector('.dots')));
  await toolbar((el, rr) => rr.querySelector('.split-wrap .tbtn').click());
  await sleep(300);
  const items = await toolbar((el, rr) => [...rr.querySelectorAll('.split-menu .mitem')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
  check('the split button opens a menu: left | right and top / bottom',
    items.length === 2 && /Left \| right/.test(items[0]) && /Top \/ bottom/.test(items[1]), JSON.stringify(items));

  // ---- 2. split both ways --------------------------------------------------------
  await toolbar((el, rr) => rr.querySelectorAll('.split-menu .mitem')[0].click());
  await sleep(3000);
  await page.keyboard.press('Control+Alt+Shift+Quote');
  await sleep(3000);
  const sh = await shape();
  check('menu then ⌃⌥" builds row[ A, col[ B, C ] ]',
    JSON.stringify(sh) === JSON.stringify({ dir: 'row', kids: [0, { dir: 'col', kids: [1, 2] }] }), JSON.stringify(sh));
  check('the newest view is focused', (await focusedIdx()) === 2);
  const fr = await framed();
  const ord = await order();
  check('only the focused view wears the frame', fr.filter(Boolean).length === 1 && fr[ord.indexOf(2)] === true, JSON.stringify(fr));
  const shown = await panes();
  check('three views, three different windows', new Set(shown).size === 3 && shown.every(Boolean), shown.join(' '));

  // ---- 2b. a view across the whole screen ------------------------------------------
  await toolbar((el, rr) => rr.querySelector('.split-wrap .tbtn').click());
  await sleep(300);
  const items2 = await toolbar((el, rr) => [...rr.querySelectorAll('.split-menu .mitem')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
  check('once split, the menu also offers full-height and full-width views',
    items2.length === 4 && /Full height/.test(items2[2]) && /Full width/.test(items2[3]), JSON.stringify(items2));
  await toolbar((el, rr) => rr.querySelectorAll('.split-menu .mitem')[3].click());
  await sleep(3000);
  const sh3 = await shape();
  check('full width puts a new view under EVERYTHING, not under one view',
    JSON.stringify(sh3) === JSON.stringify({ dir: 'col', kids: [{ dir: 'row', kids: [0, { dir: 'col', kids: [1, 2] }] }, 3] }), JSON.stringify(sh3));
  const wide = await mgr((m) => {
    const r = m.units[3].region.getBoundingClientRect();
    const all = document.querySelector('.split-root').getBoundingClientRect();
    return Math.abs(r.width - all.width) < 2;
  });
  check('…spanning the whole width', wide);
  // ↑ on it: the full-width view goes on top, the split it was under beneath — every
  // view keeping its size (sizes travel with the views, not with the slots).
  const dims = () => mgr((m) => m.units.map((u) => {
    const r = u.region.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  }));
  const before3 = await dims();
  await mgr((m) => { m.units[3].head.near = true; });
  await sleep(200);
  const up3 = await mgr((m) => {
    const b = m.units[3].head.shadowRoot.querySelector('.tbtn.up');
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(up3.x, up3.y, { steps: 3 });
  await page.mouse.click(up3.x, up3.y);
  await sleep(1200);
  const sh4 = await shape();
  check('↑ on the full-width view puts it on top, with the split beneath',
    JSON.stringify(sh4) === JSON.stringify({ dir: 'col', kids: [3, { dir: 'row', kids: [0, { dir: 'col', kids: [1, 2] }] }] }), JSON.stringify(sh4));
  const after3 = await dims();
  check('…and every view keeps its size', after3.every((d, i) => Math.abs(d[0] - before3[i][0]) <= 2 && Math.abs(d[1] - before3[i][1]) <= 2),
    `${JSON.stringify(before3)} -> ${JSON.stringify(after3)}`);
  const top3 = await mgr((m) => Math.round(m.units[3].region.getBoundingClientRect().top - document.querySelector('.split-root').getBoundingClientRect().top));
  check('…at the top of the screen', top3 <= 1, `${top3}px from the top`);
  await mgr((m) => m.moveRegion(m.units[3], 'down'));
  await sleep(800);
  check('↓ puts it back', JSON.stringify(await shape()) === JSON.stringify(sh3), JSON.stringify(await shape()));
  await mgr((m) => m.removeUnit(m.units[3]));
  await sleep(1500);
  check('closing it restores the shape it was added to',
    JSON.stringify(await shape()) === JSON.stringify({ dir: 'row', kids: [0, { dir: 'col', kids: [1, 2] }] }), JSON.stringify(await shape()));
  await mgr((m) => m.focus(m.units[2]));
  await sleep(300);

  // ---- 3. header strip -----------------------------------------------------------
  const hc = await head(2);
  check('the header strip is shown while split', hc?.shown === true);
  check('…and the terminal starts below it (nothing overlaps)', hc && hc.termTop >= hc.bottom - 0.5, `head bottom ${hc?.bottom}, term top ${hc?.termTop}`);
  await page.mouse.move((hc.left + hc.right) / 2, hc.bottom + 200, { steps: 4 });
  await sleep(300);
  check('controls stay hidden with the pointer mid-view', (await head(2)).opacity === '0', (await head(2)).opacity);
  await page.mouse.move((hc.left + hc.right) / 2, hc.bottom + 10, { steps: 4 });
  await sleep(400);
  const near = await head(2);
  check('…and appear as the pointer nears the top', near.near === true && near.opacity === '1', `near ${near.near} opacity ${near.opacity}`);
  check('bottom-right view offers ↑, ← and ✕ only',
    JSON.stringify([...near.buttons].sort()) === JSON.stringify(['close', 'move left', 'move up']), JSON.stringify(near.buttons));
  check('…and names its window', near.label.includes('window'), JSON.stringify(near.label));
  check('…with its stoplight to the left of the name', !!near.light?.left, JSON.stringify(near.light));
  const hA = await head(0);
  check('the left view offers → and ✕ only', JSON.stringify([...hA.buttons].sort()) === JSON.stringify(['close', 'move right']), JSON.stringify(hA.buttons));

  // ---- 4. move up ----------------------------------------------------------------
  const before = await panes();
  const up = await headBtn(2, 'up');
  await page.mouse.move(up.x, up.y, { steps: 3 });
  await page.mouse.click(up.x, up.y);
  await sleep(800);
  const sh2 = await shape();
  check('↑ swaps it with the view above',
    JSON.stringify(sh2) === JSON.stringify({ dir: 'row', kids: [0, { dir: 'col', kids: [2, 1] }] }), JSON.stringify(sh2));
  check('…both views keep their windows', JSON.stringify(await panes()) === JSON.stringify(before));
  check('…and the moved view keeps the focus', (await focusedIdx()) === 2);

  // ---- 5. the focused view gets the window ----------------------------------------
  await clickView(0);
  check('clicking a view focuses it', (await focusedIdx()) === 0);
  const p5 = await panes();
  const inB = p5[1];
  // Hover the tab of the window view B is showing: it previews in the FOCUSED view A.
  const box = await hoverTab(inB);
  await sleep(900);
  check('no pane picker grows off a hovered tab', await toolbar((el, rr) => !rr.querySelector('.rpick')));
  check('hovering a window another view shows previews it in the focused view', (await previewing()) === 0, `previewing ${await previewing()}`);
  const throb = await mgr((m) => m.units.map((u) => u.region.classList.contains('holds-hovered')
    && getComputedStyle(u.region, '::before').animationName));
  if (process.env.SHOT) await page.screenshot({ path: `/src/screenshots/harness/${process.env.SHOT}` });
  check('…and the view that already shows it throbs the focus frame',
    throb[1] === 'holds-hovered-throb' && !throb[0] && !throb[2], JSON.stringify(throb));
  await page.mouse.click(box.x, box.y);
  await sleep(2800);
  const p5b = await panes();
  check('clicking it brings it into the focused view', p5b[0] === inB, `${p5.join(' ')} -> ${p5b.join(' ')}`);
  check('…the other view takes the focused view\'s old window (a trade)', p5b[1] === p5[0], `${p5.join(' ')} -> ${p5b.join(' ')}`);
  check('…and no other view changed', p5b[2] === p5[2], await mgr((m) => JSON.stringify(m.units.map((u) => [u.layout?.sessionName, m.logicalSession(u), u.layout?.activeWindowId, u._targetWindowId]))));
  check('…and the focus did not jump', (await focusedIdx()) === 0);
  check('…and nothing throbs once it is picked', await mgr((m) => !document.querySelector('#app .region.holds-hovered')));
  // The windows sidebar previews through the same hover, so it throbs the holder too.
  await mgr((m) => { m.sidebar.collapsed = false; });
  await sleep(800);
  // The default sidebar lists the focused view's session, so aim at whichever other
  // view's window has a row there.
  const row = await mgr((m) => {
    for (const [n, u] of m.units.entries()) {
      if (u === m.focusedUnit) continue;
      const el = m.sidebar.renderRoot.querySelector(`.window-tab[data-win="${u.layout?.activeWindowId}"]`);
      if (!el) continue;
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return { n, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return null;
  });
  if (row) { await page.mouse.move(row.x, row.y); await sleep(1200); }
  const throbSb = await mgr((m) => m.units.map((u) => u.region.classList.contains('holds-hovered')));
  check('the split screen\'s sidebar has no close-view button (each view header has ✕)',
    await mgr((m) => ![...m.sidebar.renderRoot.querySelectorAll('button')].some((b) => /Close this/.test(b.textContent))));
  check('hovering a sidebar row for a window another view shows throbs that view',
    !!row && throbSb.every((t, i) => t === (i === row.n)), `${JSON.stringify(row)} ${JSON.stringify(throbSb)}`);
  await page.mouse.move(400, 500);
  await sleep(1200);
  check('…and stops when the pointer leaves the row', await mgr((m) => !document.querySelector('#app .region.holds-hovered')));
  await mgr((m) => { m.hover.cancel(); m.sidebar.collapsed = true; });
  await sleep(800);
  // A window that USED to be in view C, picked from A, lands in A — no stickiness.
  const wasInC = p5b[2];
  await clickView(2);
  const fresh = await visitFresh();
  await sleep(600);
  await clickView(0);
  const box2 = await hoverTab(wasInC);
  await sleep(900);
  check('a window last shown in another view still previews in the focused one', (await previewing()) === 0, `previewing ${await previewing()}`);
  await page.mouse.click(box2.x, box2.y);
  await sleep(2800);
  const p5c = await panes();
  check('…and lands there when clicked', p5c[0] === wasInC && p5c[2] === fresh, p5c.join(' '));
  await page.mouse.move(800, 880);
  await sleep(500);

  // ---- 5b. ⌃⌥L counts view switches and focuses the view holding a window ----------
  await clickView(1);
  const p5d = await panes();
  await tapMru();
  check('⌃⌥L after switching views goes back to the previous view', (await focusedIdx()) === 0, `focused ${await focusedIdx()}`);
  check('…without changing any view\'s window', JSON.stringify(await panes()) === JSON.stringify(p5d), `${p5d.join(' ')} -> ${(await panes()).join(' ')}`);
  await tapMru();
  check('…and again flips back', (await focusedIdx()) === 1, `focused ${await focusedIdx()}`);
  const fresh5 = await visitFresh();
  await sleep(600);
  await tapMru();
  const p5e = await panes();
  check('a window no view shows still loads into the focused view',
    !!fresh5 && p5e[1] === p5d[1] && p5e[0] === p5d[0] && p5e[2] === p5d[2] && (await focusedIdx()) === 1,
    `${fresh5} ${p5d.join(' ')} -> ${p5e.join(' ')}`);

  // ---- 6. drop a tab on a view ---------------------------------------------------
  const tabs = await mgr((m) => (m.toolbar.recent || []).map((e) => e.id));
  const target = tabs.find((id) => !p5c.includes(id));
  const drop = await page.evaluate(([wid]) => {
    const rr = document.querySelector('webtmux-toolbar').shadowRoot;
    const m = window.splitManager;
    const i = (m.toolbar.recent || []).findIndex((e) => e.id === wid);
    if (i < 0) return { ok: false };
    const tab = rr.querySelectorAll('.rtab:not(.spare)')[i];
    const dt = new DataTransfer();
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const region = m.units[1].region;
    region.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    region.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return { ok: true };
  }, [target]);
  await sleep(2800);
  check('a tab dropped on a view puts the window there', drop.ok && (await panes())[1] === target,
    `target ${target}, drop ${JSON.stringify(drop)}, panes ${(await panes()).join(' ')}, tabs ${JSON.stringify(await mgr((m) => (m.toolbar.recent || []).map((e) => e.id)))}`);

  // ---- 7. resize a top/bottom split ------------------------------------------------
  const dv = await mgr(() => {
    const d = document.querySelector('#app .divider.col');
    const r = d.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const hBefore = await mgr((m) => m.units[2].region.getBoundingClientRect().height);
  await page.mouse.move(dv.x, dv.y);
  await page.mouse.down();
  await page.mouse.move(dv.x, dv.y + 120, { steps: 8 });
  await page.mouse.up();
  await sleep(600);
  const hAfter = await mgr((m) => m.units[2].region.getBoundingClientRect().height);
  check('dragging the top/bottom divider resizes the views vertically', Math.abs(hAfter - hBefore - 120) < 12, `${hBefore} -> ${hAfter}`);

  // ---- 8. reload -----------------------------------------------------------------
  const shBefore = await shape();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(6000);
  const shAfter = await shape();
  check('a reload brings the same shape back', JSON.stringify(shAfter) === JSON.stringify(shBefore), `${JSON.stringify(shBefore)} vs ${JSON.stringify(shAfter)}`);
  const hReload = await mgr((m) => m.units[2]?.region.getBoundingClientRect().height);
  check('…and this browser\'s sizes', Math.abs(hReload - hAfter) < 12, `${hAfter} vs ${hReload}`);

  // ---- 9. close ------------------------------------------------------------------
  // Close the top-right view (unit 2): the next view in reading order takes the focus.
  const ord9 = await order();
  const after2 = ord9[ord9.indexOf(2) + 1];
  const cls = await headBtn(2, 'close');
  await page.mouse.move(cls.x, cls.y + 20, { steps: 3 });
  await page.mouse.move(cls.x, cls.y, { steps: 2 });
  await page.mouse.click(cls.x, cls.y);
  await sleep(1500);
  const units9 = await mgr((m) => m.units.length);
  check('✕ closes the view', units9 === 2);
  const focusedRegionOrder = await mgr((m) => [...document.querySelectorAll('#app .region')].indexOf(m.focusedUnit.region));
  check('…and the next view takes the focus', focusedRegionOrder === 1, `focused at ${focusedRegionOrder} (was after ${after2})`);

  // Close the primary's view: the other view's window stays on screen, in the primary.
  const keep = (await panes())[1];
  const pc = await headBtn(0, 'close');
  await page.mouse.move(pc.x, pc.y + 20, { steps: 3 });
  await page.mouse.move(pc.x, pc.y, { steps: 2 });
  await page.mouse.click(pc.x, pc.y);
  await sleep(3000);
  const last = await mgr((m) => ({ n: m.units.length, primary: m.units[0].primary, id: m.units[0]._targetWindowId || m.units[0].layout?.activeWindowId }));
  check('✕ on the first view closes it too', last.n === 1 && last.primary === true, JSON.stringify(last));
  check('…leaving the other view\'s window on screen', last.id === keep, `${last.id} vs ${keep}`);
  check('one view left: no header, no frame', (await head(0)).shown === false && (await framed()).every((f) => !f));

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
