// copyBuffers — the ONE live copy-buffer ring for the page, wired to the three
// things the pure ring (copy-buffers.js) deliberately knows nothing about: the
// system clipboard, per-tab persistence, and the components that redraw when it
// changes.
//
// A single module-level singleton, for the same reason stateStore is one: the
// custom elements construct themselves before any wiring could reach them, and
// the machine has ONE clipboard, so a per-region ring would mean several lists
// each claiming to describe it.
//
// WHICH STORE. Per-tab (ClientStore → sessionStorage), never the shared tmux blob:
//
//   • buffers are CONTENT, and @wt_state is written on a 400ms debounce and echoed
//     back inside every 500ms layout push — a copied scrollback would ride that
//     loop forever;
//   • @wt_state is server-global, so a copy would be readable by every browser on
//     the tmux server. Text you copied is not UI arrangement, and sharing it is
//     not a decision this feature gets to make on your behalf;
//   • the clipboard the ring mirrors is the BROWSER's, so a ring shared with a
//     browser that has a different clipboard would be describing something that
//     isn't there.
import { clientStore } from './client-store.js';
import { copyText } from './clipboard.js';
import { CopyBuffers } from './copy-buffers.js';

const SECTION = 'copyBuffers';

class CopyBufferStore {
  constructor() {
    this.ring = new CopyBuffers(clientStore.section(SECTION));
    this._subs = new Set();
  }

  // fn() on every change. Returns an unsubscribe, like writeAuthority.subscribe.
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  get entries() { return this.ring.entries; }
  get focusId() { return this.ring.focusId; }
  get focused() { return this.ring.focused; }
  get length() { return this.ring.length; }
  get pristine() { return this.ring.pristine; }
  get spent() { return this.ring.spent; }
  // How many entries actually hold something — what the toolbar counts. A ring
  // resting at one empty entry reports 0, so the badge stays off until there is
  // genuinely something to manage.
  get filled() { return this.ring.entries.filter((e) => e.text).length; }

  // A copy from anywhere in the app: ⌘C over an xterm selection, or tmux's own
  // copy arriving as OSC 52. Lands in the ring AND on the system clipboard, so
  // ⌘V (here or in any other app) pastes what was just copied — the ring changes
  // which text that is, never whether it happens.
  copy(text) {
    const entry = this.ring.copy(text);
    if (!entry) return null;
    copyText(entry.text);
    this._changed();
    return entry;
  }

  // A paste is about to happen with `text` — whatever the system clipboard just
  // handed us. Two things are settled here:
  //
  //   ADOPTION. If the clipboard no longer matches the focused entry, something
  //   outside webtmux copied (another tab, another app). That text is what the
  //   user last copied and what is about to be pasted, so it belongs in the list:
  //   without this the panel would confidently point at an entry that is NOT what
  //   ⌘V just delivered, which is worse than not having a panel at all.
  //
  //   SPENDING. The focused slot is marked pasted, so the NEXT copy reuses it
  //   rather than growing the list (see copy-buffers.js for the whole rule).
  //
  // Adoption does not re-write the clipboard: the text came FROM it.
  pasted(text) {
    const s = String(text ?? '');
    if (s && s !== this.ring.text) this.ring.copy(s);
    this.ring.notePaste();
    this._changed();
  }

  // Focus an entry — and put it on the system clipboard, which is what makes
  // "copy/paste operate on the focused buffer" true rather than merely claimed.
  focus(id) {
    const entry = this.ring.focus(id);
    if (!entry) return null;
    if (entry.text) copyText(entry.text);
    this._changed();
    return entry;
  }

  // ↑/↓ in the panel. Same commit as a click: the row you land on goes to the
  // clipboard immediately, so there is no separate "and now press Enter" step to
  // forget before switching to the window you meant to paste into.
  step(delta) {
    // null = the arrow ran off the end of the list, so nothing moved and nothing
    // is written to the clipboard or persisted.
    const entry = this.ring.step(delta);
    if (!entry) return null;
    if (entry.text) copyText(entry.text);
    this._changed();
    return entry;
  }

  add() {
    const entry = this.ring.add();
    this._changed();
    return entry;
  }

  remove(id) {
    const entry = this.ring.remove(id);
    // Removing the focused row moves the focus, and the focus is the clipboard.
    if (entry?.text) copyText(entry.text);
    this._changed();
    return entry;
  }

  clear() {
    const entry = this.ring.clear();
    this._changed();
    return entry;
  }

  _changed() {
    // Best-effort persistence: a ring too big for the tab store simply loses its
    // largest entries on the next reload (ClientStore swallows a quota failure),
    // which is why toJSON drops whole entries rather than trimming them.
    try { clientStore.patchSection(SECTION, this.ring.toJSON()); } catch (e) { /* best-effort */ }
    for (const fn of this._subs) { try { fn(); } catch (e) { /* a bad subscriber is not the ring's problem */ } }
  }
}

export const copyBuffers = new CopyBufferStore();
