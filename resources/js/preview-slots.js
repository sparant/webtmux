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
//
// One more thing belongs to a bar tile beyond its surface: its POSITION. The bar draws
// its tiles in set order, so that order is the user's to arrange — see dropInBar, and
// PREVIEW_DRAG_TYPE for the gesture that drives it.
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

// The positions the BAR TILES occupy inside the whole set, in draw order. The bar draws
// `wins.filter(slot === BAR)`, so these indices are the bar's coordinate system — and
// writing a rearrangement back through them is what keeps the corner entries, which have
// no tile in the bar at all, exactly where they were.
function barSlots(wins) {
  const out = [];
  (wins || []).forEach((w, i) => { if (normalizeSlot(w?.slot) === BAR) out.push(i); });
  return out;
}

// The bar's tiles in draw order — what a drop index counts.
export function barWins(wins) {
  return (wins || []).filter((w) => normalizeSlot(w?.slot) === BAR);
}

// Drop one window into the bar at an insertion GAP among the tiles the bar is drawing.
// Returns a NEW set, or null when the drag changes nothing.
//
// This is the drag-and-drop half of placeWindow: same question ("where is this window
// drawn"), asked by pointing instead of by pressing a button, and so it answers with a
// POSITION as well as a surface. Two kinds of drag arrive here and both are the same
// move — a bar tile dragged past its neighbours, and a corner box dragged down into the
// bar, which is `toBar` plus a say in where it lands.
//
// `toIndex` is a gap, not a slot: it counts the tiles the bar is DRAWING NOW, so it runs
// 0…barWins().length and a value past the last tile means "at the end". Removing the
// dragged tile first shifts everything after it down one, which is why a gap past the
// source maps one lower — the same translation the recents strip makes
// (reorderVisibleRecents in recents-strip.js).
//
// Corner entries keep their array positions: a window that is dragged out of a corner is
// re-filed among the bar tiles, but the ones that stayed pinned are not renumbered
// around it, so sending a corner box back and pinning it again is a round trip.
export function dropInBar(wins, id, toIndex) {
  if (!Number.isFinite(toIndex)) return null;
  const arr = wins || [];
  const i = arr.findIndex((w) => w.windowId === id);
  if (i < 0) return null;
  const self = arr[i];
  const wasBar = normalizeSlot(self.slot) === BAR;
  const from = wasBar ? barSlots(arr).indexOf(i) : -1;

  const rest = arr.filter((_, k) => k !== i);
  const slots = barSlots(rest);
  let gap = wasBar && toIndex > from ? toIndex - 1 : toIndex;
  gap = Math.max(0, Math.min(slots.length, gap));
  if (wasBar && gap === from) return null;

  // Where that gap lands in the WHOLE set: just before the tile it precedes, or —
  // for the end gap — just after the last bar tile, so a corner entry that trails the
  // bar in the array is not stepped over.
  const at = gap < slots.length
    ? slots[gap]
    : (slots.length ? slots[slots.length - 1] + 1 : rest.length);
  rest.splice(at, 0, { ...self, slot: BAR });
  return rest;
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

// ---- what a tile says when you point at it --------------------------------------

// Which side of a tile its hint and its region picker hang off: the side facing the
// middle of the screen. A bottom bar's tiles answer above themselves, a left bar's to
// their right, a top-left corner box below itself — never off the screen edge the tile
// is docked against, and never on top of the next tile along the bar.
export function tileSide(slot, edge) {
  const s = normalizeSlot(slot);
  if (s === BAR) return { top: 'below', bottom: 'above', left: 'right', right: 'left' }[edge] || 'above';
  return s === 'tl' || s === 'tr' ? 'below' : 'above';
}

// The tile's hover hint, in the recents tab's format (toolbar.js _tabTip): WHICH
// window in full first — the label strip ellipsis-clips it, and a window's name has
// no length limit — then what pointing, clicking and dragging do. What the stoplight
// colours mean is NOT in here: that key belongs to the dot, and is what hovering the
// dot says (see pip-overlay.js _buildTile).
//
// `w.label` is "N: name" (pip-overlay keeps it fresh from each capture). The drag
// clause depends on the surface: in the bar a drag reorders, and a corner box's drag
// is how it gets back into the bar.
export function tileTip(w, slot) {
  const label = w?.label || '…';
  const title = w?.session ? `${w.session} — window ${label}` : `window ${label}`;
  const drag = normalizeSlot(slot) === BAR ? 'drag to reorder' : 'drag onto the bar to dock it';
  return `${title}\nHover to preview it in a terminal region · click to switch there · ${drag}`;
}

// ---- dragging a preview tile ---------------------------------------------------
//
// A tile's hover controls name every placement by button, which is precise but is not
// how you rearrange a row of pictures — for THAT you pick one up and put it where you
// want it. So a tile is draggable, and the two preview surfaces are drop targets: the
// bar takes a drop at a position among its tiles, a corner box takes one outright.
//
// Its own private MIME type, for the reasons RECENT_DRAG_TYPE spells out (recents-
// strip.js): `types` is all a `dragover` handler can read, so the type is what each
// surface decides on, and a type nobody else claims cannot be pasted by some other
// handler. A DIFFERENT type from the recents one on purpose — a recents tab dropped on
// the preview bar is not this gesture (it means "preview this window", which the
// toolbar's ⌃⌥I already says), and the terminal regions must go on ignoring a preview
// drag entirely rather than lighting up as targets for it.
export const PREVIEW_DRAG_TYPE = 'application/x-webtmux-preview';

// A previewed window is identified by its window id alone. Unlike a recents tab it
// needs no session: the preview holds one entry per window, whichever session it was
// added from.
export function previewDragPayload(id) {
  return String(id || '');
}

// Total, like every read from outside: a payload that names no window degrades to "not
// a preview drag" rather than to a move of window `undefined`.
export function parsePreviewDrag(raw) {
  return typeof raw === 'string' && raw ? raw : null;
}

// Is this drag one of ours? Asked on every dragover, from `types` alone.
export function carriesPreviewDrag(dt) {
  const types = dt && dt.types;
  if (!types) return false;
  return Array.prototype.includes.call(types, PREVIEW_DRAG_TYPE);
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
