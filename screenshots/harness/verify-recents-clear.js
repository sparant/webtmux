// Verification driver for "clear the recents strip".
//
// The bug it exists for, reported from real use: the strip would not empty. × on a
// tab frees a slot and the head of the off-strip queue immediately takes it (see
// recents-strip.js "the off-strip queue"), so clicking × down a strip backed by a
// 50-entry history deals the next card, over and over. There was no control
// addressed to the queue, and so no way to say "forget all of this".
//
// What is checked here is the half the node tests cannot reach — that the new
// control is wired to the real DOM, the real manager and the real shared blob:
//
//   1. The ✕ is reserved but invisible, and comes out on hover over the label.
//   2. It asks first, and answering No changes nothing.
//   3. Answering Clear empties EVERYTHING — tabs, queue, and the entries the
//      preview is holding — and nothing slides back into the freed slots.
//   4. The windows all keep running, and every split region keeps its view.
//   5. A previewed window's entry is gone for good: releasing the preview does not
//      put its tab back.
//   6. The "Recent ▾" label survives an empty strip, so the menu (and the way back)
//      is still reachable — and its clear row is disabled with nothing to clear.
//   7. The empty strip reaches @wt_state: it survives a reload.
//   8. The menu row clears too, and the strip refills normally afterwards.
//
// Run exactly like run.sh does, with DRIVER=verify-recents-clear.js.
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

// Drawn, remembered, waiting, and held by the preview — the whole feature is the
// difference between the four, so every assertion below reads all of them.
const strip = () => mgr((m) => ({
  tabs: (m.toolbar.recent || []).map((e) => e.id),
  entries: m.recentWindows.map((e) => e.id),
  queued: m.offStripRecents().map((e) => e.id),
  held: m.toolbar.recentHeld,
  total: m.toolbar.recentTotal,
}));
const rtabs = () => toolbar((el, rr) => rr.querySelectorAll('.rtab .tab').length);

// Visit `n` windows the strip does not already hold, newest last (lifted from
// verify-recents-queue.js — goToWindow, so the recency order is known).
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

// Hover the label so the ✕ is live, then click it. Real pointer events, so the
// reveal-on-hover CSS is under test rather than assumed.
async function openClearConfirm() {
  const box = await toolbar((el, rr) => {
    const b = rr.querySelector('.label-clear').getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await sleep(250);
  await page.mouse.click(box.x, box.y);
  await sleep(400);
}

const confirmShown = () => toolbar((el, rr) => {
  const c = rr.querySelector('.wt-confirm');
  return { open: !!c && c.classList.contains('show'), text: c ? c.textContent : '' };
});
const answer = (which) => toolbar((el, rr, w) =>
  rr.querySelector(`.wt-confirm button.${w}`).click(), which);

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  // A native confirm() regression would hang the run rather than fail it.
  page.on('dialog', (d) => { console.log('FAIL  native dialog:', d.message()); d.dismiss(); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  // The strip, the preview and the cap all ride the shared blob, so start from a
  // known state rather than from whatever the last driver left in tmux.
  await mgr((m) => {
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    for (const e of [...m.recentWindows]) m.removeRecent(e);
    m.setRecentsMax(5);
  });
  await sleep(800);

  const seen = await visitFresh(7);
  const full = await strip();
  check('setup: 5 tabs drawn, 7 remembered, 2 queued behind them',
    seen.length === 7 && full.tabs.length === 5 && full.entries.length === 7 && full.queued.length === 2,
    `tabs=${full.tabs.length} entries=${full.entries.length} queued=${full.queued.length}`);
  check('the manager reports the whole list, not just the tabs',
    full.total === 7, `recentTotal=${full.total}`);

  // ---- 1. reserved, invisible, and revealed on hover --------------------------
  const rest = await toolbar((el, rr) => {
    const b = rr.querySelector('.label-clear');
    const s = getComputedStyle(b);
    return { op: s.opacity, pe: s.pointerEvents, w: b.getBoundingClientRect().width };
  });
  check('the ✕ holds its space while invisible and takes no clicks',
    rest.op === '0' && rest.pe === 'none' && rest.w > 0,
    `opacity=${rest.op} pointer-events=${rest.pe} width=${rest.w.toFixed(1)}`);
  const lb = await toolbar((el, rr) => {
    const b = rr.querySelector('.label').getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.move(lb.x, lb.y);
  await sleep(350);
  const hovered = await toolbar((el, rr) => {
    const s = getComputedStyle(rr.querySelector('.label-clear'));
    return { op: s.opacity, pe: s.pointerEvents };
  });
  check('hovering the "Recent" label brings it out and makes it clickable',
    Number(hovered.op) > 0.9 && hovered.pe === 'auto',
    `opacity=${hovered.op} pointer-events=${hovered.pe}`);

  // ---- 2. it asks first, and No means no --------------------------------------
  await openClearConfirm();
  const asked = await confirmShown();
  check('clicking it asks before doing anything',
    asked.open && /Clear the recents strip\?/.test(asked.text), asked.text.slice(0, 60));
  check('…and the question names the windows with no tab, which is the confusion',
    /7 remembered windows/.test(asked.text) && /2 with none yet/.test(asked.text),
    asked.text.replace(/\s+/g, ' ').slice(0, 140));
  await answer('no');
  await sleep(400);
  const afterNo = await strip();
  check('answering No changes nothing at all',
    afterNo.entries.length === 7 && afterNo.tabs.length === 5 && (await rtabs()) === 5,
    `entries=${afterNo.entries.length} tabs=${afterNo.tabs.length}`);

  // ---- 3/4/5. Clear empties the whole list, preview included -------------------
  // Park one window in the preview first: its tab stands down, so it is exactly the
  // entry a "clear what I can see" would miss — and it would come back on its own.
  const previewed = full.tabs[0];
  await mgr((m, id) => {
    const e = m.recentWindows.find((x) => x.id === id);
    m.pip.addWindow(id, { index: e?.index, name: e?.name, session: e?.session });
  }, previewed);
  await sleep(900);
  const withPreview = await strip();
  check('setup: one window is held by the preview, so it draws no tab',
    withPreview.held === 1 && !withPreview.tabs.includes(previewed) && withPreview.total === 7,
    `held=${withPreview.held} total=${withPreview.total}`);

  const windowsBefore = await mgr((m) => (m._placements || []).length);
  const regionsBefore = await mgr((m) => m.units.map((u) => u.layout?.activeWindowId));

  await openClearConfirm();
  await answer('yes');
  await sleep(900);
  const cleared = await strip();
  check('Clear empties the tabs, the queue AND the preview-held entry',
    cleared.entries.length === 0 && cleared.tabs.length === 0
      && cleared.queued.length === 0 && cleared.total === 0,
    `entries=${cleared.entries.length} queued=${cleared.queued.length} held=${cleared.held}`);
  check('…and the DOM strip is empty, with nothing sliding into the freed slots',
    (await rtabs()) === 0, `${await rtabs()} tabs drawn`);
  check('every window is still running — only the strip forgot them',
    (await mgr((m) => (m._placements || []).length)) === windowsBefore,
    `${windowsBefore} placements before`);
  check('…and no split region was torn down or moved',
    JSON.stringify(await mgr((m) => m.units.map((u) => u.layout?.activeWindowId))) === JSON.stringify(regionsBefore),
    regionsBefore.join(' '));

  // Releasing the preview must NOT resurrect the tab it was standing in for.
  await mgr((m, id) => m.pip.removeWindow(id), previewed);
  await sleep(900);
  const released = await strip();
  check('releasing the preview does not bring the cleared window back',
    released.entries.length === 0 && released.tabs.length === 0,
    `entries=${released.entries.join(' ')}`);

  // ---- 6. the label (and so the way back) survives an empty strip --------------
  const doorway = await toolbar((el, rr) => ({
    label: !!rr.querySelector('.label'),
    clearDisabled: rr.querySelector('.label-clear')?.disabled,
  }));
  check('the "Recent ▾" label is still there with an empty strip',
    doorway.label === true, `label=${doorway.label}`);
  check('…and the ✕ is disabled, with nothing left to clear',
    doorway.clearDisabled === true, `disabled=${doorway.clearDisabled}`);
  await toolbar((el, rr) => rr.querySelector('.label').click());
  await sleep(300);
  const menu = await toolbar((el, rr) => {
    const item = [...rr.querySelectorAll('.label-menu .mitem')].find((b) => /Clear the strip/.test(b.textContent));
    return { present: !!item, disabled: item?.disabled, text: item?.textContent.trim() };
  });
  check('the menu carries the same clear, disabled while the strip is empty',
    menu.present && menu.disabled === true, `${menu.text} disabled=${menu.disabled}`);
  await toolbar((el, rr) => rr.querySelector('.label-backdrop')?.click());
  await sleep(300);

  // ---- 7. the empty strip is shared state, not a local illusion ---------------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(4500);
  const reloaded = await mgr((m) => m.recentWindows.map((e) => e.id));
  // The reload focuses a region, and focusing a window IS an access — so one tab is
  // legitimately back. What must not come back is the other six.
  check('a reload does not resurrect the cleared strip from @wt_state',
    reloaded.length <= 1, `entries=${reloaded.join(' ')}`);

  // ---- 8. the menu path clears too, and the strip refills normally after ------
  const refilled = await visitFresh(4);
  const beforeMenu = await strip();
  check('the strip refills normally after a clear',
    beforeMenu.entries.length >= 4, `entries=${beforeMenu.entries.length}`);
  await toolbar((el, rr) => rr.querySelector('.label').click());
  await sleep(300);
  await toolbar((el, rr) => [...rr.querySelectorAll('.label-menu .mitem')]
    .find((b) => /Clear the strip/.test(b.textContent)).click());
  await sleep(400);
  const askedAgain = await confirmShown();
  check('the menu row asks the same question',
    askedAgain.open && /Clear the recents strip\?/.test(askedAgain.text), askedAgain.text.slice(0, 50));
  await answer('yes');
  await sleep(900);
  const clearedTwice = await strip();
  check('…and clears the strip the same way',
    clearedTwice.entries.length === 0 && (await rtabs()) === 0,
    `entries=${clearedTwice.entries.join(' ')} refilled=${refilled.length}`);

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
