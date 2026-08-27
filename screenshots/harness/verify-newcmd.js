// Verification driver for the per-session new-window command (@wt_newcmd).
//
// The Go tests prove the server half against a real tmux, and the node tests pin
// the wire payload. Neither can see the half this feature is actually delivered
// through: a field in the sidebar that has to render the stored value, survive a
// layout push overwriting it, send on commit, and then make a "+" run something.
// A lit binding written with value= instead of .value, or a keydown the sidebar's
// own type-ahead filter swallows, passes every test above and is broken on screen.
//
// Run exactly like run.sh does, with DRIVER=verify-newcmd.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One layout poll is 500ms; two of them is comfortably past a change.
const settle = () => sleep(1500);

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
// The session's "$N" id. Needed because `show-options -t` accepts NEITHER `=name`
// nor `=name:` — the exact-match syntax every other tmux command takes — and a
// bare name resolves by PREFIX. With -q that refusal is silent and reads back as
// the empty string, i.e. exactly like "this session has no command", which is how
// the first version of this driver reported two false failures against a feature
// that was working. Same reason the Go side resolves an id first.
const sessId = (sess) => {
  const row = tmux('list-sessions', '-F', '#{session_id}|#{session_name}')
    .split('\n').map((l) => l.split('|'))
    .find(([, name]) => name === sess);
  return row ? row[0] : '';
};

// What tmux itself holds for the session — the assertion that the browser wrote
// through to the real store rather than to something in the page.
const stored = (sess) => {
  const id = sessId(sess);
  return id ? tmux('show-options', '-t', id, '-qv', '@wt_newcmd') : '<<no session ' + sess + '>>';
};

const openSidebar = async () => {
  const shown = await sidebar((n) => !n.collapsed);
  if (!shown) { await page.keyboard.press('Control+Alt+w'); await sleep(600); }
};

// A command whose ONLY effect is a file, so "did the + run it" is a filesystem
// question rather than a screen-scrape.
const MARK = '/tmp/newcmd-ran';
const MARK2 = '/tmp/newcmd-session-ran';
const cmdFor = (path) => `printf '%s' "$TMUX_PANE" > ${path}`;

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  await openSidebar();

  // ---- 1. the field exists, under the session list --------------------------
  const placed = await sidebar((n, rr) => {
    const f = rr.querySelector('.newcmd');
    if (!f) return { found: false };
    const tabs = rr.querySelector('.session-tabs');
    const wins = [...rr.querySelectorAll('h3')].find((h) => h.textContent.includes('Windows'));
    return {
      found: true,
      belowSessions: !!tabs && tabs.getBoundingClientRect().bottom <= f.getBoundingClientRect().top + 1,
      aboveWindows: !!wins && f.getBoundingClientRect().bottom <= wins.getBoundingClientRect().top + 1,
      label: f.querySelector('label')?.textContent.trim(),
      value: f.querySelector('input')?.value,
      visible: f.getBoundingClientRect().height > 0,
    };
  });
  check('the command field is in the sidebar', placed.found, JSON.stringify(placed));
  check('it sits under the session list and above Windows',
    placed.belowSessions && placed.aboveWindows && placed.visible);
  check('it starts empty for a session with no command', placed.value === '');

  // ---- 2. typing a command commits it to tmux -------------------------------
  await sidebar((n, rr) => { rr.querySelector('.newcmd input').focus(); });
  await page.keyboard.type(cmdFor(MARK), { delay: 8 });
  // Typed, not committed: the field must not write on every keystroke.
  const midType = stored('dev');
  check('nothing is written while typing', midType === '', `tmux holds ${JSON.stringify(midType)}`);

  await page.keyboard.press('Enter');
  await settle();
  check('Enter commits it to the tmux session option', stored('dev') === cmdFor(MARK),
    `tmux holds ${JSON.stringify(stored('dev'))}`);

  // The sidebar's own key handling must not have eaten the keystrokes: a stray
  // type-ahead filter would leave a filter chip and a narrowed window list.
  const chip = await sidebar((n, rr) => rr.querySelector('.filter-chip')?.textContent || '');
  check('typing did not trigger the sidebar type-ahead filter', chip === '',
    `chip=${JSON.stringify(chip)}`);

  // ---- 3. a layout push does not clobber the field --------------------------
  const afterPush = await sidebar((n, rr) => rr.querySelector('.newcmd input').value);
  check('the field still shows the command after layout pushes', afterPush === cmdFor(MARK),
    JSON.stringify(afterPush));

  // ---- 4. "+" runs it in the NEW window ------------------------------------
  try { fs.unlinkSync(MARK); } catch (e) { /* first run */ }
  const panesBefore = tmux('list-panes', '-a', '-F', '#{pane_id}').split('\n');
  const winsBefore = tmux('list-windows', '-t', '=dev', '-F', '#{window_id}').split('\n').length;
  await sidebar((n, rr) => {
    // The last "+" in the window list is the new-window row for this session.
    const plus = [...rr.querySelectorAll('.window-tabs button.window-tab')]
      .filter((b) => b.textContent.trim() === '+').pop();
    plus.click();
  });
  await sleep(2500);
  const winsAfter = tmux('list-windows', '-t', '=dev', '-F', '#{window_id}').split('\n').length;
  check('the + created a window', winsAfter === winsBefore + 1, `${winsBefore} -> ${winsAfter}`);

  const ranIn = fs.existsSync(MARK) ? fs.readFileSync(MARK, 'utf8').trim() : '';
  check('the session command RAN in that window', ranIn.startsWith('%'),
    `marker=${JSON.stringify(ranIn)}`);
  check('$TMUX_PANE resolved to the NEW pane, not the clicker\'s',
    ranIn.startsWith('%') && !panesBefore.includes(ranIn),
    `ran in ${ranIn}; panes before were ${panesBefore.join(',')}`);

  // The window must still be a live shell — the command was typed into it, not
  // run AS it, so the window outlives the command.
  const alive = tmux('list-panes', '-t', ranIn, '-F', '#{pane_dead}');
  check('the window is a shell that survived the command', alive === '0', `pane_dead=${alive}`);

  // ---- 5. a new session inherits the name and the command ------------------
  await sidebar((n, rr) => { rr.querySelector('.newcmd input').focus(); });
  await page.keyboard.press('Control+a');
  await page.keyboard.type(cmdFor(MARK2), { delay: 8 });
  await page.keyboard.press('Enter');
  await settle();
  try { fs.unlinkSync(MARK2); } catch (e) { /* first run */ }

  await sidebar((n, rr) => {
    [...rr.querySelectorAll('.session-tabs button.session-tab')]
      .find((b) => b.textContent.trim() === '+').click();
  });
  await sleep(3000);

  const sessions = tmux('list-sessions', '-F', '#{session_name}').split('\n');
  check('the new session is named after the current one, indexed',
    sessions.includes('dev (1)'), `sessions: ${sessions.join(', ')}`);
  check('it inherited the command', stored('dev (1)') === cmdFor(MARK2),
    `holds ${JSON.stringify(stored('dev (1)'))}`);
  check('and ran it in its first window', fs.existsSync(MARK2));

  // ---- 6. clearing the field unsets the option ----------------------------
  await openSidebar();
  await sidebar((n, rr) => { rr.querySelector('.newcmd input').focus(); });
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Enter');
  await settle();
  const nowSess = await sidebar((n) => n.layout?.sessionBase || n.layout?.sessionName);
  check('clearing the field clears the session option', stored(nowSess) === '',
    `session ${nowSess} holds ${JSON.stringify(stored(nowSess))}`);
  // ...and the clear was not vacuous: -u leaves the option ABSENT, which is a
  // different state from present-and-empty, and only `show-options -A` (which
  // resolves the inheritance chain) can tell them apart.
  const absent = !tmux('show-options', '-t', sessId(nowSess)).split('\n')
    .some((l) => l.startsWith('@wt_newcmd'));
  check('the option is absent, not present-and-empty', absent);

  await page.screenshot({ path: '/src/screenshots/verify/newcmd.png' });

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

fs.mkdirSync('/src/screenshots/verify', { recursive: true });
main().catch((e) => { console.error(e); process.exit(1); });
