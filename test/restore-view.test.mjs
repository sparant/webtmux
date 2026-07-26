// Unit tests for resolveRestoreView — where a region lands on the first layout after
// a reload. Run with:
//
//     node --test test/
//
// restore-view.js has no imports, so it loads cleanly under node.
//
// THE BUG THESE PIN. Refreshing the browser always dumped the main region on the same
// window of the base session (`services`) instead of the tab you were last on. The
// saved state named a window but not its SESSION, and a pane's window list only covers
// the session it is attached to — so a window that lived in another session was read as
// "gone", the restore no-opped, and the pane stayed where a fresh attach to the shared
// base session puts you. The first two tests are the before/after of exactly that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRestoreView } from '../resources/js/restore-view.js';

// A pane freshly re-attached to the shared base session, with a server holding windows
// in three sessions. `windows` is deliberately only the base session's list — that
// asymmetry with `placements` IS the situation being tested.
const BASE = {
  session: 'services',
  windows: ['@1', '@2'],                       // services: webtmux, logs
  placements: [
    { id: '@1', session: 'services' },
    { id: '@2', session: 'services' },
    { id: '@7', session: 'claude-editors' },
    { id: '@8', session: 'pi-editors' },
  ],
  recents: [
    { id: '@7', session: 'claude-editors' },
    { id: '@2', session: 'services' },
    { id: '@1', session: 'services' },
  ],
  recency: (id) => ({ '@7': 30, '@2': 20, '@1': 10 })[id] || 0,
};

test('a saved view in ANOTHER session is restored, session and all', () => {
  const view = resolveRestoreView({ ...BASE, saved: { windowId: '@7', session: 'claude-editors' } });
  assert.deepEqual(view, { id: '@7', session: 'claude-editors' },
    'the window is not in the pane\'s own list — the saved session is what makes it reachable');
});

test('a saved view in the pane\'s own session is restored without a hop', () => {
  const view = resolveRestoreView({ ...BASE, saved: { windowId: '@2', session: 'services' } });
  assert.deepEqual(view, { id: '@2', session: 'services' });
});

test('nothing saved -> null: a first-ever visit never moves the pane', () => {
  // The primary shares its attach with the ssh console, so "no saved view" must mean
  // "leave tmux alone", not "pick something" — that would drag the console too.
  assert.equal(resolveRestoreView({ ...BASE, saved: null }), null);
  assert.equal(resolveRestoreView({ ...BASE, saved: { windowId: null, session: 'services' } }), null);
  assert.equal(resolveRestoreView({ ...BASE }), null);
  assert.equal(resolveRestoreView(), null, 'and it is total for no input at all');
});

test('a saved window whose session was never recorded is honored only HERE', () => {
  // Blobs from the builds that persisted a window alone. In the pane's own session the
  // id is trustworthy...
  assert.deepEqual(
    resolveRestoreView({ ...BASE, saved: { windowId: '@2', session: null } }),
    { id: '@2', session: 'services' },
  );
  // ...but an id that only exists in some OTHER session is not placed there on a guess.
  // It falls through to the most-recent-tab fallback (rule 2) instead.
  assert.deepEqual(
    resolveRestoreView({ ...BASE, saved: { windowId: '@8', session: null } }),
    { id: '@7', session: 'claude-editors' },
  );
});

test('a saved view that is gone falls back to the most recent surviving tab', () => {
  // The window was closed (or its session killed) while the browser was away.
  const view = resolveRestoreView({
    ...BASE,
    saved: { windowId: '@99', session: 'claude-editors' },
  });
  assert.deepEqual(view, { id: '@7', session: 'claude-editors' },
    '@7 is the most recently accessed placement that still exists');
});

test('a killed session falls back too, even when the window id survives elsewhere', () => {
  // @2 still exists in services, but the saved view claimed it in a session that is
  // gone. That exact placement is unrestorable, so the fallback runs.
  const view = resolveRestoreView({ ...BASE, saved: { windowId: '@2', session: 'gone' } });
  assert.deepEqual(view, { id: '@7', session: 'claude-editors' });
});

test('the fallback skips windows another pane already shows', () => {
  const view = resolveRestoreView({
    ...BASE,
    saved: { windowId: '@99', session: 'services' },
    occupied: ['@7'],                       // a split region has claude-editors:@7
  });
  assert.deepEqual(view, { id: '@2', session: 'services' }, 'next most recent, not a duplicate');
});

test('a saved view another pane already shows is refused, not mirrored', () => {
  // Rule 2 of the navigation model: a window is visible in at most one pane.
  const view = resolveRestoreView({
    ...BASE,
    saved: { windowId: '@7', session: 'claude-editors' },
    occupied: ['@7'],
  });
  assert.deepEqual(view, { id: '@2', session: 'services' });
});

test('the fallback never picks a window nobody has visited', () => {
  // recency 0 = never opened from this client. Landing on one (typically window 0 of
  // the base session) is exactly the behavior being fixed, so it must not come back
  // through the fallback.
  const view = resolveRestoreView({
    ...BASE,
    saved: { windowId: '@99', session: 'services' },
    recents: [{ id: '@1', session: 'services' }],
    recency: () => 0,
  });
  assert.equal(view, null, 'stay put rather than move to an arbitrary window');
});

test('the fallback ranks by recency, not by strip order', () => {
  const view = resolveRestoreView({
    ...BASE,
    saved: { windowId: '@99', session: 'services' },
    recents: [                              // strip order deliberately oldest-first
      { id: '@1', session: 'services' },
      { id: '@2', session: 'services' },
      { id: '@7', session: 'claude-editors' },
    ],
  });
  assert.deepEqual(view, { id: '@7', session: 'claude-editors' });
});

test('a recents entry for a window in a session that no longer holds it is skipped', () => {
  // A LINKED window unlinked from one session: the id lives on, that placement does not.
  const view = resolveRestoreView({
    ...BASE,
    saved: { windowId: '@99', session: 'services' },
    recents: [{ id: '@7', session: 'unlinked-from-here' }, { id: '@2', session: 'services' }],
  });
  assert.deepEqual(view, { id: '@2', session: 'services' });
});

test('no server directory: fall back to the pane\'s own session list', () => {
  // An older server (or a push without the directory) leaves us with one session's
  // worth of truth. That must degrade to the pre-directory behavior, not to "nothing
  // exists anywhere", which would make every reload a no-op.
  assert.deepEqual(
    resolveRestoreView({ ...BASE, placements: [], saved: { windowId: '@2', session: 'services' } }),
    { id: '@2', session: 'services' },
  );
  // A cross-session view is unverifiable without the directory, so it cannot be
  // honored; the fallback then sees only this session's tabs and picks the most recent
  // of those, which is still better than sitting on the attach window.
  assert.deepEqual(
    resolveRestoreView({ ...BASE, placements: [], saved: { windowId: '@7', session: 'claude-editors' } }),
    { id: '@2', session: 'services' },
  );
  // With nothing here worth returning to either, the pane is left alone.
  assert.equal(
    resolveRestoreView({
      ...BASE,
      placements: [],
      recents: [{ id: '@7', session: 'claude-editors' }],
      saved: { windowId: '@7', session: 'claude-editors' },
    }),
    null,
  );
});
