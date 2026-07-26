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
