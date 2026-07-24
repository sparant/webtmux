// Shared type-ahead matching, used by BOTH the sidebar (single-select window
// type-ahead) and the Exposé overlay (filter which windows are shown) so the two
// behave identically. A search phrase is a list of space-separated WORDS; a
// candidate matches when EVERY non-empty word is a substring of its (lowercased)
// haystack. So "cla" matches "claude-1", and "cla 2" matches only a haystack that
// contains both "cla" and "2". An empty phrase (no words, or only empty ones)
// matches everything.
export function matchesWords(hay, words) {
  const terms = (words || []).filter((w) => w !== '');
  if (terms.length === 0) return true;
  const h = String(hay).toLowerCase();
  return terms.every((t) => h.includes(t));
}

// Grow a words array by one typed character, mirroring the sidebar's rules: a
// space starts a new (empty) word without stacking empties; any other character
// is appended (lowercased) to the current word. Returns a NEW array (never
// mutates the input). Backspace/reset are handled by the callers.
export function appendChar(words, ch) {
  const out = (words || []).slice();
  if (ch === ' ') {
    if (out.length === 0 || out[out.length - 1] !== '') out.push('');
    return out;
  }
  if (out.length === 0) out.push('');
  out[out.length - 1] += ch.toLowerCase();
  return out;
}

// Remove the last typed character (Backspace): trims a char off the current word,
// and when that empties a non-first word, drops the empty so the previous word
// becomes current again. Returns a NEW array.
export function backspace(words) {
  const out = (words || []).slice();
  if (out.length === 0) return out;
  let last = out[out.length - 1];
  if (last.length > 0) {
    out[out.length - 1] = last.slice(0, -1);
  } else if (out.length > 1) {
    out.pop();
  }
  // Drop a now-empty trailing word so the phrase collapses cleanly to '' when done.
  if (out.length === 1 && out[0] === '') return [];
  return out;
}

// Display form of a words phrase (what the user has typed), e.g. ['cla','2'] →
// "cla 2". A trailing empty word (just after a space) renders as a trailing space.
export function phraseText(words) {
  return (words || []).join(' ');
}
