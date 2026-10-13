// Verification driver for the hold-⌃⌥ help overlay (components/help-overlay.js).
//
//   1. A browser's first connection shows it unasked ('sticky'), with the intro.
//   2. Tapping the chord dismisses it, and a reload does not bring it back.
//   3. Holding the chord alone for 1.5 s shows it ('hold'); letting go hides it.
//   4. A key pressed during the hold cancels the reveal (that was a hotkey).
//   5. Pointing near the recents strip opens it into a note per part of a tab.
//   6. Hotkeys still work while it is up — ⌃⌥F opens Exposé — and the notes follow
//      (Exposé's controls are explained instead of the toolbar's).
//   7. Clicks still work while it is up (the sidebar toggle).
//   8. No two notes overlap and every note is on screen.
//
// Run exactly like run.sh does, with DRIVER=verify-help-overlay.js.
// Screenshots land in screenshots/help-*.png for a human look.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

let page;
const help = () => page.evaluate(() => {
  const el = document.querySelector('webtmux-help');
  const notes = [...el.shadowRoot.querySelectorAll('.note')].map((n) => {
    const r = n.getBoundingClientRect();
    return { key: n.dataset.key, unplaced: n.classList.contains('unplaced'), l: r.left, t: r.top, r: r.right, b: r.bottom };
  });
  const placed = Object.fromEntries([...el._placed.entries()].map(([k, v]) => [k, v.box]));
  const sizes = Object.fromEntries(el._sizes.entries());
  return { mode: el.mode, notes, vw: innerWidth, vh: innerHeight, placed, sizes };
});
const ids = (h) => h.notes.map((n) => n.key.split('|')[0]);
function geometryOk(h) {
  const placed = h.notes.filter((n) => !n.unplaced);
  for (const [i, a] of placed.entries()) {
    if (a.l < 0 || a.t < 0 || a.r > h.vw || a.b > h.vh) return `${a.key} off screen`;
    for (const b of placed.slice(i + 1)) {
      if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) return `${a.key} overlaps ${b.key} dom=${JSON.stringify([a, b])} placed=${JSON.stringify([h.placed[a.key.split('|')[0]], h.placed[b.key.split('|')[0]]])} sizes=${JSON.stringify([h.sizes[a.key], h.sizes[b.key]])}`;
    }
  }
  return '';
}
const holdChord = async () => { await page.keyboard.down('Control'); await page.keyboard.down('Alt'); };
const releaseChord = async () => { await page.keyboard.up('Alt'); await page.keyboard.up('Control'); };

// A wedged page would otherwise hang the run forever.
setTimeout(() => { console.log('FAIL  driver timed out'); process.exit(3); }, 480000).unref();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  await page.goto(URL.replace('http://', 'http://wt:wt@'));
  await sleep(3500);

  let h = await help();
  check('first connection shows the overlay', h.mode === 'sticky', `mode=${h.mode}`);
  check('first-run intro is drawn', ids(h).includes('intro'));
  check('toolbar sections are explained', ['recents', 'tools', 'status', 'shortcuts'].every((x) => ids(h).includes(x)), ids(h).join(','));
  check('first-run geometry clean', !geometryOk(h), geometryOk(h));
  await page.screenshot({ path: '/src/screenshots/help-first-run.png' });

  // The first-run overlay must survive a hotkey hold, then go on a clean tap.
  await holdChord(); await page.keyboard.press('b'); await releaseChord(); await sleep(300);
  check('a hotkey while first-run is up leaves it up', (await help()).mode === 'sticky');
  await page.keyboard.press('Control+Alt+b'); await sleep(200);
  await holdChord(); await sleep(150); await releaseChord(); await sleep(300);
  h = await help();
  check('tapping the chord dismisses first-run', h.mode === null, `mode=${h.mode}`);
  await page.reload(); await sleep(3500);
  check('reload does not show it again', (await help()).mode === null);

  // Visit a few windows so the recents strip has tabs to explain.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(async () => {
      const m = window.splitManager;
      const held = new Set(m.recentWindows.map((e) => e.id));
      held.add(m.focusedUnit?.layout?.activeWindowId);
      const fresh = (m._placements || []).find((p) => !held.has(p.id));
      if (fresh) m.goToWindow(fresh.id, fresh.session);
    });
    await sleep(1500);
  }

  // Hold to reveal.
  await page.mouse.move(700, 600);
  await holdChord(); await sleep(800);
  check('not yet after 0.8 s', (await help()).mode === null);
  await sleep(1100);
  h = await help();
  check('hold 1.9 s shows it', h.mode === 'hold', `mode=${h.mode}`);
  check('hold geometry clean', !geometryOk(h), geometryOk(h));
  await page.screenshot({ path: '/src/screenshots/help-hold.png' });

  // Point near the recents strip.
  const tabBox = await page.evaluate(() => {
    const r = document.querySelector('webtmux-toolbar').shadowRoot.querySelector('.tabs').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom };
  });
  await page.mouse.move(tabBox.x, tabBox.y + 40, { steps: 5 }); await sleep(500);
  h = await help();
  const det = ids(h).filter((x) => x.startsWith('recents.'));
  check('near the strip: tab parts explained', det.includes('recents.tab') && det.includes('recents.light'), det.join(','));
  check('other sections went compact', h.notes.some((n) => n.key.startsWith('tools|') && n.key.endsWith('|1|hold')));
  check('recents detail geometry clean', !geometryOk(h), geometryOk(h));
  await page.screenshot({ path: '/src/screenshots/help-recents.png' });

  // Near the right-hand tools.
  const toolBox = await page.evaluate(() => {
    const r = document.querySelector('webtmux-toolbar').shadowRoot.querySelector('.mode').getBoundingClientRect();
    return { x: r.left + 4, y: r.top + 4 };
  });
  await page.mouse.move(toolBox.x, toolBox.y, { steps: 5 }); await sleep(500);
  h = await help();
  check('near the tools: each button explained', ids(h).filter((x) => x.startsWith('tools.')).length >= 6, ids(h).filter((x) => x.startsWith('tools.')).join(','));
  check('tools geometry clean', !geometryOk(h), geometryOk(h));
  await page.screenshot({ path: '/src/screenshots/help-tools.png' });

  // Hotkey while up: Exposé.
  await page.keyboard.press('f'); await sleep(900);
  const exOpen = await page.evaluate(() => window.splitManager.expose.open);
  h = await help();
  check('⌃⌥F still opens Exposé under the overlay', exOpen);
  check('overlay stays up through the hotkey', h.mode === 'hold');
  check('Exposé controls explained', ids(h).includes('ex.head') && !ids(h).includes('recents'), ids(h).join(','));
  await page.mouse.move(500, 60, { steps: 4 }); await sleep(500);
  await page.screenshot({ path: '/src/screenshots/help-expose.png' });
  await page.keyboard.press('f'); await sleep(600);

  // Click while up: toggle the sidebar.
  const before = await page.evaluate(() => window.splitManager.sidebar.collapsed);
  const sbt = await page.evaluate(() => {
    const r = document.querySelector('webtmux-toolbar').shadowRoot.querySelector('.sidebar-toggle').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(sbt.x, sbt.y); await sleep(600);
  const after = await page.evaluate(() => window.splitManager.sidebar.collapsed);
  check('a click reaches the toolbar under the overlay', before !== after, `${before} -> ${after}`);
  h = await help();
  check('overlay still up after the click', h.mode === 'hold');
  if (after) { await page.mouse.click(sbt.x, sbt.y); await sleep(600); }
  if (!(await page.evaluate(() => window.splitManager.sidebar.collapsed))) {
    const sb = await page.evaluate(() => { const r = window.splitManager.sidebar.getBoundingClientRect(); return { x: r.left - 30, y: r.top + 200 }; });
    await page.mouse.move(sb.x, sb.y, { steps: 4 }); await sleep(500);
    h = await help();
    check('near the sidebar: its parts explained', ids(h).filter((x) => x.startsWith('sb.')).length >= 4, ids(h).filter((x) => x.startsWith('sb.')).join(','));
    check('sidebar geometry clean', !geometryOk(h), geometryOk(h));
    await page.screenshot({ path: '/src/screenshots/help-sidebar.png' });
  }

  // More states, all while still holding: preview bar, copy panel, split view.
  await page.mouse.move(400, 500, { steps: 3 });
  await page.keyboard.press('i'); await sleep(1500);
  h = await help();
  check('preview bar explained', ids(h).includes('bar'), ids(h).join(','));
  await page.keyboard.press('Equal'); await sleep(900);
  h = await help();
  check('copy panel explained', ids(h).includes('copy'), ids(h).join(','));
  await page.keyboard.press('Equal'); await sleep(600);
  await page.keyboard.press('Enter'); await sleep(2500);
  h = await help();
  check('split view: regions and divider explained', ids(h).includes('term') && ids(h).some((x) => x.startsWith('divider.')) && ids(h).some((x) => /^term\.\d/.test(x)), ids(h).join(','));
  check('states geometry clean', !geometryOk(h), geometryOk(h));
  await page.screenshot({ path: '/src/screenshots/help-split.png' });
  const bar = await page.evaluate(() => { const b = window.splitManager.pip.shadowRoot.querySelector('.bar.on'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  if (bar) {
    await page.mouse.move(bar.x, bar.y, { steps: 4 }); await sleep(600);
    h = await help();
    check('near the preview bar: its parts explained', ids(h).filter((x) => x.startsWith('bar.')).length >= 3, ids(h).filter((x) => x.startsWith('bar.')).join(','));
    await page.screenshot({ path: '/src/screenshots/help-bar.png' });
  }
  await page.keyboard.press('x'); await sleep(800);
  await page.keyboard.press('i'); await sleep(800);
  await page.mouse.move(400, 500, { steps: 3 });

  await releaseChord(); await sleep(300);

  // A menu open (transparent click-away backdrop) must not blank the overlay.
  const save = await page.evaluate(() => { const r = document.querySelector('webtmux-toolbar').shadowRoot.querySelector('.tbtn[aria-label^="Save pane"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(save.x, save.y); await sleep(500);
  await page.mouse.move(300, 600);
  await holdChord(); await sleep(1900);
  h = await help();
  check('with a menu open the toolbar is still explained', ids(h).includes('recents') && ids(h).includes('tools'), ids(h).join(','));
  const sbOpen = !(await page.evaluate(() => window.splitManager.sidebar.collapsed));
  check('…and so is the sidebar under its click-away backdrop', !sbOpen || ids(h).includes('sidebar'), `sidebar open=${sbOpen}`);
  await releaseChord(); await sleep(300);
  await page.mouse.click(300, 600); await sleep(300);

  check('letting go hides it', (await help()).mode === null);

  // A key during the hold cancels.
  await holdChord(); await sleep(400); await page.keyboard.press('b'); await sleep(1600);
  check('a hotkey during the hold cancels the reveal', (await help()).mode === null);
  await releaseChord();
  await page.keyboard.press('Control+Alt+b');

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
