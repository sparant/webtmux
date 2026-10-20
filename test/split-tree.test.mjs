// Unit tests for split-tree.js — the shape of the split view (which regions sit side
// by side, which are stacked, and how big each is). Run with:
//
//     node --test test/
//
// The rules pinned here are the ones a user sees: splitting a view halves THAT view,
// closing one hands its space to the view next to it and focuses the next view, and a
// saved shape that is missing or malformed reads back as the old flat row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROW, COL, leaf, leaves, rowOf, splitLeaf, removeLeaf, replaceKey, focusAfterClose,
  toShape, fromShape, shapeSignature, sizesOf, withSizes, setSizesAt, swapKeys, neighborToward, mapKeys,
} from '../resources/js/split-tree.js';

const id = (k) => k;

test('splitting a lone view makes a two-way split in the asked direction', () => {
  assert.deepEqual(splitLeaf(leaf('a'), 'a', 'b', COL),
    { dir: COL, kids: [leaf('a'), leaf('b')], sizes: [1, 1] });
});

test('splitting along the parent\'s own direction adds a sibling and halves only that view', () => {
  const t = splitLeaf(rowOf(['a', 'b']), 'a', 'c', ROW);
  assert.deepEqual(leaves(t), ['a', 'c', 'b'], 'the new view lands right after the split one');
  assert.deepEqual(t.sizes, [0.5, 0.5, 1], 'b keeps its half of the screen');
});

test('splitting across the parent\'s direction nests a split in that view\'s slot', () => {
  const t = splitLeaf(rowOf(['a', 'b']), 'b', 'c', COL);
  assert.equal(t.dir, ROW);
  assert.deepEqual(t.kids[1], { dir: COL, kids: [leaf('b'), leaf('c')], sizes: [1, 1] });
  assert.deepEqual(leaves(t), ['a', 'b', 'c']);
});

test('closing a view gives its space to the next view, or the previous when it was last', () => {
  const t = { dir: ROW, kids: [leaf('a'), leaf('b'), leaf('c')], sizes: [1, 2, 3] };
  assert.deepEqual(removeLeaf(t, 'b').sizes, [1, 5]);
  assert.deepEqual(removeLeaf(t, 'c').sizes, [1, 5]);
});

test('closing one half of a nested split dissolves it back into its parent', () => {
  const t = splitLeaf(rowOf(['a', 'b']), 'b', 'c', COL);
  const after = removeLeaf(t, 'c');
  assert.deepEqual(after, { dir: ROW, kids: [leaf('a'), leaf('b')], sizes: [1, 1] });
});

test('a dissolved split running the same way as its new parent is merged into it', () => {
  // row[ a, col[ b, row[c, d] ] ] — closing b leaves row[c, d] inside a row.
  let t = rowOf(['a', 'b']);
  t = splitLeaf(t, 'b', 'c', COL);
  t = splitLeaf(t, 'c', 'd', ROW);
  const after = removeLeaf(t, 'b');
  assert.equal(after.dir, ROW);
  assert.deepEqual(leaves(after), ['a', 'c', 'd']);
  assert.equal(after.kids.length, 3, 'one row of three, not a row inside a row');
  assert.ok(Math.abs(after.sizes[1] + after.sizes[2] - 1) < 1e-9, 'c and d share the slot b+c had');
});

test('closing the last view leaves nothing', () => {
  assert.equal(removeLeaf(leaf('a'), 'a'), null);
});

test('focus after closing goes to the next view, else the previous', () => {
  const t = splitLeaf(rowOf(['a', 'b']), 'a', 'c', COL);   // reading order a c b
  assert.equal(focusAfterClose(t, 'a'), 'c');
  assert.equal(focusAfterClose(t, 'b'), 'c');
  assert.equal(focusAfterClose(leaf('a'), 'a'), null);
});

test('replaceKey puts a region in another\'s slot, same size', () => {
  const t = { dir: ROW, kids: [leaf('a'), leaf('b')], sizes: [3, 1] };
  assert.deepEqual(replaceKey(removeLeaf({ dir: ROW, kids: [leaf('a'), leaf('b'), leaf('p')], sizes: [3, 1, 1] }, 'p'), 'b', 'p'),
    { dir: ROW, kids: [leaf('a'), leaf('p')], sizes: [3, 2] });
  assert.deepEqual(replaceKey(t, 'a', 'z').kids[0], leaf('z'));
});

test('a shape round-trips through the blob by region index', () => {
  const t = splitLeaf(rowOf([0, 1]), 1, 2, COL);
  const shape = toShape(t, id);
  assert.deepEqual(shape, { dir: ROW, kids: [0, { dir: COL, kids: [1, 2] }] });
  assert.deepEqual(leaves(fromShape(JSON.parse(JSON.stringify(shape)), 3)), [0, 1, 2]);
});

test('no saved shape, or a malformed one, reads as one flat row of every region', () => {
  const row3 = rowOf([0, 1, 2]);
  assert.deepEqual(fromShape(undefined, 3), row3);
  assert.deepEqual(fromShape({ dir: 'diagonal', kids: [0, 1, 2] }, 3), row3);
  assert.deepEqual(fromShape({ dir: ROW, kids: [0, 0, 2] }, 3), row3, 'a region named twice');
  assert.deepEqual(fromShape({ dir: ROW, kids: [0, 1] }, 3), row3, 'a region missing');
  assert.deepEqual(fromShape({ dir: ROW, kids: [0, 1, 7] }, 3), row3, 'an index out of range');
  assert.deepEqual(fromShape(0, 1), leaf(0));
  assert.equal(fromShape(null, 0), null);
});

test('sizes are re-applied only to the shape they were measured on', () => {
  const t = splitLeaf(rowOf([0, 1]), 1, 2, COL);
  const sized = setSizesAt(setSizesAt(t, [], [2, 1]), [1], [1, 3]);
  const saved = sizesOf(sized);
  assert.deepEqual(saved, [[2, 1], [1, 3]]);
  assert.deepEqual(sizesOf(withSizes(t, saved)), saved);
  assert.deepEqual(sizesOf(withSizes(rowOf([0, 1, 2]), saved)), [[1, 1, 1]], 'wrong shape: unchanged');
  assert.deepEqual(sizesOf(withSizes(t, [[2, 'x'], [1, 3]])), [[1, 1], [1, 1]], 'junk: unchanged');
  assert.notEqual(shapeSignature(t), shapeSignature(rowOf([0, 1, 2])));
});

test('swapping two views exchanges their places and keeps the slot sizes', () => {
  const t = { dir: ROW, kids: [leaf('a'), { dir: COL, kids: [leaf('b'), leaf('c')], sizes: [1, 2] }], sizes: [3, 1] };
  const s = swapKeys(t, 'a', 'c');
  assert.deepEqual(leaves(s), ['c', 'b', 'a']);
  assert.deepEqual(sizesOf(s), sizesOf(t));
});

test('the neighbour in a direction is the one you see there', () => {
  // a | b over c   (a is full height on the left; b top-right, c bottom-right)
  const rects = new Map([
    ['a', { left: 0, top: 0, right: 100, bottom: 200 }],
    ['b', { left: 104, top: 0, right: 200, bottom: 98 }],
    ['c', { left: 104, top: 102, right: 200, bottom: 200 }],
  ]);
  assert.equal(neighborToward(rects, 'b', 'down'), 'c');
  assert.equal(neighborToward(rects, 'c', 'up'), 'b');
  assert.equal(neighborToward(rects, 'c', 'left'), 'a');
  assert.equal(neighborToward(rects, 'b', 'left'), 'a');
  assert.equal(neighborToward(rects, 'a', 'right') !== null, true, 'a has something to its right');
  assert.equal(neighborToward(rects, 'a', 'left'), null, 'against the edge');
  assert.equal(neighborToward(rects, 'a', 'up'), null);
});

test('mapKeys renames every leaf', () => {
  assert.deepEqual(leaves(mapKeys(rowOf([0, 1]), (i) => `r${i}`)), ['r0', 'r1']);
});
