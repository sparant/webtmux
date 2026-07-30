// Verification driver for the harden-guards subplan: write authority and save
// confinement, against the real stack.
//
// The Go tests pin the matrix and the resolver. What they cannot pin is the thing
// the subplan is actually about — that a server started WITHOUT `-w` still works
// as a viewer, and that everything else really is refused end to end: browser →
// websocket → gate → tmux, with a live tmux server to be changed (or not) and a
// real filesystem to be written to (or not).
//
// Two boots, because "read-only" is a property of the server process:
//
//   WT_PERMIT_WRITE=0 DRIVER=verify-guards.js WT_MODE=ro bash run.sh
//   DRIVER=verify-guards.js WT_MODE=rw bash run.sh
//
// The read-only pass deliberately sends some frames RAW over the websocket,
// bypassing the client-side guard. The client refusing is the honesty boundary;
// the server refusing is the security one, and only a raw frame tests the latter.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const MODE = process.env.WT_MODE === 'ro' ? 'ro' : 'rw';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const toolbar = el('webtmux-toolbar');
const sidebar = el('webtmux-sidebar');
const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);

const tmux = (...args) => execFileSync('tmux', ['-u', '-S', SOCK, ...args], { encoding: 'utf8' });
const sessions = () => tmux('list-sessions', '-F', '#{session_name}').trim().split('\n');
const activeWindow = (sess) => tmux('display-message', '-p', '-t', `=${sess}:`, '#{window_id}').trim();

// Send a protocol frame straight down the primary unit's websocket, around the
// client-side guard. This is how the SERVER's gate gets tested rather than the
// browser's opinion of it.
const raw = (frame) => mgr((m, f) => {
  const ws = m.units[0]?.ws;
  if (!ws || ws.readyState !== 1) return false;
  ws.send(f);
  return true;
}, frame);

async function open() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(5000);
  return browser;
}

// ---- read-only pass -------------------------------------------------------------

async function readOnly() {
  const browser = await open();

  // 1. The browser is TOLD. Without this the whole mode is a UI that silently
  //    does nothing, which is the failure the design decision is about.
  const told = await toolbar((n) => ({ prop: n.readOnly === true, attr: n.hasAttribute('readonly') }));
  check('the browser learns the server is read-only at connect',
    told.prop && told.attr, JSON.stringify(told));
  const sbRO = await sidebar((n) => n.hasAttribute('readonly'));
  check('and the sidebar is marked read-only with it', sbRO === true, String(sbRO));

  // 2. Watching still works — the whole point of the mode.
  const view = await mgr((m) => {
    const l = m.focusedUnit?.layout;
    return {
      windows: (l?.windows || []).length,
      sessions: (l?.sessions || []).length,
      screen: m.focusedUnit?.terminal?.buffer?.active?.getLine(0)?.translateToString(true)?.trim() || '',
    };
  });
  check('a read-only client still receives the layout', view.windows > 0 && view.sessions > 0,
    `${view.windows} windows, ${view.sessions} sessions`);
  check('…and still sees the terminal', view.screen.length > 0, JSON.stringify(view.screen.slice(0, 40)));

  // Captures are view-only, so Exposé must still fill.
  await page.keyboard.press('Control+Alt+e');
  await sleep(3500);
  const tiles = await el('webtmux-expose')((n, rr) => rr.querySelectorAll('.tile').length);
  check('captures still arrive (Exposé fills)', tiles > 0, `${tiles} tiles`);
  await page.keyboard.press('Escape');
  await sleep(800);

  // 3. Refusals, through the SERVER's gate (raw frames, past the client guard).
  const before = sessions();
  const beforeWin = activeWindow('dev');
  const target = (await mgr((m) => {
    const l = m.focusedUnit?.layout;
    const other = (l?.windows || []).find((w) => w.id !== l.activeWindowId);
    return other ? other.id : '';
  })) || '';

  await raw('L' + 'scratch');            // TmuxKillSession
  await raw('6' + target);               // TmuxSelectWindow
  await raw('K' + target);               // TmuxKillWindow
  await raw('P' + JSON.stringify({ v: 1, rev: 999, probe: 'read-only' })); // TmuxSetState
  const savePath = path.join(os.tmpdir(), 'ro-should-not-exist.txt');
  await raw('O' + JSON.stringify({ windowId: target, path: savePath, dir: os.tmpdir() }));
  await sleep(2500);

  check('kill-session is refused', sessions().includes('scratch'), JSON.stringify(sessions()));
  check('nothing was killed at all', sessions().length === before.length,
    `${before.length} -> ${sessions().length}`);
  check('select-window is refused (the shared console does not move)',
    activeWindow('dev') === beforeWin, `${beforeWin} -> ${activeWindow('dev')}`);
  const state = tmux('show-options', '-gqv', '@wt_state').trim();
  check('the shared @wt_state is not rewritten', !state.includes('read-only'),
    state ? state.slice(0, 60) + '…' : '(empty)');
  check('save-to-server writes no file', !fs.existsSync(savePath), savePath);

  // 4. And the UI says so rather than looking broken.
  await toolbar((n) => { n.saveOpen = true; });
  await sleep(900);
  const saveMenu = await toolbar((n, rr) => rr.querySelector('.save-menu')?.textContent || '');
  check('the save dropdown offers only the browser download',
    /read-only/i.test(saveMenu) && /Download to browser/.test(saveMenu),
    JSON.stringify(saveMenu.replace(/\s+/g, ' ').slice(0, 120)));
  const dim = await sidebar((n, rr) => {
    const tab = rr.querySelector('.window-tab');
    if (!tab) return null;
    const cs = getComputedStyle(tab);
    return { opacity: Number(cs.opacity), pointer: cs.pointerEvents };
  });
  check('sidebar rows are greyed and inert',
    !!dim && dim.opacity < 0.9 && dim.pointer === 'none', JSON.stringify(dim));

  await browser.close();
}

// ---- read-write pass ------------------------------------------------------------

async function readWrite() {
  const browser = await open();

  const told = await toolbar((n) => n.readOnly === true);
  check('with -w the browser is not in read-only mode', told === false, String(told));

  // Writing works at all — otherwise the read-only pass proves nothing.
  const before = activeWindow('dev');
  const other = await mgr((m) => {
    const l = m.focusedUnit?.layout;
    const w = (l?.windows || []).find((x) => x.id !== l.activeWindowId);
    return w ? w.id : '';
  });
  await mgr((m, id) => m.focusedUnit?.selectWindow(id), other);
  await sleep(2000);
  check('select-window works with -w', other && activeWindow('dev') === other,
    `${before} -> ${activeWindow('dev')} (wanted ${other})`);

  // ---- save confinement --------------------------------------------------------
  // The harness runs webtmux and tmux in one container, so the pane's own
  // directory IS visible: that directory is the allowlist, and /tmp is not.
  const winId = await mgr((m) => m.focusedUnit?.layout?.activeWindowId);
  const paneDir = tmux('display-message', '-p', '-t', '=dev:', '#{pane_current_path}').trim();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  const escapee = path.join(outside, 'stolen.txt');

  // Open the save dropdown and leave it open: the banner and the Overwrite
  // button live inside it, which is where a user doing this would be standing.
  await toolbar((n) => { n.saveOpen = true; });
  await sleep(900);

  await mgr((m, args) => m.focusedUnit?.sendSavePaneFile(args[0], args[1], ''), [winId, escapee]);
  await sleep(2000);
  let status = await toolbar((n) => n.saveStatus);
  check('an absolute path outside the allowed directories is refused',
    !!status && status.state === 'err' && /outside the directories/.test(status.text),
    JSON.stringify(status));
  check('…and no file was written there', !fs.existsSync(escapee), escapee);

  // The traversal form of the same escape: the parent exists, so only containment
  // catches it.
  const rel = path.relative(paneDir, escapee);
  await mgr((m, args) => m.focusedUnit?.sendSavePaneFile(args[0], args[1], ''), [winId, rel]);
  await sleep(2000);
  status = await toolbar((n) => n.saveStatus);
  check('and so is ../ out of the base directory',
    !!status && status.state === 'err' && /outside the directories/.test(status.text),
    JSON.stringify(status));
  check('…still nothing written', !fs.existsSync(escapee), escapee);

  // A save INSIDE the allowlist still works — containment, not a ban.
  const okPath = path.join(paneDir, 'guards-ok.txt');
  try { fs.unlinkSync(okPath); } catch (e) { /* fresh */ }
  await mgr((m, args) => m.focusedUnit?.sendSavePaneFile(args[0], args[1], ''), [winId, 'guards-ok.txt']);
  // Under the 1800ms auto-dismiss the success banner sets: read it before it goes.
  await sleep(1200);
  status = await toolbar((n) => n.saveStatus);
  check('a save into the pane\'s own directory still works',
    !!status && status.state === 'ok' && fs.existsSync(okPath), JSON.stringify(status));
  await sleep(1500); // let the banner auto-dismiss so the next one is unambiguous
  await toolbar((n) => { n.saveOpen = true; });
  await sleep(500);

  // ---- overwrite confirm -------------------------------------------------------
  const original = fs.readFileSync(okPath, 'utf8');
  fs.writeFileSync(okPath, 'PRECIOUS');
  // Through savePaneBufferToPath, not sendSavePaneFile: the manager has to
  // REMEMBER the refused request for the Overwrite button to re-send it.
  await mgr((m, p) => m.savePaneBufferToPath(p), 'guards-ok.txt');
  await sleep(2500);
  status = await toolbar((n) => n.saveStatus);
  check('saving over an existing file asks instead of replacing it',
    !!status && status.state === 'confirm' && /Overwrite/i.test(status.text), JSON.stringify(status));
  check('…and the file is untouched while the question stands',
    fs.readFileSync(okPath, 'utf8') === 'PRECIOUS');

  const confirmBtn = await toolbar((n, rr) => !!rr.querySelector('.save-confirm button'));
  check('the dropdown renders an Overwrite button for it', confirmBtn === true, String(confirmBtn));

  await toolbar((n, rr) => rr.querySelector('.save-confirm button')?.click());
  await sleep(1200); // again, under the success banner's 1800ms auto-dismiss
  status = await toolbar((n) => n.saveStatus);
  check('answering Overwrite goes through',
    !!status && status.state === 'ok', JSON.stringify(status));
  check('…and the file really was replaced',
    fs.readFileSync(okPath, 'utf8') !== 'PRECIOUS',
    `${original.length} bytes originally`);

  await browser.close();
}

async function main() {
  console.log(`--- write-authority verification (${MODE === 'ro' ? 'read-only, no -w' : 'read-write, -w'}) ---`);
  if (MODE === 'ro') await readOnly();
  else await readWrite();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
