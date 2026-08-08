// CopyBuffers — the ring of named-by-content copy buffers behind "copy several
// things, then paste them one at a time".
//
// THE PROBLEM. A system clipboard holds exactly one thing, so gathering three
// snippets out of a scrollback means three round trips: copy, switch, paste,
// switch back, copy, … Every intermediate copy destroys the last one, and the
// destruction is silent — there is nothing on screen that says the text you
// copied a minute ago is gone.
//
// THE MODEL. A LIST of buffers with exactly one FOCUSED entry, and one rule that
// ties it to the machine's single clipboard:
//
//     THE FOCUSED ENTRY IS WHAT THE SYSTEM CLIPBOARD HOLDS.
//
// Focusing an entry writes it to the clipboard (the store does that half — this
// module is pure), so "copy/paste operate on the focused buffer" is not a second
// clipboard fighting the real one: it is a way to CHOOSE what the real one holds.
// ⌘V keeps working, in every app, with no webtmux involvement at all.
//
// WHEN DOES A COPY APPEND RATHER THAN OVERWRITE? This is the whole design, and
// it is answered by one flag — has the focused entry been PASTED since it was
// filled?
//
//   • not yet pasted  -> you are gathering. The next copy APPENDS a new entry and
//     focuses it, so nothing you collected is destroyed.
//   • already pasted  -> that entry has done its job. The next copy REUSES the
//     slot, so the ordinary copy-paste-copy-paste rhythm never grows the list and
//     the panel stays a single row for people who don't want this feature at all.
//
// That is why the list is not simply "the last N copies": a history would fill up
// with junk from normal use, and the entry you cared about would scroll out of it.
// Here the list only grows when you are demonstrably accumulating.
//
// Import-free on purpose (like mru-order.js / work-alerts.js): the ring is where
// every rule that can be got subtly wrong lives, so it has to load under
// `node --test` without a DOM. The clipboard, persistence and the panel are all
// somebody else's file — see copy-buffer-store.js and components/copy-sidebar.js.

// How much of an entry's text a row shows before it is cut with an ellipsis. Wide
// enough to tell two shell commands apart, short enough that a row stays one line.
export const PREVIEW_CHARS = 72;

// Total characters of buffer text kept across a reload. Buffers are content, and
// content has no bound — a copied scrollback is megabytes — while the per-tab
// store it persists into is a few. Entries beyond the budget are DROPPED WHOLE;
// see toJSON for why nothing is ever truncated.
export const PERSIST_BUDGET = 256 * 1024;

// One-line label for a buffer: its text with every run of whitespace collapsed to
// a single space, cut to `max` with an ellipsis when there is more. The collapse
// is what makes a multi-line copy identifiable at a glance — the alternative,
// showing the raw first line, hides a 200-line block behind whatever its first
// line happens to be (often blank, or a bare `{`).
//
// Because the collapse can hide how BIG a buffer is, callers pair this with
// entryMeta() below rather than showing the preview alone.
export function previewText(text, max = PREVIEW_CHARS) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max).trimEnd() + '…';
}

// The size of a buffer, for the dim second line of a row: "3 lines · 412 chars".
// Returned as parts rather than a string so the component decides the wording.
// A single short line reports `lines: 1`, and the row hides the meta then — the
// preview already IS the whole buffer, and repeating its length is noise.
export function entryMeta(text, max = PREVIEW_CHARS) {
  const s = String(text ?? '');
  if (!s) return { lines: 0, chars: 0, whole: true };
  const lines = s.split('\n').length;
  // `whole` = the preview already shows everything there is, so a row can skip the
  // meta. One line that fits is the only case where that is true.
  const whole = lines === 1 && s.trim().length <= max;
  return { lines, chars: s.length, whole };
}

// Is this entry still waiting to be filled? The list always holds at least one
// entry, so the resting state of a ring nobody has used is a single empty one.
export function isEmptyEntry(entry) {
  return !entry || !entry.text;
}

export class CopyBuffers {
  // `init` is a toJSON() blob (or nothing, for a fresh ring). Anything malformed
  // reads as "a fresh ring" rather than throwing: this is restored from a browser
  // store on boot, and a bad blob must not take the whole page down with it.
  constructor(init = {}) {
    const raw = (init && Array.isArray(init.entries)) ? init.entries : [];
    this._seq = Number.isFinite(init?.seq) && init.seq > 0 ? Math.floor(init.seq) : 0;
    this._entries = [];
    for (const e of raw) {
      if (!e || typeof e.text !== 'string') continue;
      this._entries.push({ id: this._nextId(e.id), text: e.text });
    }
    if (!this._entries.length) this._entries.push({ id: this._nextId(), text: '' });
    const wanted = typeof init?.focus === 'string' ? init.focus : '';
    this._focus = this._entries.some((e) => e.id === wanted) ? wanted : this._entries[0].id;
    // Has the focused entry already been pasted (so a copy may reuse its slot)?
    // Deliberately NOT persisted: after a reload nobody can say whether the text
    // still sitting there was used, and the safe answer — treat it as unspent, so
    // the next copy appends — loses nothing, while the other one loses a buffer.
    this._spent = false;
  }

  // Ids are per-ring and stable across a reload (they key the DOM rows and the
  // focus pointer). A restored id is honored so the persisted focus still resolves;
  // the sequence is bumped past it so a new entry can never collide with an old one.
  _nextId(restored = '') {
    const m = /^b(\d+)$/.exec(String(restored || ''));
    if (m) {
      const n = Number(m[1]);
      if (n > this._seq) this._seq = n;
      return restored;
    }
    this._seq += 1;
    return 'b' + this._seq;
  }

  get entries() { return this._entries; }
  get focusId() { return this._focus; }
  get focused() { return this._entries.find((e) => e.id === this._focus) || null; }
  get length() { return this._entries.length; }
  // The text a paste should deliver: whatever the focused entry holds.
  get text() { return this.focused?.text || ''; }
  // Is this ring in its resting state (one entry, nothing in it)? The panel uses
  // it to grey out Clear, which would otherwise offer to destroy nothing.
  get pristine() { return this._entries.length === 1 && isEmptyEntry(this._entries[0]); }

  _indexOf(id) {
    const i = this._entries.findIndex((e) => e.id === id);
    return i === -1 ? this._entries.length - 1 : i;
  }

  // Record a copy. Returns the entry it landed in, or null when there was nothing
  // to record.
  //
  // The DUPLICATE GUARD is not a nicety. One user-visible copy can reach here
  // twice: ⌘C in the browser copies the xterm selection, and tmux's own copy (a
  // mouse drag in copy mode, or `y`) arrives moments later as an OSC 52 sequence
  // carrying the same text. Without the guard, half the copies in this app would
  // silently produce two identical entries.
  copy(raw) {
    const text = String(raw ?? '');
    if (!text) return null;
    const cur = this.focused;
    if (cur && cur.text === text) {
      // The same copy arriving twice — or a re-copy of what is already focused.
      // Either way this is not new material, so the slot stops being spent (the
      // user just asserted they want this text) but the list does not grow.
      this._spent = false;
      return cur;
    }
    if (cur && (isEmptyEntry(cur) || this._spent)) {
      cur.text = text;
      this._spent = false;
      return cur;
    }
    // Gathering: keep what is there and start a new entry NEXT TO it, so a run of
    // copies reads down the list in the order it was made — which is the order it
    // will be pasted back out in.
    const entry = { id: this._nextId(), text };
    this._entries.splice(this._indexOf(this._focus) + 1, 0, entry);
    this._focus = entry.id;
    this._spent = false;
    return entry;
  }

  // A paste happened from the focused entry: its slot is now reusable. This is the
  // single input to the append-vs-overwrite rule at the top of this file.
  notePaste() {
    this._spent = true;
  }

  // Has the focused slot been pasted from (so the next copy would reuse it)? Read
  // by the panel to explain, on the row itself, what the next copy will do.
  get spent() { return this._spent; }

  // Focus an entry. Deliberately clears `spent`: picking an entry out of the list
  // by hand is a statement that it matters, and letting the next copy overwrite
  // the thing you just reached for would be the one destructive surprise this
  // whole feature exists to remove.
  focus(id) {
    if (!this._entries.some((e) => e.id === id)) return null;
    this._focus = id;
    this._spent = false;
    return this.focused;
  }

  // Step the focus by `delta` rows (↑/↓ in the panel). Clamped, not wrapped: the
  // list is short and on screen, and wrapping from the last row round to the first
  // would silently change what ⌘V pastes when an arrow key overshoots.
  //
  // A step off either end returns null and does nothing at all — not even the
  // un-spending focus() does — so holding ↓ at the bottom of the list cannot
  // quietly change what the next copy will do to the row you are sitting on.
  step(delta) {
    const i = this._indexOf(this._focus);
    const next = Math.max(0, Math.min(this._entries.length - 1, i + delta));
    if (next === i) return null;
    return this.focus(this._entries[next].id);
  }

  // The "+" button: an empty entry, focused, waiting for the next copy. Adding a
  // SECOND empty entry is refused — two blank rows are indistinguishable, and the
  // one already focused is exactly what the button was going to produce.
  add() {
    const cur = this.focused;
    if (cur && isEmptyEntry(cur)) return cur;
    const entry = { id: this._nextId(), text: '' };
    this._entries.splice(this._indexOf(this._focus) + 1, 0, entry);
    this._focus = entry.id;
    this._spent = false;
    return entry;
  }

  // Drop one entry (a row's ×). The list can never become empty — a ring with no
  // entries has nowhere to put the next copy — so removing the last one leaves a
  // fresh empty entry behind instead.
  remove(id) {
    const i = this._entries.findIndex((e) => e.id === id);
    if (i === -1) return null;
    this._entries.splice(i, 1);
    if (!this._entries.length) this._entries.push({ id: this._nextId(), text: '' });
    if (!this._entries.some((e) => e.id === this._focus)) {
      // Focus the row that slid into the gap, or the last one if we removed the
      // tail — the same place a list cursor lands anywhere else.
      this._focus = this._entries[Math.min(i, this._entries.length - 1)].id;
      this._spent = false;
    }
    return this.focused;
  }

  // The "clear" button: everything goes except the FOCUSED entry.
  //
  // Which one survives is not arbitrary. The focused entry is the one the system
  // clipboard holds, so keeping it means clearing the list changes what is in the
  // panel and nothing about what ⌘V will paste. Keeping "the newest" or "a fresh
  // empty one" instead would leave the clipboard holding text that is no longer
  // anywhere on screen — the exact desync this feature exists to prevent.
  clear() {
    const keep = this.focused || this._entries[0];
    this._entries = [keep];
    this._focus = keep.id;
    return keep;
  }

  // Persistable shape, within a character budget.
  //
  // Entries are dropped WHOLE. Truncating one to make it fit would leave a buffer
  // that still looks complete in the panel and pastes half a command into a shell
  // — a silent corruption of the one thing this module is trusted with. The
  // focused entry is always kept, whatever its size, because it is what the
  // clipboard holds; the rest are kept in list order while they fit.
  toJSON({ budget = PERSIST_BUDGET } = {}) {
    const keep = new Set();
    const focused = this.focused;
    let used = 0;
    if (focused) { keep.add(focused.id); used += focused.text.length; }
    for (const e of this._entries) {
      if (keep.has(e.id)) continue;
      if (used + e.text.length > budget) continue;
      keep.add(e.id);
      used += e.text.length;
    }
    return {
      seq: this._seq,
      focus: this._focus,
      entries: this._entries.filter((e) => keep.has(e.id)).map((e) => ({ id: e.id, text: e.text })),
    };
  }
}
