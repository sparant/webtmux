// Unit tests for file-transfer.js — the wording and the URL/plan arithmetic
// behind the ⤓ dropdown's upload and download sections. Run with:
//
//     node --test test/
//
// Two things are under test, and neither is formatting.
//
// The first is DIRECTION. This feature has two machines in every sentence and
// they are not the two the save section above it talks about, so a label that
// says "Upload" without saying upload to where is a coin flip for the reader.
// Every assertion about text below is really an assertion that both ends are
// named.
//
// The second is the folder plan. `webkitRelativePath` is what makes a folder
// upload arrive as a folder; using `name` in its place is a one-word slip that
// flattens the tree and silently merges every src/index.js in the selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HERE, THERE, TRANSFER_BLURB, UPLOAD_TITLE, DOWNLOAD_TITLE,
  uploadPlan, transferSummary, uploadLabel, transferUrl,
  defaultTransferDir, transferPlaceholder, transferHint,
  probeBanner, uploadBanner, uploadProgressText,
} from '../resources/js/file-transfer.js';

// A stand-in for the browser's File: only size, name and webkitRelativePath are
// ever read.
const f = (rel, size = 1024) => ({
  name: rel.split('/').pop(),
  webkitRelativePath: rel.includes('/') ? rel : '',
  size,
});

test('every heading names BOTH machines, in the direction the bytes travel', () => {
  // The whole design rests on this. "Upload"/"Download" alone are obvious to
  // whoever wrote them and ambiguous to everyone with two machines on screen.
  for (const s of [TRANSFER_BLURB, UPLOAD_TITLE, DOWNLOAD_TITLE]) {
    assert.ok(s.includes(HERE), `"${s}" does not name the browser's machine`);
    assert.ok(s.includes(THERE), `"${s}" does not name the tmux machine`);
  }
  // Direction is carried by the order, so it has to be the right way round.
  assert.ok(UPLOAD_TITLE.indexOf(HERE) < UPLOAD_TITLE.indexOf(THERE), UPLOAD_TITLE);
  assert.ok(DOWNLOAD_TITLE.indexOf(THERE) < DOWNLOAD_TITLE.indexOf(HERE), DOWNLOAD_TITLE);
});

test('webtmux is never named as an endpoint in a heading', () => {
  // It is in the middle of every byte and it is still not one of the two ends.
  // Naming it puts a third machine in a sentence already asking for two.
  for (const s of [UPLOAD_TITLE, DOWNLOAD_TITLE]) {
    assert.doesNotMatch(s, /webtmux/i, s);
  }
});

test('a folder pick keeps its tree, and is named by its folder', () => {
  const plan = uploadPlan([
    f('project/src/util.js', 100),
    f('project/README.md', 200),
  ]);
  assert.equal(plan.files, 2);
  assert.equal(plan.bytes, 300);
  // The rel path, not the basename: flattening merges files that share a name.
  assert.deepEqual(plan.entries.map((e) => e.rel), ['project/src/util.js', 'project/README.md']);
  assert.equal(plan.folder, 'project');
  // Which folder, not just how many files — picking the wrong one is the easy
  // mistake and "42 files" is true of almost any folder.
  assert.match(transferSummary(plan), /project/);
  assert.match(uploadLabel(plan), /project/);
  assert.ok(uploadLabel(plan).includes(THERE));
});

test('a plain multi-file pick has no folder and uses bare names', () => {
  const plan = uploadPlan([f('a.txt', 10), f('b.txt', 20)]);
  assert.equal(plan.folder, '');
  assert.deepEqual(plan.entries.map((e) => e.rel), ['a.txt', 'b.txt']);
  assert.match(transferSummary(plan), /2 files/);
});

test('files from two different folders are not claimed to be one folder', () => {
  // Every rel has a slash, so a first-segment check that forgot to compare them
  // would report "folder alpha" for a selection that is nothing of the sort.
  const plan = uploadPlan([f('alpha/x.txt'), f('beta/y.txt')]);
  assert.equal(plan.folder, '');
});

test('an empty pick summarises to nothing rather than to "0 files"', () => {
  const plan = uploadPlan([]);
  assert.equal(plan.files, 0);
  assert.equal(transferSummary(plan), '');
  // With nothing chosen the button still has to say where it would send things.
  assert.ok(uploadLabel(plan).includes(THERE));
});

test('transferUrl drops empty params instead of sending them blank', () => {
  // A blank `dir` would override a real remembered directory with nothing.
  const url = transferUrl('/', 'download', { path: '/a b.txt', dir: '', win: '@3', probe: true });
  assert.ok(!url.includes('dir='), url);
  assert.match(url, /^\/transfer\/download\?/);
  assert.match(url, /win=%403/);
  assert.match(url, /probe=1/);
  // A space in a path must survive the round trip.
  assert.match(url, /path=%2Fa\+b\.txt|path=%2Fa%20b\.txt/);
});

test('transferUrl hangs off the page path, so it inherits the page auth', () => {
  assert.match(transferUrl('/tmux/', 'upload', {}), /^\/tmux\/transfer\/upload$/);
});

test('the prefill is the directory webtmux can reach, not the one tmux reports', () => {
  // They differ exactly when webtmux is containerized and reaching the host
  // through a mapping — and there paneDir is the path that looks right, matches
  // the user's shell, and fails.
  const info = { paneDir: '/home/you/Projects', baseDir: '/data', paneVisible: false, container: true };
  assert.equal(defaultTransferDir(info), '/data');
  assert.equal(transferPlaceholder(info, 'upload'), '/data');
  assert.equal(transferPlaceholder(info, 'download'), '/data/build.log');
});

test('with nothing shared, the hint points at the question already on screen', () => {
  const hint = transferHint({ blocked: true, container: true, baseDir: '' });
  assert.equal(hint.level, 'warn');
  assert.match(hint.text, /above/);          // the save section's directory row
  assert.doesNotMatch(hint.text, /WEBTMUX_SAVE_DIR/); // that answer belongs to the section above
});

test('the container hint names both directories, like the save hint does', () => {
  const hint = transferHint({ baseDir: '/data', paneDir: '/home/you/Projects', paneVisible: false, container: true });
  assert.equal(hint.level, 'warn');
  assert.match(hint.text, /\/data/);
  assert.match(hint.text, /\/home\/you\/Projects/);
});

test('a folder download says what it will leave out BEFORE it starts', () => {
  // An archive quietly missing things is the failure nobody checks for.
  const b = probeBanner({ ok: true, isDir: true, name: 'project.zip', bytes: 2048, files: 9, skipped: ['link (symlink)'] });
  assert.match(b.text, /project\.zip/);
  assert.match(b.text, /skipping 1 item/);
  assert.match(b.text, /symlink/);
});

test('a refused probe becomes an error banner carrying the server reason', () => {
  const b = probeBanner({ ok: false, error: '/etc/shadow is outside the folders webtmux may read' });
  assert.equal(b.state, 'err');
  assert.match(b.text, /outside the folders/);
});

test('a partly-failed upload reports what landed AND what did not', () => {
  // The interesting outcome for a folder: one gesture, many files, and a banner
  // that collapses to plain red would hide the half that worked.
  const b = uploadBanner({
    ok: false, files: 4, bytes: 4096, dir: '/data/in', skipped: 2,
    failures: [{ name: 'a.txt', error: 'already exists' }, { name: 'b.txt', error: 'already exists' }],
  });
  // 'partial', never 'confirm': the save section renders an Overwrite button from
  // the state alone, and this banner has nothing left to overwrite.
  assert.equal(b.state, 'partial');
  assert.match(b.text, /4 files/);
  assert.match(b.text, /a\.txt/);
  assert.match(b.text, /already exists/);
});

test('a wholly successful upload names the machine it landed on', () => {
  const b = uploadBanner({ ok: true, files: 1, bytes: 512, dir: '/data/in' });
  assert.equal(b.state, 'ok');
  assert.match(b.text, /\/data\/in/);
  assert.ok(b.text.includes(THERE));
});

test('upload progress states a percentage only when the total is known', () => {
  assert.match(uploadProgressText(512, 1024), /50%/);
  assert.ok(uploadProgressText(512, 1024).includes(THERE));
  // A stream with no declared total still has to say how far it has got;
  // inventing a percentage would be worse than omitting one.
  assert.doesNotMatch(uploadProgressText(2048, 0), /%/);
});
