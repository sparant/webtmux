// Verification driver for UX batch 6. Five claims, each of which needs a real
// browser (the node tests cover the pure logic; these cover the WIRING — that the
// logic is reachable from the controls the user actually touches):
//
//   1. ⌃⌥L navigates even with an EMPTY capture cache — the after-a-reload bug. The
//      cache is cleared explicitly rather than by racing the sidebar's 2s capture
//      poll, because the empty cache IS the mechanism and a timing race would make
//      the test flaky in both directions.
//   2. Exposé's Show filter narrows the mosaic to one @wt_working state, and the
//      header's "N of M" tells the truth about it.
//   3. The two mouse-mode buttons are one dropdown, both gesture groups are in it,
//      and picking a row really changes the focused unit's mode.
//   4. Both sidebar panel toggles sit on ONE line (same offsetTop) with the short
//      labels.
//   5. Pasting a path into the rename input inserts the trimmed basename.
//
// Run exactly like run.sh does, with DRIVER=verify-ux6.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ---- reach-ins ---------------------------------------------------------------
// Every control lives one shadow root down, so document.querySelector never sees it.

const el = (tag) => (fn, arg) => page.evaluate(([t, f, a]) => {
  const node = document.querySelector(t);
  return eval(f)(node, node.shadowRoot, a);
}, [tag, fn.toString(), arg]);

const toolbar = el('webtmux-toolbar');
const sidebar = el('webtmux-sidebar');
const expose = el('webtmux-expose');
const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);

// tmux runs in THIS container, on the harness's private socket, so the driver can
// set the work statuses the Exposé filter is supposed to key off.
const tmux = (...args) => execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8' });

// Walk windows through the sidebar so each one is genuinely ACCESSED (the recency the
// MRU walk ranks by is only written on a real access). ↓ wraps within one session's
// list, so hop sessions with → every few steps.
async function walk(steps) {
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Control+Alt+w');
    await sleep(450);
    if (i % 3 === 2) { await page.keyboard.press('ArrowRight'); await sleep(800); }
    await page.keyboard.press('ArrowDown');
    await sleep(600);
    await page.keyboard.press('Enter');
    await sleep(600);
  }
}

// Hold ⌃⌥ and tap L, then release — the chord the walker is driven by. The release
// matters: _endMruCycle commits the landing window's recency.
async function tapMru() {
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyL');
  await sleep(400);
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(700);
}

async function openMouseMenu() {
  const open = await toolbar((n, rr) => !!rr.querySelector('.mouse-menu'));
  if (!open) await toolbar((n, rr) => { rr.querySelector('.tbtn.text').click(); });
  await sleep(200);
}

async function closeMouseMenu() {
  await toolbar((n, rr) => { rr.querySelector('.mouse-wrap .label-backdrop')?.click(); });
  await sleep(200);
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

  // ---- 1. the MRU chord with no captures -------------------------------------
  await walk(5);
  const before = await mgr((m) => m.focusedUnit?.layout?.activeWindowId);
  // Exactly the after-reload state: recency is known, the capture cache is not.
  const cleared = await mgr((m) => {
    m.captureCache.byPlacement.clear();
    m.captureCache.byWindow.clear();
    return { placements: m.captureCache.placementCount, recency: m.captureCache.accessed.size };
  });
  check('setup: capture cache emptied, recency kept',
    cleared.placements === 0 && cleared.recency > 1, JSON.stringify(cleared));
  await tapMru();
  const after = await mgr((m) => m.focusedUnit?.layout?.activeWindowId);
  check('⌃⌥L navigates with an EMPTY capture cache (the after-reload bug)',
    !!after && after !== before, `${before} -> ${after}`);
  // And tapping again comes back — the alt-tab property, which needs the landing
  // window's recency to have been committed on release.
  await tapMru();
  const back = await mgr((m) => m.focusedUnit?.layout?.activeWindowId);
  check('and tapping again returns to where you came from', back === before, `${after} -> ${back}`);

  // ---- 2. the Exposé Show filter ---------------------------------------------
  // Give three windows known statuses. The filter must count these, not the tiles it
  // happens to have already built.
  tmux('set-option', '-t', 'dev:build', '-w', '@wt_working', '1');
  tmux('set-option', '-t', 'dev:server', '-w', '@wt_working', '2');
  tmux('set-option', '-t', 'dev:tests', '-w', '@wt_working', '0');
  await sleep(1500);                        // one layout push carries allWorking

  await page.keyboard.press('Control+Alt+e');
  await sleep(2500);                        // tiles need a capture round
  const total = await expose((n) => n.cache.placementCount);
  const pickFilter = async (id) => {
    await expose((n, rr, want) => {
      const btns = [...rr.querySelectorAll('.sort .seg button')];
      const b = btns.find((x) => x.textContent.trim().toLowerCase() === want);
      if (b) b.click();
    }, id);
    await sleep(900);
    return expose((n, rr) => ({
      tiles: rr.querySelectorAll('.tile').length,
      head: [...rr.querySelectorAll('.head span')].map((s) => s.textContent.trim()).join(' | '),
      empty: rr.querySelector('.empty')?.textContent || '',
      filter: n._statusFilter,
    }));
  };

  const needs = await pickFilter('needs you');
  check('Exposé: "Needs you" shows only the amber window',
    needs.filter === 'attention' && needs.tiles === 1, `${needs.tiles} tiles, ${needs.head}`);
  check('and the header counts against the whole server',
    needs.head.includes(`1 of ${total}`), needs.head);

  const working = await pickFilter('working');
  check('Exposé: "Working" shows only the green window',
    working.filter === 'working' && working.tiles === 1, `${working.tiles} tiles`);

  const idle = await pickFilter('idle');
  check('Exposé: "Idle" shows only the red window',
    idle.filter === 'idle' && idle.tiles === 1, `${idle.tiles} tiles`);

  const all = await pickFilter('all');
  check('Exposé: "All" shows every window again',
    all.filter === 'all' && all.tiles === total, `${all.tiles} of ${total}`);

  // A status nothing reports must say so, rather than looking like an empty server.
  tmux('set-option', '-t', 'dev:server', '-w', '-u', '@wt_working');
  await sleep(1500);
  const none = await pickFilter('needs you');
  check('an empty status view explains itself',
    none.tiles === 0 && /No windows are/.test(none.empty), `"${none.empty}"`);
  await pickFilter('all');
  await page.keyboard.press('Escape');
  await sleep(600);

  // ---- 3. the mouse-capture dropdown ----------------------------------------
  const triggers = await toolbar((n, rr) => rr.querySelectorAll('.tbtn.text').length);
  check('the two gesture buttons are one dropdown trigger', triggers === 1, `${triggers} found`);

  await openMouseMenu();
  const menu = await toolbar((n, rr) => ({
    titles: [...rr.querySelectorAll('.mouse-menu .mtitle')].map((t) => t.textContent.trim()),
    mouse: rr.querySelectorAll('.mouse-menu .mitem[data-kind="mouse"]').length,
    scroll: rr.querySelectorAll('.mouse-menu .mitem[data-kind="scroll"]').length,
    hints: rr.querySelectorAll('.mouse-menu .mhint').length,
    marks: [...rr.querySelectorAll('.mouse-menu .mark')].filter((m) => m.textContent.trim()).length,
  }));
  check('it holds both gesture groups, titled', menu.titles.includes('click+drag:')
    && menu.titles.includes('copymode on scroll:'), menu.titles.join(' / '));
  check('four modes in each group, each with its own hint',
    menu.mouse === 4 && menu.scroll === 4 && menu.hints === 8, JSON.stringify(menu));
  check('exactly one ✓ per group', menu.marks === 2, `${menu.marks} marks`);

  await toolbar((n, rr) => {
    rr.querySelector('.mouse-menu .mitem[data-kind="mouse"][data-mode="buffer"]').click();
  });
  await sleep(500);
  const picked = await mgr((m) => m.focusedUnit?.mouseMode);
  check('picking a row sets the focused unit\'s mouse mode', picked === 'buffer', `got ${picked}`);
  await toolbar((n, rr) => {
    rr.querySelector('.mouse-menu .mitem[data-kind="scroll"][data-mode="buffer"]').click();
  });
  await sleep(500);
  const pickedScroll = await mgr((m) => m.focusedUnit?.scrollMode);
  check('and the scroll group sets the scroll mode', pickedScroll === 'buffer', `got ${pickedScroll}`);
  await closeMouseMenu();
  const label = await toolbar((n, rr) => rr.querySelector('.tbtn.text').textContent.trim());
  check('the closed button shows both current modes', label.includes('buf/buf'), label);
  // Put the defaults back so a later run/driver isn't inheriting this.
  await openMouseMenu();
  await toolbar((n, rr) => {
    rr.querySelector('.mouse-menu .mitem[data-kind="mouse"][data-mode="adaptive-probe"]').click();
    rr.querySelector('.mouse-menu .mitem[data-kind="scroll"][data-mode="adaptive-probe"]').click();
  });
  await sleep(400);
  await closeMouseMenu();

  // ---- 4. the sidebar's paired toggles --------------------------------------
  await page.keyboard.press('Control+Alt+w');
  await sleep(700);
  const pair = await sidebar((n, rr) => {
    const btns = [...rr.querySelectorAll('.mode-pair .mode-btn')];
    return {
      count: btns.length,
      tops: btns.map((b) => b.getBoundingClientRect().top),
      texts: btns.map((b) => b.textContent.trim()),
      // The destructive control must NOT be in the pair.
      closeInPair: btns.some((b) => b.textContent.includes('Close this region')),
    };
  });
  check('both panel toggles are in the pair', pair.count === 2, `${pair.count} buttons`);
  check('and they share one line', pair.count === 2 && Math.abs(pair.tops[0] - pair.tops[1]) < 2,
    JSON.stringify(pair.tops));
  check('with the short labels', /float|mount/.test(pair.texts[0]) && /pinned|auto hide/.test(pair.texts[1]),
    pair.texts.join(' / '));
  check('close-region is not one of them', pair.closeInPair === false);

  // ---- 5. paste-trim in the rename input ------------------------------------
  const pasted = await sidebar((n, rr) => {
    const row = rr.querySelector('.window-tab');
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
    return !!row;
  });
  await sleep(600);
  const renamed = await sidebar((n, rr) => {
    const input = rr.querySelector('.window-edit');
    if (!input) return { error: 'no rename input' };
    input.focus();
    input.value = '';
    const dt = new DataTransfer();
    dt.setData('text/plain', 'webtmux/plan-webtmux-portable-deps.md');
    input.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true, composed: true,
    }));
    return { value: input.value, caret: input.selectionStart };
  });
  check('pasting a path into the rename box inserts the trimmed name',
    renamed.value === 'plan-webtmux-portable-deps',
    `dblclick=${pasted}, got ${JSON.stringify(renamed)}`);
  check('and the caret lands after it, not selecting it',
    renamed.caret === 'plan-webtmux-portable-deps'.length, `caret=${renamed.caret}`);
  await page.keyboard.press('Escape');
  await sleep(300);

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
