// Recents-strip helpers — the pure, testable half of the toolbar's recent-window
// tabs: which entries actually render (see "preview suppression" below), how the tab
// cap is spent, and keeping the strip in the shared @wt_state blob.
//
// The strip lives in tmux server state, which means two things this module exists
// to handle:
//
//   IT IS UNTRUSTED INPUT. @wt_state is a plain tmux user option: another client
//   (or a person with a tmux socket and `set -g @wt_state ...`) can put anything
//   in it. A malformed entry must degrade to "no tab", never to a render crash in
//   _refreshToolbar, so sanitizeRecents is total — it always returns a well-formed
//   array, dropping what it can't repair.
//
//   IT IS WRITTEN FROM A HOT PATH. _refreshToolbar runs on every 500ms layout
//   push, and a naive persist there would bump @wt_state's rev twice a second
//   forever, spamming every other client with remote-apply work for no change.
//   recentsSignature is the cheap equality test that gates the write down to
//   actual edits.
//
// Kept import-free (like work-alerts.js) so `node --test` can load it directly;
// split-manager.js pulls in lit and could never run under the test harness.

// Tab slots the strip DRAWS, by default. The strip is a glance-able switcher, not a
// history: past ~5 the tabs stop being distinguishable at a glance and the Exposé is
// the better tool.
//
// It is only a default because "how many windows do I flip between" is a property of
// the user's workspace, not of the widget: on a wide monitor with a dozen live agents
// five tabs is an overflow arrow that never goes away. The cap is settable from the
// "Recent ▾" menu and rides the shared blob (toolbar.recentMax) like the other strip
// prefs, so every browser on this tmux server keeps the same strip.
//
// THE CAP BOUNDS THE TABS, NOT THE LIST. See "the off-strip queue" below: a window
// pushed out of the last slot keeps its entry and comes back when a slot frees.
export const MAX_RECENTS = 5;

// Bounds for the settable cap. The floor is 1 rather than 0 because a strip with no
// slots is not a smaller strip, it's a removed feature with no way back — the "Recent"
// label (and so the menu that would restore it) only renders when a tab exists. The
// ceiling is where the tabs stop fitting any plausible toolbar and the Exposé is
// unambiguously the better tool.
export const RECENTS_MIN = 1;
export const RECENTS_MAX = 20;

// ---- the off-strip queue ------------------------------------------------------
//
// The strip is the first `max` entries of a LONGER list. Everything past that point
// is off-strip: no tab, but a remembered position, waiting for a slot.
//
// This is the difference between "pushed off" and "closed", and the strip used to
// have no way to tell them apart. A sixth window arriving DESTROYED the least-recently
// used entry — so closing a tab afterwards left a gap that stayed a gap, even though
// the user had a perfectly good sixth window they had just been in. Meanwhile × on a
// tab, which is the user saying "I'm done with this one", did the same thing. One of
// those two is a statement of intent and the other is a side effect of running out of
// room, and only the first should be permanent.
//
// So: an access that doesn't fit DEMOTES the least-recently-used tab to the head of
// the off-strip queue, and a slot freeing up (× on a tab, a window dying, the cap
// being raised, a window moving into the preview) lets the head slide back in. The
// only thing that ERASES an entry is the user removing it, or its window ceasing to
// exist.
//
// WHY POSITION, RATHER THAN A SEPARATE SHELF WITH ITS OWN RANKING. The strip's order
// is hand-arrangeable (drag) and deliberately stable, so it is already a list whose
// index means something. Making the off-strip queue the TAIL of that same list means
// "what comes back next" needs no extra state, no second blob section, and no rule
// that could disagree with the tabs: it is simply the next entry along. Demotion
// inserts at the head of the tail (the slot just past the last tab), which keeps the
// queue in most-recently-used order without sorting it — the entry being demoted was
// the least-recently-used TAB, and every tab is at least as recent as anything already
// off-strip, so it belongs exactly there.
//
// The list is still bounded, just far above the cap: it holds live windows only
// (_pruneDeletedRecents drops the dead on the next layout push), and it rides a tmux
// user option that every client parses, so it gets a ceiling rather than being allowed
// to grow with every window the user has ever touched.
export const RECENTS_HISTORY_MAX = 50;

// Coerce a stored/typed cap into the allowed range. Total, like sanitizeRecents: the
// value comes from the same user-writable tmux blob, and a junk cap must degrade to
// the default rather than to a strip of NaN slots (which would evict every access —
// `list.length < NaN` is false — and quietly pin the strip at one tab).
// Only a number, or a string that is one, is a cap. Everything else — absent, null,
// blank, an object — means "no preference" and takes the default. Number() alone
// would not do: it turns null, '' and [] into 0, and a MISSING cap clamping to the
// floor is how "I never set this" silently becomes a one-tab strip.
export function clampRecentsMax(raw) {
  const n = typeof raw === 'number' ? raw
    : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(n)) return MAX_RECENTS;
  return Math.min(RECENTS_MAX, Math.max(RECENTS_MIN, Math.floor(n)));
}

// ---- the width cap -------------------------------------------------------------
//
// The cap above is a PREFERENCE ("how many windows do I flip between"). This one is a
// FACT about the browser window: how many of those tabs there is actually room to draw.
//
// The strip used to scroll when the tabs outgrew the toolbar, and a scrollbar is the
// wrong answer twice over. A glance-able switcher whose tabs are off screen isn't one,
// and the tabs that scrolled away were invisible to the alert machinery too — they had
// tabs, so the overflow arrow didn't count them, but you couldn't see them flash.
// Fitting the strip instead makes the two agree: what doesn't fit is off-strip, which
// is a state the rest of this module already knows how to explain and to undo.
//
// So the drawn count is min(the user's cap, what fits), and the surplus goes to the
// head of the off-strip queue — exactly where lowering the cap by hand would put it,
// and it slides back the moment the window is widened again.
//
// Widths come from the DOM (the toolbar measures its own tabs), which is why the
// arithmetic lives here and the measuring lives there: this half is testable.
//
// `slack` absorbs sub-pixel layout: clientWidth is an integer and the tab boxes are
// not, so a set that fits exactly can measure a hair over and drop a tab for nothing.
export function fitTabCount(widths, avail, gap = 0, { min = RECENTS_MIN, slack = 1 } = {}) {
  const list = Array.isArray(widths) ? widths : [];
  if (!list.length) return 0;
  // No width to measure against (never rendered, display:none, a zero-width toolbar):
  // say `min` rather than 0. A measurement that hasn't happened yet must not read as
  // "nothing fits" — that would empty the strip on first paint and take the "Recent ▾"
  // menu (the only way back) with it.
  if (!Number.isFinite(avail) || avail <= 0) return Math.min(list.length, min);
  let used = 0;
  let n = 0;
  for (const w of list) {
    used += (n ? gap : 0) + (Number.isFinite(w) && w > 0 ? w : 0);
    if (used > avail + slack) break;
    n++;
  }
  // Same floor as the cap control: one tab that overflows beats no strip at all.
  return Math.max(Math.min(list.length, min), n);
}

// Coerce arbitrary blob content into well-formed strip entries.
//
// `id` is the only field with no sensible default — an entry without one can't be
// navigated to, resolved against a live layout, or de-duplicated, so it is dropped.
// Everything else is display metadata that _refreshToolbar re-derives from the live
// layout on the very next push, so a placeholder is strictly better than a drop:
// the tab survives, and it self-corrects within 500ms.
//
// `index` is deliberately passed through unvalidated-but-typed: tmux window indexes
// are numbers, but the strip renders `?` for a missing one (see _refreshToolbar),
// and forcing a 0 here would render a confident, wrong window number.
//
// The bound is the HISTORY ceiling, not the tab cap: what is stored is the strip plus
// its off-strip queue, and truncating a restore to the visible cap would throw away
// every entry waiting to come back — the reload would silently do what closing each
// of those tabs by hand does.
export function sanitizeRecents(raw, max = RECENTS_HISTORY_MAX) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.id !== 'string' || !e.id) continue;
    // Entries are keyed by (session, id): the SAME window reached through two
    // sessions is two legitimate tabs, but a duplicated (session, id) is corruption
    // — it would render two identical tabs that both claim to be active.
    const session = typeof e.session === 'string' ? e.session : '';
    const key = session + '\x00' + e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: e.id,
      index: typeof e.index === 'number' ? e.index : undefined,
      name: typeof e.name === 'string' && e.name ? e.name : 'bash',
      session,
    });
    if (out.length >= max) break;
  }
  return out;
}

// Stable content signature for change detection. Only the four durable fields are
// included — the derived per-render flags (active/disabled/working) change on
// nearly every push and would defeat the guard entirely if they leaked in.
export function recentsSignature(list) {
  if (!Array.isArray(list)) return '[]';
  return JSON.stringify(
    list.map((e) => [e.id, e.index, e.name, e.session]),
  );
}

// ---- preview suppression ------------------------------------------------------
//
// A window sitting in the preview — the corner PiP or the docked preview bar — is
// already on screen and one click from being switched to, so a recents TAB for it
// is a second copy of an affordance the user is looking at. The strip's scarce
// resource is horizontal space in the toolbar, and spending a slot on the one set
// of windows that needs no shortcut is the worst possible trade. So the strip
// renders every entry EXCEPT the ones the preview is currently showing.
//
// SUPPRESSION IS A VIEW, NEVER AN EDIT. The entry keeps its slot, its hand-arranged
// position, its name/index refresh and its place in the persisted blob for as long
// as the preview holds the window; the tab comes back — in the same position — the
// moment the preview lets go. That is why the source of truth is the preview's
// "what am I showing right now" (pip.windowIds(), which is empty while the preview
// is tucked away) rather than "what is in its set": a hidden preview shows nothing,
// so it suppresses nothing.
//
// Suppression is keyed by window ID ALONE, even though strip entries are keyed by
// (session, id). The preview shows a window's SCREEN, and a window linked into two
// sessions has one screen — both of its tabs are routes to the thing already on
// display, so both stand down.
//
// The MRU chord (⌃⌥L / ⌘⌥L) is deliberately NOT filtered by any of this: it walks
// the whole window directory (see mru-order.js) and a previewed window is a
// perfectly good place to walk to. Only the strip's tabs stand down.

// Normalize whatever the caller has (a Set, an array of ids, nothing) into a Set.
function suppressedSet(previewed) {
  if (previewed instanceof Set) return previewed;
  return new Set(Array.isArray(previewed) ? previewed : []);
}

// An entry's identity: (session, window). A window linked into two sessions is two
// tabs, so the id alone would collapse them (see sanitizeRecents).
function keyOf(e) {
  return (e && typeof e.session === 'string' ? e.session : '') + '\x00' + (e?.id || '');
}

// The POSITIONS in the durable list of the entries that draw a tab — the first `max`
// that the preview isn't already showing. This is the one place the two rules that
// decide what the user sees (suppression, then the cap) are applied, so the render,
// the drag and the eviction can't drift apart about which entries are "the tabs".
function visibleIndices(arr, hidden, max) {
  const out = [];
  for (let i = 0; i < arr.length && out.length < max; i++) {
    const e = arr[i];
    if (e && !hidden.has(e.id)) out.push(i);
  }
  return out;
}

// The entries that actually render as tabs, in strip order.
export function visibleRecents(list, previewed, max = MAX_RECENTS) {
  const arr = Array.isArray(list) ? list : [];
  return visibleIndices(arr, suppressedSet(previewed), max).map((i) => arr[i]);
}

// The entries queued behind the last tab, nearest first. Everything here is one freed
// slot away from being a tab again. Callers use it for counts and for explaining the
// strip; nothing needs it to render.
//
// Suppressed entries are NOT in this queue even though they draw no tab: they are held
// by the preview, not by the cap, and they come back on their own when it lets go.
// Counting them here would double-count them against recentHeld and would tell the
// user that raising the cap gets them back, which it wouldn't.
export function offStripRecents(list, previewed, max = MAX_RECENTS) {
  const arr = Array.isArray(list) ? list : [];
  const hidden = suppressedSet(previewed);
  const shown = new Set(visibleIndices(arr, hidden, max));
  return arr.filter((e, i) => e && !shown.has(i) && !hidden.has(e.id));
}

// Give `entry` a tab, and return the list it should be stored as.
//
// Called on every access to a window that isn't already a tab — whether it has never
// been in the strip or was pushed off it — because "the window I just moved to has no
// tab" is the same wrong answer in both cases.
//
// Three outcomes:
//
//   • it is ALREADY a tab (or is suppressed and already in the list) — the list is
//     returned unchanged, by reference. Re-accessing a window must never move its
//     tab: the order is the user's, arranged by drag, and re-sorting it on every
//     visit is what makes a strip you can't aim at.
//   • there is ROOM — it takes the slot just past the last tab.
//   • the tabs are FULL — the least-recently-used one gives up its slot, in place, and
//     is re-filed at the head of the off-strip queue. Nothing is destroyed; the
//     demoted entry is first in line to come back.
//
// The cap counts TABS, not entries: an entry whose window is in the preview draws
// nothing, so it neither holds a slot nor gets demoted for one — demoting it would
// free no space and would re-file the tab that is waiting for the preview to let go.
//
// `recency` maps an entry to its access sequence (higher = more recent); the caller
// owns that store (captureCache.accessed), this module only ranks with it.
export function admitRecent(list, entry, { previewed, max = MAX_RECENTS, recency = () => 0 } = {}) {
  if (!entry || !entry.id) return Array.isArray(list) ? list : [];
  const hidden = suppressedSet(previewed);
  const arr = Array.isArray(list) ? list : [];
  const key = keyOf(entry);
  // A suppressed window's entry is placed the moment it exists and then left alone:
  // it draws nothing either way, and moving it would rearrange the strip the user
  // gets back when the preview closes.
  const alreadyPlaced = hidden.has(entry.id)
    ? arr.some((e) => e && keyOf(e) === key)
    : visibleIndices(arr, hidden, max).some((i) => keyOf(arr[i]) === key);
  if (alreadyPlaced) return arr;

  // Off-strip and being visited again: it is coming back as a tab, so drop the stale
  // placement first and let the rules below decide where it lands.
  const next = arr.filter((e) => e && keyOf(e) !== key);
  const vis = visibleIndices(next, hidden, max);
  const after = vis.length ? vis[vis.length - 1] + 1 : 0;
  if (vis.length < max) {
    next.splice(after, 0, entry);
    return next;
  }
  // Full. vis.length === max >= 1, so there is always a tab to demote.
  let slot = vis[0];
  let lru = Infinity;
  for (const i of vis) {
    const seq = recency(next[i]);
    if (seq < lru) { lru = seq; slot = i; }
  }
  const demoted = next[slot];
  next[slot] = entry;
  // Head of the off-strip queue — the slot immediately past the last tab. `after` is
  // still that boundary: the swap above changed what is in a slot, not how many.
  next.splice(after, 0, demoted);
  return next;
}

// The window that takes over a view whose window has just closed (or whose tab was just
// closed): the next entry to the RIGHT of it in the strip's stable order, wrapping round
// to the start — the same "the next one just appears" a closed recents tab gives the
// focused view. `skip(entry)` rules out what may not take its place (windows that are
// gone, or already on screen in another view). Null when the closed window was not in
// the list or nothing else qualifies; the caller falls back to most-recently-used.
export function nextRecentAfter(list, gone, skip = () => false) {
  const l = Array.isArray(list) ? list : [];
  const i = l.findIndex((e) => e && e.id === gone?.id && (!gone.session || e.session === gone.session));
  if (i < 0) return null;
  for (let k = 1; k < l.length; k++) {
    const e = l[(i + k) % l.length];
    if (e && e.id !== gone.id && !skip(e)) return e;
  }
  return null;
}

// Hold the stored list to its ceiling. The tail is the least-recently-used end of the
// off-strip queue (see "the off-strip queue"), so dropping from there loses the
// entries the user is least likely to ever come back to — and never a tab, since tabs
// live in the first `max` slots and the ceiling is far above the cap.
export function trimRecentsHistory(list, max = RECENTS_HISTORY_MAX) {
  const arr = Array.isArray(list) ? list : [];
  return arr.length <= max ? arr : arr.slice(0, max);
}

// Drag-reorder in VISIBLE coordinates. The toolbar hands back an insertion gap into
// the tabs it drew — the strip minus the suppressed entries, cut off at the cap — so
// the move is computed there and then written back through the durable list.
//
// Entries with no tab (suppressed, or off-strip) hold their durable slots while the
// visible ones shuffle around them: their position is the position their tab will
// reappear in, and a drag the user made among the tabs they can see must not silently
// re-file the ones they can't. Returns a new list, or null when the drag is a no-op.
export function reorderVisibleRecents(list, { previewed, entry, toIndex, max = MAX_RECENTS } = {}) {
  if (!Number.isFinite(toIndex)) return null;
  const hidden = suppressedSet(previewed);
  const arr = Array.isArray(list) ? list : [];
  const slots = visibleIndices(arr, hidden, max);
  const from = slots.findIndex((i) => arr[i].id === entry?.id && arr[i].session === entry?.session);
  if (from === -1) return null;
  // Translate the insertion GAP into a final slot: removing the dragged tab first
  // shifts everything after it down one, so a gap past the source maps one lower.
  let to = toIndex > from ? toIndex - 1 : toIndex;
  to = Math.max(0, Math.min(slots.length - 1, to));
  if (to === from) return null;
  const moved = slots.map((i) => arr[i]);
  moved.splice(to, 0, moved.splice(from, 1)[0]);
  const out = [...arr];
  slots.forEach((slot, k) => { out[slot] = moved[k]; });
  return out;
}

// Owns the strip's half of the shared blob: the write guard, the change
// signature, and — critically — the rule that NOTHING MAY BE WRITTEN BEFORE THE
// FIRST READ.
//
// That rule exists because violating it silently destroys the user's data, and
// the SplitManager constructor violates it by default. addUnit() -> focus() ->
// _refreshToolbar() runs while recentWindows is still [], BEFORE _restoreRecents()
// gets to look at the store. An unguarded persist there writes an empty strip;
// StateStore.patchSection mutates the in-memory blob (and the localStorage cache)
// synchronously, so the restore that follows reads back the empty array it just
// wrote, and 400ms later the debounced flush pushes that emptiness to tmux —
// erasing a strip the user spent real time arranging. The symptom is "recents
// never restore", and it looks exactly like a restore that was never implemented.
//
// Reordering the constructor would fix today's instance, but the hazard is a
// lifecycle invariant, not a line number: any future early refresh reintroduces
// it. So the guard lives with the data, and this class is deliberately free of
// DOM/lit dependencies so `node --test` can drive the real boot order against it.
export class RecentsPersistence {
  // `store` is the StateStore singleton (only .section()/.patchSection() are used,
  // so a plain stub works in tests).
  // The bound is the HISTORY ceiling, not the tab cap — what is stored is the strip
  // AND its off-strip queue, and the cap is a property of the rendering client (it can
  // even differ mid-write between two browsers) rather than of the stored data.
  constructor(store, section = 'recentTabs', max = RECENTS_HISTORY_MAX) {
    this.store = store;
    this.sectionName = section;
    this.max = Math.max(1, Math.floor(Number(max) || RECENTS_HISTORY_MAX));
    this._sig = null;
    this._restored = false;
  }

  // Read the persisted strip. Until this has run, persist() is inert.
  restore() {
    const list = sanitizeRecents(this.store.section(this.sectionName).windows, this.max);
    this._sig = recentsSignature(list);
    this._restored = true;
    return list;
  }

  // Write the strip if it actually changed. Returns whether a write was issued —
  // callers ignore it, but it makes the guard's behavior assertable.
  //
  // TWO guards, for two versions of the same hazard. `_restored` covers the local
  // boot order described above. `store.loadedOnce` covers the SHARED one: until the
  // first layout push, everything this client holds came out of its own localStorage
  // cache, and on a browser opening for the first time that is nothing at all.
  // Writing then publishes an empty strip to every other browser on the tmux server
  // — same erasure as before, but from a client that never had the data. So no
  // section writes until the server's own answer (or its "I hold nothing") is in.
  //
  // The signature only advances on an ACCEPTED write: patchSection returns false
  // when the store swallows it (mid-apply), and recording the signature anyway would
  // remember the change as published and never write it again.
  persist(list) {
    if (!this._restored) return false;        // the invariant above
    if (!this.store.loadedOnce) return false; // …and the shared one
    const sig = recentsSignature(list);
    if (sig === this._sig) return false;    // unchanged: do not bump the blob's rev
    // Only the durable identity fields; active/disabled/working are per-render.
    const ok = this.store.patchSection(this.sectionName, {
      windows: (list || []).map((e) => ({
        id: e.id, index: e.index, name: e.name, session: e.session,
      })),
    });
    if (ok) this._sig = sig;
    return ok;
  }

  // Re-read after another client wrote. Returns the new list, or null when the
  // blob still matches what we hold (the echo of our own write, or an unrelated
  // section changing) so the caller can skip a pointless re-render.
  adopt() {
    const list = sanitizeRecents(this.store.section(this.sectionName).windows, this.max);
    const sig = recentsSignature(list);
    if (sig === this._sig) return null;
    this._sig = sig;
    return list;
  }
}

// ---- dragging a tab out of the strip ------------------------------------------
//
// A recents tab has always been draggable WITHIN the strip (reorder). Dropping one
// onto a terminal region is the other half of the same gesture — "put that window
// THERE" — and it is the only way to name a region other than the focused one with
// the pointer alone (see SplitManager.moveWindowTo).
//
// It rides a private MIME type rather than text/plain for two reasons. The regions
// have to decide in `dragover` whether they accept the drop, and `types` is the only
// thing readable that early — a text/plain drag from anywhere else (a link, a
// selection) would otherwise light every region up as a target. And a payload the
// browser considers plain text is one some other drop handler may decide to paste;
// a type nobody else claims can only ever be read by the code that wrote it.
export const RECENT_DRAG_TYPE = 'application/x-webtmux-recent';

// (session, window) is the pair a tab stands for — a window linked into two sessions
// earns a tab per session, and dropping one of them must land in the session it was
// dragged from. Newline-separated because a tmux session name may contain spaces (so
// the old space-joined key is ambiguous to split) but never a newline.
export function recentDragPayload(entry) {
  return `${(entry && entry.session) || ''}\n${(entry && entry.id) || ''}`;
}

// Total, like everything else that reads from outside: a payload that isn't one
// degrades to "not a recents drag" rather than to a move of window `undefined`.
export function parseRecentDrag(raw) {
  if (typeof raw !== 'string') return null;
  const nl = raw.indexOf('\n');
  if (nl < 0) return null;
  const id = raw.slice(nl + 1);
  return id ? { session: raw.slice(0, nl), id } : null;
}

// Is this drag one of ours? Asked by every region on every dragover, from `types`
// alone — see RECENT_DRAG_TYPE.
export function carriesRecentDrag(dt) {
  const types = dt && dt.types;
  if (!types) return false;
  return Array.prototype.includes.call(types, RECENT_DRAG_TYPE);
}
