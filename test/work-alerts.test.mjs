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
import { WorkAlerts, hiddenAlerts, alertOf } from '../resources/js/work-alerts.js';

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

test('the same window in two sessions is acknowledged per tab', () => {
  // A linked window earns a tab per session; focusing it in one says nothing about
  // the other, so the alerts must not share a key.
  const a = new WorkAlerts();
  const strip = (working, activeIn) => [
    tab('@1', working, { session: 'services', active: activeIn === 'services' }),
    tab('@1', working, { session: 'editors', active: activeIn === 'editors' }),
  ];
  run(a, strip('1'), strip('0'));
  const out = run(a, strip('0', 'services'));
  assert.equal(out[0].alert, '', 'the tab you focused is acknowledged');
  assert.equal(out[1].alert, '0', 'the other session keeps flashing');
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
