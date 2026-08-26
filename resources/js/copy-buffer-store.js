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
    // Did the LAST write to the system clipboard actually land? Not a formality.
    // A browser is allowed to refuse navigator.clipboard.writeText outside a user
    // gesture, and every copy that arrives from the terminal — tmux's own yank, a
    // program's "(c to copy)" — is by definition not one: nobody clicked anything
    // in the page. Firefox refuses those outright, Safari wants a gesture, and
    // Chrome wants the tab focused. When the write is refused the text is still in
    // the ring, so nothing is lost — but the panel's green "this is on the
    // clipboard" dot would be a lie, and ⌘V would paste something else entirely
    // with nothing on screen to explain why.
    //
    // Starts null = "no clipboard write has been attempted", which is neither ok
    // nor refused and is what an untouched ring should report.
    this.clipboardOk = null;
    // The text the last ATTEMPT was for, so a stale refusal from an entry you have
    // since moved off does not colour the row you are on now.
    this._clipboardFor = '';
  }

  // Put `text` on the system clipboard and remember whether it worked. Every
  // clipboard write in this file goes through here so that "the focused entry is
  // what the clipboard holds" is a checked claim rather than an assumption.
  //
  // `reason` is passed on so subscribers redrawing after a refusal know it was a
  // clipboard outcome and not a fresh change to the ring.
  _toClipboard(text, reason) {
    const want = String(text ?? '');
    this._clipboardFor = want;
    // Optimistic: assume it lands, correct it if it does not. Waiting for the
    // promise before drawing would make every copy flicker through "not on the
    // clipboard" on the way to being on it.
    this.clipboardOk = true;
    copyText(want).then((ok) => {
      // A later copy has already moved on — its own attempt owns the flag now.
      if (this._clipboardFor !== want) return;
      if (ok) return;
      this.clipboardOk = false;
      this._notify(reason);
    }).catch(() => {
      if (this._clipboardFor !== want) return;
      this.clipboardOk = false;
      this._notify(reason);
    });
  }

  // Re-try the write for the focused entry from inside a real user gesture (the
  // copy panel's "put it on the clipboard" affordance). This is the recovery for
  // every browser that refuses an unsolicited write: the text was never lost, it
  // just needs a click to cross the last inch. Returns the promise so the caller
  // can report the outcome.
  async retryClipboard() {
    const entry = this.ring.focused;
    if (!entry?.text) return false;
    this._clipboardFor = entry.text;
    const ok = await copyText(entry.text);
    if (this._clipboardFor !== entry.text) return ok;
    this.clipboardOk = !!ok;
    this._notify('clipboard');
    return !!ok;
  }

  // fn(reason) on every change, where `reason` names WHAT happened — 'copy',
  // 'paste', 'focus', 'add', 'remove', 'clear', and 'clipboard' for a change to
  // whether the system clipboard actually took the text. Most subscribers just
  // redraw and ignore it; the panel needs it because a COPY is the one change that
  // happened somewhere else entirely (a pane, with the panel closed) and is
  // therefore the one worth announcing. Returns an unsubscribe, like
  // writeAuthority.subscribe.
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
    this._toClipboard(entry.text, 'copy');
    this._changed('copy');
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
    // A paste is PROOF about the clipboard: the browser just handed us what it
    // holds, and after adoption the focused entry is that text. Whatever an
    // earlier refused write left the flag saying, it is settled now.
    if (s) { this._clipboardFor = this.ring.text; this.clipboardOk = true; }
    this._changed('paste');
  }

  // Focus an entry — and put it on the system clipboard, which is what makes
  // "copy/paste operate on the focused buffer" true rather than merely claimed.
  focus(id) {
    const entry = this.ring.focus(id);
    if (!entry) return null;
    if (entry.text) this._toClipboard(entry.text, 'focus');
    this._changed('focus');
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
    if (entry.text) this._toClipboard(entry.text, 'step');
    this._changed('step');
    return entry;
  }

  add() {
    const entry = this.ring.add();
    this._changed('add');
    return entry;
  }

  remove(id) {
    const entry = this.ring.remove(id);
    // Removing the focused row moves the focus, and the focus is the clipboard.
    if (entry?.text) this._toClipboard(entry.text, 'remove');
    this._changed('remove');
    return entry;
  }

  clear() {
    const entry = this.ring.clear();
    this._changed('clear');
    return entry;
  }

  _changed(reason = '') {
    // Best-effort persistence: a ring too big for the tab store simply loses its
    // largest entries on the next reload (ClientStore swallows a quota failure),
    // which is why toJSON drops whole entries rather than trimming them.
    try { clientStore.patchSection(SECTION, this.ring.toJSON()); } catch (e) { /* best-effort */ }
    this._notify(reason);
  }

  // Redraw without persisting. Separate from _changed because a clipboard outcome
  // arriving late changes nothing about the RING — writing the same blob again on
  // every refusal would be churn for a fact the store does not persist anyway
  // (whether a clipboard write landed cannot survive a reload).
  _notify(reason = '') {
    for (const fn of this._subs) { try { fn(reason); } catch (e) { /* a bad subscriber is not the ring's problem */ } }
  }
}

export const copyBuffers = new CopyBufferStore();
