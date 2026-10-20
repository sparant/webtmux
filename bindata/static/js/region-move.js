// "Put THAT window in THIS region" — the rule for showing a window in one region when
// another region may already be showing it.
//
// Every switcher in the app (recents strip, sidebar, Exposé, ⌃⌥N) navigates the
// FOCUSED region, and a tab dropped on a region names that one. Either way the window
// may already be on screen in some OTHER region, and "show me this window" has to
// bring it HERE rather than jump the focus over there — jumping made the split
// sticky, every window dragging you back to wherever it was last shown.
//
// THE EXCHANGE. A window is visible in at most one region — two regions showing one
// window are two mirrors of the same screen, which wastes a pane and confuses every
// "which region has it" question in the app. So sending a window that is already on
// screen somewhere does not duplicate it and does not leave its old region blank:
// the two regions TRADE views. Region A had the window you want and region B had
// something else; afterwards B has the window and A has what B was showing.
//
// Trading rather than, say, sending A back to its previous window is what makes the
// gesture reversible: doing it again puts both regions back exactly where they were.
// It also never has to invent a destination for A — the only window it could pick
// would be one the user didn't ask about.
//
// Pure: views in, moves out. No DOM, no tmux — see test/region-move.test.mjs.

// views    [{ windowId, session }] — what each region shows (or is on its way to
//                                    showing), in region order. See _viewOf.
// target   index of the region the window should end up in
// windowId the window being sent
// session  the LOGICAL session it is being sent through ('' = the target's own).
//          A window linked into two sessions is a different view through each, so
//          a region already showing that id may still have somewhere to go.
//
// Returns null when the request is not actionable at all, otherwise:
//   moves   [{ index, windowId, session }] — regions to switch, in the order to do it
//   focus   the region index that should end up focused (always `target`)
//   vacate  a region that gave up the window but has nothing to take in exchange,
//           and so must pick a window for itself (null in the normal case)
export function planRegionMove({ views, target, windowId, session = '' } = {}) {
  const list = Array.isArray(views) ? views : [];
  const to = list[target];
  if (!windowId || !to) return null;

  // Already there. Not "nothing to do" — the region may not be the focused one, and
  // asking for a window that is right in front of you is a perfectly good way to say
  // "focus that pane". Only a genuine session change counts as a move (a linked
  // window viewed through its other session is a different view of the same id).
  const sameView = to.windowId === windowId && (!session || !to.session || session === to.session);
  if (sameView) return { moves: [], focus: target, vacate: null };

  const holder = list.findIndex((v, i) => i !== target && v && v.windowId === windowId);
  const move = { index: target, windowId, session };
  if (holder < 0) return { moves: [move], focus: target, vacate: null };

  // The exchange. The target moves FIRST so that, if anything goes wrong between the
  // two sends, the pane the user is looking at is the one that got what they asked
  // for — the other region is the consolation prize either way.
  //
  // A holder with nothing to take in return is a region that has not landed on a
  // window yet (mid-boot, mid-restore). There is nothing to give it, and leaving it
  // on the window we just took would put two regions on one window, so it is handed
  // back to the same most-recently-used auto-pick a freshly split region uses.
  if (!to.windowId) return { moves: [move], focus: target, vacate: holder };
  return {
    moves: [move, { index: holder, windowId: to.windowId, session: to.session || '' }],
    focus: target,
    vacate: null,
  };
}
