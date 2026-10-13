// Unit tests for the help overlay's callout placement. Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeCallouts, overlaps, facing, nearestSection, rect, union, EDGE } from '../resources/js/help-layout.js';

const VIEW = { width: 1200, height: 800 };
const size = { width: 220, height: 70 };

test('a toolbar target gets its callout below it', () => {
  const t = rect(300, 4, 400, 30);
  assert.equal(facing(t, VIEW), 'below');
  const { box, arrow } = placeCallouts([{ id: 'a', target: t, size }], [t], VIEW).get('a');
  assert.ok(box.top >= t.bottom);
  assert.ok(arrow.to.y <= t.bottom + 0.01 && arrow.from.y >= box.top - 0.01);
});

test('a right-hand panel gets its callout to the left', () => {
  const t = rect(870, 44, 330, 756);
  assert.equal(facing(t, VIEW), 'left');
  const { box } = placeCallouts([{ id: 'a', target: t, size }], [t], VIEW).get('a');
  assert.ok(box.right <= t.left);
});

test('callouts never overlap each other, any target, or the screen edge', () => {
  const targets = [rect(10, 4, 30, 30), rect(50, 4, 30, 30), rect(90, 4, 30, 30), rect(130, 4, 30, 30), rect(870, 44, 330, 756)];
  const items = targets.map((t, i) => ({ id: String(i), target: t, size }));
  const out = [...placeCallouts(items, targets, VIEW).values()].map((p) => p.box);
  for (const [i, a] of out.entries()) {
    assert.ok(a.left >= EDGE && a.right <= VIEW.width - EDGE && a.top >= EDGE && a.bottom <= VIEW.height - EDGE);
    for (const t of targets) assert.ok(!overlaps(a, t), `box ${i} covers a target`);
    for (const b of out.slice(i + 1)) assert.ok(!overlaps(a, b), `box ${i} overlaps another`);
  }
});

test('an inside callout sits within its (huge) target and has no arrow', () => {
  const t = rect(0, 44, 800, 756);
  const p = placeCallouts([{ id: 'term', target: t, size, inside: true }], [], VIEW).get('term');
  assert.equal(p.arrow, null);
  assert.ok(p.box.left >= t.left && p.box.right <= t.right && p.box.top >= t.top);
});

test('a fixed callout keeps its spot and later ones avoid it', () => {
  const at = rect(500, 400, 300, 100);
  const t = rect(550, 300, 200, 40);
  const m = placeCallouts([{ id: 'intro', at, size }, { id: 'b', target: t, size }], [t], VIEW);
  assert.deepEqual(m.get('intro').box, at);
  assert.ok(!overlaps(m.get('b').box, at));
});

test('nearestSection picks the closest within reach, smaller on ties', () => {
  const big = { id: 'big', rect: rect(0, 0, 1000, 40) };
  const small = { id: 'small', rect: rect(100, 0, 100, 40) };
  assert.equal(nearestSection([big, small], { x: 150, y: 20 }).id, 'small');
  assert.equal(nearestSection([big, small], { x: 150, y: 90 }).id, 'small');
  assert.equal(nearestSection([big, small], { x: 150, y: 300 }), null);
  assert.equal(nearestSection([big], null), null);
});

test('union spans its rects and ignores nulls', () => {
  assert.deepEqual(union([rect(0, 0, 10, 10), null, rect(20, 5, 10, 10)]), { left: 0, top: 0, right: 30, bottom: 15 });
  assert.equal(union([null]), null);
});
