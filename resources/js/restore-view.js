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

// planReconnectLanding — the same question as planRestoreLanding, asked for the OTHER
// way a pane loses its view: a websocket drop (close the laptop lid, sleep the machine,
// a tty loss) rather than a page reload. Nothing here is read from storage; the unit
// still holds the view it was on in memory (desiredSession/desiredWindowId), and the
// reconnect just has to put it back.
//
// THE BUG THIS PINS. A fresh attach always lands on the SHARED BASE session, on
// whatever window that session currently shows. A pane that had switched to another
// session therefore came back somewhere it had never been — typically the base
// session's last-created window, since creating a window makes it current and nobody
// has moved that session since. Reopening the laptop showed that window instead of the
// one you were working in. Only the extra (grouped) regions were restored; the primary
// was left parked, on the reasoning that forcing its window would drag the ssh console
// that shares the base session's attach.
//
// That reasoning is right about `select-window` and wrong about `switch-client`:
//   • select-window in the BASE session moves the session itself, console and all. So
//     within the base session the primary still follows tmux rather than yanking it —
//     if the base session's current window changed while we were away, somebody else
//     moved it, and their view is the shared one (this is the behavior verified when
//     the reconnect restore was first written).
//   • switch-client moves only THIS connection's own tmux client (the backend targets
//     it by tty, and re-groups a split region onto the target). A pane that hops back
//     to the session it was in leaves the base session — and the console on it —
//     exactly where they are. There is no reason for the primary to sit this out, and
//     the reload path (resolveRestoreView above) already hops the primary this way.
// Hence: the cross-session restore is for every region; the same-session window
// restore stays an extra-regions-only affair.
//
// input:
//   primary        bool                    is this the console-sharing primary region?
//   base           string                  the LOGICAL session the fresh attach landed in
//   activeWindowId string                  the window that attach parked us on
//   desiredSession string|null             the session we were viewing before the drop
//   desiredWindowId    string|null         ...and the window
//   desiredWindowIndex number|null         ...and its index, for a same-session id miss
//   windows        {id, index}[]           the pane's own (post-attach) window list
//   placements     {id, session}[]         server-wide (session, window) directory
//   sessions       string[]                session names that still exist
// -> { markSeen, park, hop, select }
//    markSeen — window id whose arrival must NOT count as a visit (the parked window)
//    park     — the parked window id while a restore is in flight, else null
//    hop      — session to switch-client to, or null
//    select   — window id to select-window, or null
export function planReconnectLanding({
  primary = false,
  base = '',
  activeWindowId = null,
  desiredSession = null,
  desiredWindowId = null,
  desiredWindowIndex = null,
  windows = [],
  placements = [],
  sessions = [],
} = {}) {
  const stay = { markSeen: activeWindowId, park: null, hop: null, select: null };

  // 1. We were in another session: hop back. Guarded on the session still existing —
  //    switching to a killed session is an error, and the pane is better off staying
  //    where the attach put it than chasing a name that is gone. An empty list means
  //    the layout didn't say, which is not evidence of absence.
  if (desiredSession && base && desiredSession !== base) {
    const alive = !sessions.length || sessions.includes(desiredSession);
    if (alive) {
      // Select the window only if that exact PLACEMENT survived. A window closed
      // while we slept (or unlinked from this session) leaves the hop standing on its
      // own: land in the right session, on whatever it is showing, rather than firing
      // a select-window at an id tmux no longer has there.
      const placed = !placements.length
        || placements.some((p) => p.id === desiredWindowId && (p.session || '') === desiredSession);
      const select = desiredWindowId && placed ? desiredWindowId : null;
      return { markSeen: activeWindowId, park: activeWindowId, hop: desiredSession, select };
    }
  }

  // 2. Same session. The primary shares this session's attach with the ssh console, so
  //    a select-window here would move the console too — it follows tmux instead (see
  //    the header). Extra regions have their own grouped session and restore freely.
  if (primary) return stay;
  const want = (windows.find((w) => w.id === desiredWindowId)
    || (desiredWindowIndex != null ? windows.find((w) => w.index === desiredWindowIndex) : null)
    || null);
  if (!want || want.id === activeWindowId) return stay;
  return { markSeen: activeWindowId, park: activeWindowId, hop: null, select: want.id };
}

// planRestoreLanding — given the resolved view, what should the pane DO, and which
// window must be marked already-seen so the boot layout is not mistaken for a visit?
//
// THE BUG THIS PINS. A pane's first layout after a reload shows whatever window the
// attach parked it on — for the primary, the base session's current window (typically
// `services`' window 0). SplitManager's access-note treats "showing a window it
// wasn't" as a visit, so unless that boot window is marked seen, it lands in the
// recents strip on every reload — a tab for a window nobody opened. The suppression
// used to run only on the NAVIGATE path; when the resolution said "stay put" (nothing
// restorable, or the saved view IS the boot window) nothing was marked, and the boot
// window leaked into the strip. Staying put must suppress exactly as navigating away
// does: neither is a user opening a window.
//
// The one deliberate exception: a hop to the SAME window id in another session (a
// linked window restored to its other tab). Marking the id there would swallow the
// real access the landing layout must record — the landing arrives with the same id,
// so the seen-check would read it as "no change" (see _applyRestoreTarget's caller).
//
// input:
//   view    {id, session} | null   resolveRestoreView's answer
//   bootId  string                 the window the pane booted on (layout.activeWindowId)
//   session string                 the pane's current LOGICAL session
// -> { markSeen: string|null, nav: {id, session, hop} | null }
export function planRestoreLanding({ view = null, bootId = null, session = '' } = {}) {
  if (!view) return { markSeen: bootId, nav: null };
  const hop = !!view.session && view.session !== session;
  if (!hop && view.id === bootId) return { markSeen: bootId, nav: null };
  return {
    markSeen: view.id !== bootId ? bootId : null,
    nav: { id: view.id, session: view.session, hop },
  };
}
