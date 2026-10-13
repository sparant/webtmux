// Where the help overlay's callouts go — pure geometry, no DOM.
//
// Every callout is a box of text with an arrow to the UI element it explains. The
// boxes must not cover what they point at (or anything else the overlay is
// pointing at), must not cover each other, and must stay on screen. The dimmed
// terminal area is where the room is, so a callout prefers the side of its target
// that faces into the page: below the toolbar, left of the right-hand panels,
// above a bottom-docked preview bar.
//
// placeCallouts walks the items in order (most important first) and gives each
// one the nearest candidate position that collides with nothing placed so far.
// Rects are {left, top, right, bottom} in viewport pixels throughout.
//
// Tested under node — see test/help-layout.test.mjs.

export const EDGE = 8;       // kept clear of the viewport edge
export const PAD = 6;        // kept clear between a callout and anything else

export const rect = (left, top, width, height) =>
  ({ left, top, right: left + width, bottom: top + height });

export function overlaps(a, b, pad = 0) {
  return a.left < b.right + pad && b.left < a.right + pad
    && a.top < b.bottom + pad && b.top < a.bottom + pad;
}

export function union(rects) {
  const rs = rects.filter(Boolean);
  if (!rs.length) return null;
  return {
    left: Math.min(...rs.map((r) => r.left)),
    top: Math.min(...rs.map((r) => r.top)),
    right: Math.max(...rs.map((r) => r.right)),
    bottom: Math.max(...rs.map((r) => r.bottom)),
  };
}

// Which side of the page a target sits on decides which way its callout faces.
export function facing(target, viewport) {
  const cx = (target.left + target.right) / 2;
  const cy = (target.top + target.bottom) / 2;
  const dx = cx / viewport.width - 0.5;     // -0.5 … 0.5
  const dy = cy / viewport.height - 0.5;
  // Wide-and-short things (the toolbar strip) face up/down even when off-centre.
  const w = target.right - target.left;
  const h = target.bottom - target.top;
  if (w > h * 2.5 || Math.abs(dy) >= Math.abs(dx)) return dy <= 0 ? 'below' : 'above';
  return dx >= 0 ? 'left' : 'right';
}

// Distances out from the target, and slides along its side, tried nearest first.
// Fine-grained on purpose: a coarse grid misses the one gap that fits between two
// notes and falls back to overlapping. ~1600 candidates a note is still cheap.
const GAPS = [22, 40, 62, 88, 118, 152, 190, 235, 290, 360, 440, 530];
const SHIFTS = [0];
for (let s = 30; s <= 600; s += 30) SHIFTS.push(s, -s);
const SIDES_AFTER = {
  below: ['right', 'left', 'above'], above: ['right', 'left', 'below'],
  left: ['below', 'above', 'right'], right: ['below', 'above', 'left'],
};

// Candidate boxes for one target, in preference order.
function* candidates(target, size, first) {
  const cx = (target.left + target.right) / 2;
  const cy = (target.top + target.bottom) / 2;
  const sides = [first, ...SIDES_AFTER[first]];
  for (const [si, side] of sides.entries()) {
    for (const gap of GAPS) {
      for (const shift of SHIFTS) {
        let left, top;
        if (side === 'below' || side === 'above') {
          left = cx - size.width / 2 + shift;
          top = side === 'below' ? target.bottom + gap : target.top - gap - size.height;
        } else {
          top = cy - size.height / 2 + shift;
          left = side === 'right' ? target.right + gap : target.left - gap - size.width;
        }
        yield { box: rect(left, top, size.width, size.height), cost: si * 1000 + gap + Math.abs(shift) * 0.6 };
      }
    }
  }
}

// Candidates for a callout that lives INSIDE its target (the terminal: too big to
// point at from outside, so its note sits in it) — every spot in the target that
// fits, nearest its centre first. Kept inside when the target is big enough to
// hold it; a note that wanders into the next region reads as that region's.
function* insideCandidates(target, size) {
  const cx = (target.left + target.right) / 2;
  const cy = (target.top + target.bottom) / 2;
  const fits = target.right - target.left >= size.width && target.bottom - target.top >= size.height;
  const spots = [];
  const hw = (target.right - target.left) / 2, hh = (target.bottom - target.top) / 2;
  for (let dy = -hh; dy <= hh; dy += 30) {
    for (let dx = -hw; dx <= hw; dx += 40) {
      const box = rect(cx - size.width / 2 + dx, cy - size.height / 2 + dy, size.width, size.height);
      if (fits && (box.left < target.left || box.right > target.right || box.top < target.top || box.bottom > target.bottom)) continue;
      spots.push({ box, cost: Math.abs(dx) + Math.abs(dy) * 1.2 });
    }
  }
  spots.sort((a, b) => a.cost - b.cost);
  yield* spots;
}

// Every spot on screen, nearest the target's centre first.
function* nearestFirst(area, target, size) {
  const cx = (target.left + target.right) / 2, cy = (target.top + target.bottom) / 2;
  const spots = [];
  for (let top = area.top + EDGE; top + size.height <= area.bottom - EDGE; top += 30) {
    for (let left = area.left + EDGE; left + size.width <= area.right - EDGE; left += 40) {
      spots.push({ box: rect(left, top, size.width, size.height),
        cost: 5000 + Math.hypot(left + size.width / 2 - cx, top + size.height / 2 - cy) });
    }
  }
  spots.sort((a, b) => a.cost - b.cost);
  yield* spots;
}

function onScreen(box, viewport) {
  return box.left >= EDGE && box.top >= EDGE
    && box.right <= viewport.width - EDGE && box.bottom <= viewport.height - EDGE;
}

function clampToScreen(box, viewport) {
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  const left = Math.max(EDGE, Math.min(box.left, viewport.width - EDGE - w));
  const top = Math.max(EDGE, Math.min(box.top, viewport.height - EDGE - h));
  return rect(left, top, w, h);
}

function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

// The two ends of the arrow: from the callout's edge to the target's edge, along
// the line between their nearest points.
export function arrowFor(box, target) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const bc = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  const to = { x: clamp(bc.x, target.left, target.right), y: clamp(bc.y, target.top, target.bottom) };
  const from = { x: clamp(to.x, box.left, box.right), y: clamp(to.y, box.top, box.bottom) };
  return { from, to };
}

// ---- arrows as obstacles ------------------------------------------------------
// A layout whose notes never overlap can still be unreadable: two arrows that cross,
// or an arrow that runs under a note on its way, make you trace lines to find out
// which note is which. So arrows are part of the placement, not drawn after it.

function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }

// Do segments p1-p2 and q1-q2 cross? Sharing an end point (two arrows into the same
// target) is not a crossing.
export function segmentsCross(p1, p2, q1, q2) {
  const near = (a, b) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
  if (near(p1, q1) || near(p1, q2) || near(p2, q1) || near(p2, q2)) return false;
  const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// Does segment p1-p2 pass through rect r (shrunk by `inset`, so an arrow that only
// grazes an edge — or ends on it — does not count)?
export function segmentHitsRect(p1, p2, r, inset = 0) {
  const R = { left: r.left + inset, top: r.top + inset, right: r.right - inset, bottom: r.bottom - inset };
  if (R.left >= R.right || R.top >= R.bottom) return false;
  const inside = (p) => p.x > R.left && p.x < R.right && p.y > R.top && p.y < R.bottom;
  if (inside(p1) || inside(p2)) return true;
  const c = [{ x: R.left, y: R.top }, { x: R.right, y: R.top }, { x: R.right, y: R.bottom }, { x: R.left, y: R.bottom }];
  for (let i = 0; i < 4; i++) if (segmentsCross(p1, p2, c[i], c[(i + 1) % 4])) return true;
  return false;
}

const segLen = (a) => Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y);

// How bad a candidate's arrow is, or Infinity when it is not allowed at all:
//   • crossing an arrow already drawn, or running through a note already placed
//     (or a placed arrow running through this note) — never;
//   • running across other highlighted UI on its way — allowed but costly, since
//     sometimes it is the only way out (a toolbar button above a docked panel);
//   • length — a short arrow is easier to follow, so it costs a little too.
function arrowCost(box, arrow, ownBox, arrows, taken, blockers, own, side) {
  for (const a of arrows) {
    if (segmentsCross(arrow.from, arrow.to, a.from, a.to)) return Infinity;
    if (segmentHitsRect(a.from, a.to, box, 1)) return Infinity;
  }
  for (const t of taken) if (t !== ownBox && segmentHitsRect(arrow.from, arrow.to, t, 1)) return Infinity;
  let cost = segLen(arrow) * 0.15;
  // …and slant: an arrow that leaves its target squarely (straight down from the
  // toolbar, straight out from a panel) reads as belonging to it; a shallow one
  // skimming along a row of buttons reads as belonging to any of them.
  const run = side === 'left' || side === 'right'
    ? Math.abs(arrow.to.y - arrow.from.y) : Math.abs(arrow.to.x - arrow.from.x);
  cost += run * 0.3;
  for (const o of blockers) if (o !== own && segmentHitsRect(arrow.from, arrow.to, o, 4)) cost += 350;
  return cost;
}

// The approach to a target that is still waiting for its note: a strip running
// out from it on the side its note will hang. A note parked there, or an arrow run
// through it, walls that target in — its arrow would have to cross something to
// get out. Under a dense row (the toolbar's buttons) that is exactly how the first
// notes placed used to strand the rest.
const CORRIDOR = 64;
function corridor(t, side) {
  if (side === 'below') return { left: t.left, right: t.right, top: t.bottom, bottom: t.bottom + CORRIDOR };
  if (side === 'above') return { left: t.left, right: t.right, top: t.top - CORRIDOR, bottom: t.top };
  if (side === 'left') return { left: t.left - CORRIDOR, right: t.left, top: t.top, bottom: t.bottom };
  return { left: t.right, right: t.right + CORRIDOR, top: t.top, bottom: t.bottom };
}
const CORRIDOR_COST = 320;

// items: [{ id, target: rect|null, size: {width, height}, inside?: bool,
//           side?: 'below'|'above'|'left'|'right', at?: rect (fixed position) }]
// obstacles: rects no callout may cover (every highlighted target).
// Returns Map id -> { box, clean, arrow|null, badge? }; badge means the note is
// paired with its target by a number instead of an arrow. clean is false when nothing free
// was found and the box overlaps something (the caller can shrink it and retry).
export function placeCallouts(items, obstacles, viewport) {
  const placed = new Map();
  const taken = [];               // boxes already given out
  const arrows = [];              // arrows already drawn
  let total = 0;                  // summed score: lets a caller compare two orders
  const sideOf = (it) => it.side || facing(it.target, viewport);
  for (const [idx, it] of items.entries()) {
    // Approaches of the pointed-at items still to come.
    const ahead = items.slice(idx + 1).filter((o) => !o.at && !o.inside && o.target)
      .map((o) => corridor(o.target, sideOf(o)));
    if (it.at) {
      placed.set(it.id, { box: it.at, clean: true, arrow: null, badge: !!it.badge });
      taken.push(it.at);
      continue;
    }
    const own = it.target;
    // it.badge: paired with its target by number, no arrow (see placeBestOrder).
    const pointed = !it.inside && own && !it.badge;
    const blockers = obstacles.filter((o) => !(it.inside && o === own));
    // The obstacle that IS this item's target (padded by the caller), so its own
    // arrow is not charged for arriving at it.
    const ownObst = pointed ? obstacles.find((o) => o.left <= own.left && o.right >= own.right && o.top <= own.top && o.bottom >= own.bottom) : null;
    // An inside note that finds its target full may sit anywhere free on screen,
    // nearest the target first, before settling for an overlap.
    const anywhere = rect(0, 0, viewport.width, viewport.height);
    const all = [...(it.inside
      ? (function* () { yield* insideCandidates(own, it.size); yield* nearestFirst(anywhere, own, it.size); })()
      : candidates(own, it.size, it.side || facing(own, viewport)))];
    if (!it.inside) all.sort((x, y) => x.cost - y.cost);
    let best = null;
    let fallback = null;
    for (const c of all) {
      // Sorted by base cost, so once that alone is worse than the best found,
      // nothing later can win.
      if (best && c.cost >= best.score) break;
      if (!onScreen(c.box, viewport)) continue;
      if (!it.inside && overlaps(c.box, own, PAD)) continue;
      const hitsBox = taken.some((t) => overlaps(c.box, t, PAD));
      const hitsObst = blockers.some((o) => overlaps(c.box, o, PAD - 2));
      if (!hitsBox && !hitsObst) {
        let score = c.cost + ahead.reduce((n, k) => n + (overlaps(c.box, k) ? CORRIDOR_COST : 0), 0);
        let arrow = null;
        if (pointed) {
          arrow = arrowFor(c.box, own);
          const ac = arrowCost(c.box, arrow, null, arrows, taken, blockers, ownObst, sideOf(it));
          if (ac === Infinity) continue;
          score += ac + ahead.reduce((n, k) => n + (segmentHitsRect(arrow.from, arrow.to, k, 0) ? CORRIDOR_COST : 0), 0);
        } else if (arrows.some((a) => segmentHitsRect(a.from, a.to, c.box, 1))) {
          continue;                  // a note may not sit on someone else's arrow
        }
        if (!best || score < best.score) best = { box: c.box, score, arrow };
        if (it.inside) break;        // inside candidates come nearest-first already
        continue;
      }
      // Remember the least-bad spot in case nothing is clean (a tiny window).
      const bad = taken.reduce((s, t) => s + overlapArea(c.box, t) * 3, 0)
        + blockers.reduce((s, o) => s + overlapArea(c.box, o), 0) + c.cost;
      if (!fallback || bad < fallback.bad) fallback = { box: c.box, bad };
    }
    // No spot whose arrow can get through cleanly: rather than draw a crossing,
    // put the note anywhere free (off every arrow) and pair it with its target by
    // a numbered badge instead. Only a crowded group (a dense row of buttons)
    // ever gets here, and only for its last few notes.
    if (!best && pointed) {
      const free = [...nearestFirst(anywhere, own, it.size)].find((c) => !overlaps(c.box, own, PAD)
        && !taken.some((t) => overlaps(c.box, t, PAD))
        && !blockers.some((o) => overlaps(c.box, o, PAD - 2))
        && !arrows.some((a) => segmentHitsRect(a.from, a.to, c.box, 1)));
      if (free) {
        taken.push(free.box);
        total += free.cost + 400;
        placed.set(it.id, { box: free.box, clean: true, arrow: null, badge: true });
        continue;
      }
    }
    if (it.badge) {
      const box = best?.box || (fallback && fallback.box) || clampToScreen(rect(0, 0, it.size.width, it.size.height), viewport);
      taken.push(box);
      total += best ? best.score : 1e6;
      placed.set(it.id, { box, clean: !!best, arrow: null, badge: true });
      continue;
    }
    const box = best?.box || (fallback && fallback.box) || clampToScreen(
      rect(viewport.width / 2 - it.size.width / 2, viewport.height / 2 - it.size.height / 2,
        it.size.width, it.size.height), viewport);
    taken.push(box);
    const arrow = pointed ? (best?.arrow || arrowFor(box, own)) : null;
    if (arrow) arrows.push(arrow);
    total += best ? best.score : 1e6;   // an overlap is worse than any detour
    placed.set(it.id, { box, clean: !!best, arrow });
  }
  placed.score = total;
  return placed;
}

// Place the items twice — the `group` ids walked one way along their side, then
// the other — and keep the better layout. Which end of a dense row should be
// placed first depends on where the free room is (the tools' notes stack off to
// the left of a docked sidebar, the recents' to the right), and trying both is
// cheaper than guessing.
export function placeBestOrder(items, group, side, obstacles, viewport) {
  const inGroup = new Set(group);
  const fwd = orderAlong(items.filter((it) => inGroup.has(it.id)), side);
  const build = (seq) => {
    let k = 0;
    return items.map((it) => (inGroup.has(it.id) ? seq[k++] : it));
  };
  const a = placeCallouts(build(fwd), obstacles, viewport);
  if (fwd.length < 2) return a;
  const b = placeCallouts(build([...fwd].reverse()), obstacles, viewport);
  const best = b.score < a.score ? b : a;
  // Arrows for some of a group and numbers for the rest reads as two systems. If
  // any note of the group could not get a clean arrow, the whole group goes over
  // to numbers — a legend, numbered in order along the side — and drops arrows.
  if (![...inGroup].some((id) => best.get(id)?.badge)) return best;
  const numbers = new Map(fwd.map((it, i) => [it.id, i + 1]));
  // Laid out as a grid in number order when one fits beside the group; otherwise
  // each numbered note simply takes the nearest free spot.
  // Whatever comes before the group (the intro card) keeps its spot — it is placed
  // first in every layout, so it never moves — and the grid works around it.
  const firstAt = items.findIndex((it) => inGroup.has(it.id));
  const lead = items.slice(0, firstAt);
  const leadBoxes = [...placeCallouts(lead, obstacles, viewport).values()].map((p) => p.box);
  const grid = legendGrid(fwd, side, [...obstacles, ...leadBoxes], viewport);
  const legend = grid
    ? placeCallouts([...lead, ...fwd.map((it, i) => ({ ...it, badge: true, at: grid[i] })),
      ...items.slice(firstAt).filter((it) => !inGroup.has(it.id))], obstacles, viewport)
    : placeCallouts(build(fwd.map((it) => ({ ...it, badge: true }))), obstacles, viewport);
  legend.numbers = numbers;
  return legend;
}

// A legend's notes as a grid, in number order: rows read left to right under (or
// above) a row of controls, columns read top to bottom beside a panel. The grid is
// pushed out from the group until it covers no highlighted control; null when no
// such spot fits on screen.
const GRID_GAP = 10;
export function legendGrid(seq, side, obstacles, viewport) {
  const group = union(seq.map((it) => it.target));
  const W = Math.max(...seq.map((it) => it.size.width));
  const fitsAt = (boxes) => boxes.every((b) => onScreen(b, viewport)
    && !obstacles.some((o) => overlaps(b, o, GAP_CLEAR)));
  const vertical = side === 'below' || side === 'above';
  if (vertical) {
    const cols = Math.max(1, Math.min(seq.length, Math.floor((viewport.width - 2 * EDGE + GRID_GAP) / (W + GRID_GAP))));
    // Fewest rows, then as few columns as those rows need (a 2x4 block, not 7+1).
    const rows = Math.ceil(seq.length / cols);
    const per = Math.ceil(seq.length / rows);
    const blockW = per * W + (per - 1) * GRID_GAP;
    const cx = (group.left + group.right) / 2;
    const left0 = Math.max(EDGE, Math.min(cx - blockW / 2, viewport.width - EDGE - blockW));
    const rowH = [];
    seq.forEach((it, i) => { const r = Math.floor(i / per); rowH[r] = Math.max(rowH[r] || 0, it.size.height); });
    const blockH = rowH.reduce((a, b) => a + b, 0) + (rowH.length - 1) * GRID_GAP;
    for (let gap = 22; gap <= 400; gap += 18) {
      const top0 = side === 'below' ? group.bottom + gap : group.top - gap - blockH;
      const boxes = seq.map((it, i) => {
        const r = Math.floor(i / per), c = i % per;
        const top = top0 + rowH.slice(0, r).reduce((a, b) => a + b + GRID_GAP, 0);
        return rect(left0 + c * (W + GRID_GAP), top, it.size.width, it.size.height);
      });
      if (fitsAt(boxes)) return boxes;
    }
    return null;
  }
  // Columns beside a panel: fill top to bottom, then the next column outward.
  const avail = viewport.height - 2 * EDGE;
  const columns = [[]];
  let used = 0;
  for (const it of seq) {
    if (used && used + GRID_GAP + it.size.height > avail) { columns.push([]); used = 0; }
    columns.at(-1).push(it);
    used += (used ? GRID_GAP : 0) + it.size.height;
  }
  const blockW = columns.length * W + (columns.length - 1) * GRID_GAP;
  for (let gap = 22; gap <= 400; gap += 18) {
    const left0 = side === 'left' ? group.left - gap - blockW : group.right + gap;
    const boxes = [];
    columns.forEach((col, c) => {
      const h = col.reduce((a, it) => a + it.size.height, 0) + (col.length - 1) * GRID_GAP;
      const cy = (group.top + group.bottom) / 2;
      let top = Math.max(EDGE, Math.min(cy - h / 2, viewport.height - EDGE - h));
      for (const it of col) { boxes.push(rect(left0 + c * (W + GRID_GAP), top, it.size.width, it.size.height)); top += it.size.height + GRID_GAP; }
    });
    if (fitsAt(boxes)) return boxes;
  }
  return null;
}
const GAP_CLEAR = 4;

// Detail notes are placed in the order their targets sit along the side the notes
// hang from — left to right under a toolbar, top to bottom beside a panel — so
// neighbouring controls get neighbouring notes and their arrows run side by side
// instead of across each other.
export function orderAlong(items, side) {
  const key = side === 'left' || side === 'right'
    ? (it) => (it.target.top + it.target.bottom) / 2
    : (it) => (it.target.left + it.target.right) / 2;
  return [...items].sort((a, b) => key(a) - key(b));
}

// Which section the pointer is "at": the nearest one within reach, measured to the
// edge of its rect (0 when inside it). Sections expand to their details as the
// pointer approaches, so this decides what the overlay is talking about.
export const NEAR = 70;
export function nearestSection(sections, point, reach = NEAR) {
  if (!point) return null;
  let best = null;
  for (const s of sections) {
    const r = s.rect;
    if (!r) continue;
    const dx = Math.max(r.left - point.x, 0, point.x - r.right);
    const dy = Math.max(r.top - point.y, 0, point.y - r.bottom);
    const d = Math.hypot(dx, dy);
    // Ties (nested/adjacent areas both at 0) go to the SMALLER rect — the more
    // specific section the pointer is actually inside.
    const area = (r.right - r.left) * (r.bottom - r.top);
    if (d <= reach && (!best || d < best.d || (d === best.d && area < best.area))) best = { s, d, area };
  }
  return best ? best.s : null;
}
