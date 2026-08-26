// Verification driver for APPLICATION CLIPBOARD WRITES — "(c to copy)" in a
// program running on the tmux machine putting text on the clipboard of the machine
// running the browser.
//
// The node tests (test/osc52.test.mjs) pin the parsing; everything here is the
// WIRING, in a real browser against a real tmux, because the parsing was never the
// broken half. tmux was: `set-clipboard` ships as `external`, which forwards tmux's
// OWN copies to the client and DROPS an application's OSC 52 — silently, with no
// error at either end. So the program says it copied, webtmux never hears about it,
// and nothing on screen says why.
//
//   1. attaching turns forwarding on, and remembers what it found.
//   2. a program's OSC 52 reaches the copy ring AND the browser's system clipboard.
//   3. a sequence split across websocket frames still copies exactly once — and
//      does not leave its own bytes painted in the terminal.
//   4. the link menu's row reports the state and switches it off, which really does
//      stop the forwarding.
//   5. having switched it off, RECONNECTING does not switch it back on: the
//      attach-time default is a default, and there is one attach per split region.
//
// Run exactly like run.sh does, with DRIVER=verify-osc52.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => execFileSync('tmux', ['-S', SOCK, ...a], { encoding: 'utf8' }).trim();

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const el = (tag) => (fn, arg) => page.evaluate(([t, f, a]) => {
  const node = document.querySelector(t);
  if (!node) return null;
  return eval(f)(node, node.shadowRoot, a);
}, [tag, fn.toString(), arg]);

const copyPanel = el('webtmux-copy-sidebar');
const toolbar = el('webtmux-toolbar');

const rows = () => copyPanel((n, rr) => [...rr.querySelectorAll('.btext')].map((e) => e.textContent.trim()));
const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
const setClipboardOption = () => tmux('show-options', '-g', '-q', '-v', 'set-clipboard');

// What the BROWSER's terminal is showing. tmux's own screen is the wrong place to
// look: tmux consumes the OSC 52 and forwards it, so it was never in tmux's buffer
// to begin with. The question is whether a fragment got painted at THIS end, which
// is what the old chunk-local scanner did whenever a copy straddled a frame.
const screenText = () => page.evaluate(() => {
  const t = window.splitManager.focusedUnit.terminal;
  const buf = t.buffer.active;
  const out = [];
  for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y)?.translateToString(true) || '');
  return out.join('\n');
});

const fs = require('fs');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const EMITTER = '/tmp/emit-osc52.sh';

// Emit from a SCRIPT rather than by typing printf at the prompt. send-keys types
// the command onto the pane's screen, so an inline printf would leave the base64
// visible there — and check 3 needs to tell "the sequence was stripped" from "the
// sequence was painted", which a copy of it in the echoed command line destroys.
function stageEmitter(payload) {
  const enc = b64(payload);
  const cut = Math.floor(enc.length / 2);
  fs.writeFileSync(EMITTER, [
    '#!/bin/bash',
    '# Written by verify-osc52.js. Emits the OSC 52 a program writes when it',
    '# offers to copy something — whole, or torn in half with a pause between,',
    '# so the two halves cannot land in one websocket frame.',
    `if [ "$1" = split ]; then`,
    `  printf '\\033]52;c;${enc.slice(0, cut)}'`,
    '  sleep 1',
    `  printf '${enc.slice(cut)}\\007'`,
    'else',
    `  printf '\\033]52;c;${enc}\\007'`,
    'fi',
    '',
  ].join('\n'));
}

function emitOsc52(payload) {
  stageEmitter(payload);
  tmux('send-keys', '-t', 'dev', `clear; bash ${EMITTER}`, 'Enter');
}

function emitOsc52Split(payload) {
  stageEmitter(payload);
  tmux('send-keys', '-t', 'dev', `clear; bash ${EMITTER} split`, 'Enter');
}

async function openPanel() {
  const open = await copyPanel((n) => n.collapsed === false);
  if (!open) { await page.keyboard.press('Control+Alt+Equal'); await sleep(500); }
}

async function main() {
  // Put tmux back to its OUT-OF-THE-BOX value before the browser ever connects, so
  // what the first attach does to it is the thing under test.
  tmux('set-option', '-g', 'set-clipboard', 'external');
  tmux('set-option', '-g', '-u', '@wt_clipboard_choice');
  tmux('set-option', '-g', '-u', '@wt_clipboard_saved');
  const before = setClipboardOption();

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

  // ---- 1. attaching turns forwarding on ---------------------------------------
  check('tmux started at its own default', before === 'external', `set-clipboard=${before}`);
  const after = setClipboardOption();
  check('attaching turns application clipboard forwarding on', after === 'on',
    `set-clipboard=${after}`);
  check('what tmux had is remembered, so it can be given back',
    tmux('show-options', '-g', '-q', '-v', '@wt_clipboard_saved') === 'external');
  check('turning it on by default is not recorded as the user deciding',
    tmux('show-options', '-g', '-q', '-v', '@wt_clipboard_choice') === '');

  await openPanel();

  // ---- 2. a program's copy reaches the browser --------------------------------
  const url = 'https://claude.ai/oauth/authorize?code=' + 'k'.repeat(180);
  emitOsc52(url);
  await sleep(1800);
  const got = await rows();
  const head = url.slice(0, 72).trimEnd() + '…';
  check('a program\'s OSC 52 lands in the copy buffers', got.includes(head),
    JSON.stringify(got));
  check('…and on the system clipboard of the machine running the browser',
    (await clipboard()) === url);

  // ---- 3. a sequence torn across frames ---------------------------------------
  const split = 'SPLIT-' + 'q'.repeat(400) + '-END';
  emitOsc52Split(split);
  await sleep(3200);
  const afterSplit = await rows();
  const splitHead = split.slice(0, 72).trimEnd() + '…';
  check('a sequence split across frames still copies', afterSplit.includes(splitHead),
    JSON.stringify(afterSplit.slice(0, 3)));
  check('…exactly once', afterSplit.filter((t) => t === splitHead).length === 1);
  // The pane was cleared before the emit and the sequence came from a script, so
  // the only way its base64 body can be on screen is if a fragment was painted
  // there — which is exactly what the old chunk-local scanner did to every copy
  // that straddled a frame.
  const screen = await screenText();
  check('…and none of it is painted into the terminal',
    !screen.includes(b64(split).slice(0, 40)),
    JSON.stringify(screen.split('\n').filter(Boolean).slice(-2)));
  check('…and it is what the clipboard holds', (await clipboard()) === split);

  // ---- 4. the link menu row ---------------------------------------------------
  await toolbar((n, rr) => rr.querySelector('.spin').click());
  await sleep(900);
  const menu = await toolbar((n, rr) => [...rr.querySelectorAll('.link-menu .mitem')].map((b) => ({
    label: b.querySelector('b')?.textContent.trim() || '',
    pressed: b.getAttribute('aria-pressed'),
    hint: b.querySelector('.mhint')?.textContent.trim() || '',
  })));
  const clipRow = (menu || []).find((m) => /clipboard|browser/i.test(m.label));
  check('the link menu has a row for it', !!clipRow, JSON.stringify((menu || []).map((m) => m.label)));
  check('…drawn from tmux, and ticked', clipRow?.pressed === 'true');
  check('…explaining what it does', /OSC 52/.test(clipRow?.hint || ''), clipRow?.hint?.slice(0, 90));

  // Click it off. The checkbox is drawn from the reply, so waiting for it to
  // untick is waiting for tmux to have actually changed.
  await toolbar((n, rr) => {
    const b = [...rr.querySelectorAll('.link-menu .mitem')]
      .find((x) => /clipboard|browser/i.test(x.querySelector('b')?.textContent || ''));
    b?.click();
  });
  await sleep(1500);
  check('switching it off restores what tmux had', setClipboardOption() === 'external',
    `set-clipboard=${setClipboardOption()}`);
  check('…and records that the user decided',
    tmux('show-options', '-g', '-q', '-v', '@wt_clipboard_choice') === '0');

  // And it really is off: the same emit now reaches nothing.
  const dropped = 'SHOULD-NOT-ARRIVE-' + Date.now();
  emitOsc52(dropped);
  await sleep(1800);
  check('with it off, a program\'s copy no longer reaches the browser',
    !(await rows()).includes(dropped) && (await clipboard()) !== dropped);

  // ---- 5. the choice survives the next attach ---------------------------------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(4500);
  check('reconnecting does not undo that choice', setClipboardOption() === 'external',
    `set-clipboard=${setClipboardOption()}`);

  // Put it back on through the menu, and prove the round trip is symmetric.
  await toolbar((n, rr) => rr.querySelector('.spin').click());
  await sleep(900);
  await toolbar((n, rr) => {
    const b = [...rr.querySelectorAll('.link-menu .mitem')]
      .find((x) => /clipboard|browser/i.test(x.querySelector('b')?.textContent || ''));
    b?.click();
  });
  await sleep(1500);
  check('and switching it back on forwards again', setClipboardOption() === 'on',
    `set-clipboard=${setClipboardOption()}`);

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('DRIVER ERROR', e); process.exit(1); });
