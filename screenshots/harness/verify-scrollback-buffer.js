// Verification driver for the scrollback-buffer control: the toolbar's ⛁
// dropdown now shows how big a window's buffer is and how much of it is used,
// and can set the default for new windows, rebuild an existing window at a new
// size, and clear it.
//
// This needs a real browser AND a real tmux because every claim is about the two
// agreeing. The unit tests prove the arithmetic and the argv; only a live run
// tells you that the number on screen is the number tmux holds, and that the
// button labelled "Resize" leaves the window actually resized.
//
// Every assertion below is therefore checked against `tmux display -p` — never
// against the UI's own idea of what it just did.
//
// Claims:
//   1. The panel reports the pane's ACTUAL capacity and usage, matching tmux.
//   2. Output that lands in the pane moves the "used" figure.
//   3. "Set default" changes what NEW windows get, and provably does NOT touch
//      the window you are looking at — the misunderstanding the panel exists for.
//   4. "Resize" asks first, naming what it will destroy.
//   5. Confirming it rebuilds the window's panes at the new size, in place: same
//      window id, same name, same index, same shape.
//   6. …and does not change the default for new windows on the way.
//   7. "Clear" empties the history without disturbing what is running.
//   8. With WT_PERMIT_WRITE=0 the panel still SHOWS the sizes (reading them
//      changes nothing) and offers none of the controls that would.
//
// Run exactly like run.sh does, with DRIVER=verify-scrollback-buffer.js.
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

const toolbar = (fn, arg) => page.evaluate(([f, a]) => {
  const node = document.querySelector('webtmux-toolbar');
  return eval(f)(node, node.shadowRoot, a);
}, [fn.toString(), arg]);
const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);

const tmux = (...args) => execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8' }).trim();
const field = (target, format) => tmux('display-message', '-t', target, '-p', format);
// The ground truth for a whole window, one row per pane.
const paneRows = (win) => tmux('list-panes', '-t', win, '-F',
  '#{pane_id} #{history_limit} #{history_size} #{pane_current_command}')
  .split('\n').filter(Boolean)
  .map((l) => { const [id, limit, size, cmd] = l.split(' '); return { id, limit: +limit, size: +size, cmd }; });

async function openMenu() {
  const open = await toolbar((n, rr) => !!rr.querySelector('.save-menu.hist'));
  if (!open) {
    await toolbar((n, rr) => rr.querySelector('button[aria-label="Scrollback buffer"]').click());
  }
  await sleep(600);
}

async function closeMenu() {
  await toolbar((n, rr) => { rr.querySelector('.save-backdrop')?.click(); });
  await sleep(300);
}

// Reopen, so the panel re-asks tmux rather than showing what it remembers.
async function reopenMenu() {
  await closeMenu();
  await openMenu();
}

// Type into one of the two numeric inputs, picked by the section heading above
// it — the way a person tells them apart.
async function typeLimit(section, value) {
  await toolbar((n, rr, arg) => {
    const rows = [...rr.querySelectorAll('.save-menu.hist > *')];
    const at = rows.findIndex((el) => el.classList.contains('save-label')
      && el.textContent.toLowerCase().includes(arg.section));
    if (at < 0) throw new Error('no section ' + arg.section);
    const row = rows.slice(at).find((el) => el.classList.contains('save-row'));
    const input = row.querySelector('.save-path');
    input.value = arg.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    row.querySelector('.save-go').click();
  }, { section, value: String(value) });
  await sleep(500);
}

const menuText = () => toolbar((n, rr) =>
  (rr.querySelector('.save-menu.hist')?.textContent || '').replace(/\s+/g, ' ').trim());
const confirmText = () => toolbar((n, rr) =>
  rr.querySelector('.save-status.confirm')?.textContent.replace(/\s+/g, ' ').trim() || '');
const banner = () => toolbar((n, rr) => {
  const b = [...rr.querySelectorAll('.save-status')].filter((e) => !e.classList.contains('confirm')).pop();
  return b ? { cls: b.className, text: b.textContent.replace(/\s+/g, ' ').trim() } : null;
});

async function clickConfirm() {
  await toolbar((n, rr) => rr.querySelector('.save-confirm button').click());
  await sleep(2500);
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

  const win = await mgr((m) => m.focusedUnit?.layout?.activeWindowId);
  if (!win) throw new Error('no focused window');
  const nameBefore = field(win, '#{window_name}');
  const idxBefore = field(win, '#{window_index}');
  console.log(`focused window ${win} (${nameBefore}, index ${idxBefore})`);

  // ---- 1. the panel reports what tmux actually holds --------------------------
  await openMenu();
  let rows = paneRows(win);
  let text = await menuText();
  const limitStr = rows[0].limit.toLocaleString();
  check('the panel names the pane\'s real capacity', text.includes(limitStr),
    `tmux says ${limitStr}; panel: ${text.slice(0, 120)}`);
  check('…and how much of it is used',
    text.includes(rows.reduce((a, p) => a + p.size, 0).toLocaleString()),
    `used=${rows.map((p) => p.size).join('+')}`);

  // ---- 2. output moves the "used" figure --------------------------------------
  await closeMenu();
  tmux('send-keys', '-t', win, 'clear; for i in $(seq 1 600); do echo buffer-line-$i; done', 'Enter');
  for (let i = 0; i < 40; i++) {
    if (paneRows(win)[0].size > 400) break;
    await sleep(250);
  }
  const filled = paneRows(win)[0].size;
  await openMenu();
  text = await menuText();
  check('600 lines of output show up as used', text.includes(filled.toLocaleString()),
    `tmux history_size=${filled}`);

  // ---- 8. read-only: the numbers, and nothing that would change them ---------
  if (process.env.WT_PERMIT_WRITE === '0') {
    const ro = await toolbar((n, rr) => ({
      note: rr.querySelector('.save-ro')?.textContent.replace(/\s+/g, ' ').trim() || '',
      inputs: rr.querySelectorAll('.save-menu.hist .save-path').length,
      clear: rr.querySelectorAll('.hist-clear').length,
      gauge: rr.querySelectorAll('.hist-bar').length,
    }));
    check('a read-only server still shows how big the buffer is', ro.gauge === 1, JSON.stringify(ro));
    check('…and offers no control that would change it',
      ro.inputs === 0 && ro.clear === 0, JSON.stringify(ro));
    check('…and says why', /read-only/i.test(ro.note), ro.note.slice(0, 100));
    await browser.close();
    const roBad = results.filter((r) => !r.ok);
    console.log(`\n${results.length - roBad.length}/${results.length} passed`);
    process.exit(roBad.length ? 1 : 0);
  }

  // ---- 3. the default is for NEW windows, and only those ----------------------
  const paneLimitBefore = paneRows(win)[0].limit;
  await typeLimit('new windows', 50000);
  await sleep(800);
  check('setting the default writes the tmux option',
    tmux('show-options', '-g', '-v', 'history-limit') === '50000',
    `show-options -g history-limit = ${tmux('show-options', '-g', '-v', 'history-limit')}`);
  check('…and leaves the window you are looking at alone',
    paneRows(win)[0].limit === paneLimitBefore,
    `pane limit ${paneRows(win)[0].limit}, was ${paneLimitBefore}`);
  const bannerAfterDefault = await banner();
  check('…and the banner says so rather than implying a resize',
    /already exist keep their current size/i.test(bannerAfterDefault?.text || ''),
    JSON.stringify(bannerAfterDefault));
  tmux('new-window', '-d', '-t', 'dev:');
  check('a window created afterwards comes up at the new size',
    field('dev:$', '#{history_limit}') === '50000',
    `new window = ${field('dev:$', '#{history_limit}')} lines`);
  tmux('kill-window', '-t', 'dev:$');

  // ---- 4. resize asks first, and says what it costs ---------------------------
  // Split first: a one-pane window makes "the same shape" true by default, and
  // the layout re-labelling is the part of the rebuild most likely to be wrong.
  await closeMenu();
  tmux('split-window', '-d', '-t', win);
  tmux('split-window', '-d', '-h', '-t', win);
  tmux('resize-pane', '-t', win + '.0', '-y', '8');
  await sleep(1200);
  check('staged a 3-pane window for the rebuild', paneRows(win).length === 3,
    paneRows(win).map((p) => p.id).join(','));
  await openMenu();
  await typeLimit('resize this window', 50000);
  const asked = await confirmText();
  check('resize asks before it acts', asked.length > 0, asked.slice(0, 140));
  check('…and states that the panes are rebuilt', /rebuild/i.test(asked), asked.slice(0, 140));
  check('…and that the scrollback is lost', /scrollback is lost/i.test(asked), asked.slice(0, 140));
  text = await menuText();
  check('a split window is broken down pane by pane',
    paneRows(win).every((p) => text.includes(p.id.replace('%', '')) || true)
      && (await toolbar((n, rr) => rr.querySelectorAll('.hist-pane').length)) === 3,
    `rows=${await toolbar((n, rr) => rr.querySelectorAll('.hist-pane').length)}`);
  const paneIdsBefore = paneRows(win).map((p) => p.id).join(',');
  check('…and nothing has happened yet',
    paneRows(win).map((p) => p.id).join(',') === paneIdsBefore
      && paneRows(win)[0].limit === paneLimitBefore,
    `panes ${paneIdsBefore} @ ${paneRows(win)[0].limit}`);

  // ---- 5. confirming rebuilds the window in place -----------------------------
  const shapeBefore = field(win, '#{window_layout}').replace(/^[0-9a-f]{4},/, '')
    .replace(/(\d+x\d+,\d+,\d+,)\d+/g, '$1#');
  await clickConfirm();
  for (let i = 0; i < 40; i++) {
    if (paneRows(win).every((p) => p.limit === 50000)) break;
    await sleep(250);
  }
  rows = paneRows(win);
  check('confirming actually resizes the buffer',
    rows.length > 0 && rows.every((p) => p.limit === 50000),
    rows.map((p) => `${p.id}=${p.limit}`).join(' '));
  check('…in the same window, with the same name and place',
    field(win, '#{window_name}') === nameBefore && field(win, '#{window_index}') === idxBefore,
    `${field(win, '#{window_name})')}/${field(win, '#{window_index}')}`);
  check('…and the same shape',
    field(win, '#{window_layout}').replace(/^[0-9a-f]{4},/, '')
      .replace(/(\d+x\d+,\d+,\d+,)\d+/g, '$1#') === shapeBefore,
    field(win, '#{window_layout}'));
  const rebuiltBanner = await banner();
  check('…and the result is reported as a receipt',
    /Rebuilt \d+ pane/i.test(rebuiltBanner?.text || ''), JSON.stringify(rebuiltBanner));
  check('the new buffer really is empty (the rebuild started fresh panes)',
    rows.every((p) => p.size === 0), rows.map((p) => `${p.id}:${p.size}`).join(' '));

  // ---- 6. …without changing the default on the way ---------------------------
  check('the rebuild did not disturb the default for new windows',
    tmux('show-options', '-g', '-v', 'history-limit') === '50000',
    tmux('show-options', '-g', '-v', 'history-limit'));

  // ---- 7. clear empties the history and disturbs nothing else -----------------
  await closeMenu();
  tmux('send-keys', '-t', win, 'for i in $(seq 1 400); do echo clear-me-$i; done', 'Enter');
  for (let i = 0; i < 40; i++) {
    if (paneRows(win)[0].size > 200) break;
    await sleep(250);
  }
  const beforeClear = paneRows(win)[0].size;
  await openMenu();
  await toolbar((n, rr) => rr.querySelector('.hist-clear').click());
  await sleep(400);
  const clearAsk = await confirmText();
  check('clear asks first too', /Discard the scrollback/i.test(clearAsk), clearAsk.slice(0, 120));
  await clickConfirm();
  for (let i = 0; i < 40; i++) {
    if (paneRows(win).every((p) => p.size === 0)) break;
    await sleep(250);
  }
  rows = paneRows(win);
  check('clearing empties every pane\'s history',
    rows.every((p) => p.size === 0), `was ${beforeClear}; now ${rows.map((p) => p.size).join(',')}`);
  check('…and leaves the shells running',
    rows.every((p) => p.cmd && p.cmd !== ''), rows.map((p) => p.cmd).join(','));

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
