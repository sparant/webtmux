// resolveRestoreView — which VIEW should a region land on when its first layout
// arrives after a reload?
//
// A VIEW IS (SESSION, WINDOW). That is the whole point of this module, and the bug it
// exists to prevent: a pane's window list covers ONLY the session it is attached to
// (the server runs `list-windows -t <session>`), and every reload re-attaches the
// primary region to the shared base session. So "is the saved window still there?"
// asked against that list answers NO for every window that lived in another session —
// the restore quietly does nothing, and the primary parks on whatever window the base
// session is currently showing. Same window every refresh, wherever you actually were.
// The saved session is what makes the window reachable: differ => hop first.
//
// Split out of SplitManager (which imports lit and can never load under `node --test`)
// so the precedence below is pinned by tests rather than by reading.
//
// Precedence:
//   1. The saved view, if it is still placed on the server and no other pane shows it.
//   2. Otherwise the most recently ACCESSED window that is still placed and free — a
//      reload whose exact view is gone should land on your most recent tab, not on
//      whatever the base session happens to be showing.
//   3. Otherwise null: stay put. Notably this is what a client with nothing saved
//      gets, so a first-ever visit never yanks the shared base session (and with it
//      the ssh console) off the window it is on.

// input:
//   saved      {windowId, session} | null   the persisted view (session may be null)
//   session    string                        the pane's current LOGICAL session
//   windows    string[]                      window ids in the pane's own session
//   placements {id, session}[]               server-wide (session, window) directory
//   occupied   iterable<string>              window ids other panes already show
//   recents    {id, session}[]               the recents strip, any order
//   recency    (id) => number                access sequence; 0 = never visited here
// -> {id, session} | null
export function resolveRestoreView({
  saved = null,
  session = '',
  windows = [],
  placements = [],
  occupied = [],
  recents = [],
  recency = () => 0,
} = {}) {
  const savedId = saved && typeof saved.windowId === 'string' && saved.windowId ? saved.windowId : null;
  if (!savedId) return null;   // nothing was saved -> never move the pane (rule 3)

  const taken = new Set(occupied);
  const savedSession = saved && typeof saved.session === 'string' && saved.session ? saved.session : null;

  // Where can we look? The server-wide directory when the server sends one; otherwise
  // just this pane's own session, which degrades this to the pre-directory behavior
  // rather than to "nothing exists anywhere".
  const dir = placements.length
    ? placements.map((p) => ({ id: p.id, session: p.session || '' }))
    : windows.map((id) => ({ id, session }));
  const placed = (id, sess) => dir.some((p) => p.id === id && p.session === sess);

  // 1. The saved view. With no saved session (blobs from the builds that persisted a
  //    window alone) the id is honored only in the pane's CURRENT session — the exact
  //    behavior those blobs were written under, and the conservative reading: an id
  //    from an unknown session is as likely to name a window we would place wrongly.
  if (!taken.has(savedId)) {
    if (savedSession) {
      if (placed(savedId, savedSession)) return { id: savedId, session: savedSession };
    } else if (windows.includes(savedId)) {
      return { id: savedId, session };
    }
  }

  // 2. Most recent surviving tab. Recency 0 means "never visited from here", which
  //    keeps windows nobody has opened (typically window 0) out of the running.
  const candidates = recents
    .map((e) => ({ id: e.id, session: e.session || session }))
    .filter((v) => v.id && recency(v.id) > 0 && !taken.has(v.id) && placed(v.id, v.session));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => recency(b.id) - recency(a.id))[0];
}
