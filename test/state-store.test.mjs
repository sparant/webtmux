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

// The first layout push, carrying no @wt_state (a tmux server nobody has written to
// yet). Every test that expects a WRITE has to do this first: nothing may be flushed
// before the authoritative server blob — or its absence — is known (decision 1 of
// plan-webtmux-harden-state.md). In the browser this happens within 500ms of boot,
// because load() runs on every layout push whether or not it carries a blob.
const firstPush = (store, state) => store.load(state);

test('debounced write-back coalesces rapid patches into one send with bumped rev', async () => {
  const store = new StateStore();
  const sends = [];
  store.setSender((json) => sends.push(JSON.parse(json)));
  firstPush(store);

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
  firstPush(store);
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

// --- decision 1: the first-load gate ------------------------------------------
//
// Every clobber this plan set exists to stop has the same shape: a client writes
// state it read from its own localStorage CACHE before it has seen what the tmux
// server actually holds, and last-writer-wins hands the cache the win. The gate is
// one rule — no flush before the first load() — and it belongs in the store rather
// than in each of the four sections that would otherwise have to remember it.

test('nothing is flushed before the first layout push, and the held write goes out after', async () => {
  const store = new StateStore();
  const sends = [];
  store.setSender((json) => sends.push(JSON.parse(json)));

  // Boot-time write from cached state, before any server blob has been seen.
  store.patchSection('split', { regions: [] });
  await delay(500);
  assert.equal(sends.length, 0, 'the pre-load write is held, not sent');

  // The server's answer arrives: it holds a real split the user arranged elsewhere.
  store.load(JSON.stringify({ v: 1, rev: 4, split: { regions: [{ windowId: '@9' }] } }));
  await delay(500);

  assert.equal(sends.length, 1, 'the held write is flushed once the blob is known');
  assert.deepEqual(sends[0].split.regions, [], 'and it is replayed on top of the adopted blob');
  assert.equal(sends[0].rev, 5, 'on top of the server rev, not from a cached one');
});

test('onFirstLoad fires once after the first push, and immediately once already loaded', () => {
  const store = new StateStore();
  const order = [];
  store.onFirstLoad(() => order.push('early'));
  assert.deepEqual(order, [], 'not fired before any push');

  store.load(JSON.stringify({ v: 1, rev: 1 }));
  assert.equal(store.loadedOnce, true);
  assert.deepEqual(order, ['early']);

  store.onFirstLoad(() => order.push('late'));
  assert.deepEqual(order, ['early', 'late'], 'a late subscriber runs immediately');

  store.load(JSON.stringify({ v: 1, rev: 2 }));
  assert.deepEqual(order, ['early', 'late'], 'and never again on later pushes');
});

test('a push with no @wt_state still counts as loaded (a fresh tmux server)', async () => {
  const store = new StateStore();
  const sends = [];
  store.setSender((json) => sends.push(JSON.parse(json)));
  store.load(undefined);
  assert.equal(store.loadedOnce, true, 'the server answered: it holds nothing');

  store.patchSection('sidebar', { pinned: true });
  await delay(500);
  assert.equal(sends.length, 1, 'writes are allowed against a server with no blob');
});

// --- decision 3: the write-success contract -----------------------------------

test('patch/patchSection report whether the write was accepted', () => {
  const store = new StateStore();
  store.setSender(() => {});
  assert.equal(store.patch({ a: 1 }), true, 'an accepted top-level patch reports true');
  assert.equal(store.patchSection('sidebar', { pinned: true }), true);

  let inner = null;
  store.subscribe(() => { if (inner === null) inner = store.patchSection('sidebar', { pinned: false }); });
  store.load(JSON.stringify({ v: 1, rev: 3 }));
  assert.equal(inner, false, 'a patch swallowed by the _applying guard reports false');
});

// --- decision 4: equal revs are a collision, not a tie -------------------------

test('an equal-rev blob with DIFFERENT content is adopted (last writer wins, visibly)', () => {
  const store = new StateStore();
  store.setSender(() => {});
  store.load(JSON.stringify({ v: 1, rev: 5, expose: { sort: 'recent' } }));

  // Another client wrote rev 5 too — a collision. Under a strict `rev > appliedRev`
  // rule the two clients would sit on different content at the same rev forever.
  store.load(JSON.stringify({ v: 1, rev: 5, expose: { sort: 'session' } }));
  assert.equal(store.section('expose').sort, 'session', 'the server content wins');
  assert.equal(store.appliedRev, 5);
});

test('an equal-rev blob with the SAME content is still ignored (our own echo)', () => {
  const store = new StateStore();
  const sends = [];
  store.setSender((json) => sends.push(JSON.parse(json)));
  let applies = 0;
  store.subscribe((_s, fromRemote) => { if (fromRemote) applies += 1; });

  store.load(JSON.stringify({ v: 1, rev: 5, expose: { sort: 'recent' } }));
  assert.equal(applies, 1);
  // Key order differs; the content does not. A content hash, not a string compare.
  store.load(JSON.stringify({ rev: 5, expose: { sort: 'recent' }, v: 1 }));
  assert.equal(applies, 1, 'no re-apply for an echo of what we already hold');
});

test('two clients colliding on one rev converge on the server content', async () => {
  // One fake tmux server: whatever was written last is what the next push carries.
  let blob = null;
  const a = new StateStore();
  const b = new StateStore();
  a.setSender((json) => { blob = json; return true; });
  b.setSender((json) => { blob = json; return true; });
  a.load(undefined); b.load(undefined);

  a.patchSection('sidebar', { pinned: true });
  b.patchSection('sidebar', { pinned: false });
  await delay(500);
  // Both wrote rev 1; the server kept B's. A must not sit on its own rev-1 forever.
  const server = JSON.parse(blob);
  assert.equal(server.rev, 1);
  a.load(blob);
  assert.equal(a.section('sidebar').pinned, server.sidebar.pinned, 'A converges on the server');
});

test('un-flushed local patches survive an adopt and are replayed on top', async () => {
  const store = new StateStore();
  const sends = [];
  store.setSender((json) => sends.push(JSON.parse(json)));
  store.load(JSON.stringify({ v: 1, rev: 2, sidebar: { pinned: true } }));

  // A local edit that has not yet reached the wire...
  store.patchSection('sidebar', { overlay: false });
  // ...and a remote blob lands first, replacing the whole state.
  store.load(JSON.stringify({ v: 1, rev: 3, sidebar: { pinned: false }, expose: { sort: 'recent' } }));

  assert.equal(store.section('sidebar').overlay, false, 'the un-flushed local edit is not lost');
  assert.equal(store.section('sidebar').pinned, false, 'the remote value it did not touch is adopted');
  assert.equal(store.section('expose').sort, 'recent');
  await delay(500);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].rev, 4, 'the replayed edit is written on top of the remote rev');
});

test('an acked patch is not replayed a second time', async () => {
  const store = new StateStore();
  let blob = null;
  store.setSender((json) => { blob = json; return true; });
  store.load(undefined);
  store.patchSection('sidebar', { pinned: true });
  await delay(500);
  assert.ok(blob);

  // The server echoes our write, and then another client removes the key entirely.
  store.load(blob);
  store.load(JSON.stringify({ v: 1, rev: 2, sidebar: {} }));
  assert.equal(store.section('sidebar').pinned, undefined,
    'once the server has our write, a later removal is not undone by a replay');
});

// --- decision 5: a flush over a dead socket must not vanish --------------------

test('a send over a non-OPEN socket stays pending and is retried on resync', async () => {
  const store = new StateStore();
  const sends = [];
  let open = false;
  store.setSender((json) => { if (!open) return false; sends.push(JSON.parse(json)); return true; });
  store.load(undefined);

  store.patchSection('sidebar', { pinned: true });
  await delay(500);
  assert.equal(sends.length, 0, 'nothing reached the wire');
  assert.equal(store.lastWrittenRev, 0, 'and the rev was NOT claimed for a write that never left');

  open = true;
  store.resync();
  await delay(500);
  assert.equal(sends.length, 1, 'the reconnect re-flushes what was held');
  assert.equal(sends[0].sidebar.pinned, true);
});

test('a sender that throws is treated as a failed send, not as a completed one', async () => {
  const store = new StateStore();
  let boom = true;
  const sends = [];
  store.setSender((json) => { if (boom) throw new Error('ws closed'); sends.push(JSON.parse(json)); return true; });
  store.load(undefined);
  store.patchSection('pip', { hidden: true });
  await delay(500);
  assert.equal(store.lastWrittenRev, 0);

  boom = false;
  store.resync();
  await delay(500);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].pip.hidden, true);
});

// --- decision 6: the offline cache is keyed per tmux server --------------------

test('the offline cache is scoped to the tmux server it was written under', async () => {
  const store = new StateStore();
  const keys = withFakeStorage(() => {
    const s = new StateStore();
    s.load(JSON.stringify({ v: 1, rev: 9, sidebar: { pinned: true } }), 'server-A');
    return Object.keys(globalThis.localStorage._data);
  });
  assert.ok(keys.some((k) => k.includes('server-A')), `cache key carries the server id: ${keys}`);
  assert.ok(store, 'the un-identified store still boots (old server, no identity)');
});

test('a different tmux server does not inherit the old server rev', () => {
  withFakeStorage(() => {
    const a = new StateStore();
    a.load(JSON.stringify({ v: 1, rev: 40, sidebar: { pinned: true } }), 'server-A');

    // Same browser, same localStorage, but the socket now points at a NEW tmux
    // server whose own blob is at rev 2. Under one shared cache key the cached
    // rev 40 would suppress every push until the new server climbed past it.
    const b = new StateStore();
    b.load(JSON.stringify({ v: 1, rev: 2, sidebar: { pinned: false } }), 'server-B');
    assert.equal(b.section('sidebar').pinned, false, 'the new server blob is adopted');
    assert.equal(b.appliedRev, 2);
  });
});

test('a server with no identity keeps using the legacy shared cache key', () => {
  withFakeStorage(() => {
    const a = new StateStore();
    a.load(JSON.stringify({ v: 1, rev: 3, sidebar: { pinned: true } }));
    assert.ok(Object.keys(globalThis.localStorage._data).includes('webtmux-state'),
      'no identity -> today\'s key, so an older webtmux server keeps its cache');
  });
});

// A minimal localStorage, installed only for the duration of `fn`. The stores read
// it lazily (in their constructor), so this works regardless of import order — only
// the module-level singleton is fixed at import time, and these tests never use it.
function withFakeStorage(fn) {
  const data = Object.create(null);
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.localStorage = {
    _data: data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
  try { return fn(); } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    else delete globalThis.localStorage;
  }
}

test('ClientStore get/patch works in-memory when sessionStorage is absent', () => {
  const cs = new ClientStore();
  assert.equal(cs.get('focusedIndex', 0), 0);
  cs.patch({ focusedIndex: 2 });
  assert.equal(cs.get('focusedIndex', 0), 2);
  cs.patchSection('sidebar', { collapsed: true });
  assert.deepEqual(cs.section('sidebar'), { collapsed: true });
});
