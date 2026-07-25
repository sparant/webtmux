// Unit tests for the bug-prone parts of the shared StateStore: the debounced
// write-back and the rev-based conflict/echo protocol. Run with:
//
//     node --test test/
//
// state-store.js has no external imports (the browser resolves lit/@xterm via the
// importmap; these stores don't touch either), so it loads cleanly under node.
// localStorage/sessionStorage are absent in node — the stores' try/catch treats
// that as "no cache", which is exactly the fresh-client path we want to exercise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../resources/js/state-store.js';
import { ClientStore } from '../resources/js/client-store.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('debounced write-back coalesces rapid patches into one send with bumped rev', async () => {
  const store = new StateStore();
  const sends = [];
  store.setSender((json) => sends.push(JSON.parse(json)));

  store.patchSection('sidebar', { overlay: false });
  store.patchSection('sidebar', { pinned: true });
  store.patch({ sessionOrder: ['a', 'b'] });

  assert.equal(sends.length, 0, 'nothing sent before the debounce elapses');
  await delay(500);

  assert.equal(sends.length, 1, 'the three patches coalesce into a single send');
  const blob = sends[0];
  assert.equal(blob.v, 1);
  assert.equal(blob.rev, 1, 'first write bumps rev 0 -> 1');
  assert.deepEqual(blob.sidebar, { overlay: false, pinned: true });
  assert.deepEqual(blob.sessionOrder, ['a', 'b']);
});

test('echo of our own write is suppressed (no re-apply, no rev change)', async () => {
  const store = new StateStore();
  const sends = [];
  store.setSender((json) => sends.push(JSON.parse(json)));
  let emits = 0;
  store.subscribe(() => { emits += 1; });

  store.patch({ toolbar: { showBuild: true } });
  await delay(500);
  assert.equal(sends.length, 1);
  const emitsAfterLocal = emits;
  const ourBlob = sends[0]; // rev 1

  // The server echoes our own write back on the next layout push.
  store.load(JSON.stringify(ourBlob));
  assert.equal(store.appliedRev, 1, 'appliedRev unchanged by our echo');
  assert.equal(emits, emitsAfterLocal, 'no extra emit for our own echo');
});

test('a strictly-newer remote blob is adopted and applied fromRemote', async () => {
  const store = new StateStore();
  store.setSender(() => {});
  const remotes = [];
  store.subscribe((_s, fromRemote) => remotes.push(fromRemote));

  store.load(JSON.stringify({ v: 1, rev: 5, expose: { sort: 'recent' } }));
  assert.equal(store.appliedRev, 5);
  assert.equal(store.section('expose').sort, 'recent');
  assert.deepEqual(remotes, [true], 'exactly one apply, flagged fromRemote');

  // A stale/older push is ignored.
  store.load(JSON.stringify({ v: 1, rev: 3, expose: { sort: 'session' } }));
  assert.equal(store.section('expose').sort, 'recent', 'older rev does not clobber');
  assert.deepEqual(remotes, [true], 'no apply for the stale push');
});

test('a local write after adopting a remote rev bumps past it', async () => {
  const store = new StateStore();
  const sends = [];
  store.setSender((json) => sends.push(JSON.parse(json)));
  store.load(JSON.stringify({ v: 1, rev: 9, sidebar: { pinned: true } }));

  store.patchSection('sidebar', { overlay: false });
  await delay(500);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].rev, 10, 'next write is max(appliedRev,lastWritten)+1');
  assert.equal(sends[0].sidebar.pinned, true, 'remote fields preserved');
  assert.equal(sends[0].sidebar.overlay, false, 'local change merged in');
});

test('the _applying guard blocks a subscriber from looping a write back in', async () => {
  const store = new StateStore();
  const sends = [];
  store.setSender((json) => sends.push(JSON.parse(json)));
  // A misbehaving subscriber that tries to write during an apply must be a no-op.
  store.subscribe(() => { store.patch({ sneaky: true }); });

  store.load(JSON.stringify({ v: 1, rev: 2, foo: 1 }));
  assert.equal(store.get('sneaky', undefined), undefined, 'guarded patch did not mutate');
  await delay(500);
  assert.equal(sends.length, 0, 'guarded patch scheduled no send');
});

test('ClientStore get/patch works in-memory when sessionStorage is absent', () => {
  const cs = new ClientStore();
  assert.equal(cs.get('focusedIndex', 0), 0);
  cs.patch({ focusedIndex: 2 });
  assert.equal(cs.get('focusedIndex', 0), 2);
  cs.patchSection('sidebar', { collapsed: true });
  assert.deepEqual(cs.section('sidebar'), { collapsed: true });
});
