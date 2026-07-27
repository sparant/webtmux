// buildMruOrder — the walk order for the held-chord recent-window cycle (⌃⌥L /
// ⌘⌥L), newest-accessed first.
//
// WHY THIS IS ITS OWN MODULE. It used to be four lines inside navigateMru that read
// `captureCache.all('recent')` — the live CAPTURE map. Captures only exist while
// something is asking for them: the sidebar's poll (open panel only), an open Exposé,
// a preview, a hover. So after a browser refresh with the sidebar collapsed there were
// no captures, the candidate list came back empty, and the chord silently did nothing.
// The recency ORDER was never lost — it rides the shared @wt_state blob and reloads
// fine — the candidate SET was missing. That bug was invisible from the code that had
// it, and untestable in place (split-manager.js imports lit and cannot load under
// `node --test`), so the ranking moved here where the reload case can be pinned.
//
// THE CANDIDATE SET IS THE WINDOW DIRECTORY, NOT THE CAPTURE CACHE. `layout.allWindows`
// — every (session, window) placement on the tmux server — arrives with every 500ms
// layout push whether or not anything is capturing, so it is available on the first
// keystroke after a reload. Captures and the recents strip are folded in as extra
// sources rather than the source: they can name a placement the directory hasn't listed
// yet (a session no region covers, a window the strip outlived), and a candidate the
// user demonstrably visited should never be missing from an alt-tab walk.
//
// A window with no recorded access still appears, at the TAIL. tmux's own last-window
// doesn't require you to have captured anything, and "the chord does nothing" is
// indistinguishable from a broken build — a walk that reaches every window is both more
// honest and more useful than one that can be empty.
//
// Import-free on purpose (like work-alerts.js / recents-strip.js) so the test runner
// can load it directly.

// Read a recency sequence out of either a Map or a plain object. The live caller hands
// a Map (captureCache.accessed); the persisted blob shape is entry pairs, and a test
// (or a future reader of @wt_state) may reasonably hand an object.
function seqOf(accessed, id) {
  if (!accessed || !id) return 0;
  const v = typeof accessed.get === 'function' ? accessed.get(id) : accessed[id];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Normalize the three input shapes to one. Placements/recents use {id, session};
// captures use {windowId, sessionName}. `index` is optional everywhere and is only
// ever used as a tie-break, so a missing one sorts last rather than pretending to be 0.
function normalize(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' && entry.id ? entry.id
    : (typeof entry.windowId === 'string' && entry.windowId ? entry.windowId : '');
  if (!id) return null;
  const session = typeof entry.session === 'string' ? entry.session
    : (typeof entry.sessionName === 'string' ? entry.sessionName : '');
  const index = typeof entry.index === 'number' ? entry.index : Infinity;
  return { id, session, index };
}

// Which of a linked window's placements the walk should visit. A window linked into
// two sessions is ONE stop on the walk (visiting both would land you on the same screen
// twice and look like a dropped keypress), so one placement has to win:
//
//   1. the session the focused pane is already on — switching windows without also
//      switching session is the smaller move, and it keeps the pane where the user
//      put it;
//   2. otherwise the lowest (session, index), which is the order the sidebar and
//      Exposé already list placements in, so the choice matches what the user sees.
function better(a, b, currentSession) {
  if (!a) return b;
  if (!b) return a;
  const aCur = a.session === currentSession;
  const bCur = b.session === currentSession;
  if (aCur !== bCur) return aCur ? a : b;
  const bySession = String(a.session).localeCompare(String(b.session));
  if (bySession !== 0) return bySession < 0 ? a : b;
  return a.index <= b.index ? a : b;
}

// Build the walk.
//
//   placements  — [{id, session, index}] the server-wide window directory
//                 (SplitManager._placements, from layout.allWindows). PRIMARY source.
//   captures    — [{windowId, sessionName, index}] the capture cache's placements.
//   recents     — [{id, session, index}] the toolbar strip's entries.
//   accessed    — Map|object windowId -> recency seq (higher = more recent).
//   currentId / currentSession — what the focused pane shows right now.
//   occupied    — Set of window ids some OTHER pane is showing; they are skipped,
//                 because two panes on one window would just mirror each other. The
//                 current window is exempt: it is in that set by definition.
//
// Returns [{id, session}] with the current window pinned at index 0, so the first
// forward tap lands on the PREVIOUS window — the alt-tab feel. Fewer than two entries
// means there is nowhere to go; the caller treats that as "do nothing".
export function buildMruOrder({
  placements = [],
  captures = [],
  recents = [],
  accessed = null,
  currentId = '',
  currentSession = '',
  occupied = null,
} = {}) {
  const busy = occupied instanceof Set ? occupied : new Set(occupied || []);
  const best = new Map();   // window id -> the placement the walk will visit
  for (const list of [placements, captures, recents]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const e = normalize(raw);
      if (!e) continue;
      // Skip what another pane already shows — but never our own current window: it
      // is "occupied" by us, and it has to be in the order to be pinned to slot 0.
      if (e.id !== currentId && busy.has(e.id)) continue;
      best.set(e.id, better(best.get(e.id), e, currentSession));
    }
  }

  const order = [...best.values()].sort((a, b) => {
    const d = seqOf(accessed, b.id) - seqOf(accessed, a.id);
    if (d !== 0) return d;
    // Never-accessed (and same-second) windows fall back to the listing order every
    // other surface uses, so the tail of the walk is at least predictable.
    return String(a.session).localeCompare(String(b.session)) || (a.index - b.index);
  }).map((e) => ({ id: e.id, session: e.session }));

  if (!currentId) return order;
  const pos = order.findIndex((e) => e.id === currentId);
  // Match by id, not by (id, session): the directory's label for a placement and the
  // pane's logical session can disagree for a moment after a session hop, and pinning
  // the wrong slot would make the first tap re-enter the window you are already in.
  if (pos === -1) order.unshift({ id: currentId, session: currentSession });
  else if (pos > 0) order.unshift(order.splice(pos, 1)[0]);
  return order;
}
