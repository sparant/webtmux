// Recents-strip persistence helpers — the pure, testable half of keeping the
// toolbar's recent-window tabs in the shared @wt_state blob.
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

// Tab slots in the strip. The strip is a glance-able switcher, not a history: past
// ~5 the tabs stop being distinguishable at a glance and the Exposé is the better
// tool. noteAccess evicts the least-recently-accessed slot to stay within this.
export const MAX_RECENTS = 5;

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
