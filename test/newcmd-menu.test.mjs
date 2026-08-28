// Unit tests for the new-window menu view model. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  menuFor, displayName, describe as describeEntry,
  withCmdAt, withoutIndex, withAppended, isDefaultMenu,
} from '../resources/js/newcmd-menu.js';

test('a session with no menu still offers one plain "+"', () => {
  assert.deepEqual(menuFor({}), [{ label: '', cmd: '' }]);
  assert.deepEqual(menuFor({ newCmds: [] }), [{ label: '', cmd: '' }]);
  assert.deepEqual(menuFor(undefined), [{ label: '', cmd: '' }]);
});

test('menuFor copies, so editing a menu cannot write through to the layout', () => {
  const session = { newCmds: [{ label: 'a', cmd: 'x' }] };
  const menu = menuFor(session);
  menu[0].cmd = 'mutated';
  assert.equal(session.newCmds[0].cmd, 'x');
});

test('junk entries are dropped rather than drawn as buttons', () => {
  assert.deepEqual(menuFor({ newCmds: [null, 'nope', { cmd: 'ok' }] }), [{ label: '', cmd: 'ok' }]);
});

test('the caption is the LAST path-shaped token, not the first wrapper', () => {
  // The exact three claude-editors defaults.
  assert.equal(displayName({ cmd: '' }), 'shell');
  assert.equal(displayName({ cmd: 'cd /home/me/Projects' }), 'Projects');
  assert.equal(displayName({ cmd: '/p/scripts/enter_secure_container.sh' }), 'enter_secure_container');
  assert.equal(
    displayName({ cmd: '/p/scripts/run-in-daemon.sh -w /workspace scripts/claude-docker/launch_new.sh' }),
    'launch_new',
  );
});

test('an explicit label always wins — the derivation is only a fallback', () => {
  assert.equal(displayName({ label: 'claude', cmd: 'anything at all' }), 'claude');
  assert.equal(displayName({ label: '  spaced  ', cmd: 'x' }), 'spaced');
});

test('flags never become the caption', () => {
  assert.equal(displayName({ cmd: 'ls -la' }), 'ls');
  assert.equal(displayName({ cmd: 'make -j8' }), 'make');
});

test('a redirect target is not what runs', () => {
  // Caught by the browser driver: this captioned itself "menu-entry0".
  assert.equal(displayName({ cmd: 'printf ran > /tmp/menu-entry0' }), 'printf');
  assert.equal(displayName({ cmd: 'make 2> /tmp/err' }), 'make');
});

test('the right-hand side of a pipe is not what runs', () => {
  assert.equal(displayName({ cmd: 'tail -F "$LOG" | grep -i error' }), 'tail');
  assert.equal(displayName({ cmd: 'a.sh && b.sh' }), 'a');
});

test('the tooltip carries the whole command, since the caption cannot', () => {
  const long = '/p/scripts/run-in-daemon.sh -w /workspace scripts/claude-docker/launch_new.sh';
  assert.ok(describeEntry({ cmd: long }, 'claude-editors').includes(long));
  assert.ok(describeEntry({ cmd: '' }, 'dev').includes('plain shell'));
});

test('edits return new lists rather than mutating', () => {
  const menu = [{ label: '', cmd: 'a' }, { label: '', cmd: 'b' }];
  assert.deepEqual(withCmdAt(menu, 1, 'B'), [{ label: '', cmd: 'a' }, { label: '', cmd: 'B' }]);
  assert.equal(menu[1].cmd, 'b', 'original untouched');
  assert.deepEqual(withoutIndex(menu, 0), [{ label: '', cmd: 'b' }]);
  assert.equal(withAppended(menu).length, 3);
  assert.equal(withAppended(menu)[2].cmd, '');
});

test('an out-of-range edit changes nothing', () => {
  const menu = [{ label: '', cmd: 'a' }];
  assert.deepEqual(withCmdAt(menu, 5, 'x'), menu);
  assert.deepEqual(withCmdAt(menu, -1, 'x'), menu);
});

test('a menu of one empty entry IS the default, so it is stored as nothing', () => {
  // Storing it would be indistinguishable from storing nothing, and clearing
  // leaves the session its single plain "+".
  assert.equal(isDefaultMenu([{ label: '', cmd: '' }]), true);
  assert.equal(isDefaultMenu([{ label: '', cmd: 'x' }]), false);
  assert.equal(isDefaultMenu([{ label: 'named', cmd: '' }]), false);
  assert.equal(isDefaultMenu([{ label: '', cmd: '' }, { label: '', cmd: '' }]), false);
});
