// Verification driver for what a Preview/PiP tile says when you point at it — which
// has to be what the recents tab says for the same window, at the same speed:
//
//   1. No native `title` anywhere in the preview. `title` waits ~1s and can't be told
//      to hurry; every hint is the shared Tip (600ms, the recents tab's delay).
//   2. Hovering a tile — the screen, not just the label — shows the full
//      "session — window N: name" first, then what the gestures do, in the recents
//      tab's format. It does NOT explain the stoplight colours.
//   3. The stoplight dot (now at the head of the label, where the recents tab has it)
//      is hoverable, and hovering IT is what explains the colours. Coming off it puts
//      the tile's own hint back.
//   4. With the view split, hovering a tile opens the region picker instead — one chip
//      per pane, the pane already holding the window marked, flush against the tile's
//      inward side. Hovering a chip previews the window in that pane; clicking it sends
//      the window there, and the picker then says which region it is in.
//
// The long window name also checks the reason the hint exists at all: the label strip
// ellipsis-clips a long name, and the hint is how you read the rest.
//
// Run exactly like run.sh does, with DRIVER=verify-pip-tile-tip.js.
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LONG_NAME = 'a-deliberately-long-tmux-window-name-meant-to-overflow-the-preview-tiles-label-strip';
const LEGEND_HEAD = 'Work status — set by the window itself';

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

// The centre of something inside a given tile ('' = the tile's frame).
const boxIn = (id, sel) => pip((el, rr, [wid, s]) => {
  const t = rr.querySelector(`.ptile[data-window="${wid}"]`);
  const e = t && t.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}, [id, sel]);

const tipState = () => pip((el, rr) => {
  const tip = rr.querySelector('.wt-tip');
  const r = tip.getBoundingClientRect();
  return { shown: tip.classList.contains('show'), text: tip.textContent, top: r.top, bottom: r.bottom };
});

const picker = () => pip((el, rr) => {
  const p = rr.querySelector('.rpick');
  if (!p) return null;
  const r = p.getBoundingClientRect();
  return {
    head: p.querySelector('.rpick-head')?.textContent.trim(),
    hint: p.querySelector('.rpick-hint')?.textContent.replace(/\s+/g, ' ').trim(),
    chips: [...p.querySelectorAll('.rslot')].map((b) => ({ here: b.classList.contains('here'), label: b.textContent.replace(/\s+/g, ' ').trim() })),
    top: r.top, bottom: r.bottom,
  };
});
const chipBox = (n) => pip((el, rr, i) => {
  const b = rr.querySelectorAll('.rpick .rslot')[i];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, n);

const panes = () => mgr((m) => m.units.map((u) => u._targetWindowId || u.layout?.activeWindowId));
const previewing = () => mgr((m) => m.units.findIndex((u) => u === m.hover.activeUnit));

async function main() {
  execSync(`tmux -S /tmp/wt.sock rename-window -t dev:editor "${LONG_NAME}"`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  // Known state: no preview, no split, bar at the bottom.
  await mgr((m) => {
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    for (const u of m.units.slice(1)) m.removeUnit(u);
    m.pip.setEdge('bottom');
  });
  await sleep(1000);

  // Two tiles: the long-named focused window, and one other.
  const ids = await mgr((m) => {
    const unit = m.focusedUnit;
    const a = unit?.layout?.activeWindowId;
    const b = (m._placements || []).find((p) => p.id !== a);
    if (!a || !b) return null;
    m.pip.addWindow(a, { session: m.logicalSession(unit) });
    m.pip.addWindow(b.id, { session: b.session, index: b.index, name: b.name });
    return { a, b: b.id };
  });
  check('setup: two windows in the preview bar', !!ids, JSON.stringify(ids));
  await sleep(2500);   // a real capture lands; _paint refreshes each label

  const wins = await pip((el) => el._wins.map((w) => ({ id: w.windowId, session: w.session, label: w.label })));
  const A = wins.find((w) => w.id === ids.a);
  const B = wins.find((w) => w.id === ids.b);
  const title = (w) => `${w.session} — window ${w.label}`;
  check('the long name really is clipped in the label strip',
    await pip((el, rr, id) => { const n = rr.querySelector(`.ptile[data-window="${id}"] .plabel .name`); return n.scrollWidth > n.clientWidth; }, A.id));

  // ---- 1. no native titles --------------------------------------------------------
  const titled = await pip((el, rr) => [...rr.querySelectorAll('[title]')].map((e) => e.className));
  check('nothing in the preview uses a native title', titled.length === 0, JSON.stringify(titled));

  // ---- 2. hovering the SCREEN shows the recents-format hint, at the recents' speed --
  const fA = await boxIn(A.id, '.pframe');
  await page.mouse.move(fA.x, fA.y, { steps: 4 });
  await sleep(300);
  const early = await tipState();
  check('the hint waits (not up at 300ms — sweeping the bar must not strobe)', early.shown === false);
  await sleep(450);   // 750ms total > TIP_DELAY 600
  const t = await tipState();
  check('hovering the tile\'s screen opens the hint by ~600ms', t.shown === true, JSON.stringify(t.text));
  check('…leading with the full "session — window N: name"', t.text.split('\n')[0] === title(A),
    `${JSON.stringify(t.text.split('\n')[0])} vs ${JSON.stringify(title(A))}`);
  check('…then what the gestures do, in the recents tab\'s words', /click to switch there · drag to reorder/.test(t.text), JSON.stringify(t.text));
  check('…and NOT the stoplight key', !t.text.includes(LEGEND_HEAD), JSON.stringify(t.text));
  const tileATop = await pip((el, rr, id) => rr.querySelector(`.ptile[data-window="${id}"]`).getBoundingClientRect().top, A.id);
  check('…placed above the tile (the bar is at the bottom)', t.bottom <= tileATop, `tip bottom ${t.bottom}, tile top ${tileATop}`);
  const hovered = await mgr((m) => m.hover?.windowId);
  check('the live hover-preview still engaged', hovered === A.id, hovered);

  // ---- 3. the dot explains the colours ---------------------------------------------
  const dot = await boxIn(A.id, '.plabel .pwork');
  check('the stoplight dot sits in the label strip', !!dot);
  await page.mouse.move(dot.x, dot.y, { steps: 3 });
  await sleep(200);   // a hint is already up, so it swaps at once
  const td = await tipState();
  check('hovering the dot shows the stoplight key', td.shown && td.text.includes(LEGEND_HEAD), JSON.stringify(td.text));
  await page.mouse.move(fA.x, fA.y, { steps: 3 });
  await sleep(200);
  const tb = await tipState();
  check('coming off the dot puts the tile\'s own hint back', tb.shown && tb.text.split('\n')[0] === title(A), JSON.stringify(tb.text));

  // A tile control answers fast too.
  const close = await boxIn(A.id, '.tbtn.close');
  await page.mouse.move(close.x, close.y, { steps: 3 });
  await sleep(200);
  const tc = await tipState();
  check('a tile button hints through the shared Tip', tc.shown && tc.text.startsWith('Remove from the preview'), JSON.stringify(tc.text));

  check('single view offers no region picker', (await picker()) === null);
  await page.mouse.move(800, 300, { steps: 4 });
  await sleep(700);

  // ---- 4. split view: the tile gets the region picker ------------------------------
  await mgr((m) => m.splitAdd());
  await sleep(3500);
  const before = await panes();
  check('setup: the view is split in two', before.length === 2, before.join(' '));

  const fB = await boxIn(B.id, '.pframe');
  await page.mouse.move(fB.x, fB.y, { steps: 4 });
  await sleep(450);   // > PICKER_DELAY 240
  const p1 = await picker();
  check('hovering a tile in split view opens the region picker (by ~240ms)', !!p1);
  check('…with one chip per pane', p1?.chips.length === 2, JSON.stringify(p1?.chips));
  check('…headed with the same "session — window N: name"', p1?.head === title(B), `${JSON.stringify(p1?.head)} vs ${JSON.stringify(title(B))}`);
  const tileBTop = await pip((el, rr, id) => rr.querySelector(`.ptile[data-window="${id}"]`).getBoundingClientRect().top, B.id);
  check('…flush against the tile\'s top edge (the pointer can walk into it)', p1 && Math.abs(p1.bottom - tileBTop) <= 1, `picker bottom ${p1?.bottom}, tile top ${tileBTop}`);
  const heldAt = before.indexOf(B.id);
  check('…marking the pane that holds the window, if any',
    p1 && p1.chips.every((c, i) => c.here === (i === heldAt)), `held at ${heldAt}: ${JSON.stringify(p1?.chips)}`);
  check('…while the tile\'s plain hint stays down', (await tipState()).shown === false);

  // Walk up into the picker, onto the chip of a pane that is NOT showing B.
  const target = heldAt === 1 ? 0 : 1;
  const cb = await chipBox(target);
  await page.mouse.move(fB.x, tileBTop + 2, { steps: 4 });
  await page.mouse.move(cb.x, cb.y, { steps: 6 });
  await sleep(900);
  check(`hovering chip ${target + 1} previews the window in pane ${target + 1}`, (await previewing()) === target, `previewing ${await previewing()}`);
  check('…and the picker stayed up on the way', !!(await picker()));

  await page.mouse.click(cb.x, cb.y);
  await sleep(2800);
  const after = await panes();
  check(`clicking it puts the window in pane ${target + 1}`, after[target] === B.id, `${before.join(' ')} -> ${after.join(' ')}`);
  check('…and the picker closed', (await picker()) === null);

  await page.mouse.move(800, 300, { steps: 4 });
  await sleep(600);
  await page.mouse.move(fB.x, fB.y, { steps: 4 });
  await sleep(450);
  const p2 = await picker();
  check('the picker now says which region the window is in',
    !!p2 && p2.chips[target]?.here === true && p2.hint.includes(`It is in region ${target + 1}`), JSON.stringify(p2));

  // The dot's key is still reachable with the picker up.
  const dotB = await boxIn(B.id, '.plabel .pwork');
  await page.mouse.move(dotB.x, dotB.y, { steps: 3 });
  await sleep(800);
  const tdb = await tipState();
  check('in split view the dot still explains the colours', tdb.shown && tdb.text.includes(LEGEND_HEAD), JSON.stringify(tdb.text));

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
