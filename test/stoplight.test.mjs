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
  workClass, workLabel, workTip, WORK_LEGEND,
  STATUS_FILTERS, normalizeStatusFilter, matchesStatus,
} from '../resources/js/stoplight.js';

test('the three reported states each get their own fill', () => {
  assert.equal(workClass('1'), 'on');
  assert.equal(workClass('0'), 'off');
  assert.equal(workClass('2'), 'wait');
});

test('anything else is the unfilled dot, not a stuck colour', () => {
  // '' is @wt_working unset; undefined is a window missing from the map entirely;
  // '3'/'yes' stand in for a client that sets something we never defined.
  for (const v of ['', undefined, null, '3', 'yes', 1]) {
    assert.equal(workClass(v), '', `expected no class for ${JSON.stringify(v)}`);
    assert.equal(workLabel(v), 'Not reporting a status');
  }
});

test('every state hovers with the full colour key, not just its own line', () => {
  for (const v of ['1', '0', '2', '']) {
    const tip = workTip(v);
    assert.ok(tip.startsWith(workLabel(v)), 'the tip leads with where THIS window is');
    assert.ok(tip.includes(WORK_LEGEND), 'and then explains all four fills');
  }
});

test('the key names every colour it can paint', () => {
  for (const colour of ['Green', 'Amber', 'Red', 'Unfilled']) {
    assert.ok(WORK_LEGEND.includes(colour), `legend is missing ${colour}`);
  }
});

// --- the Exposé status filter -------------------------------------------------
// Same two invariants as the mapping above, for the same reason: the ids ride the
// user-writable @wt_state blob, and a filter that silently matched nothing would look
// exactly like an empty tmux server.

test('each filter admits exactly its own colour', () => {
  const cases = {
    working: '1',
    attention: '2',
    idle: '0',
  };
  for (const [filter, pass] of Object.entries(cases)) {
    for (const v of ['1', '0', '2', '']) {
      assert.equal(matchesStatus(v, filter), v === pass,
        `${filter} vs ${JSON.stringify(v)}`);
    }
  }
});

test('"all" admits every value, including ones we never defined', () => {
  for (const v of ['1', '0', '2', '', undefined, '3']) {
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
