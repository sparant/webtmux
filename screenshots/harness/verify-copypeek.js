// Verification driver for the copy-buffer panel's AUTO-PEEK: a copy floats the
// panel in for a couple of seconds so you can see where it landed.
//
// This is all timing, focus and listener-ordering, none of which a unit test can
// reach, and each claim here is one that failed silently in an earlier design:
//
//   1. A copy with the panel SHUT shows it — and the keystroke that copied does
//      not immediately dismiss it (the outside-watcher is installed during that
//      very keydown).
//   2. It never takes the keyboard: focus stays in the pane you are typing in.
//   3. It always FLOATS, even when the pref says mount, and the terminal is not
//      resized. The pref is put back when the peek ends.
//   4. It collapses on its own, and does NOT persist as open — a reload after a
//      peek finds the panel shut.
//   5. A panel that is ALREADY open is left alone: a copy neither closes it nor
//      starts a countdown against it.
//   6. Typing / Escape / a click / a scroll ANYWHERE ELSE ends it early.
//   7. Reaching for the panel instead promotes it: it stays past the countdown.
//   8. A second copy re-arms the countdown rather than stacking.
//
// Run exactly like run.sh does, with DRIVER=verify-copypeek.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// copy-sidebar.js's PEEK_MS, plus room for the timer to actually fire.
const PEEK_MS = 3200;
const AFTER_PEEK = PEEK_MS + 1300;

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const el = (tag) => (fn, arg) => page.evaluate(([t, f, a]) => {
  const node = document.querySelector(t);
  if (!node) return null;
  return eval(f)(node, node.shadowRoot, a);
}, [tag, fn.toString(), arg]);

const copyPanel = el('webtmux-copy-sidebar');
const tmux = (...args) => execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8' });

// The panel's live state, as the peek machinery sees it.
const state = () => copyPanel((n) => ({
  collapsed: n.collapsed,
  peeking: !!n._peeking,
  overlay: n.overlay,
  hasTimer: !!n._peekTimer,
  watching: !!n._onOutside,
  tag: !!n.shadowRoot.querySelector('.peek-tag'),
}));

// Where the keyboard actually is, piercing shadow roots — "took focus" is only
// answerable this way, because the panel's focusable div is inside one.
const focusInfo = () => page.evaluate(() => {
  const panel = document.querySelector('webtmux-copy-sidebar');
  let a = document.activeElement;
  let inPanel = false;
  while (a) {
    if (a === panel) inPanel = true;
    if (a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    else break;
  }
  return { tag: a ? a.tagName : '(none)', inPanel };
});

const termWidth = () => page.evaluate(
  () => Math.round(document.querySelector('.region-term').getBoundingClientRect().width));

// Print a marker into a pane, select it in xterm as a drag would, and press ⌘C.
//
// The pane is reset first, and that is not defensive padding: the dismissal cases
// below deliberately type INTO the pane (that is the whole point of them), so the
// prompt genuinely does carry a stray character by the time the next marker is
// echoed, and a click into the terminal can genuinely have left the pane in copy
// mode. Both silently turn `echo MARK` into something that prints nothing.
async function copyMarker(mark) {
  try { tmux('copy-mode', '-q', '-t', 'dev'); } catch (e) { /* not in a mode */ }
  tmux('send-keys', '-t', 'dev', 'C-u');            // drop whatever is half-typed
  await sleep(200);
  tmux('send-keys', '-t', 'dev', `echo ${mark}`, 'Enter');
  await sleep(900);
  const selected = await page.evaluate((want) => {
    const t = window.splitManager.focusedUnit.terminal;
    const buf = t.buffer.active;
    for (let y = buf.length - 1; y >= 0; y--) {
      const line = buf.getLine(y) ? buf.getLine(y).translateToString(true) : '';
      const i = line.indexOf(want);
      if (i === -1 || /echo/.test(line)) continue;
      t.select(i, y, want.length);
      t.focus();
      return t.getSelection();
    }
    return null;
  }, mark);
  if (selected !== mark) return { selected, copied: false };
  await page.keyboard.press('Control+c');
  await sleep(350);
  return { selected, copied: true };
}

// Put the panel back to "shut, not peeking" between cases.
async function reset() {
  await copyPanel((n) => { n._endPeek(); n.collapsed = true; });
  await sleep(400);
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4500);

  // The windows sidebar starts open and overlaying; get it out of the way so it
  // cannot be mistaken for the panel under test.
  await page.evaluate(() => { document.querySelector('webtmux-sidebar').collapsed = true; });
  await sleep(500);
  check('setup: the copy panel starts shut', (await state()).collapsed === true);

  // ---- 1 & 2. a copy shows it, and it takes no focus --------------------------
  const widthBefore = await termWidth();
  const one = await copyMarker('PK-ONE');
  check('setup: a real ⌘C over a real selection', one.copied, JSON.stringify(one));
  let s = await state();
  check('a copy auto-shows the panel', s.collapsed === false && s.peeking === true, JSON.stringify(s));
  check('…and the keystroke that copied does not instantly dismiss it', s.watching === true && s.hasTimer === true,
    JSON.stringify(s));
  check('…and it says why it appeared', s.tag === true);

  const f = await focusInfo();
  check('the peek takes NO keyboard focus — the pane keeps it',
    f.inPanel === false && f.tag === 'TEXTAREA', JSON.stringify(f));
  check('and it floats, so the terminal is not resized',
    s.overlay === true && (await termWidth()) === widthBefore,
    `${widthBefore} -> ${await termWidth()}`);

  // ---- 3. it goes away by itself ---------------------------------------------
  await sleep(AFTER_PEEK);
  s = await state();
  check('it collapses again on its own',
    s.collapsed === true && s.peeking === false && s.hasTimer === false && s.watching === false,
    JSON.stringify(s));

  // ---- 4. it does not persist as open ----------------------------------------
  const persisted = await page.evaluate(() => {
    const id = sessionStorage.getItem('webtmux-client-id');
    const blob = JSON.parse(sessionStorage.getItem('webtmux-client:' + id) || '{}');
    return blob.copySidebar || {};
  });
  check('a peek is not persisted as "open"', persisted.collapsed !== false, JSON.stringify(persisted));

  // ---- 3b. a MOUNTED pref is honoured again afterwards ------------------------
  await copyPanel((n) => { n.collapsed = false; });
  await sleep(300);
  await copyPanel((n) => { n.toggleOverlay(); });     // -> mount, and persist it
  await sleep(500);
  check('setup: the panel pref is now mount', (await state()).overlay === false);
  await copyPanel((n) => { n.collapsed = true; });
  await sleep(500);
  const mountedWidth = await termWidth();
  const two = await copyMarker('PK-TWO');
  check('setup: a copy with the pref set to mount', two.copied, JSON.stringify(two));
  s = await state();
  check('a peek floats even when the pref says mount',
    s.peeking === true && s.overlay === true, JSON.stringify(s));
  check('…so the terminal keeps its width through the peek',
    (await termWidth()) === mountedWidth, `${mountedWidth} -> ${await termWidth()}`);
  await sleep(AFTER_PEEK);
  s = await state();
  check('and the mount pref is put back when the peek ends',
    s.collapsed === true && s.overlay === false, JSON.stringify(s));
  // Back to float for the rest of the run.
  await copyPanel((n) => { n.collapsed = false; });
  await sleep(300);
  await copyPanel((n) => { n.toggleOverlay(); });
  await sleep(400);
  await copyPanel((n) => { n.collapsed = true; });
  await sleep(400);

  // ---- 5. an already-open panel is left alone --------------------------------
  await page.keyboard.press('Control+Alt+Equal');
  await sleep(500);
  check('setup: the panel is open for real', (await state()).collapsed === false);
  const three = await copyMarker('PK-THREE');
  check('setup: a copy while it is open', three.copied, JSON.stringify(three));
  s = await state();
  check('a copy does not turn an open panel into a peek',
    s.collapsed === false && s.peeking === false && s.hasTimer === false, JSON.stringify(s));
  await sleep(AFTER_PEEK);
  s = await state();
  check('…and it is still open after the peek delay — nothing auto-collapses it',
    s.collapsed === false, JSON.stringify(s));
  await page.keyboard.press('Control+Alt+Equal');
  await sleep(400);

  // ---- 6. anything else you do ends it early ---------------------------------
  const dismissals = [
    ['typing', 'PKTYPE', async () => { await focusPane(); await page.keyboard.press('x'); }],
    ['Escape', 'PKESC', async () => { await focusPane(); await page.keyboard.press('Escape'); }],
    ['a click in the terminal', 'PKCLICK', async () => { await page.mouse.click(300, 400); }],
    ['a scroll over the terminal', 'PKSCROLL',
      async () => { await page.mouse.move(300, 400); await page.mouse.wheel(0, -120); }],
  ];
  for (const [what, mark, act] of dismissals) {
    await reset();
    const m = await copyMarker(mark);
    const up = await state();
    if (!m.copied || !up.peeking) { check(`setup: peeking before ${what}`, false, JSON.stringify({ m, up })); continue; }
    await act();
    await sleep(500);
    s = await state();
    check(`${what} dismisses the peek early`,
      s.collapsed === true && s.peeking === false && s.watching === false,
      JSON.stringify(s));
  }

  // The dismissal must not EAT the keystroke that dismissed it — you pressed a key
  // at a shell, and that has to still happen. Typed here with a peek up, then read
  // back off the real pane.
  await reset();
  const typed = await copyMarker('PKSWALLOW');
  check('setup: peeking before the swallow test', typed.copied && (await state()).peeking,
    JSON.stringify(typed));
  await focusPane();
  await page.keyboard.type('Zq');
  await sleep(600);
  const prompt = tmux('capture-pane', '-p', '-t', 'dev').trimEnd().split('\n').pop();
  check('the dismissing keystrokes still reach the pane — they are not swallowed',
    /Zq\s*$/.test(prompt), JSON.stringify(prompt.slice(-24)));
  check('…and the peek went away all the same', (await state()).collapsed === true);
  tmux('send-keys', '-t', 'dev', 'C-u');

  // ---- 7. reaching for the panel promotes it ---------------------------------
  await reset();
  const four = await copyMarker('PK-FOUR');
  check('setup: peeking before reaching for it', four.copied && (await state()).peeking, JSON.stringify(four));
  await copyPanel((n, rr) => { rr.querySelector('.buf').dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, composed: true })); });
  await sleep(400);
  s = await state();
  check('clicking a row promotes the peek to a real open panel',
    s.collapsed === false && s.peeking === false && s.hasTimer === false && s.watching === false,
    JSON.stringify(s));
  await sleep(AFTER_PEEK);
  check('…so it is still there after the countdown would have closed it',
    (await state()).collapsed === false);
  await page.keyboard.press('Control+Alt+Equal');
  await sleep(400);

  // ---- 8. a second copy re-arms rather than stacking -------------------------
  await reset();
  await copyMarker('PK-FIVE');
  await sleep(PEEK_MS - 1200);            // most of the way through the first countdown
  const six = await copyMarker('PK-SIX');
  check('setup: a second copy mid-peek', six.copied, JSON.stringify(six));
  await sleep(1600);                      // past the FIRST countdown's deadline
  s = await state();
  check('a second copy re-arms the countdown instead of letting the first close it',
    s.collapsed === false && s.peeking === true, JSON.stringify(s));
  const panels = await page.evaluate(() => document.querySelectorAll('webtmux-copy-sidebar').length);
  check('and there is still exactly one panel', panels === 1, `${panels} found`);
  await sleep(AFTER_PEEK);
  check('which then closes as usual', (await state()).collapsed === true);

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

// Put the keyboard back in the pane before a "typing" dismissal, so the keystroke
// really is happening somewhere else rather than nowhere.
async function focusPane() {
  await page.evaluate(() => window.splitManager.focusedUnit.terminal.focus());
}

main().catch((e) => { console.error(e); process.exit(1); });
