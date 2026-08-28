// Verification driver for the per-session NEW-WINDOW MENU (@wt_newcmds).
//
// The Go tests prove the server half against a real tmux, and the node tests pin
// the wire payloads and the caption derivation. Neither can see the half this
// feature is delivered through: a row of "+" buttons that has to draw one per menu
// entry, start the RIGHT one, edit in place without the sidebar's type-ahead filter
// eating the keystrokes, and add/remove entries. A lit binding written with value=
// instead of .value, or an index off by one, passes every test above and is wrong
// on screen.
//
// Run exactly like run.sh does, with DRIVER=verify-newcmd.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(1600); // one layout poll is 500ms

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const el = (tag) => (fn, arg) => page.evaluate(([t, f, a]) => {
  const node = document.querySelector(t);
  return eval(f)(node, node.shadowRoot, a);
}, [tag, fn.toString(), arg]);
const sidebar = el('webtmux-sidebar');

const tmux = (...args) => {
  try {
    return execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8' }).trim();
  } catch (e) {
    return '<<tmux error: ' + (e.stderr || e.message).toString().trim() + '>>';
  }
};
// A session must be addressed by its "$N" id for the option commands: `-t =name`
// is rejected outright and a bare name resolves by PREFIX. With -q that failure is
// silent and reads back as "no menu", which is how an earlier version of this
// driver reported false failures against working code.
const sessId = (sess) => {
  const row = tmux('list-sessions', '-F', '#{session_id}|#{session_name}')
    .split('\n').map((l) => l.split('|')).find(([, n]) => n === sess);
  return row ? row[0] : '';
};
// The stored menu, decoded. $ / | are JSON escapes the encoder uses so a
// '$' or a '|' can survive a tmux option — JSON.parse puts them back.
const storedMenu = (sess) => {
  const raw = tmux('show-options', '-t', sessId(sess), '-qv', '@wt_newcmds');
  if (!raw || raw.startsWith('<<')) return null;
  try { return JSON.parse(raw); } catch (e) { return { parseError: raw }; }
};

// What the plus row is showing right now.
const plusRow = () => sidebar((n, rr) => {
  const row = rr.querySelector('.plus-row');
  if (!row) return null;
  return {
    buttons: [...row.querySelectorAll('button.window-tab')]
      .filter((b) => !b.classList.contains('plus-add'))
      .map((b) => ({ text: b.textContent.replace(/×/g, '').trim(), title: b.title })),
    hasAdd: !!row.querySelector('.plus-add'),
    editing: !!row.querySelector('.cmd-edit'),
    editValue: row.querySelector('.cmd-edit')?.value ?? null,
  };
});

const clickPlus = (i) => sidebar((n, rr, idx) => {
  const row = rr.querySelector('.plus-row');
  const btns = [...row.querySelectorAll('button.window-tab')].filter((b) => !b.classList.contains('plus-add'));
  btns[idx].click();
}, i);

const MARK0 = '/tmp/menu-entry0';
const MARK2 = '/tmp/menu-entry2';

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

  // Seed a three-entry menu the way scripts/stack.sh does: straight into the tmux
  // option, before the browser ever connects.
  const seeded = [
    { label: 'shell', cmd: '' },
    { label: '', cmd: `printf ran > ${MARK0}` },   // no label: caption is derived
    { label: 'claude', cmd: `printf ran > ${MARK2}` },
  ];
  tmux('set-option', '-t', sessId('dev'), '@wt_newcmds', JSON.stringify(seeded));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  if (await sidebar((n) => n.collapsed)) { await page.keyboard.press('Control+Alt+w'); await sleep(600); }

  // ---- 1. the old single-command field is gone ------------------------------
  const oldField = await sidebar((n, rr) => !!rr.querySelector('.newcmd'));
  check('the session-level "+ runs" field is gone', !oldField);

  // ---- 2. one "+" per menu entry, captioned ------------------------------
  const row = await plusRow();
  check('the plus row exists', !!row, JSON.stringify(row));
  check('one "+" per menu entry', row.buttons.length === 3, `${row.buttons.length} buttons`);
  check('captions: label, else derived from the command',
    row.buttons.map((b) => b.text).join(',') === '+ shell,+ printf,+ claude',
    row.buttons.map((b) => b.text).join(','));
  check('the whole command is in the tooltip, since the caption cannot be',
    row.buttons[2].title.includes(MARK2), row.buttons[2].title.replace(/\n/g, ' | '));
  check('there is an add-another button', row.hasAdd);

  // ---- 3. each "+" runs ITS OWN entry --------------------------------------
  for (const f of [MARK0, MARK2]) { try { fs.unlinkSync(f); } catch (e) { /* first run */ } }
  const winsBefore = tmux('list-windows', '-t', '=dev', '-F', '#{window_id}').split('\n').length;

  await clickPlus(0);                       // entry 0 is a plain shell
  await sleep(2200);
  check('the first "+" created a window',
    tmux('list-windows', '-t', '=dev', '-F', '#{window_id}').split('\n').length === winsBefore + 1);
  check('a plain-shell entry runs nothing', !fs.existsSync(MARK0) && !fs.existsSync(MARK2));

  await clickPlus(2);                       // the THIRD button, not the first
  await sleep(2500);
  check('the third "+" ran the third entry', fs.existsSync(MARK2));
  check('...and not another entry', !fs.existsSync(MARK0),
    'entry 0 must not have run — that would be an index off by one');

  // ---- 4. double-click edits in place -------------------------------------
  await sidebar((n, rr) => {
    const btns = [...rr.querySelectorAll('.plus-row button.window-tab')]
      .filter((b) => !b.classList.contains('plus-add'));
    btns[2].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await sleep(400);
  const editing = await plusRow();
  check('double-click opens an editor showing that entry\'s command',
    editing.editing && editing.editValue === `printf ran > ${MARK2}`, JSON.stringify(editing.editValue));

  await page.keyboard.press('Control+a');
  await page.keyboard.type('echo edited', { delay: 8 });
  const midType = storedMenu('dev');
  check('nothing is written while typing',
    midType && midType[2].cmd === `printf ran > ${MARK2}`, JSON.stringify(midType && midType[2]));

  await page.keyboard.press('Enter');
  await settle();
  const afterEdit = storedMenu('dev');
  check('Enter commits the edit to the tmux option',
    afterEdit && afterEdit.length === 3 && afterEdit[2].cmd === 'echo edited',
    JSON.stringify(afterEdit));
  check('the edit did not disturb the other entries',
    afterEdit && afterEdit[0].label === 'shell' && afterEdit[1].cmd === `printf ran > ${MARK0}`);

  const chip = await sidebar((n, rr) => rr.querySelector('.filter-chip')?.textContent || '');
  check('typing a command did not trigger the sidebar type-ahead filter', chip === '', chip);

  // ---- 5. add and remove --------------------------------------------------
  await sidebar((n, rr) => rr.querySelector('.plus-row .plus-add').click());
  await settle();
  const added = storedMenu('dev');
  check('the add button appends an entry', added && added.length === 4, `${added && added.length} entries`);
  const addedRow = await plusRow();
  check('the new entry\'s editor opens by itself', addedRow.editing, JSON.stringify(addedRow));
  await page.keyboard.press('Escape');
  await sleep(300);

  await sidebar((n, rr) => {
    const btns = [...rr.querySelectorAll('.plus-row button.window-tab')]
      .filter((b) => !b.classList.contains('plus-add'));
    btns[3].querySelector('.kill').click();
  });
  await settle();
  const removed = storedMenu('dev');
  check('the × removes just that entry', removed && removed.length === 3, `${removed && removed.length} entries`);
  check('...and leaves the rest in order',
    removed && removed[0].label === 'shell' && removed[2].cmd === 'echo edited', JSON.stringify(removed));

  // ---- 6. a menu with a '$' and a '|' survives storage --------------------
  await sidebar((n, rr) => {
    const btns = [...rr.querySelectorAll('.plus-row button.window-tab')]
      .filter((b) => !b.classList.contains('plus-add'));
    btns[2].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await sleep(400);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('tail -F "$LOG" | grep -i error', { delay: 8 });
  await page.keyboard.press('Enter');
  await settle();
  const nasty = storedMenu('dev');
  check('a command with a $ and a | round-trips through the tmux option',
    nasty && nasty[2] && nasty[2].cmd === 'tail -F "$LOG" | grep -i error',
    JSON.stringify(nasty && nasty[2]));
  const shown = await plusRow();
  check('...and the UI shows it back unmangled',
    shown.buttons.length === 3 && shown.buttons[2].title.includes('tail -F "$LOG" | grep -i error'),
    shown.buttons[2] && shown.buttons[2].title.replace(/\n/g, ' | '));

  await page.screenshot({ path: '/src/screenshots/verify/newcmd.png' });
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

fs.mkdirSync('/src/screenshots/verify', { recursive: true });
main().catch((e) => { console.error(e); process.exit(1); });
