// trimPastedName — turn a pasted PATH into a window name.
//
// Renaming a window is very often "call it after the thing I am working on", and the
// thing is on the clipboard as a path you just copied out of a file tree, a grep hit,
// or a plan filename: `webtmux/plan-webtmux-portable-deps.md`. The name you want is
// `plan-webtmux-portable-deps` — the basename, without the extension — and trimming it
// by hand in a five-character-wide inline input is enough friction to make people keep
// the ugly name instead.
//
// So a paste into the rename input is trimmed: everything after the last `/`, minus a
// trailing extension.
//
// WHAT IT DELIBERATELY DOES NOT DO. It never touches typed text — only the paste path
// runs through here, so the transformation is always attached to an action the user
// just took and can undo by editing. And it is conservative about what counts as an
// extension (see below), because a window name legitimately contains dots
// (`v1.2.3`, `api.staging`) and silently eating `.3` would be worse than leaving `.md`.
//
// Import-free so `node --test` can load it (the sidebar component that calls it
// imports lit and cannot).

// Longest trailing run still treated as a file extension. `.md`, `.json`, `.tsx`,
// `.yaml` are extensions; `.staging` is part of a name. Five is the line because it
// covers essentially every real suffix while leaving ordinary dotted words alone — and
// when it guesses wrong the cost is a name with a suffix in it, not a name with a word
// missing.
const MAX_EXT = 5;

// The trailing `.ext` matcher: a dot, then 1..MAX_EXT LETTERS, at the very end.
//
// Letters only, no digits, and that is the whole rule that keeps `v1.2.3` intact — a
// version's last component is indistinguishable from a short extension by length, so
// the only signal left is that extensions are words. The cost is that a genuinely
// numeric suffix (`capture.mp4`) is left on the name; that is the right way round,
// because a name with `.mp4` on it is untidy while a name that lost its version is
// wrong. Requires a character BEFORE the dot (enforced by the dotfile check below) so
// `.zshrc` keeps its identity.
const EXT_RE = new RegExp(`\\.[A-Za-z]{1,${MAX_EXT}}$`);

export function trimPastedName(text) {
  // A paste can carry newlines and runs of whitespace (a line out of a terminal, two
  // cells out of a table). A window name is one line, so collapse first — otherwise
  // the trailing-slash and extension logic below reasons about the wrong end of a
  // multi-line blob.
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!flat) return '';

  // Trailing slashes are how a directory is written, and `webtmux/` means the same
  // thing as `webtmux`. Strip them before taking the basename or the basename is ''.
  const noTrail = flat.replace(/\/+$/, '');
  const cut = noTrail.lastIndexOf('/');
  const base = cut === -1 ? noTrail : noTrail.slice(cut + 1);
  if (!base) return '';

  // A dotfile (`.zshrc`, `.gitignore`) is all extension and no stem: stripping it
  // would leave nothing, and the name you want is the whole thing anyway.
  if (base.startsWith('.')) return base;

  const stem = base.replace(EXT_RE, '');
  // `.md` on its own, or any strip that would empty the field, keeps the original.
  // An empty rename is discarded by the caller, so producing one turns a paste into
  // a silent no-op.
  return stem || base;
}
