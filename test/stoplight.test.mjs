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
import { workClass, workLabel, workTip, WORK_LEGEND } from '../resources/js/stoplight.js';

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
