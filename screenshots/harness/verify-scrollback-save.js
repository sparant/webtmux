// Verification driver for the save-scope work: the ⤓ dropdown can now save the
// ENTIRE tmux scrollback, not just the visible screen, and that is the default.
//
// This needs a real browser because the defect and the fix are both invisible to
// unit tests: the node tests prove the scope module's rules and the Go tests
// prove `capture-pane -S -` reaches the history, but only a real download tells
// you that the bytes which arrive in the user's file are the ones that scrolled
// off. Every claim here is therefore asserted against a DOWNLOADED FILE, not
// against a class name or an internal call.
//
// Claims:
//   1. The dropdown offers both scopes and opens with the whole buffer selected.
//   2. Downloading with the default scope produces a file containing a line that
//      scrolled off the screen long ago — the whole point.
//   3. Downloading "Visible screen only" produces a file that does NOT contain it
//      (so the two options genuinely differ; a fix that always saved everything
//      would pass claim 2 and be a different bug).
//   4. Closing and reopening the menu resets the scope to the whole buffer.
//   5. A server-side save with the whole-buffer scope writes that history to the
//      file on disk too, not just to the browser download.
//   6. The confirmation states how much came out (the thing that made the old
//      truncation invisible).
//
// Run exactly like run.sh does, with DRIVER=verify-scrollback-save.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const LINES = 400;          // deeper than any screen; the pane is 24-ish rows
const OLDEST = 'scrollback-marker-1';
const NEWEST = `scrollback-marker-${LINES}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Every control lives one shadow root down, so document.querySelector misses it.
const toolbar = (fn, arg) => page.evaluate(([f, a]) => {
  const node = document.querySelector('webtmux-toolbar');
  return eval(f)(node, node.shadowRoot, a);
}, [fn.toString(), arg]);
const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);

const tmux = (...args) => execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8' });

// Fill the FOCUSED window's pane with numbered lines, then wait until the last
// one has actually printed. Anything less is a race against the shell.
async function fillFocusedPane() {
  const win = await mgr((m) => m.focusedUnit?.layout?.activeWindowId);
  if (!win) throw new Error('no focused window to fill');
  tmux('send-keys', '-t', win,
    `clear; for i in $(seq 1 ${LINES}); do echo scrollback-marker-$i; done`, 'Enter');
  for (let i = 0; i < 60; i++) {
    const screen = tmux('capture-pane', '-p', '-t', win);
    if (screen.includes(NEWEST)) return win;
    await sleep(250);
  }
  throw new Error('pane never printed the last marker');
}

async function openSaveMenu() {
  const open = await toolbar((n, rr) => !!rr.querySelector('.save-menu'));
  if (!open) {
    await toolbar((n, rr) => {
      rr.querySelector('button[aria-label="Save pane buffer"]').click();
    });
  }
  await sleep(400);
}

async function closeSaveMenu() {
  await toolbar((n, rr) => { rr.querySelector('.save-backdrop')?.click(); });
  await sleep(300);
}

// Pick a scope by its VISIBLE LABEL, the way a person does — not by setting the
// property, which would prove nothing about the radio being wired up.
async function pickScope(match) {
  await toolbar((n, rr, m) => {
    const opt = [...rr.querySelectorAll('.save-scope-opt')]
      .find((o) => o.textContent.toLowerCase().includes(m));
    if (!opt) throw new Error('no scope option matching ' + m);
    opt.querySelector('input').click();
  }, match);
  await sleep(250);
}

// Click Download and return the text of the file the browser actually received.
async function downloadBuffer() {
  const wait = page.waitForEvent('download', { timeout: 45000 });
  await toolbar((n, rr) => {
    rr.querySelector('.save-item').click();
  });
  const dl = await wait;
  const path = await dl.path();
  return { name: dl.suggestedFilename(), text: fs.readFileSync(path, 'utf8') };
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
    acceptDownloads: true,
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  const win = await fillFocusedPane();
  console.log(`filled ${win} with ${LINES} markers`);
  await sleep(800);

  // ---- 1. both scopes offered, whole buffer preselected ----------------------
  await openSaveMenu();
  const scopes = await toolbar((n, rr) => [...rr.querySelectorAll('.save-scope-opt')].map((o) => ({
    text: o.textContent.replace(/\s+/g, ' ').trim(),
    on: o.querySelector('input').checked,
  })));
  check('the dropdown offers both scopes', scopes.length === 2, JSON.stringify(scopes));
  check('and opens with the entire scrollback buffer selected',
    scopes[0]?.on === true && /entire scrollback/i.test(scopes[0]?.text || ''),
    JSON.stringify(scopes[0]));
  const dlLabel = await toolbar((n, rr) => rr.querySelector('.save-item').textContent.trim());
  check('the download button names the scope it will act on',
    /entire buffer/i.test(dlLabel), `label=${JSON.stringify(dlLabel)}`);

  // ---- 2. the default download carries the scrolled-off history ---------------
  const whole = await downloadBuffer();
  const wholeLines = whole.text.split('\n').length;
  check('the default download contains a line that scrolled off screen',
    whole.text.includes(OLDEST + '\n'), `${whole.name}, ${wholeLines} lines`);
  check('…and the newest line too',
    whole.text.includes(NEWEST), `${wholeLines} lines`);
  check('…and it is a whole history, not a screenful',
    wholeLines > 300, `${wholeLines} lines`);

  // ---- 6. the confirmation says how much came out ----------------------------
  await sleep(500);
  const banner = await toolbar((n, rr) => {
    const b = rr.querySelector('.save-status');
    return b ? { cls: b.className, text: b.textContent.trim() } : null;
  });
  check('the download is confirmed with its size',
    !!banner && /ok/.test(banner.cls) && /lines/.test(banner.text),
    JSON.stringify(banner));

  // ---- 3. the screen scope really is the smaller one -------------------------
  await pickScope('visible screen');
  const screenLabel = await toolbar((n, rr) => rr.querySelector('.save-item').textContent.trim());
  check('the download button follows the scope', /visible screen/i.test(screenLabel),
    `label=${JSON.stringify(screenLabel)}`);
  const screenOnly = await downloadBuffer();
  const screenLines = screenOnly.text.split('\n').length;
  check('the screen scope leaves the scrolled-off history out',
    !screenOnly.text.includes(OLDEST + '\n'), `${screenLines} lines`);
  check('…while still holding what is on screen',
    screenOnly.text.includes(NEWEST), `${screenLines} lines`);
  check('…and is much smaller than the whole buffer',
    screenLines < wholeLines / 4, `${screenLines} vs ${wholeLines} lines`);

  // ---- 4. the scope resets on reopen -----------------------------------------
  await closeSaveMenu();
  await openSaveMenu();
  const reopened = await toolbar((n, rr) => [...rr.querySelectorAll('.save-scope-opt')]
    .map((o) => o.querySelector('input').checked));
  check('reopening the menu goes back to the entire buffer',
    reopened[0] === true && reopened[1] === false, JSON.stringify(reopened));

  // ---- 5. the server-side file save honors the scope too ---------------------
  // Inside the harness webtmux's own working directory: server-side saves are
  // allowlisted to the directories webtmux may write to, and this claim is about
  // the SCOPE, not about the path rules (savepath_test.go owns those).
  const target = '/tmp/pw/scope-save.txt';
  try { fs.unlinkSync(target); } catch (e) { /* first run */ }
  await toolbar((n, rr, p) => {
    const input = rr.querySelector('.save-path');
    input.value = p;
    rr.querySelectorAll('.save-go').forEach((b) => { if (/save/i.test(b.textContent)) b.click(); });
  }, target);
  let saved = '';
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(target)) { saved = fs.readFileSync(target, 'utf8'); break; }
    await sleep(250);
  }
  check('a server-side save writes the whole history to the file',
    saved.includes(OLDEST + '\n') && saved.includes(NEWEST),
    saved ? `${saved.split('\n').length} lines` : (await toolbar((n, rr) => rr.querySelector('.save-status')?.textContent || 'no file, no banner')));

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
