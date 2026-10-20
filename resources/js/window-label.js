// The SHORT name a window goes by on a small surface — a recents tab, a preview
// tile's label strip. Shaped by the two "Labels" toggles under the toolbar's
// Recent ▾ menu, which ride the shared 'toolbar' state section.
//
// One function for both surfaces, because they label the same windows side by side:
// with "Trim name" on, a tab reading "web-01" above a tile reading "ssh web-01" is the
// same window under two names, and the whole point of the toggle is that you picked
// one. (The FULL "session — window N: name" is what every hover hint says, whatever
// these are set to — see windowTitle below.)
//
// Pure — no DOM, no lit — so it is unit-tested under node (test/window-label.test.mjs).

// Two INDEPENDENT toggles rather than one four-way cycle, because they answer
// unrelated questions: "which session is this in" and "how much of the name do I
// need". Defaults are the quiet ones — most windows live in the session you're
// already in, and long names are usually "<tool> <what>", where the leading word is
// the part you already know.
export const LABEL_DEFAULTS = { showSession: false, trimName: true };

// The prefs as stored in the 'toolbar' section (recentShowSession/recentTrimName —
// named for where the menu lives). Absent = default; anything but `true` = off.
export function labelPrefs(toolbarSection) {
  const t = toolbarSection || {};
  return {
    showSession: t.recentShowSession === undefined
      ? LABEL_DEFAULTS.showSession : t.recentShowSession === true,
    trimName: t.recentTrimName === undefined
      ? LABEL_DEFAULTS.trimName : t.recentTrimName === true,
  };
}

// Drop everything up to and including the first space: "ssh web-01" reads
// as "web-01". A name with no space is left alone (there's nothing redundant
// to remove), and a name that is ALL prefix ("ssh ") keeps the original rather
// than collapsing to nothing.
export function trimWindowName(name) {
  const s = String(name || '');
  const i = s.indexOf(' ');
  if (i < 0) return s;
  const tail = s.slice(i + 1).trim();
  return tail || s;
}

// The label text under `prefs`: the (maybe trimmed) name, with "session: " in front
// when the session is shown. The window INDEX is not part of it — both surfaces draw
// that as its own, differently-coloured span in front.
export function windowLabel(w, prefs = LABEL_DEFAULTS) {
  const name = prefs.trimName ? trimWindowName(w?.name) : (w?.name || 'bash');
  return prefs.showSession && w?.session ? `${w.session}: ${name}` : name;
}

// The FULL name of a window — "session — window N: name" — the one way every hover
// hint and every split view's header names a window, so the same window reads the
// same wherever you point at it.
export function windowTitle(session, index, name) {
  const win = `window ${index == null || index === '' ? '' : `${index}: `}${name || ''}`;
  return session ? `${session} — ${win}` : win;
}
