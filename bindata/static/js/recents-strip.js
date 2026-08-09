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

// Tab slots in the strip, by DEFAULT. The strip is a glance-able switcher, not a
// history: past ~5 the tabs stop being distinguishable at a glance and the Exposé is
// the better tool. noteAccess evicts the least-recently-accessed slot to stay within
// whatever the current cap is.
//
// It is only a default because "how many windows do I flip between" is a property of
// the user's workspace, not of the widget: on a wide monitor with a dozen live agents
// five tabs is an overflow arrow that never goes away. The cap is settable from the
// "Recent ▾" menu and rides the shared blob (toolbar.recentMax) like the other strip
// prefs, so every browser on this tmux server keeps the same strip.
export const MAX_RECENTS = 5;

// Bounds for the settable cap. The floor is 1 rather than 0 because a strip with no
// slots is not a smaller strip, it's a removed feature with no way back — the "Recent"
// label (and so the menu that would restore it) only renders when a tab exists. The
// ceiling is where the tabs stop fitting any plausible toolbar and the Exposé is
// unambiguously the better tool.
export const RECENTS_MIN = 1;
export const RECENTS_MAX = 20;

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
export function sanitizeRecents(raw, max = MAX_RECENTS) {
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

// The entries that actually render as tabs, in strip order.
export function visibleRecents(list, previewed) {
  const hidden = suppressedSet(previewed);
  return (Array.isArray(list) ? list : []).filter((e) => e && !hidden.has(e.id));
}

// Where a NEW entry goes when the strip is full. Returns -1 for "there is room,
// append"; otherwise the index of the entry it replaces IN PLACE (which is what
// keeps the strip's order stable — a new tab inherits the evicted tab's slot).
//
// The cap counts TABS, not entries: an entry whose window is in the preview draws
// nothing, so letting it hold a slot against the cap would shrink the visible strip
// every time the user previews something — the same wasted space, just relocated.
// For the same reason the eviction scan skips suppressed entries: replacing one
// frees no space, and it would quietly destroy the tab that is waiting to come back
// when the preview lets go.
//
// `recency` maps an entry to its access sequence (higher = more recent); the caller
// owns that store (captureCache.accessed), this module only ranks with it.
export function recentsInsertSlot(list, { previewed, max = MAX_RECENTS, recency = () => 0 } = {}) {
  const hidden = suppressedSet(previewed);
  const arr = Array.isArray(list) ? list : [];
  const visible = arr.filter((e) => e && !hidden.has(e.id));
  if (visible.length < max) return -1;
  // visible.length >= max >= 1, so there is always a visible entry to evict here.
  let slot = -1;
  let lru = Infinity;
  arr.forEach((e, i) => {
    if (!e || hidden.has(e.id)) return;
    const seq = recency(e);
    if (seq < lru) { lru = seq; slot = i; }
  });
  return slot;
}

// Bring the strip back within its cap, counting only the entries that render.
//
// The overflow this exists for is the preview HANDING WINDOWS BACK: while three
// tabs were suppressed the strip refilled to its cap with useful windows, and
// closing the preview returns three more. Trimming is deliberately NOT done at that
// moment — tabs vanishing as a side effect of closing a preview is exactly the kind
// of behind-your-back destruction the strip's stable order exists to avoid. It
// happens on the next ACCESS instead, where losing the least-recently-used tab is
// the rule the strip has always followed and the user is already causing churn.
//
// Suppressed entries are never trimmed: they cost no space and are not the user's
// to lose yet.
export function trimRecentsToCap(list, { previewed, max = MAX_RECENTS, recency = () => 0 } = {}) {
  const hidden = suppressedSet(previewed);
  const arr = Array.isArray(list) ? list : [];
  const visible = arr.filter((e) => e && !hidden.has(e.id));
  if (visible.length <= max) return arr;
  const keep = new Set(
    [...visible].sort((a, b) => recency(b) - recency(a)).slice(0, max),
  );
  // Filter, don't re-sort: survivors keep the order the user arranged by hand.
  return arr.filter((e) => e && (hidden.has(e.id) || keep.has(e)));
}

// Drag-reorder in VISIBLE coordinates. The toolbar hands back an insertion gap into
// the tabs it drew, which is the strip with the suppressed entries taken out, so the
// move is computed there and then written back through the durable list.
//
// Suppressed entries hold their durable slots while the visible ones shuffle around
// them: their position is the position their tab will reappear in, and a drag the
// user made among the tabs they can see must not silently re-file the tabs they
// can't. Returns a new list, or null when the drag is a no-op.
export function reorderVisibleRecents(list, { previewed, entry, toIndex } = {}) {
  if (!Number.isFinite(toIndex)) return null;
  const hidden = suppressedSet(previewed);
  const arr = Array.isArray(list) ? list : [];
  const visible = arr.filter((e) => e && !hidden.has(e.id));
  const from = visible.findIndex((e) => e.id === entry?.id && e.session === entry?.session);
  if (from === -1) return null;
  // Translate the insertion GAP into a final slot: removing the dragged tab first
  // shifts everything after it down one, so a gap past the source maps one lower.
  let to = toIndex > from ? toIndex - 1 : toIndex;
  to = Math.max(0, Math.min(visible.length - 1, to));
  if (to === from) return null;
  const moved = [...visible];
  moved.splice(to, 0, moved.splice(from, 1)[0]);
  let k = 0;
  return arr.map((e) => (e && !hidden.has(e.id) ? moved[k++] : e));
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
  constructor(store, section = 'recentTabs', max = MAX_RECENTS) {
    this.store = store;
    this.sectionName = section;
    this.max = clampRecentsMax(max);
    this._sig = null;
    this._restored = false;
  }

  // Change the cap future reads are truncated to. Does NOT touch what the caller is
  // already holding — SplitManager owns the live list and trims it by recency, which
  // is information this module doesn't have.
  setMax(max) {
    this.max = clampRecentsMax(max);
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
