// DIAGNOSTIC (not a gate): does a clipboard write made by a program INSIDE tmux
// reach the browser?
//
// The reported symptom: claude-cli prints "(c to copy)", you press c, and nothing
// is on the clipboard of the machine running the browser. claude-cli emits THREE
// channels when $TMUX is set (verified by reading its bundle):
//
//   A. raw   ESC ] 52 ; c ; <b64> BEL
//   B. DCS   ESC P tmux; <A, escaped> ESC \
//   C. `tmux load-buffer -w -`
//
// Each is gated by a different tmux option, so this prints which ones actually
// arrive in copyBuffers with the tmux server webtmux is talking to.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => execFileSync('tmux', ['-S', SOCK, ...a], { encoding: 'utf8' }).trim();

let page;

// The ring is a module singleton, not a global — read it through the panel that
// draws it, exactly as verify-copybuffers.js does.
const panel = (fn) => page.evaluate((f) => {
  const node = document.querySelector('webtmux-copy-sidebar');
  if (!node) return null;
  return eval(f)(node, node.shadowRoot);
}, fn.toString());

const ring = () => panel((n, rr) => [...rr.querySelectorAll('.btext')].map((e) => e.textContent.trim()));

// previewText() collapses whitespace and cuts at 72 chars with an ellipsis, so a
// long payload is compared on its visible head rather than in full.
const head = (s) => (s.length <= 72 ? s : s.slice(0, 72).trimEnd() + '…');

async function probe(label, payload, emit) {
  const before = await ring();
  emit(payload);
  await sleep(1800);
  const got = await ring();
  const want = head(payload);
  const hit = got.some((t) => t === want) && !before.some((t) => t === want);
  // Landing in the ring is only half of it: the point is the SYSTEM clipboard of
  // the machine running the browser. An unsolicited write (no user gesture) is
  // exactly the case browsers are allowed to refuse.
  let clip = '';
  try { clip = await page.evaluate(() => navigator.clipboard.readText()); } catch (e) { clip = '<<read refused: ' + e.message.split('\n')[0] + '>>'; }
  const onClip = clip === payload;
  console.log(`${hit ? 'ARRIVED ' : 'dropped '} ${label}   sysClipboard=${onClip ? 'YES' : 'no'}`);
  if (!hit && got.length !== before.length) console.log('   (ring changed to:', JSON.stringify(got), ')');
  return hit;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
// send-keys types a command into the pane; \\033 survives the shell into printf.
const emitRaw = (p) => tmux('send-keys', '-t', 'dev', `printf '\\033]52;c;${b64(p)}\\007'`, 'Enter');
const emitDcs = (p) => tmux('send-keys', '-t', 'dev', `printf '\\033Ptmux;\\033\\033]52;c;${b64(p)}\\007\\033\\\\'`, 'Enter');
const emitBuf = (p) => tmux('send-keys', '-t', 'dev', `printf %s ${JSON.stringify(p)} | tmux -S ${SOCK} load-buffer -w -`, 'Enter');

(async () => {
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
  // The panel has to be OPEN for its rows to exist in the shadow root.
  await page.keyboard.press('Control+Alt+Equal');
  await sleep(600);

  console.log('tmux            :', tmux('-V'));
  console.log('clients         :', tmux('list-clients', '-F', '#{client_tty} term=#{client_termname} flags=#{client_flags}'));
  console.log('set-clipboard   :', tmux('show-options', '-g', '-q', '-v', 'set-clipboard'));
  console.log('allow-passthru  :', tmux('show-options', '-g', '-q', '-v', 'allow-passthrough'));
  console.log('term-features   :', tmux('show-options', '-g', '-q', '-v', 'terminal-features'));
  console.log('panel rows      :', JSON.stringify(await ring()));
  console.log('');

  console.log('--- default tmux options ---');
  await probe('A raw OSC 52', 'RAW-DEFAULT', emitRaw);
  await probe('B DCS passthrough', 'DCS-DEFAULT', emitDcs);
  await probe('C tmux load-buffer -w', 'BUF-DEFAULT', emitBuf);

  console.log('\n--- set-clipboard on ---');
  tmux('set-option', '-g', 'set-clipboard', 'on');
  await probe('A raw OSC 52', 'RAW-SETCLIP', emitRaw);
  await probe('C tmux load-buffer -w', 'BUF-SETCLIP', emitBuf);

  console.log('\n--- + allow-passthrough on ---');
  // tmux < 3.3 has no such option and passes DCS through unconditionally; 3.3+
  // defaults it OFF, which is what kills channel B on a modern tmux.
  try {
    tmux('set-option', '-g', 'allow-passthrough', 'on');
    await probe('B DCS passthrough', 'DCS-PASSTHRU', emitDcs);
  } catch (e) { console.log('  (no allow-passthrough option on this tmux — always passes through)'); }

  console.log('\n--- long payload (a real login URL is ~250 chars) ---');
  const longURL = 'https://claude.ai/oauth/authorize?code=true&client_id=' + 'a'.repeat(300) + '&state=' + 'b'.repeat(120);
  await probe(`A raw OSC 52, ${longURL.length} chars`, longURL, emitRaw);

  console.log('\n--- a SECOND client attached (the ssh console) ---');
  // `load-buffer -w` forwards to ONE client — whichever tmux picks as the target.
  const { spawn } = require('child_process');
  const second = spawn('script', ['-q', '-f', '-c', `tmux -S ${SOCK} attach -t dev`, '/tmp/second.raw'], { stdio: ['pipe', 'ignore', 'ignore'] });
  await sleep(2000);
  console.log('clients now     :', tmux('list-clients', '-F', '#{client_tty}').split('\n').join(' '));
  await probe('C tmux load-buffer -w (2 clients)', 'BUF-TWOCLIENTS', emitBuf);
  await probe('A raw OSC 52 (2 clients)', 'RAW-TWOCLIENTS', emitRaw);
  second.kill();

  await browser.close();
})().catch((e) => { console.error('DIAG ERROR', e); process.exit(1); });
