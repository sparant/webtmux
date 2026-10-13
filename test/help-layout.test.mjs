// Unit tests for the help overlay's callout placement. Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeCallouts, placeBestOrder, legendGrid, segmentsCross, segmentHitsRect, overlaps, facing, nearestSection, rect, union, EDGE } from '../resources/js/help-layout.js';

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

// A dense row of small targets (the toolbar's buttons), notes hanging below: no
// two arrows may cross, and no arrow may run under another note.
function assertReadable(out, n) {
  const ps = [...out.values()];
  for (const [i, a] of ps.entries()) {
    assert.ok(a.clean, `note ${i} had no clean spot`);
    assert.ok(a.arrow || a.badge, `note ${i} is tied to nothing`);
    for (const [j, b] of ps.entries()) {
      if (i === j) continue;
      if (j > i && a.arrow && b.arrow) assert.ok(!segmentsCross(a.arrow.from, a.arrow.to, b.arrow.from, b.arrow.to), `arrows ${i} and ${j} cross`);
      if (a.arrow) assert.ok(!segmentHitsRect(a.arrow.from, a.arrow.to, b.box, 1), `arrow ${i} runs under note ${j}`);
    }
  }
  assert.equal(ps.length, n);
}

test('a dense toolbar row: arrows never cross or run under notes', () => {
  const targets = Array.from({ length: 8 }, (_, i) => rect(600 + i * 40, 6, 32, 32));
  const items = targets.map((t, i) => ({ id: `t${i}`, target: t, size: { width: 210, height: 80 } }));
  assertReadable(placeBestOrder(items, items.map((i) => i.id), 'below', targets, VIEW), 8);
});

test('the same row above a docked right-hand panel still reads cleanly', () => {
  const panel = rect(870, 44, 330, 756);
  const targets = Array.from({ length: 6 }, (_, i) => rect(900 + i * 45, 6, 36, 32));
  const items = targets.map((t, i) => ({ id: `t${i}`, target: t, size: { width: 210, height: 80 } }));
  assertReadable(placeBestOrder(items, items.map((i) => i.id), 'below', [...targets, panel], VIEW), 6);
});

test('rows beside a panel (a window list) get notes in the same order', () => {
  const panel = rect(870, 44, 330, 756);
  const rows = Array.from({ length: 9 }, (_, i) => rect(880, 80 + i * 36, 300, 30));
  const items = rows.map((t, i) => ({ id: `r${i}`, target: t, size: { width: 210, height: 60 } }));
  const out = placeBestOrder(items, items.map((i) => i.id), 'left', [panel, ...rows], VIEW);
  assertReadable(out, 9);
});

test('segment helpers', () => {
  const p = (x, y) => ({ x, y });
  assert.ok(segmentsCross(p(0, 0), p(10, 10), p(0, 10), p(10, 0)));
  assert.ok(!segmentsCross(p(0, 0), p(10, 0), p(0, 5), p(10, 5)));
  assert.ok(!segmentsCross(p(0, 0), p(10, 10), p(10, 10), p(20, 0)));   // shared end
  assert.ok(segmentHitsRect(p(-5, 5), p(15, 5), rect(0, 0, 10, 10)));
  assert.ok(!segmentHitsRect(p(-5, -5), p(15, -5), rect(0, 0, 10, 10)));
});

test('badges stay rare: a modest row gets arrows for every note', () => {
  const targets = Array.from({ length: 5 }, (_, i) => rect(500 + i * 40, 6, 32, 32));
  const items = targets.map((t, i) => ({ id: `t${i}`, target: t, size: { width: 210, height: 80 } }));
  const out = placeBestOrder(items, items.map((i) => i.id), 'below', targets, VIEW);
  assert.equal([...out.values()].filter((p) => p.badge).length, 0);
});

test('a group that cannot all have arrows becomes a numbered legend, all of it', () => {
  const targets = Array.from({ length: 8 }, (_, i) => rect(600 + i * 40, 6, 32, 32));
  const items = targets.map((t, i) => ({ id: `t${i}`, target: t, size: { width: 210, height: 80 } }));
  const out = placeBestOrder(items, items.map((i) => i.id), 'below', targets, VIEW);
  const ps = [...out.values()];
  assert.ok(ps.every((p) => p.badge && !p.arrow) || ps.every((p) => p.arrow && !p.badge));
  if (ps[0].badge) assert.deepEqual([...out.numbers.values()], [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const [i, a] of ps.entries()) for (const b of ps.slice(i + 1)) assert.ok(!overlaps(a.box, b.box));
});

test('a legend grid reads in number order and covers no control', () => {
  const targets = Array.from({ length: 8 }, (_, i) => rect(600 + i * 40, 6, 32, 32));
  const seq = targets.map((t, i) => ({ id: `t${i}`, target: t, size: { width: 210, height: 80 } }));
  const g = legendGrid(seq, 'below', targets, VIEW);
  assert.ok(g);
  for (let i = 1; i < g.length; i++) {
    const a = g[i - 1], b = g[i];
    assert.ok(b.top > a.top || (b.top === a.top && b.left > a.left), `note ${i + 1} reads before ${i}`);
  }
  for (const b of g) for (const t of targets) assert.ok(!overlaps(b, t));
  const panel = rect(870, 44, 330, 756);
  const rows = Array.from({ length: 13 }, (_, i) => rect(880, 60 + i * 50, 300, 40));
  const col = legendGrid(rows.map((t, i) => ({ id: `r${i}`, target: t, size: { width: 210, height: 90 } })), 'left', [panel], VIEW);
  assert.ok(col && col.every((b) => b.right <= panel.left));
});
