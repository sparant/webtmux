// Verification driver for the link menu's third tmux setting: the
// `after-rename-window` hook — the tmux ability to RUN something when a window is
// renamed, and the per-window opt-in a well-built handler reads.
//
// What this checks, on the real UI against a real tmux server:
//   1. with no hook installed, the row is drawn and INERT, and says so — an
//      enabled checkbox over a server that has no hook is a control that cannot
//      do anything
//   2. with a hook installed, the row ticks and shows the command VERBATIM
//   3. the windows that opted in are listed, with their handler, under the row —
//      and windows that did not are not listed
//   4. unticking the row removes the hook FROM TMUX and stashes it; re-ticking
//      restores the same command, in order, and clears the stash
//   5. a per-window click moves that window's handler to the stash and back,
//      leaving the hook and every other window alone
//   6. a window whose last pushed name is stale is marked, and one that is in
//      sync is not
//
// Every assertion about state is made against TMUX, not against the UI's opinion
// of tmux: this feature is a tmux hook and a tmux option, and a UI agreeing with
// itself proves nothing.
//
// Run exactly like run.sh does, with DRIVER=verify-rename-hook.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const OUT = '/src/screenshots/verify';
const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const HOOK_CMD = 'run-shell -b "/tmp/on-rename-probe.sh \'#{window_id}\' \'#{window_name}\'"';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function tmux(...args) {
  try {
    return execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8' }).trim();
  } catch (e) {
    return `<error: ${e.message}>`;
  }
}
const hookLines = () => tmux('show-hooks', '-g')
  .split('\n').filter((l) => l.startsWith('after-rename-window['));
const winOpt = (win, name) => tmux('show-options', '-w', '-t', win, '-q', '-v', name);

const toolbar = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-toolbar');
  return eval(f)(el, el.shadowRoot, a);
}, [fn.toString(), arg]);

// Everything the rename row and its window list are saying, in one read. The row
// is found by its heading rather than by index, so adding a fourth setting above
// it does not silently re-point every assertion at the wrong control.
const rowState = () => toolbar((el, rr) => {
  const menu = rr.querySelector('.link-menu');
  if (!menu) return null;
  const row = [...menu.querySelectorAll('.mitem')]
    .find((b) => b.querySelector('b')?.textContent.includes('renamed'));
  if (!row) return null;
  return {
    ticked: row.getAttribute('aria-pressed') === 'true',
    disabled: row.hasAttribute('disabled'),
    hint: row.querySelector('.mhint')?.textContent.trim() || '',
    code: row.querySelector('.mcode')?.textContent.trim() || '',
    windows: [...menu.querySelectorAll('.rwin')].map((w) => ({
      label: w.querySelector('.rwname')?.textContent.trim() || '',
      handler: w.querySelector('.rwh')?.textContent.trim() || '',
      on: w.getAttribute('aria-pressed') === 'true',
      pending: !!w.querySelector('.rwpend'),
    })),
  };
});

const openMenu = async () => {
  await toolbar((el, rr) => {
    if (!el.linkMenuOpen) rr.querySelector('.spin').click();
  });
  await sleep(500);
};
const closeMenu = async () => {
  await toolbar((el) => { el.linkMenuOpen = false; });
  await sleep(150);
};
// Re-open so the menu re-asks tmux. Every assertion below is about what tmux
// says, so a stale answer from before a click would be indistinguishable from a
// click that did nothing.
const reopen = async () => { await closeMenu(); await openMenu(); };

const clickRow = async () => {
  await toolbar((el, rr) => {
    [...rr.querySelectorAll('.link-menu .mitem')]
      .find((b) => b.querySelector('b')?.textContent.includes('renamed'))?.click();
  });
  await sleep(700);
};
const clickWindow = async (label) => {
  await toolbar((el, rr, want) => {
    [...rr.querySelectorAll('.link-menu .rwin')]
      .find((w) => w.querySelector('.rwname')?.textContent.trim() === want)?.click();
  }, label);
  await sleep(700);
};

(async () => {
  const browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });
  page.on('pageerror', (e) => console.log('  [page exception]', e.message));
  await page.goto(URL.replace('//', '//wt:wt@'));
  await page.waitForSelector('webtmux-toolbar', { timeout: 15000 });
  await sleep(2500);

  // ── 1. no hook: the row is drawn, inert, and honest ────────────────────────
  await openMenu();
  let st = await rowState();
  check('the rename row exists in the tmux settings section', !!st);
  check('with no hook, the row is not ticked', st && !st.ticked, st && `ticked=${st.ticked}`);
  check('with no hook, the row is disabled rather than a dead control',
    st && st.disabled, st && `disabled=${st.disabled}`);
  check('with no hook, the row says nothing is hooked',
    st && /nothing is hooked/i.test(st.hint), st && st.hint.slice(0, 90));
  check('with no hook, no command block is shown', st && st.code === '', st && st.code);

  // ── 2/3. a hook and two opted-in windows ──────────────────────────────────
  await closeMenu();
  tmux('set-hook', '-ga', 'after-rename-window', HOOK_CMD);
  // Two windows opt in, one does not. The third is the control: a hook fires for
  // every window, and listing every window would make the list useless.
  const wins = tmux('list-windows', '-a', '-F', '#{window_id}|#{session_name}|#{window_name}')
    .split('\n').filter(Boolean).map((l) => l.split('|'));
  const [w1, w2, w3] = wins;
  tmux('set-option', '-w', '-t', w1[0], '@wt_rename_handler', 'claude-session');
  tmux('set-option', '-w', '-t', w1[0], '@wt_rename_target', '%0');
  tmux('set-option', '-w', '-t', w1[0], '@wt_rename_last', w1[2]); // in sync
  tmux('set-option', '-w', '-t', w2[0], '@wt_rename_handler', 'claude-session');
  tmux('set-option', '-w', '-t', w2[0], '@wt_rename_last', 'a-name-it-no-longer-has');

  await openMenu();
  st = await rowState();
  check('with a hook, the row is ticked', st && st.ticked);
  check('with a hook, the row is clickable', st && !st.disabled);
  check('the hook command is shown verbatim',
    st && st.code.includes('/tmp/on-rename-probe.sh'), st && st.code.slice(0, 80));
  const labels = (st?.windows || []).map((w) => w.label);
  check('both opted-in windows are listed', st && st.windows.length === 2, labels.join(', '));
  check('the window that did not opt in is absent',
    !labels.includes(`${w3[1]}:${w3[2]}`), labels.join(', '));
  check('each listed window names its handler',
    st && st.windows.every((w) => w.handler === 'claude-session'),
    (st?.windows || []).map((w) => w.handler).join(', '));

  // ── 6. the stale marker ───────────────────────────────────────────────────
  const inSync = (st?.windows || []).find((w) => w.label === `${w1[1]}:${w1[2]}`);
  const stale = (st?.windows || []).find((w) => w.label === `${w2[1]}:${w2[2]}`);
  check('a window whose last push matches its name is not marked pending',
    inSync && !inSync.pending);
  check('a window whose last push is stale IS marked pending',
    stale && stale.pending);

  await page.screenshot({ path: `${OUT}/rename-hook-menu.png` });

  // ── 4. the global switch, against tmux ────────────────────────────────────
  await clickRow();
  check('unticking removes the hook from tmux', hookLines().length === 0, hookLines().join(' | '));
  const stash = tmux('show-options', '-g', '-q', '-v', '@wt_rename_hook_saved');
  check('the hook is stashed, as JSON, before it is removed',
    stash.includes('/tmp/on-rename-probe.sh') && stash.trim().startsWith('['), stash.slice(0, 80));
  await reopen();
  st = await rowState();
  check('after unticking, the row is off but still clickable (there is something to restore)',
    st && !st.ticked && !st.disabled, st && `ticked=${st.ticked} disabled=${st.disabled}`);
  check('after unticking, the row offers the restore rather than claiming nothing exists',
    st && /remembered/i.test(st.hint), st && st.hint.slice(0, 90));

  await clickRow();
  const back = hookLines();
  check('re-ticking restores exactly one hook', back.length === 1, back.join(' | '));
  check('the restored hook is the command that was there',
    back[0] && back[0].includes('/tmp/on-rename-probe.sh'), back[0]);
  check('the stash is cleared once the hook is back',
    tmux('show-options', '-g', '-q', '-v', '@wt_rename_hook_saved') === '');

  // ── 5. the per-window switch ──────────────────────────────────────────────
  await reopen();
  await clickWindow(`${w1[1]}:${w1[2]}`);
  check('switching a window off clears its live handler',
    winOpt(w1[0], '@wt_rename_handler') === '', winOpt(w1[0], '@wt_rename_handler'));
  check('switching a window off stashes its handler',
    winOpt(w1[0], '@wt_rename_handler_saved') === 'claude-session',
    winOpt(w1[0], '@wt_rename_handler_saved'));
  check('the OTHER window is untouched',
    winOpt(w2[0], '@wt_rename_handler') === 'claude-session');
  check('the hook itself is untouched by a per-window click', hookLines().length === 1);

  await reopen();
  st = await rowState();
  const off = (st?.windows || []).find((w) => w.label === `${w1[1]}:${w1[2]}`);
  check('a switched-off window is still listed, unticked, still naming its handler',
    off && !off.on && off.handler === 'claude-session',
    off && `on=${off.on} handler=${off.handler}`);

  await clickWindow(`${w1[1]}:${w1[2]}`);
  check('switching it back on restores the handler',
    winOpt(w1[0], '@wt_rename_handler') === 'claude-session',
    winOpt(w1[0], '@wt_rename_handler'));
  check('switching it back on clears the hook\'s last-pushed guard',
    winOpt(w1[0], '@wt_rename_last') === '', winOpt(w1[0], '@wt_rename_last'));

  await reopen();
  await page.screenshot({ path: `${OUT}/rename-hook-windows.png` });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
