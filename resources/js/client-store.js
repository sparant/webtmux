// ClientStore — the PER-CLIENT, ephemeral half of webtmux's persisted UI state
// (the shared/durable half lives in StateStore → tmux @wt_state). Backed by
// sessionStorage under a per-tab namespaced key (`webtmux-client:<clientId>`,
// clientId = crypto.randomUUID() generated once per tab). sessionStorage is
// per-tab: it survives a page reload and a websocket reconnect, but is cleared
// when the tab closes — exactly the "truly ephemeral per-client" lifetime we want.
// It is NEVER written to tmux and NEVER shared with other clients/browsers.
//
// Per-client fields (viewport state that must survive a reconnect but must not leak
// to other clients): focused window / focused unit, active pane, split-view region
// flex widths. Pure in-flight UI (hover timers, drag state) stays plain in-memory —
// no store at all.
//
// Same get()/patch() shape as StateStore, but with no tmux round-trip and no
// rev/conflict logic — a single tab is the only writer, so writes are immediate.

const ID_KEY = 'webtmux-client-id';

function ensureClientId() {
  try {
    let id = sessionStorage.getItem(ID_KEY);
    if (!id) {
      id = (crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(ID_KEY, id);
    }
    return id;
  } catch (e) {
    // sessionStorage unavailable — fall back to a volatile in-memory id.
    return 'c' + Math.random().toString(36).slice(2);
  }
}

export class ClientStore {
  constructor() {
    this.clientId = ensureClientId();
    this.key = `webtmux-client:${this.clientId}`;
    this.state = this._read();
  }

  get(key, dflt) {
    const v = this.state[key];
    return v === undefined ? dflt : v;
  }

  section(name) {
    const v = this.state[name];
    return v && typeof v === 'object' ? v : {};
  }

  patch(partial) {
    Object.assign(this.state, partial);
    this._write();
  }

  patchSection(name, partial) {
    this.patch({ [name]: { ...this.section(name), ...partial } });
  }

  _read() {
    try {
      const raw = sessionStorage.getItem(this.key);
      if (!raw) return {};
      const o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : {};
    } catch (e) { return {}; }
  }

  _write() {
    try { sessionStorage.setItem(this.key, JSON.stringify(this.state)); } catch (e) { /* best-effort */ }
  }
}

// The single shared per-tab instance every component imports.
export const clientStore = new ClientStore();
