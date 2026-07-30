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
