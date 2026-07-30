// Unit tests for save-target.js — the sentence the save dropdown shows about
// where a file will land. Run with:
//
//     node --test test/
//
// The module is import-free, so it loads cleanly under node.
//
// The thing under test is not formatting, it's honesty: the hint must never
// claim the pane's own directory when the server has told us it can't see it,
// and when it can't, the text must name BOTH directories — the one the user
// thinks they're in and the one the file will actually appear in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveHint, saveOkText, saveResultBanner, DEFAULT_SAVE_HINT } from '../resources/js/save-target.js';

test('with no answer yet, the hint states the intended rule', () => {
  assert.equal(saveHint(null).text, DEFAULT_SAVE_HINT);
  assert.equal(saveHint({}).text, DEFAULT_SAVE_HINT);
  assert.equal(saveHint(null).level, 'info');
});

test('with nothing shared, the hint asks for a directory instead of guessing', () => {
  // The default deployment: a container mounting only the tmux control socket.
  // webtmux can't tell a bind mount from its own filesystem; the user can.
  const h = saveHint({ paneDir: '/home/you/Projects', baseDir: '', blocked: true, container: true });
  assert.equal(h.level, 'warn');
  assert.match(h.text, /Name one above/);
  assert.match(h.text, /\/data/);                 // an example they can act on
  assert.match(h.text, /Download to browser/);    // the no-directory alternative
  assert.doesNotMatch(h.text, /Relative paths save in/); // there is no directory to name
});

test('a rejected directory is explained, and the question stays open', () => {
  const h = saveHint({
    blocked: true, container: true, baseDir: '', chosen: '',
    chosenError: 'there is no directory /workspce inside the container webtmux runs in',
  });
  assert.equal(h.level, 'warn');
  assert.match(h.text, /\/workspce/);
});

test('once chosen, the hint names the directory and says it is remembered', () => {
  const h = saveHint({
    paneDir: '/home/you/Projects', baseDir: '/workspace', chosen: '/workspace',
    paneVisible: false, writable: true, container: true,
  });
  assert.equal(h.level, 'info');
  assert.match(h.text, /\/workspace/);
  assert.match(h.text, /remembered/);
});

test('when the pane directory is visible, the hint names it plainly', () => {
  const h = saveHint({
    paneDir: '/home/you/Projects', baseDir: '/home/you/Projects',
    paneVisible: true, writable: true, mapped: false, container: false,
  });
  assert.equal(h.level, 'info');
  assert.match(h.text, /\/home\/you\/Projects/);
  assert.doesNotMatch(h.text, /⚠/);
});

test('the container case warns and names both directories', () => {
  const h = saveHint({
    paneDir: '/home/you/Projects', baseDir: '/saves',
    paneVisible: false, writable: true, mapped: false, container: true,
  });
  assert.equal(h.level, 'warn');
  assert.match(h.text, /\/home\/you\/Projects/);  // where the user thinks they are
  assert.match(h.text, /\/saves/);                    // where the file will land
  assert.match(h.text, /container/);                  // why
  assert.match(h.text, /Download to browser/);        // the escape hatch
});

test('an invisible pane directory warns even when containerization is unknown', () => {
  const h = saveHint({
    paneDir: '/gone', baseDir: '/tmp',
    paneVisible: false, writable: true, mapped: false, container: false,
  });
  assert.equal(h.level, 'warn');
  assert.match(h.text, /does not exist on the machine webtmux runs on/);
});

test('a mapped directory is disclosed, so the saved path is not a surprise', () => {
  const h = saveHint({
    paneDir: '/home/you/Projects', baseDir: '/workspace',
    paneVisible: true, writable: true, mapped: true, container: true,
  });
  assert.equal(h.level, 'info');
  assert.match(h.text, /\/workspace/);
  assert.match(h.text, /\/home\/you\/Projects/);
});

test('an unwritable destination warns before anything is typed', () => {
  const h = saveHint({
    paneDir: '/x', baseDir: '/x', paneVisible: true, writable: false, mapped: false,
  });
  assert.equal(h.level, 'warn');
  assert.match(h.text, /cannot write/);
});

test('the success banner explains a destination the user did not choose', () => {
  const info = { paneDir: '/home/you/Projects', baseDir: '/saves', paneVisible: false };
  assert.match(saveOkText('/saves/out.txt', info), /Saved: \/saves\/out\.txt/);
  assert.match(saveOkText('/saves/out.txt', info), /\/home\/you\/Projects/);
});

test('the success banner stays terse when nothing surprising happened', () => {
  const info = { paneDir: '/p', baseDir: '/p', paneVisible: true };
  assert.equal(saveOkText('/p/out.txt', info), 'Saved: /p/out.txt');
  assert.equal(saveOkText('/p/out.txt', null), 'Saved: /p/out.txt');
});

// ---- the save-result banner ----------------------------------------------------
//
// Three outcomes, not two. "That file already exists" is the one failure the user
// can answer where they are standing, and the dropdown turns it into an Overwrite
// button — so the banner has to distinguish it, and has to do so from the reply's
// FLAG rather than from the wording of the error.

test('a successful save reads as one, with the destination', () => {
  const b = saveResultBanner({ ok: true, path: '/p/out.txt', env: { paneDir: '/p', baseDir: '/p', paneVisible: true } });
  assert.equal(b.state, 'ok');
  assert.match(b.text, /Saved: \/p\/out\.txt/);
});

test('an existing file is a question the dropdown can answer, not a dead end', () => {
  const b = saveResultBanner({
    ok: false, exists: true, path: '/p/out.txt',
    error: '/p/out.txt already exists. Overwrite it?',
  });
  assert.equal(b.state, 'confirm');
  assert.equal(b.path, '/p/out.txt');
  assert.match(b.text, /Overwrite/);
});

test('the overwrite case is told from the flag, never from the message text', () => {
  // Same words, no flag: an ordinary error. A UI that matched on English would
  // offer an Overwrite button that cannot help.
  const b = saveResultBanner({ ok: false, error: 'something already exists somewhere' });
  assert.equal(b.state, 'err');
});

test('every other failure keeps the server reason verbatim', () => {
  const b = saveResultBanner({
    ok: false,
    error: '/etc/x is outside the directories webtmux may write to (/workspace).',
  });
  assert.equal(b.state, 'err');
  assert.match(b.text, /outside the directories/);
});

test('a missing reply still says something', () => {
  assert.equal(saveResultBanner(null).state, 'err');
  assert.equal(saveResultBanner({ ok: false }).text, 'Save failed');
});
