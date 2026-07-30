// Unit tests for trimPastedName — the paste-a-path-get-a-window-name transform. Run:
//
//     node --test test/
//
// paste-name.js is import-free, so it loads cleanly under node.
//
// The interesting cases are all about RESTRAINT. This runs on content the user did not
// type, so every rule that removes characters has to be one they would have removed
// themselves; the tests below pin the places where it must keep its hands off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimPastedName } from '../resources/js/paste-name.js';

test('the reported case: a path to a plan file becomes the plan name', () => {
  assert.equal(
    trimPastedName('webtmux/plan-webtmux-portable-deps.md'),
    'plan-webtmux-portable-deps',
  );
});

test('only the last path segment survives, however deep', () => {
  assert.equal(trimPastedName('/workspace/webtmux/resources/js/split-manager.js'), 'split-manager');
  assert.equal(trimPastedName('a/b/c/d'), 'd');
});

test('a trailing slash means a directory, not an empty name', () => {
  assert.equal(trimPastedName('webtmux/'), 'webtmux');
  assert.equal(trimPastedName('/workspace/webtmux///'), 'webtmux');
});

test('a plain word is left exactly as it is', () => {
  assert.equal(trimPastedName('claude'), 'claude');
  assert.equal(trimPastedName('web-01'), 'web-01');
});

test('a dotted NAME keeps its dots — only a short trailing suffix is a suffix', () => {
  // The failure this guards against is worse than not trimming: a version or a
  // qualified name silently losing its tail.
  assert.equal(trimPastedName('v1.2.3'), 'v1.2.3');
  assert.equal(trimPastedName('api.staging'), 'api.staging');
  assert.equal(trimPastedName('release.candidate'), 'release.candidate');
});

test('a NUMERIC suffix is kept — that is the trade the letters-only rule buys', () => {
  // A version's last component and a short extension are the same shape, so the rule
  // errs towards keeping characters: an untidy name beats a truncated one.
  assert.equal(trimPastedName('clips/capture.mp4'), 'capture.mp4');
});

test('a dotfile is all suffix, so it keeps its whole name', () => {
  assert.equal(trimPastedName('~/.zshrc'), '.zshrc');
  assert.equal(trimPastedName('.gitignore'), '.gitignore');
});

test('a name that is nothing BUT a suffix is kept rather than emptied', () => {
  // Emptying the field would turn the paste into a silent no-op: commitRename
  // discards a blank name.
  assert.equal(trimPastedName('docs/.md'), '.md');
});

test('multi-line and whitespace-padded pastes collapse to one line', () => {
  assert.equal(trimPastedName('  webtmux/notes.md\n'), 'notes');
  assert.equal(trimPastedName('src/a.js\nsrc/b.js'), 'b');
});

test('nothing usable yields the empty string, so the caller can fall through', () => {
  for (const v of ['', '   ', '\n', '/', '///', null, undefined]) {
    assert.equal(trimPastedName(v), '', `expected '' for ${JSON.stringify(v)}`);
  }
});

test('windows-style separators are left alone (a tmux name may contain a backslash)', () => {
  // Only `/` is a path separator here: webtmux talks to a tmux running on a unix host,
  // and treating `\` as one would mangle a legitimate name.
  assert.equal(trimPastedName('a\\b\\c.md'), 'a\\b\\c');
});
