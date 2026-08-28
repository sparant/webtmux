// Encoders for the tmux control messages whose payload is STRUCTURED — more than
// one field packed into a single string. Import-free on purpose: the wire format
// is a contract with the Go server (webtty/tmux.go), and a contract deserves a
// test that can run without a browser or an xterm.
//
// The general rule for these payloads is the same one the server's tmux -F formats
// follow: machine-shaped fields (window ids "@N", integers) go FIRST and are split
// off one at a time, and the single user-typed string goes LAST so a space in it
// cannot be mistaken for a delimiter. Where TWO user-typed strings must ride in
// one payload, the rule can't apply and an explicit separator is needed instead.

// The separator for payloads carrying two user-typed strings. tmux forbids NUL in
// a session or window name, so it is the one byte neither half can contain.
export const FIELD_SEP = '\x00';

// Rename-session is the one payload with a user-typed string in FRONT. Splitting
// it on the first space took "my" as the target of a session called "my project"
// — and the server resolves a session target by name, so that renamed a DIFFERENT
// session (tmux matches a target prefix) with no error anywhere.
export function renameSessionPayload(oldName, newName) {
  return String(oldName) + FIELD_SEP + String(newName);
}

// The server's half of the same contract, so a test can state the round trip
// rather than restate the encoding. Returns null for a payload with no separator,
// which is exactly what the server drops.
export function parseRenameSessionPayload(payload) {
  const s = String(payload);
  const i = s.indexOf(FIELD_SEP);
  if (i < 0) return null;
  return { oldName: s.slice(0, i), newName: s.slice(i + 1) };
}

// Set-session-menu carries a session name (which may contain spaces) followed by
// the whole new-window menu as JSON. Same separator as rename-session, for the same
// reason — the first half is user-typed, so there is no first-space rule.
//
// JSON for the menu, not a delimited string: its entries are arbitrary command
// lines, and every single-byte delimiter is one somebody's pipeline or loop needs.
// (The server re-encodes it before storing — see pkg/tmux/newcmds.go for why '$'
// and '|' cannot survive a tmux option as themselves. That is a storage concern,
// not a wire one, so nothing here escapes anything.)
export function sessionCmdsPayload(session, cmds) {
  return String(session) + FIELD_SEP + JSON.stringify(cmds || []);
}

// The server's half of that contract. Returns null for a payload with no
// separator, which is exactly what the server drops — and it must drop it, since
// reading a separator-less payload as "this whole thing is a session name, with an
// empty menu" would silently CLEAR a session's menu.
export function parseSessionCmdsPayload(payload) {
  const s = String(payload);
  const i = s.indexOf(FIELD_SEP);
  if (i < 0) return null;
  const raw = s.slice(i + 1);
  let cmds = null;
  try { cmds = JSON.parse(raw || '[]'); } catch (e) { return null; }
  if (!Array.isArray(cmds)) return null;
  return { session: s.slice(0, i), cmds };
}

// New-window carries the menu INDEX first and the session last: the index is
// machine-shaped and the session name is user-arbitrary, which is the rule every
// payload here follows. An empty session means the pane's own.
export function newWindowPayload(session, menu) {
  const i = Number(menu) || 0;
  return String(i) + ' ' + String(session || '');
}
