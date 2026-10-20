// The SHAPE of the split view: which terminal regions sit side by side, which are
// stacked, and how much of its parent each one takes.
//
// Split views used to be one flat row — every region a column — so the arrangement was
// nothing more than the order of the regions. Splitting a view top/bottom as well as
// left/right makes it a tree: a split node lays its children out in a row ('row', a
// left|right split) or a column ('col', a top/bottom split), and a child is either a
// region (a leaf) or another split. Same model as tmux's own pane layouts.
//
// Pure: no DOM, no units — a leaf's `key` is whatever the caller uses to name a region
// (SplitManager uses the TerminalUnit itself in memory and its index in `units` on
// disk). Every operation returns a NEW tree and leaves its input alone, so a caller can
// compute "what would closing this do" without committing to it. See
// test/split-tree.test.mjs.
//
//   leaf  { key }
//   split { dir: 'row' | 'col', kids: [node, …≥2], sizes: [number, …] }
//
// `sizes` are flex-grow weights, one per kid. Only their RATIOS matter, which is what
// lets them survive a window resize.

export const ROW = 'row';   // children left → right (a left | right split)
export const COL = 'col';   // children top → bottom (a top / bottom split)

export function leaf(key) {
  return { key };
}

const isSplit = (n) => !!n && Array.isArray(n.kids);

// The keys of every region in reading order (depth-first, left→right / top→bottom).
// This is the order "next view" means.
export function leaves(node) {
  if (!node) return [];
  if (!isSplit(node)) return [node.key];
  return node.kids.flatMap(leaves);
}

// One flat row holding every key — the only layout there was before splits could be
// stacked, and so what a saved view with no shape reads back as.
export function rowOf(keys) {
  const list = [...keys];
  if (!list.length) return null;
  if (list.length === 1) return leaf(list[0]);
  return { dir: ROW, kids: list.map(leaf), sizes: list.map(() => 1) };
}

// Split the region `key` in two along `dir`, with `newKey` after it (right of it, or
// below it). The new region takes HALF of the space the old one had — splitting a view
// divides that view, it doesn't re-deal the whole screen. When the region already sits
// in a split running the same way it simply gains a sibling, so three side-by-side
// splits are one row of three rather than a row nested inside a row.
export function splitLeaf(node, key, newKey, dir = ROW) {
  if (!node) return leaf(newKey);
  if (!isSplit(node)) {
    if (node.key !== key) return node;
    return { dir, kids: [node, leaf(newKey)], sizes: [1, 1] };
  }
  const i = node.kids.findIndex((k) => !isSplit(k) && k.key === key);
  if (i >= 0) {
    const kids = [...node.kids];
    const sizes = [...node.sizes];
    if (node.dir === dir) {
      const half = sizes[i] / 2;
      kids.splice(i + 1, 0, leaf(newKey));
      sizes.splice(i, 1, half, half);
    } else {
      kids[i] = { dir, kids: [kids[i], leaf(newKey)], sizes: [1, 1] };
    }
    return { ...node, kids, sizes };
  }
  return { ...node, kids: node.kids.map((k) => splitLeaf(k, key, newKey, dir)) };
}

// Take the region `key` out. Its space goes to the neighbour that FOLLOWS it (or the
// one before, if it was last), so the view next to the closed one grows into the gap
// rather than every view shifting. A split left holding a single child dissolves into
// that child, and a child split running the same way as its new parent is merged into
// it, so the tree never accumulates nesting that draws nothing.
// Returns null when the last region is removed.
export function removeLeaf(node, key) {
  if (!node) return null;
  if (!isSplit(node)) return node.key === key ? null : node;
  const i = node.kids.findIndex((k) => !isSplit(k) && k.key === key);
  let kids;
  let sizes;
  if (i >= 0) {
    kids = node.kids.filter((_, j) => j !== i);
    sizes = node.sizes.filter((_, j) => j !== i);
    const heir = i < kids.length ? i : i - 1;
    sizes[heir] += node.sizes[i];
  } else {
    kids = node.kids.map((k) => removeLeaf(k, key));
    sizes = [...node.sizes];
  }
  return normalize({ ...node, kids, sizes });
}

// Put `newKey` where `oldKey` was — same slot, same size.
export function replaceKey(node, oldKey, newKey) {
  if (!node) return node;
  if (!isSplit(node)) return node.key === oldKey ? leaf(newKey) : node;
  return { ...node, kids: node.kids.map((k) => replaceKey(k, oldKey, newKey)) };
}

// Which region takes focus when `key` closes: the NEXT one in reading order, or the
// previous when it was the last — the same rule closing a recents tab follows. Null
// when nothing would be left.
export function focusAfterClose(node, key) {
  const order = leaves(node);
  const i = order.indexOf(key);
  if (i < 0 || order.length < 2) return null;
  return i + 1 < order.length ? order[i + 1] : order[i - 1];
}

// Drop empty children, dissolve single-child splits, and merge a child split that
// runs the same way as its parent (scaling its sizes into the parent's slot).
function normalize(node) {
  if (!isSplit(node)) return node;
  const kids = [];
  const sizes = [];
  node.kids.forEach((k, j) => {
    if (!k) return;
    const s = node.sizes[j] > 0 ? node.sizes[j] : 1;
    const n = normalize(k);
    if (isSplit(n) && n.dir === node.dir) {
      const total = n.sizes.reduce((a, b) => a + b, 0) || 1;
      n.kids.forEach((kk, jj) => { kids.push(kk); sizes.push((s * n.sizes[jj]) / total); });
    } else {
      kids.push(n);
      sizes.push(s);
    }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  return { dir: node.dir, kids, sizes };
}

// ---- saving --------------------------------------------------------------------

// The shape alone, with each leaf's key mapped through `indexOf` — what the shared
// blob stores. Sizes are left out on purpose: they are a property of the screen the
// split is drawn on and stay per-browser (see sizesOf).
export function toShape(node, indexOf) {
  if (!node) return null;
  if (!isSplit(node)) return indexOf(node.key);
  return { dir: node.dir, kids: node.kids.map((k) => toShape(k, indexOf)) };
}

// Read a stored shape back for `count` regions numbered 0..count-1. The blob is
// untrusted, so this is total: anything that is not a well-formed tree naming every
// region exactly once reads as one flat row — the layout every older saved view had.
export function fromShape(raw, count) {
  const fallback = rowOf([...Array(Math.max(0, count | 0)).keys()]);
  if (raw == null) return fallback;
  const seen = new Set();
  let ok = true;
  const walk = (r, depth) => {
    if (!ok || depth > 32) { ok = false; return null; }
    if (Number.isInteger(r)) {
      if (r < 0 || r >= count || seen.has(r)) { ok = false; return null; }
      seen.add(r);
      return leaf(r);
    }
    if (!r || typeof r !== 'object' || (r.dir !== ROW && r.dir !== COL)
        || !Array.isArray(r.kids) || !r.kids.length) {
      ok = false;
      return null;
    }
    const kids = r.kids.map((k) => walk(k, depth + 1));
    return { dir: r.dir, kids, sizes: kids.map(() => 1) };
  };
  const tree = walk(raw, 0);
  if (!ok || seen.size !== count) return fallback;
  return normalize(tree);
}

// A string that is equal for two trees exactly when they have the same shape over the
// same keys (mapped through `indexOf`). Saved sizes are only applied to the shape they
// were measured on.
export function shapeSignature(node, indexOf = (k) => k) {
  return JSON.stringify(toShape(node, indexOf));
}

// Every split's sizes, in depth-first order — the per-browser half of a saved view.
export function sizesOf(node) {
  if (!isSplit(node)) return [];
  return [[...node.sizes], ...node.kids.flatMap(sizesOf)];
}

// Re-apply sizesOf output to a tree of the same shape. A list that does not fit
// (wrong count, wrong lengths, junk numbers) leaves the tree's sizes as they were.
export function withSizes(node, list) {
  if (!Array.isArray(list)) return node;
  let i = 0;
  let ok = true;
  const walk = (n) => {
    if (!isSplit(n)) return n;
    const s = list[i++];
    if (!Array.isArray(s) || s.length !== n.kids.length
        || !s.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) ok = false;
    return { ...n, sizes: ok ? [...s] : n.sizes, kids: n.kids.map(walk) };
  };
  const out = walk(node);
  return ok && i === list.length ? out : node;
}

// Replace the sizes of the split at `path` (kid indices from the root) — the divider
// drag measures in pixels and hands the result over here when it lets go. Sizes that
// do not fit that split leave the tree as it was.
export function setSizesAt(node, path, sizes) {
  if (!isSplit(node)) return node;
  if (!path.length) {
    if (!Array.isArray(sizes) || sizes.length !== node.kids.length
        || !sizes.every((x) => Number.isFinite(x) && x > 0)) return node;
    return { ...node, sizes: [...sizes] };
  }
  const [head, ...rest] = path;
  return { ...node, kids: node.kids.map((k, j) => (j === head ? setSizesAt(k, rest, sizes) : k)) };
}

// Exchange two regions' places — the views move, the slots (and their sizes) stay.
export function swapKeys(node, a, b) {
  if (!node || a === b) return node;
  if (!isSplit(node)) {
    if (node.key === a) return leaf(b);
    if (node.key === b) return leaf(a);
    return node;
  }
  return { ...node, kids: node.kids.map((k) => swapKeys(k, a, b)) };
}

// The region next to `from` in direction `dir` ('left' | 'right' | 'up' | 'down'), by
// what is on screen: `rects` maps each key to its box ({left, top, right, bottom}). A
// candidate must lie wholly on that side and overlap `from` across the other axis; the
// nearest wins, and among equally near ones the one sharing the most edge. Null when
// `from` is already against that edge of the split. Geometry rather than tree walking
// because "the one to my left" is a question about what you see — in a stacked split
// the tree neighbour and the screen neighbour are often different regions.
export function neighborToward(rects, from, dir) {
  const r = rects.get(from);
  if (!r) return null;
  const SLOP = 3;   // a divider's width, plus rounding
  let best = null;
  for (const [key, c] of rects) {
    if (key === from) continue;
    let gap;
    let overlap;
    if (dir === 'left' || dir === 'right') {
      gap = dir === 'left' ? r.left - c.right : c.left - r.right;
      overlap = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top);
    } else if (dir === 'up' || dir === 'down') {
      gap = dir === 'up' ? r.top - c.bottom : c.top - r.bottom;
      overlap = Math.min(r.right, c.right) - Math.max(r.left, c.left);
    } else {
      return null;
    }
    if (gap < -SLOP || overlap <= 0) continue;
    if (!best || gap < best.gap - SLOP || (Math.abs(gap - best.gap) <= SLOP && overlap > best.overlap)) {
      best = { key, gap, overlap };
    }
  }
  return best ? best.key : null;
}

// The same tree with every leaf key passed through `fn` — saved shapes name regions by
// index, the live tree by the region itself.
export function mapKeys(node, fn) {
  if (!node) return node;
  if (!isSplit(node)) return leaf(fn(node.key));
  return { ...node, kids: node.kids.map((k) => mapKeys(k, fn)) };
}
