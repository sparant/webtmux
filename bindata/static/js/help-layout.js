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

// items: [{ id, target: rect|null, size: {width, height}, inside?: bool,
//           side?: 'below'|'above'|'left'|'right', at?: rect (fixed position) }]
// obstacles: rects no callout may cover (every highlighted target).
// Returns Map id -> { box, clean, arrow|null }; clean is false when nothing free
// was found and the box overlaps something (the caller can shrink it and retry).
export function placeCallouts(items, obstacles, viewport) {
  const placed = new Map();
  const taken = [];               // boxes already given out
  for (const it of items) {
    if (it.at) {
      placed.set(it.id, { box: it.at, clean: true, arrow: null });
      taken.push(it.at);
      continue;
    }
    const own = it.target;
    const blockers = obstacles.filter((o) => !(it.inside && o === own));
    // An inside note that finds its target full may sit anywhere free on screen,
    // nearest the target first, before settling for an overlap.
    const anywhere = rect(0, 0, viewport.width, viewport.height);
    const gen = it.inside
      ? (function* () { yield* insideCandidates(own, it.size); yield* nearestFirst(anywhere, own, it.size); })()
      : candidates(own, it.size, it.side || facing(own, viewport));
    let best = null;
    let fallback = null;
    for (const c of gen) {
      if (!onScreen(c.box, viewport)) continue;
      if (!it.inside && overlaps(c.box, own, PAD)) continue;
      const hitsBox = taken.some((t) => overlaps(c.box, t, PAD));
      const hitsObst = blockers.some((o) => overlaps(c.box, o, PAD - 2));
      if (!hitsBox && !hitsObst) { best = c.box; break; }
      // Remember the least-bad spot in case nothing is clean (a tiny window).
      const bad = taken.reduce((s, t) => s + overlapArea(c.box, t) * 3, 0)
        + blockers.reduce((s, o) => s + overlapArea(c.box, o), 0) + c.cost;
      if (!fallback || bad < fallback.bad) fallback = { box: c.box, bad };
    }
    const box = best || (fallback && fallback.box) || clampToScreen(
      rect(viewport.width / 2 - it.size.width / 2, viewport.height / 2 - it.size.height / 2,
        it.size.width, it.size.height), viewport);
    taken.push(box);
    placed.set(it.id, { box, clean: !!best, arrow: it.inside || !own ? null : arrowFor(box, own) });
  }
  return placed;
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
