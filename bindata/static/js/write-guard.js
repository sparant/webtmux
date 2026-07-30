// Client-side mirror of the server's write-authority matrix (webtty/authority.go).
//
// A server started without `-w` refuses every message that mutates the tmux
// server or the filesystem. It says so once, at connect time, in the preferences
// frame (`permitWrite`). This module is what the browser does with that answer:
//
//   • classify() is the SAME matrix as the server's, so the UI's idea of what is
//     forbidden cannot drift from what is actually enforced;
//   • writeAuthority is the one flag every component reads, so "read-only" is
//     decided in one place rather than inferred in six;
//   • TerminalUnit.sendMessage consults it and refuses locally, which turns a
//     silently-dropped frame into a visible, explained no-op.
//
// The refusal is enforced on BOTH sides on purpose. The server's gate is the
// security boundary — a hostile client simply does not get the flag. This one is
// the honesty boundary: without it a read-only browser sends commands into a void
// and paints an optimistic UI describing a tmux server that never changed.

// Message types, as terminal-unit.js's MSG. Duplicated (not imported) because
// terminal-unit.js imports THIS module, and because the pair of tables is the
// thing worth reading side by side.
export const MSG_INPUT = '1';
export const MSG_PING = '2';
export const MSG_RESIZE = '3';
export const MSG_SET_ENCODING = '4';

export const MSG_CAPTURE_REQUEST = 'G';
export const MSG_SAVE_INFO_REQUEST = 'R';
export const MSG_REFRESH = 'Q';

// Everything a read-only connection may send: it changes nothing another client
// can observe. Note what is NOT here — selecting a window moves the window every
// other client attached to that session is looking at, so it is a write.
export const VIEW_ONLY = new Set([
  MSG_PING,
  MSG_RESIZE,
  MSG_SET_ENCODING,
  MSG_CAPTURE_REQUEST,
  MSG_SAVE_INFO_REQUEST,
  MSG_REFRESH,
]);

// Does this message type need `-w`? Unknown types fail CLOSED, matching the
// server: a control nobody classified should do nothing, not everything.
export function requiresWrite(type) {
  return !VIEW_ONLY.has(type);
}

// The one-line explanation shown when a control is refused. Names the flag,
// because the person reading it is often also the person who started the server.
export const READ_ONLY_NOTICE =
  'This webtmux server is read-only — it was started without -w, so it will not change anything in tmux.';

// The shared flag. A module-level singleton for the same reason stateStore is
// one: the custom elements construct themselves before any wiring could reach
// them, so the only thing they can read at boot is an import.
class WriteAuthority {
  constructor() {
    // Optimistic until the handshake says otherwise: the preferences frame arrives
    // within a few ms of connect, and assuming read-only until then would flash
    // every control greyed on every page load.
    this._permitWrite = true;
    this._known = false;
    this._subs = new Set();
  }

  get permitWrite() { return this._permitWrite; }
  get readOnly() { return !this._permitWrite; }
  // Has the server actually told us? Lets a caller distinguish "allowed" from
  // "not asked yet" without a second flag.
  get known() { return this._known; }

  // Called from the SetPreferences handler. Idempotent; only a CHANGE notifies.
  set(permitWrite) {
    const next = permitWrite !== false;
    const changed = this._known === false || next !== this._permitWrite;
    this._permitWrite = next;
    this._known = true;
    if (changed) for (const fn of this._subs) { try { fn(next); } catch (e) {} }
  }

  // fn(permitWrite) on every change; fires immediately if the answer is in.
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._subs.add(fn);
    if (this._known) { try { fn(this._permitWrite); } catch (e) {} }
    return () => this._subs.delete(fn);
  }

  // May this message go out? The question sendMessage asks.
  allows(type) {
    return this._permitWrite || !requiresWrite(type);
  }
}

export const writeAuthority = new WriteAuthority();
