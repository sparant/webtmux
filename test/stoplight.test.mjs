// Unit tests for stoplight.js — the shared meaning of the @wt_working dot. Run with:
//
//     node --test test/
//
// The module is import-free, so it loads cleanly under node.
//
// What's worth testing here isn't the mapping table (that's a one-liner you can read)
// but the two invariants the four surfaces depend on: the mapping is TOTAL, so a
// value tmux hands us that we didn't anticipate degrades to the unfilled "not
// reporting" dot rather than a stuck colour; and every state's hover text carries the
// WHOLE colour key, because a dot nobody can decode is just decoration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  workClass, workLabel, workTip, WORK_LEGEND, isBusy, formatDuration,
  workBadge, workBadgeTip, workBadgeModes, nextBadgeMode,
  STATUS_FILTERS, normalizeStatusFilter, matchesStatus, paintWorkClass, WORK_CLASSES,
} from '../resources/js/stoplight.js';

test('the four reported states each get their own fill', () => {
  assert.equal(workClass('1'), 'on');
  assert.equal(workClass('0'), 'off');
  assert.equal(workClass('2'), 'wait');
  assert.equal(workClass('3'), 'bg');
});

test('anything else is the unfilled dot, not a stuck colour', () => {
  // '' is @wt_working unset; undefined is a window missing from the map entirely;
  // '4'/'yes' stand in for a client that sets something we never defined.
  for (const v of ['', undefined, null, '4', 'yes', 1]) {
    assert.equal(workClass(v), '', `expected no class for ${JSON.stringify(v)}`);
    assert.equal(workLabel(v), 'Not reporting a status');
  }
});

test('every state hovers with the full colour key, not just its own line', () => {
  for (const v of ['1', '0', '2', '3', '']) {
    const tip = workTip(v);
    assert.ok(tip.startsWith(workLabel(v)), 'the tip leads with where THIS window is');
    assert.ok(tip.includes(WORK_LEGEND), 'and then explains every fill');
  }
});

test('the key names every colour it can paint', () => {
  for (const colour of ['Green', 'Green ring', 'Amber', 'Red', 'Unfilled']) {
    assert.ok(WORK_LEGEND.includes(colour), `legend is missing ${colour}`);
  }
});

// --- duration formatting and the "how long" lines in the tooltip --------------

test('formatDuration renders the expected boundary shapes', () => {
  assert.equal(formatDuration(0), '<1m');
  assert.equal(formatDuration(59), '<1m');
  assert.equal(formatDuration(60), '1m');
  assert.equal(formatDuration(125), '2m');
  assert.equal(formatDuration(3600), '1h');
  assert.equal(formatDuration(3600 + 8 * 60), '1h8m');
  assert.equal(formatDuration(24 * 3600), '1d');
  assert.equal(formatDuration(24 * 3600 + 3 * 3600), '1d3h');
});

test('formatDuration degrades to empty rather than a nonsense reading', () => {
  for (const bad of [-1, NaN, Infinity, undefined, null, 'nope']) {
    assert.equal(formatDuration(bad), '');
  }
});

test('workTip with no since/activity is byte-identical to the old single-arg form', () => {
  // The whole point of the added parameters being optional: every pre-existing
  // call site (three of them, across sidebar.js and toolbar.js) must keep behaving
  // exactly as before until it is updated to pass the new values.
  for (const v of ['1', '0', '2', '3', '']) {
    assert.equal(workTip(v), `${workLabel(v)}\n\n${WORK_LEGEND}`);
  }
});

test('workTip appends "in this state" when a valid since is given', () => {
  const now = 2_000_000;
  const tip = workTip('0', now - 125, undefined, now);
  assert.ok(tip.startsWith('Waiting for work to do — In this state for 2m'), tip);
});

test('workTip appends "pane silent" when a valid activity is given', () => {
  const now = 2_000_000;
  const tip = workTip('3', undefined, now - 3700, now);
  assert.ok(tip.startsWith('Working in the background — it can take input meanwhile — Pane silent for 1h1m'), tip);
});

test('workTip shows both readings together when both are given, since first', () => {
  const now = 2_000_000;
  const tip = workTip('0', now - 60, now - 30, now);
  assert.ok(tip.startsWith('Waiting for work to do — In this state for 1m — Pane silent for <1m'), tip);
});

test('workTip ignores an unset/zero/negative/non-numeric since or activity', () => {
  const now = 2_000_000;
  for (const bad of [undefined, null, '', 0, -5, 'nope']) {
    assert.equal(workTip('1', bad, bad, now), workTip('1'));
  }
});

test('workBadge prefers since over activity', () => {
  const now = 2_000_000;
  assert.equal(workBadge(now - 125, now - 5, now), '2m');
});

test('workBadge falls back to activity when since is absent/invalid', () => {
  const now = 2_000_000;
  for (const bad of [undefined, null, '', 0, -5, 'nope']) {
    assert.equal(workBadge(bad, now - 125, now), '2m');
  }
});

test('workBadge is empty when neither reading is available, not a fake "0m"', () => {
  const now = 2_000_000;
  for (const bad of [undefined, null, '', 0, -5, 'nope']) {
    assert.equal(workBadge(bad, bad, now), '');
  }
});

test('workBadgeTip names the mechanism matching whatever workBadge actually shows', () => {
  const now = 2_000_000;
  // since present -> explains @wt_working transitions, matches the badge's own value.
  const sinceTip = workBadgeTip(now - 125, now - 5, now);
  assert.ok(sinceTip.startsWith(`In this state for ${workBadge(now - 125, now - 5, now)}`), sinceTip);
  assert.ok(/@wt_working/.test(sinceTip) && /transition/i.test(sinceTip), sinceTip);
  assert.ok(!/window_activity/.test(sinceTip), 'the since branch must not cite the OTHER mechanism');

  // since absent, activity present -> explains tmux's own clock instead.
  const activityTip = workBadgeTip(undefined, now - 3700, now);
  assert.ok(activityTip.startsWith(`Pane silent for ${workBadge(undefined, now - 3700, now)}`), activityTip);
  assert.ok(/window_activity/.test(activityTip), activityTip);
});

test('workBadgeTip says plainly when there is nothing to explain', () => {
  const now = 2_000_000;
  for (const bad of [undefined, null, '', 0, -5, 'nope']) {
    assert.equal(workBadgeTip(bad, bad, now), 'No timing data available for this window.');
  }
});

// --- click-to-cycle between the two readings -----------------------------------

test('workBadgeModes lists exactly the readings a window actually has, since first', () => {
  assert.deepEqual(workBadgeModes(100, 200), ['since', 'activity']);
  assert.deepEqual(workBadgeModes(100, ''), ['since']);
  assert.deepEqual(workBadgeModes('', 200), ['activity']);
  assert.deepEqual(workBadgeModes('', ''), []);
  assert.deepEqual(workBadgeModes(0, -5), [], 'zero/negative are not valid readings');
});

test('nextBadgeMode cycles when both readings exist', () => {
  assert.equal(nextBadgeMode('since', 100, 200), 'activity');
  assert.equal(nextBadgeMode('activity', 100, 200), 'since');
  // an unrecognised/empty current mode is treated as "not the first" -> wraps to it
  assert.equal(nextBadgeMode('', 100, 200), 'since');
});

test('nextBadgeMode is a no-op when there is nothing to cycle to', () => {
  assert.equal(nextBadgeMode('since', 100, ''), 'since', 'only one reading exists');
  assert.equal(nextBadgeMode('activity', '', ''), 'activity', 'no reading exists at all');
});

test('workBadge with an explicit mode shows exactly that reading, never substitutes', () => {
  const now = 2_000_000;
  assert.equal(workBadge(now - 60, now - 3700, now, 'since'), '1m');
  assert.equal(workBadge(now - 60, now - 3700, now, 'activity'), '1h1m');
  // forcing a mode with no data for it must NOT fall back to the other one
  assert.equal(workBadge(now - 60, '', now, 'activity'), '');
  assert.equal(workBadge('', now - 3700, now, 'since'), '');
});

test('workBadgeTip in an explicit mode explains exactly that mechanism', () => {
  const now = 2_000_000;
  const sinceTip = workBadgeTip(now - 60, now - 3700, now, 'since');
  assert.ok(sinceTip.startsWith('In this state for 1m'), sinceTip);
  assert.ok(!/window_activity/.test(sinceTip), 'forced to since: must not mention the other mechanism');

  const activityTip = workBadgeTip(now - 60, now - 3700, now, 'activity');
  assert.ok(activityTip.startsWith('Pane silent for 1h1m'), activityTip);
  assert.ok(!/@wt_working/.test(activityTip), 'forced to activity: must not mention the other mechanism');
});

test('workBadgeTip mentions the click-to-cycle hint only when both readings exist', () => {
  const now = 2_000_000;
  assert.ok(/Click to switch/.test(workBadgeTip(now - 60, now - 3700, now)));
  assert.ok(!/Click to switch/.test(workBadgeTip(now - 60, '', now)), 'only one reading -> nothing to cycle to');
  assert.ok(!/Click to switch/.test(workBadgeTip('', '', now)), 'no reading -> nothing to cycle to');
});

// --- busy ---------------------------------------------------------------------
// The one distinction WorkAlerts asks about. Both greens are busy; nothing else is.
// Tested here rather than only through the flash rules because it is the predicate
// that keeps the flash and the dot telling the same story.

test('both greens are busy, and only they are', () => {
  assert.equal(isBusy('1'), true, 'a live turn is busy');
  assert.equal(isBusy('3'), true, 'so is a window parked on work it started');
  for (const v of ['0', '2', '', undefined, null, '4']) {
    assert.equal(isBusy(v), false, `${JSON.stringify(v)} is not busy`);
  }
});

test('the two busy states are still told apart everywhere it matters', () => {
  // The whole point of the fourth value: it must not collapse back into green.
  assert.notEqual(workClass('3'), workClass('1'));
  assert.notEqual(workLabel('3'), workLabel('1'));
  assert.ok(/background/i.test(workLabel('3')), 'the label says what it is waiting on');
  assert.ok(/input/i.test(workLabel('3')), 'and that you can still talk to it');
});

// --- the Exposé status filter -------------------------------------------------
// Same two invariants as the mapping above, for the same reason: the ids ride the
// user-writable @wt_state blob, and a filter that silently matched nothing would look
// exactly like an empty tmux server.

test('each filter admits exactly its own colour', () => {
  const cases = {
    working: '1',
    background: '3',
    attention: '2',
    idle: '0',
  };
  for (const [filter, pass] of Object.entries(cases)) {
    for (const v of ['1', '0', '2', '3', '']) {
      assert.equal(matchesStatus(v, filter), v === pass,
        `${filter} vs ${JSON.stringify(v)}`);
    }
  }
});

test('"Working" does not quietly include the background windows', () => {
  // They are both busy, but the filter answers "who is running a turn right now",
  // and the reason 'background' is its own button is that those are the windows you
  // can interrupt for free. Folding them in would delete the only useful answer.
  assert.equal(matchesStatus('3', 'working'), false);
  assert.equal(matchesStatus('1', 'background'), false);
});

test('"all" admits every value, including ones we never defined', () => {
  for (const v of ['1', '0', '2', '3', '', undefined, '4']) {
    assert.ok(matchesStatus(v, 'all'), `all should admit ${JSON.stringify(v)}`);
  }
});

test('a window that reports nothing is not idle — it only shows under "all"', () => {
  // "Not reporting" is the absence of a claim, not a claim of idleness: most windows
  // never install the hook, and folding them into Idle would bury the few that really
  // did say they had run out of work.
  assert.equal(matchesStatus('', 'idle'), false);
  assert.equal(matchesStatus('', 'all'), true);
});

test('an unknown filter degrades to showing everything, never to an empty grid', () => {
  for (const f of ['', undefined, null, 'green', 42]) {
    assert.equal(normalizeStatusFilter(f), 'all', `bad id ${JSON.stringify(f)}`);
    assert.ok(matchesStatus('1', f) && matchesStatus('', f));
  }
});

test('every filter has an id, a label and a hint, and "all" leads', () => {
  assert.equal(STATUS_FILTERS[0].id, 'all', 'the widest option is the first button');
  for (const f of STATUS_FILTERS) {
    assert.ok(f.id && f.label && f.hint, `incomplete filter ${JSON.stringify(f)}`);
    assert.equal(normalizeStatusFilter(f.id), f.id);
  }
});

// The preview tiles and Exposé paint their dots imperatively; they once toggled
// on/off/wait by hand and never set 'bg', so a background-work window showed the
// grey "not reporting" circle there while the recents tab showed the green ring.
test('paintWorkClass sets exactly the class workClass names, for every state', () => {
  const fakeEl = () => {
    const set = new Set(['stoplight']);
    return { set, classList: { toggle: (c, on) => (on ? set.add(c) : set.delete(c)) } };
  };
  const el = fakeEl();
  for (const v of ['1', '0', '2', '3', '', '1']) {
    paintWorkClass(el, v);
    const want = workClass(v);
    assert.deepEqual([...el.set].sort(), ['stoplight', ...(want ? [want] : [])].sort(), `value ${JSON.stringify(v)}`);
  }
  for (const v of ['0', '1', '2', '3']) assert.ok(WORK_CLASSES.includes(workClass(v)));
});
