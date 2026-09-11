// Pending-kill state for the sidebar's × affordances — the "killing, hold on"
// bar a row gets between the click and the layout push that removes it.
//
// Why it exists: killing a session that runs slow-starting work (an LLM
// client, a test suite) can take a good while, because tmux waits for the
// processes to die. In that gap the server does not push anything and the row
// keeps sitting in the list untouched — which reads as "the × did nothing".
// The bar answers that: the kill IS accepted, it is just still draining.
//
// The pure half, in the same shape as window-tree.js: no DOM, no lit, no
// stores — testable under node without a browser, and the sidebar component
// keeps only the rendering and the wiring (see test/kill-pending.test.mjs).
//
// Keys are the same placement keys window-tree.js uses, so a row is never
// ambivalent about what is dying:
//
//   session  — the logical session name ("s:<name>")
//   window   — (session, windowId) placement, "w:" + rowKey(session, windowId).
//              A window linked into two sessions has one row per session, but a
//              bar is only ever marked on a row the click judged to be the
//              window's LAST home (a linked window's × unlinks, it does not
//              kill), so the placement key still matters: the bar must land on
//              the row that was clicked, and nowhere else.

// The window half carries no session name of its own (windowIds are "@N"), so
// the join borrows window-tree.js's rowKey.
import { rowKey } from './window-tree.js';

export function sessionKey(name) {
  return 's:' + (name || '');
}

export function windowKey(session, windowId) {
  return 'w:' + rowKey(session, windowId);
}

// One pending kill, as the component stores it: the key plus the placement's
// display fields, frozen at click time. The fields let the bar render its label
// without re-deriving it from the (soon to be stale) layout, and they stay
// honest after the row disappears from the list.
export function makePending(kind, key, label) {
  return { kind, key, label, at: Date.now() };
}

// The pending kill for one WINDOW placement, or null. Each bar sits on the
// one row it belongs to — a window's bar on its row, a session's bar under its
// header — so a kill never scatters more than one bar. `pending` is the live
// Map; the entry is a stable object the caller renders from directly.
export function pendingWindow(pending, session, windowId) {
  if (!pending) return null;
  return pending.get(windowKey(session, windowId)) || null;
}

// The pending kill for a SESSION, or null (its own — the windows it contains
// carry their own bars).
export function pendingSession(pending, session) {
  if (!pending) return null;
  return pending.get(sessionKey(session)) || null;
}

// A layout push has settled. Clear the pending entries it answered for:
//
//   • a session name the list no longer carries — its kill landed;
//   • a window ROW that the list no longer carries — its kill or unlink landed.
//
// Row absence is always a correct settle signal, because a window bar is only
// ever marked on a placement the click judged to be the window's LAST one (the
// × on a linked window unlinks instead — non-destructive, no bar), and a
// kill-window by @id removes the window from every directory at once. The one
// way a killed window can outlive its row is a stale link count racing another
// client's link-window, and in that race the bar settles on a row that is no
// longer drawn — where it can do no further good — while the surviving row,
// which was never barred, simply shows no bar.
//
// The rule is keyed on the list, not on the render: a filter that hides a row
// does not keep its kill pending, because pruning reads layout.allWindows
// directly. And a rename — row absence by ID with the window still listed —
// settles the same as a kill, which is harmless: the row the bar was on is the
// one that is gone.
//
// Everything still present stays pending. The pruned entries are RETURNED as
// well as deleted, so a caller can observe exactly which kills a push settled.
//
// `windows` is the placement directory the sidebar rows come from —
// layout.allWindows, falling back to the current session's layout.windows
// under its own name, exactly as window-tree.js's buildTree does.
export function prunePending(pending, sessions, windows, ownSession) {
  if (!pending || !pending.size) return [];
  const liveSessions = new Set();
  for (const s of (sessions || [])) {
    if (s && s.name) liveSessions.add(s.name);
  }
  const livePlacements = new Set();
  for (const w of (windows || [])) {
    // A row without a session name is the pane's own session's window (the
    // layout.windows fallback, stamped by the caller or here — same thing).
    if (w && w.id) livePlacements.add(rowKey(w.session || ownSession, w.id));
  }
  const gone = [];
  for (const [key, p] of pending) {
    if (p.kind === 'session') {
      if (!liveSessions.has(key.slice(2))) gone.push(p);
      continue;
    }
    if (!livePlacements.has(key.slice(2))) gone.push(p);
  }
  for (const p of gone) pending.delete(p.key);
  return gone;
}

// The notice text for a kill the server actually REFUSED (a target it could not
// identify), if the server ever reports refusals for kills — it does not today:
// webtty's afterCmd sends TmuxError only for the controller's ErrRefused, and a
// kill whose target vanished is an ordinary failure, logged and repaired by the
// layout push, never reported. Kept next to the state it would dress so the
// wiring is one change, not a memory exercise.
export function failedKillNotice(label) {
  return `Did not kill ${label} — it is still there (tmux refused or it was already gone).`;
}
