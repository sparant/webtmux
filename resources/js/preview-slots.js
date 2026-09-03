// Where a previewed window is DRAWN — the preview's placement model, with no DOM in
// it so it can be tested directly (see test/preview-slots.test.mjs).
//
// The preview used to derive its shape from a count: one window meant a floating
// corner box, two or more meant a docked edge bar, and you could not ask for either.
// That tied two independent choices together — "how many windows am I watching" and
// "where do I want this one drawn" — so a single window could never be a bar tile, a
// second window silently evicted your corner box, and the four screen corners could
// only ever hold one window between them.
//
// The count is gone. Every previewed window carries its own SLOT:
//
//   'bar'                  — a tile in the docked edge bar (the default)
//   'tl' | 'tr' | 'bl'|'br'— a floating Picture-in-Picture box in that screen corner
//
// The bar holds any number of tiles; each corner holds at most one window. Those two
// rules are the whole model, and every function here is a consequence of them.
export const BAR = 'bar';
export const CORNERS = ['tl', 'tr', 'bl', 'br'];
export const SLOTS = [BAR, ...CORNERS];

export const CORNER_GLYPH = { tl: '⌜', tr: '⌝', bl: '⌞', br: '⌟' };
export const CORNER_NAME = { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' };

export const EDGES = ['top', 'bottom', 'left', 'right'];
export const EDGE_GLYPH = { top: '↑', bottom: '↓', left: '←', right: '→' };
export const EDGE_NAME = { top: 'top', bottom: 'bottom', left: 'left', right: 'right' };

// Anything we don't recognise is a bar tile. Unknown slots come from a persisted blob
// written by another version, and the bar is the placement that always works — it has
// no capacity limit and cannot collide with anything.
export function normalizeSlot(slot) {
  return SLOTS.includes(slot) ? slot : BAR;
}

// corner -> windowId for the windows currently pinned to corners. Built in list order,
// so if a malformed set claims a corner twice the FIRST entry keeps it (and
// normalizeWins below is what pushes the loser back to the bar).
export function cornerOccupancy(wins) {
  const map = new Map();
  for (const w of wins || []) {
    if (CORNERS.includes(w?.slot) && !map.has(w.slot)) map.set(w.slot, w.windowId);
  }
  return map;
}

// Enforce the one-window-per-corner rule over a whole set: fill in missing slots and
// send any window whose corner was already claimed to the bar. Order is preserved —
// the bar draws its tiles in set order, and a window that comes back from a corner
// should land where it used to be rather than at the end.
export function normalizeWins(wins) {
  const taken = new Set();
  return (wins || []).map((w) => {
    const slot = normalizeSlot(w?.slot);
    if (slot !== BAR && taken.has(slot)) return { ...w, slot: BAR };
    if (slot !== BAR) taken.add(slot);
    return { ...w, slot };
  });
}

// The first corner nobody is in, preferring `prefer` when it happens to be free. Null
// when all four are taken — the caller decides what that means (the keyboard shortcut
// falls back to the bar rather than doing nothing).
export function freeCorner(wins, prefer) {
  const taken = cornerOccupancy(wins);
  if (CORNERS.includes(prefer) && !taken.has(prefer)) return prefer;
  return CORNERS.find((c) => !taken.has(c)) || null;
}

// Move one window to a slot, returning a NEW set. Two invariants are maintained here
// so no caller has to remember them:
//   • a corner holds one window, so whoever was in the target corner is bumped to the
//     bar rather than being drawn underneath;
//   • the moved window keeps its position in the set, so bar order is stable across a
//     round trip to a corner and back.
export function placeWindow(wins, id, slot) {
  const want = normalizeSlot(slot);
  return (wins || []).map((w) => {
    if (w.windowId === id) return { ...w, slot: want };
    if (want !== BAR && w.slot === want) return { ...w, slot: BAR };
    return w;
  });
}

// What the hover controls on ONE tile should offer. Same answer for a bar tile and a
// corner box — which is the point: the control cluster is a property of a previewed
// window, not of the surface it happens to be drawn on.
//
//   corners — the corner buttons to draw. A corner another window is in is NOT
//             offered ("we don't need the control to go there"); this window's own
//             corner IS, marked active, because a control cluster that hides where you
//             already are stops being a map of the four corners.
//   toBar   — offer "send back to the bar" only when the tile isn't already in it.
export function tileControls(wins, id) {
  const self = (wins || []).find((w) => w.windowId === id);
  if (!self) return { corners: [], toBar: false };
  const taken = cornerOccupancy(wins);
  const corners = CORNERS
    .filter((c) => !taken.has(c) || taken.get(c) === id)
    .map((c) => ({ corner: c, active: taken.get(c) === id }));
  return { corners, toBar: normalizeSlot(self.slot) !== BAR };
}

// Read a persisted 'pip' section into a slotted set, upgrading blobs written before
// slots existed. The old shape stored no slot at all and derived the shape from the
// count, so the honest upgrade is to reproduce what the user was LOOKING AT: a lone
// window was a corner box at the shared `pip.corner`, and any larger set was the bar.
// Blobs that already carry slots are just normalized.
export function winsFromState(pip) {
  const raw = Array.isArray(pip && pip.wins) ? pip.wins.filter((w) => w && w.windowId) : [];
  const legacy = raw.length > 0 && raw.every((w) => !w.slot);
  if (legacy && raw.length === 1) {
    const c = CORNERS.includes(pip && pip.corner) ? pip.corner : 'tr';
    return [{ ...raw[0], slot: c }];
  }
  return normalizeWins(raw);
}
