// Unit tests for WorkAlerts — the "which windows should be flashing" state machine —
// and for hiddenAlerts, which decides what is left for the recents strip's overflow
// arrow to announce. Run with:
//
//     node --test test/
//
// work-alerts.js has no imports at all, so it loads cleanly under node.
//
// This is worth testing because every rule in it is about a SEQUENCE of polls, not
// about one snapshot: the same red dot means "flash" or "stay quiet" depending
// entirely on what came before it and on whether you've looked since. That's the
// kind of logic that regresses invisibly — a stuck flash is annoying, but a flash
// that silently stops firing is the failure you'd never notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkAlerts, AlertsPersistence, hiddenAlerts, alertOf } from '../resources/js/work-alerts.js';

// One recents strip entry, shaped like the ones SplitManager._refreshToolbar builds.
const tab = (id, working, extra = {}) => ({
  id, working, session: 'services', name: id, index: 1, active: false, ...extra,
});

// Feed a sequence of strips through one WorkAlerts and return the last one marked.
function run(alerts, ...strips) {
  let out = [];
  for (const s of strips) out = alerts.mark(s);
  return out;
}

test('green -> red raises a red alert; green -> amber raises an amber one', () => {
  const a = new WorkAlerts();
  const out = run(a,
    [tab('@1', '1'), tab('@2', '1')],
    [tab('@1', '0'), tab('@2', '2')],
  );
  assert.equal(out[0].alert, '0', 'stopped window flashes red');
  assert.equal(out[1].alert, '2', 'waiting window flashes amber');
});

test('a window already red on the first poll does NOT flash', () => {
  // Nothing changed while you were away — you just opened the browser. Flashing
  // here would mean every reload lights up the strip for old news.
  const a = new WorkAlerts();
  const out = run(a, [tab('@1', '0')], [tab('@1', '0')]);
  assert.equal(out[0].alert, '', 'no prior green, so no transition, so no flash');
});

test('the flash persists across polls until the window is focused', () => {
  const a = new WorkAlerts();
  run(a, [tab('@1', '1')], [tab('@1', '0')]);
  // Many quiet polls later it is still flashing — there is deliberately no expiry.
  const still = run(a, [tab('@1', '0')], [tab('@1', '0')], [tab('@1', '0')]);
  assert.equal(still[0].alert, '0');

  const focused = run(a, [tab('@1', '0', { active: true })]);
  assert.equal(focused[0].alert, '', 'focusing the window acknowledges it');

  // ...and it stays acknowledged after you look away again.
  const after = run(a, [tab('@1', '0')]);
  assert.equal(after[0].alert, '', 'acknowledged stays acknowledged');
});

test('red -> amber while unacknowledged re-colours the flash without clearing it', () => {
  const a = new WorkAlerts();
  const out = run(a, [tab('@1', '1')], [tab('@1', '0')], [tab('@1', '2')]);
  assert.equal(out[0].alert, '2', 'still flashing, now in the colour it changed to');
});

test('returning to green clears the flash by itself', () => {
  const a = new WorkAlerts();
  const out = run(a, [tab('@1', '1')], [tab('@1', '0')], [tab('@1', '1')]);
  assert.equal(out[0].alert, '', 'it un-stopped, so there is nothing to go and look at');
});

test('a blank status neither raises nor clears', () => {
  const a = new WorkAlerts();
  // green -> blank is not a stop: the window just stopped reporting.
  const quiet = run(a, [tab('@1', '1')], [tab('@1', '')]);
  assert.equal(quiet[0].alert, '', 'losing the signal is not the same as stopping');

  // ...and a blank arriving mid-flash leaves the flash (and its colour) alone.
  const b = new WorkAlerts();
  const kept = run(b, [tab('@1', '1')], [tab('@1', '2')], [tab('@1', '')]);
  assert.equal(kept[0].alert, '2', 'flash survives @wt_working being cleared');
});

test('a window focused as it stops never flashes', () => {
  // You were watching it happen — the whole premise of the alert is absence.
  const a = new WorkAlerts();
  const out = run(a,
    [tab('@1', '1', { active: true })],
    [tab('@1', '0', { active: true })],
  );
  assert.equal(out[0].alert, '');
});

// A linked window earns a tab per session, so it RAISES in both — but the two tabs are
// two doors onto one screen, so looking through either one acknowledges both. (This
// used to assert the opposite; see the keying note in work-alerts.js for why it
// changed.)
const linked = (working, activeIn) => [
  tab('@1', working, { session: 'services', active: activeIn === 'services' }),
  tab('@1', working, { session: 'editors', active: activeIn === 'editors' }),
];

test('a linked window flashes in every session it is placed in', () => {
  const a = new WorkAlerts();
  const out = run(a, linked('1'), linked('0'));
  assert.equal(out[0].alert, '0');
  assert.equal(out[1].alert, '0');
});

test('viewing a linked window in ONE session clears the flash in all of them', () => {
  const a = new WorkAlerts();
  run(a, linked('1'), linked('0'));
  const out = run(a, linked('0', 'services'));
  assert.equal(out[0].alert, '', 'the tab you focused is acknowledged');
  assert.equal(out[1].alert, '', 'and so is the other door onto the same screen');
});

test('acknowledging the LATER placement in the list still clears the earlier one', () => {
  // The pass that clears has to see the whole poll before it decides: the placement
  // you are looking at is often listed after the one that must stop flashing.
  const a = new WorkAlerts();
  run(a, linked('1'), linked('0'));
  const out = run(a, linked('0', 'editors'));
  assert.equal(out[0].alert, '', 'services tab quiet even though editors comes second');
  assert.equal(out[1].alert, '');
});

test('an acknowledged linked window does not re-raise when you look away', () => {
  const a = new WorkAlerts();
  run(a, linked('1'), linked('0'), linked('0', 'services'));
  const out = run(a, linked('0'));          // still red, nobody viewing it
  assert.equal(out[0].alert, '', 'no second transition, so no second flash');
  assert.equal(out[1].alert, '');
});

test('a linked window that drops out of green again DOES flash again', () => {
  const a = new WorkAlerts();
  run(a, linked('1'), linked('0'), linked('0', 'services'));
  const out = run(a, linked('1'), linked('2'));
  assert.equal(out[0].alert, '2', 'fresh news is announced in both tabs');
  assert.equal(out[1].alert, '2');
});

test('an unviewed linked window keeps flashing in both tabs', () => {
  const a = new WorkAlerts();
  const other = (working) => [
    ...linked(working),
    tab('@2', working, { session: 'services', active: true }),
  ];
  const out = run(a, other('1'), other('0'));
  assert.equal(out[0].alert, '0');
  assert.equal(out[1].alert, '0');
  assert.equal(out[2].alert, '', 'the window you are actually looking at is quiet');
});

test('a tab leaving the strip forgets its state, so re-entering does not re-flash', () => {
  const a = new WorkAlerts();
  run(a, [tab('@1', '1')], [tab('@1', '0')]);       // flashing
  run(a, [tab('@9', '1')]);                          // @1 evicted / ×'d
  const back = run(a, [tab('@1', '0')]);             // it comes back, still red
  assert.equal(back[0].alert, '', 'no stale prior-green, so no phantom transition');
});

// --- ordering: which alert is the MOST RECENT --------------------------------
// The overflow arrow takes you to one window out of several, and it has to be the
// latest — "some window somewhere stopped" is not a thing anyone can act on. Ordering
// is the only part of this module a user can see directly, via where the arrow lands.

test('alertSeq ranks alerts by when they were raised', () => {
  const a = new WorkAlerts();
  run(a, [tab('@1', '1'), tab('@2', '1'), tab('@3', '1')]);
  run(a, [tab('@1', '0'), tab('@2', '1'), tab('@3', '1')]);   // @1 stops first
  const out = run(a, [tab('@1', '0'), tab('@2', '1'), tab('@3', '0')]); // then @3
  assert.ok(out[2].alertSeq > out[0].alertSeq, '@3 stopped later, so it ranks first');
  assert.equal(out[1].alertSeq, 0, 'a quiet window carries no rank');
});

test('a quiet poll does not restamp an existing alert', () => {
  // Otherwise "most recent" would decay into "whichever window the 500ms loop touched
  // last", and the arrow would wander between windows that changed minutes apart.
  const a = new WorkAlerts();
  run(a, [tab('@1', '1'), tab('@2', '1')]);
  const first = run(a, [tab('@1', '0'), tab('@2', '1')])[0].alertSeq;
  run(a, [tab('@1', '1'), tab('@2', '0')]);   // @1 recovers, @2 stops (now the latest)
  const later = run(a, [tab('@1', '0'), tab('@2', '0')]);
  assert.ok(later[0].alertSeq > later[1].alertSeq, '@1 stopping again is the newer news');
  assert.notEqual(later[0].alertSeq, first, 'a fresh transition earns a fresh rank');
});

test('a re-colour counts as fresh news', () => {
  // red -> amber is "and now it wants you" — a stronger claim than the one before it,
  // so it must be able to overtake alerts raised after the original red.
  const a = new WorkAlerts();
  run(a, [tab('@1', '1'), tab('@2', '1')]);
  run(a, [tab('@1', '0'), tab('@2', '1')]);   // @1 red
  run(a, [tab('@1', '0'), tab('@2', '0')]);   // @2 red, later
  const out = run(a, [tab('@1', '2'), tab('@2', '0')]);   // @1 now PROMPTING
  assert.ok(out[0].alertSeq > out[1].alertSeq, 'the escalation outranks the older red');
});

// --- the snapshot the surfaces read ------------------------------------------

test('the snapshot answers per placement, and falls back to the window', () => {
  const a = new WorkAlerts();
  run(a,
    [tab('@1', '1', { session: 'services' })],
    [tab('@1', '0', { session: 'services' })],
  );
  const snap = a.snapshot();
  assert.equal(alertOf(snap, 'services', '@1'), '0', 'the placement that flashed');
  assert.equal(alertOf(snap, '', '@1'), '0', 'a surface with no session still sees it');
  assert.equal(alertOf(snap, 'editors', '@1'), '0',
    'a stale session label falls back to the window rather than going quiet');
  assert.equal(alertOf(snap, 'services', '@9'), '', 'an unknown window is quiet');
  assert.equal(alertOf(null, 'services', '@1'), '', 'no snapshot yet is quiet, not a crash');
});

test('a fresh snapshot is handed out each time', () => {
  // lit re-renders on identity, so a reused map would freeze every row on whatever it
  // showed when the sidebar first painted.
  const a = new WorkAlerts();
  run(a, [tab('@1', '1')], [tab('@1', '0')]);
  assert.notEqual(a.snapshot(), a.snapshot());
});

// --- hiddenAlerts: what the overflow arrow still has to say -------------------

test('hiddenAlerts drops the windows some surface is already showing', () => {
  const a = new WorkAlerts();
  run(a, [tab('@1', '1'), tab('@2', '1'), tab('@3', '1')]);
  const marked = run(a, [tab('@1', '0'), tab('@2', '0'), tab('@3', '1')]);
  // @1 has a tab in the strip; @3 never stopped.
  const out = hiddenAlerts(marked, new Set(['@1']));
  assert.deepEqual(out.map((w) => w.id), ['@2']);
});

test('hiddenAlerts returns the most recent first', () => {
  const a = new WorkAlerts();
  run(a, [tab('@1', '1'), tab('@2', '1')]);
  run(a, [tab('@1', '0'), tab('@2', '1')]);
  const marked = run(a, [tab('@1', '0'), tab('@2', '2')]);
  assert.deepEqual(hiddenAlerts(marked, []).map((w) => w.id), ['@2', '@1'],
    'the arrow lands on the latest, so it has to sort first');
});

test('one covered placement covers the window in every session', () => {
  // A linked window flashing in the strip under services is already drawing the eye;
  // announcing the editors placement too would inflate the arrow with the same news.
  const a = new WorkAlerts();
  const strip = (working) => [
    tab('@1', working, { session: 'services' }),
    tab('@1', working, { session: 'editors' }),
  ];
  run(a, strip('1'));
  const marked = run(a, strip('0'));
  assert.equal(hiddenAlerts(marked, new Set(['@1'])).length, 0);
});

// --- surviving a reload -------------------------------------------------------
//
// The bug these cover: you open the laptop to several flashing tabs, refresh the
// browser to get the connection back, and the refresh clears every flash as though
// you had gone and looked at each window. The registry is derived from a sequence of
// polls, so a reload wiped it — and an empty registry is indistinguishable from an
// acknowledged one.

test('a reload restores the flashes it left', () => {
  const a = new WorkAlerts();
  run(a,
    [tab('@1', '1'), tab('@2', '1'), tab('@3', '1')],
    [tab('@1', '0'), tab('@2', '2'), tab('@3', '1')],
  );
  const saved = JSON.parse(JSON.stringify(a.toJSON()));   // through the store and back

  const b = new WorkAlerts().restore(saved);
  const out = run(b, [tab('@1', '0'), tab('@2', '2'), tab('@3', '1')]);
  assert.equal(out[0].alert, '0', 'the red flash survived the reload');
  assert.equal(out[1].alert, '2', 'so did the amber one');
  assert.equal(out[2].alert, '', 'and a window that never stopped is still quiet');
});

test('a restored flash still clears the moment you look at it', () => {
  const a = new WorkAlerts();
  run(a, [tab('@1', '1')], [tab('@1', '0')]);
  const b = new WorkAlerts().restore(a.toJSON());
  const out = run(b, [tab('@1', '0', { active: true })]);
  assert.equal(out[0].alert, '', 'restoring is not the same as making it permanent');
});

test('a restored flash re-colours when the window moved on during the reload', () => {
  const a = new WorkAlerts();
  run(a, [tab('@1', '1')], [tab('@1', '0')]);
  const b = new WorkAlerts().restore(a.toJSON());
  const out = run(b, [tab('@1', '2')]);
  assert.equal(out[0].alert, '2', 'red -> amber across the reload is still "and now it wants you"');
});

test('a restored flash clears when the window went back to green', () => {
  const a = new WorkAlerts();
  run(a, [tab('@1', '1')], [tab('@1', '0')]);
  const b = new WorkAlerts().restore(a.toJSON());
  assert.equal(run(b, [tab('@1', '1')])[0].alert, '', 'nothing left to go and look at');
});

test('the remembered green baseline survives, so a drop DURING the reload flashes', () => {
  // The whole point of carrying `prev` and not just the live alerts: the window was
  // green when the page went away and stopped while it was reloading (or while the
  // laptop was shut). Without the baseline this reads as "first seen red" and stays
  // silent forever — the exact transition the flash exists to catch.
  const a = new WorkAlerts();
  run(a, [tab('@1', '1')]);
  const b = new WorkAlerts().restore(a.toJSON());
  assert.equal(run(b, [tab('@1', '0')])[0].alert, '0');
});

test('a window that was already red and acknowledged stays quiet after a reload', () => {
  const a = new WorkAlerts();
  run(a, [tab('@1', '1')], [tab('@1', '0')], [tab('@1', '0', { active: true })]);
  const b = new WorkAlerts().restore(a.toJSON());
  assert.equal(run(b, [tab('@1', '0')])[0].alert, '', 'a reload must not resurrect old news');
});

test('restored alerts keep their order against ones raised afterwards', () => {
  const a = new WorkAlerts();
  run(a, [tab('@1', '1'), tab('@2', '1')], [tab('@1', '0'), tab('@2', '1')]);
  const b = new WorkAlerts().restore(a.toJSON());
  const out = run(b, [tab('@1', '0'), tab('@2', '0')]);
  const [w1, w2] = out;
  assert.ok(w2.alertSeq > w1.alertSeq,
    'the flash raised after the reload is the newer one, so the arrow goes there first');
});

test('restore tolerates junk out of the store', () => {
  const b = new WorkAlerts().restore({ seq: 'x', prev: 'nope', alerts: [null, {}, { id: '@1', value: '9' }] });
  assert.equal(run(b, [tab('@1', '0')])[0].alert, '', 'a bad value is dropped, not flashed');
  assert.equal(new WorkAlerts().restore(null).snapshot().size, 0);
  assert.equal(new WorkAlerts().restore(undefined).snapshot().size, 0);
});

test('a linked window restores a flash in both of its tabs', () => {
  const a = new WorkAlerts();
  const strip = (working) => [
    tab('@1', working, { session: 'services' }),
    tab('@1', working, { session: 'editors' }),
  ];
  run(a, strip('1'), strip('0'));
  const b = new WorkAlerts().restore(a.toJSON());
  const out = run(b, strip('0'));
  assert.equal(out[0].alert, '0');
  assert.equal(out[1].alert, '0', 'both doors onto the window still flash');
});

// --- AlertsPersistence: the guard around the store ----------------------------

// Minimal stand-in for ClientStore (section/patchSection is all that is used).
function fakeStore(initial = {}) {
  const state = { ...initial };
  return {
    state,
    writes: 0,
    section(name) { return state[name] && typeof state[name] === 'object' ? state[name] : {}; },
    patchSection(name, partial) { this.writes++; state[name] = { ...this.section(name), ...partial }; },
  };
}

test('nothing is written before the registry has been restored', () => {
  // SplitManager's constructor reaches _refreshToolbar before the restore runs; an
  // unguarded persist there saves an EMPTY registry over the one about to be read,
  // which is the reload-dismisses-your-flashes bug arriving by the back door.
  const store = fakeStore({ alerts: { registry: { seq: 3, prev: [], alerts: [{ session: 's', id: '@1', value: '0', seq: 3 }] } } });
  const p = new AlertsPersistence(store, 'alerts');
  assert.equal(p.persist(new WorkAlerts()), false, 'inert before restore()');
  assert.equal(store.writes, 0);

  const a = p.restore(new WorkAlerts());
  assert.equal(alertOf(a.snapshot(), 's', '@1'), '0', 'the saved flash was still there to read');
});

test('an unchanged registry is not written twice a second', () => {
  const store = fakeStore();
  const p = new AlertsPersistence(store, 'alerts');
  const a = p.restore(new WorkAlerts());
  run(a, [tab('@1', '1')]);
  assert.equal(p.persist(a), true, 'the first real change is written');
  const after = store.writes;
  assert.equal(p.persist(a), false, 'an identical registry is not');
  assert.equal(store.writes, after);
  run(a, [tab('@1', '0')]);
  assert.equal(p.persist(a), true, 'a raised flash is');
});

test('a persist/restore round trip through the store carries the flashes', () => {
  const store = fakeStore();
  const p = new AlertsPersistence(store, 'alerts');
  const a = p.restore(new WorkAlerts());
  run(a, [tab('@1', '1')], [tab('@1', '0')]);
  p.persist(a);

  // …reload: a new tab-lifetime object reading the same sessionStorage-backed blob.
  const b = new AlertsPersistence(store, 'alerts').restore(new WorkAlerts());
  assert.equal(run(b, [tab('@1', '0')])[0].alert, '0');
});
