// Where a thing that hangs off a control goes. ONE rule, shared by the hover hint
// (tooltip.js) and the confirm popup (confirm-popup.js).
//
// It is one function because the two must not disagree about where "next to this
// control" is: a hint that appears below the × and a question that appears above it
// read as two different mechanisms rather than one app answering you.
//
// THE RULE:
//   • sit just BELOW the anchor;
//   • FLIP above it when the bottom of the screen is in the way (a sidebar list
//     runs to the bottom edge, so "always below" puts its last few hints nowhere);
//   • clamp horizontally so the whole thing stays on screen;
//   • …and, when a `bounds` box is given and the popup fits inside it, clamp to
//     THAT instead — what belongs to a panel should stay in the panel rather than
//     hanging out over the terminal beside it.
//
// Pure geometry: rects in, {left, top} out, so it is testable without a DOM (see
// test/popup-place.test.mjs). Callers do the measuring and the styling.

// Gap from the anchor, and the margin kept from every edge it clamps against.
export const PLACE_MARGIN = 6;

// anchor  {left, right, top, bottom} — the control's viewport rect
// size    {width, height}            — the popup's measured size
// opts.viewport {width, height}      — the visible area
// opts.align 'left' | 'right'        — which popup edge lines up with the anchor's
//                                      same-named edge. 'right' for controls that
//                                      sit at the right edge of a narrow panel (a
//                                      tab's ×), where left-aligning would push the
//                                      popup off the panel.
// opts.bounds {left, right} | null   — preferred horizontal container
// opts.margin                        — override the default gap
export function placePopup(anchor, size, opts = {}) {
  const {
    viewport = { width: 0, height: 0 },
    align = 'left',
    bounds = null,
    margin = PLACE_MARGIN,
  } = opts;
  const w = size.width || 0;
  const h = size.height || 0;

  // Horizontal limits: the bounds box only counts when the popup actually fits in
  // it — a panel narrower than its own popup would otherwise clamp it to a sliver.
  const fits = bounds && (bounds.right - bounds.left) >= w + 2 * margin;
  const minLeft = fits ? Math.max(margin, bounds.left + margin) : margin;
  const maxRight = fits
    ? Math.min(viewport.width - margin, bounds.right - margin)
    : viewport.width - margin;

  let left = align === 'right' ? anchor.right - w : anchor.left;
  if (left + w > maxRight) left = maxRight - w;
  if (left < minLeft) left = minLeft;

  let top = anchor.bottom + margin;
  if (top + h > viewport.height - margin) top = anchor.top - h - margin;
  if (top < margin) top = margin;

  return { left: Math.round(left), top: Math.round(top) };
}

// ---- hanging off one named SIDE --------------------------------------------------
//
// placePopup's "below, else above" is right for a control in a row of controls. It is
// wrong for a preview TILE, which is a big box docked against a screen edge: below a
// tile in a bottom bar is off screen, and below a tile in a left bar is on top of the
// next tile down. What a tile's popups want is "on the side facing the middle of the
// screen", and which side that is depends on where the tile is docked — so the caller
// names it (see tileSide in preview-slots.js) and this does the geometry.
//
// `gap` is 0 for something the pointer has to travel INTO (the region picker: a gap
// between the tile and the picker is a strip where the hover it depends on ends) and
// PLACE_MARGIN for a hint, which the pointer never enters.
//
// side  'above' | 'below' | 'left' | 'right'
// Flips to the opposite side when the named one has no room, and clamps along the
// other axis so the whole popup stays on screen.
export function placeOnSide(anchor, size, side, opts = {}) {
  const { viewport = { width: 0, height: 0 }, gap = 0, margin = PLACE_MARGIN } = opts;
  const w = size.width || 0;
  const h = size.height || 0;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  let left;
  let top;
  if (side === 'left' || side === 'right') {
    const before = anchor.left - gap - w;   // to the left of the anchor
    const after = anchor.right + gap;       // to the right of it
    const room = (x) => x >= margin && x + w <= viewport.width - margin;
    left = side === 'left'
      ? (room(before) || !room(after) ? before : after)
      : (room(after) || !room(before) ? after : before);
    left = clamp(left, margin, viewport.width - margin - w);
    top = clamp(anchor.top, margin, viewport.height - margin - h);
  } else {
    const before = anchor.top - gap - h;    // above the anchor
    const after = anchor.bottom + gap;      // below it
    const room = (y) => y >= margin && y + h <= viewport.height - margin;
    top = side === 'above'
      ? (room(before) || !room(after) ? before : after)
      : (room(after) || !room(before) ? after : before);
    top = clamp(top, margin, viewport.height - margin - h);
    left = clamp(anchor.left, margin, viewport.width - margin - w);
  }
  return { left: Math.round(left), top: Math.round(top) };
}
