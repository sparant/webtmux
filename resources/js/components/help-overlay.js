// The help overlay: arrows and notes pointing at the live UI.
//
// Hold ⌃⌥ (Ctrl+Alt) with no other key for HOLD_DELAY and it appears; it stays
// while the chord is held (help-hold.js). On a browser's FIRST connection it is up
// from the start and stays until the chord is tapped — that is how the overlay
// teaches itself.
//
// It never takes an event: the whole layer is pointer-events:none and only
// listens, so every hotkey and every click keeps working while it is up — and the
// overlay follows along (open Exposé with ⌃⌥F and the notes switch to Exposé's
// controls).
//
// The terminal is dimmed so the notes have somewhere to sit; the parts being
// explained are cut out of the dimming and outlined. What is explained comes from
// help-spots.js in SECTIONS: each starts as one outline and one note, and the
// section the pointer is near opens into a note per control (help-layout.js
// nearestSection), so pointing toward anything is how you find out about it.
//
// Rendering is two passes: the notes are drawn, measured, and only then placed
// (help-layout.js placeCallouts) — their size depends on their text, and placing
// without measuring is how notes end up on top of each other.
import { LitElement, html, svg, css } from 'lit';
import { HelpHold } from '../help-hold.js';
import { placeCallouts, nearestSection, union } from '../help-layout.js';
import { helpSections } from '../help-spots.js';
import { MOD_CHIPS, MOD_LABEL } from '../os.js';

const SEEN_KEY = 'webtmux-help-seen';
const REFRESH_MS = 250;          // re-read the UI this often while up (it changes under us)
const OUTLINE_PAD = 3;

function seenBefore() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
}
function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* private mode: shown again next time */ }
}

// A menu's click-away backdrop covers the whole screen but draws nothing; looking
// through it is right — the UI under it is still what the user sees.
function seeThrough(el) {
  if (![...el.classList].some((c) => c.endsWith('backdrop'))) return false;
  const bg = getComputedStyle(el).backgroundColor;
  return bg === 'transparent' || /rgba\(.*,\s*0\)$/.test(bg);
}
// The element under (x, y), descending through open shadow roots and looking
// through see-through backdrops — including a component whose only content at
// that point IS such a backdrop (the toolbar, while one of its menus is open,
// over the sidebar): the search goes on to whatever lies beneath that component.
const THROUGH = Symbol('see-through');
function hitIn(root, x, y, depth) {
  let skipped = false;
  for (const e of root.elementsFromPoint(x, y)) {
    // A shadow root also lists (retargeted) elements from outside it; reaching
    // one means this tree has nothing more here.
    if (e.getRootNode() !== root) break;
    if (seeThrough(e)) { skipped = true; continue; }
    if (e.shadowRoot && depth < 8) {
      const inner = hitIn(e.shadowRoot, x, y, depth + 1);
      if (inner === THROUGH) continue;
      return inner || e;
    }
    return e;
  }
  return skipped ? THROUGH : null;
}
function deepHit(x, y) {
  const hit = hitIn(document, x, y, 0);
  return hit === THROUGH ? null : hit;
}
// Is `node` el or inside it, crossing shadow boundaries upward?
function within(node, el) {
  for (let n = node; n; n = n.parentNode || n.host) if (n === el) return true;
  return false;
}

// The element's on-screen box if any of it is actually visible (not covered by
// Exposé, a menu backdrop, a floating panel…), else null.
function visibleRect(el) {
  if (!el || !el.getBoundingClientRect) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const box = { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(vw, r.right), bottom: Math.min(vh, r.bottom) };
  if (box.right - box.left < 2 || box.bottom - box.top < 2) return null;
  for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
    const x = box.left + (box.right - box.left) * fx;
    const y = box.top + (box.bottom - box.top) * fy;
    if (within(deepHit(x, y), el)) return box;
  }
  return null;
}

// The rect a spot is about: every element find() names that is visible, unioned.
function spotRect(spot, m) {
  const pick = (fn) => {
    if (!fn) return null;
    let els;
    try { els = [].concat(fn(m)).filter(Boolean); } catch (e) { els = []; }
    return union(els.map(visibleRect));
  };
  return pick(spot.find) || pick(spot.alt);
}

const pad = (r, p) => ({ left: r.left - p, top: r.top - p, right: r.right + p, bottom: r.bottom + p });

class WebtmuxHelp extends LitElement {
  static properties = {
    mode: { type: String, reflect: true },
  };

  static styles = css`
    :host {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 990;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --hl: #ffd479;
    }
    :host([mode]) { display: block; }
    svg.layer { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
    .dim { fill: rgba(4, 7, 18, 0.66); }
    .outline { fill: none; stroke: var(--hl); stroke-width: 1.5; }
    .outline.sec { stroke-dasharray: 5 4; }
    .outline.open { stroke-width: 2; stroke-dasharray: none; }
    .arrow { stroke: var(--hl); stroke-width: 1.5; fill: none; }
    .head { fill: var(--hl); }

    .note {
      position: absolute;
      box-sizing: border-box;
      width: 240px;
      padding: 7px 10px 8px;
      border-radius: 7px;
      background: #0b1020;
      border: 1px solid var(--hl);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
      color: #dfe6f5;
      font-size: 12px;
      line-height: 1.4;
    }
    .note.detail { width: 210px; }
    /* max-content, not auto: an auto width shrinks to the room left of the screen
       edge, so a note's size would depend on where it was placed, and placing it
       depends on its size — a loop. */
    .note.compact { width: max-content; max-width: 220px; padding: 4px 9px; }
    .note.unplaced { visibility: hidden; left: 0; top: 0; }
    .title { color: var(--hl); font-weight: 600; font-size: 12.5px; }
    .text { margin-top: 2px; color: #b9c4dc; }
    .more { margin-top: 3px; color: #8fa0c4; font-size: 11px; font-style: italic; }
    .keys { margin-top: 5px; display: grid; grid-template-columns: auto 1fr; gap: 3px 8px; align-items: baseline; }
    .chips { display: flex; gap: 3px; white-space: nowrap; }
    .kd { color: #c8d3ea; font-size: 11.5px; }
    kbd {
      background: #1a1a2e;
      border: 1px solid #2c4f86;
      border-bottom-width: 2px;
      border-radius: 4px;
      padding: 0 5px;
      color: #9fc4ff;
      font-family: Menlo, Monaco, "Courier New", monospace;
      font-size: 11px;
    }

    .note.intro.compact { width: max-content; max-width: 440px; padding: 4px 10px; }
    .note.intro { width: 330px; border-width: 2px; padding: 11px 14px 12px; }
    .intro h2 { margin: 0 0 6px; color: var(--hl); font-size: 15px; letter-spacing: 0.02em; }
    .intro p { margin: 5px 0 0; color: #c7d1e8; }
    .intro .dismiss { margin-top: 10px; display: flex; align-items: center; gap: 10px; color: #ffe7b0; }
    .intro button {
      pointer-events: auto;
      background: var(--hl); color: #1a1a2e; border: 0; border-radius: 5px;
      padding: 3px 12px; font-weight: 600; font-size: 12px; cursor: pointer;
    }
  `;

  constructor() {
    super();
    this.mode = null;
    this.manager = null;
    this._pointer = null;
    this._items = [];          // what to draw: [{ id, kind, spot, rect, … }]
    this._placed = new Map();  // id -> { box, arrow }
    this._sizes = new Map();   // id -> {width, height} as last measured
    this._sig = '';
    this._setKey = '';
    this._squeezed = new Set();
    this.hold = new HelpHold((mode) => this._setMode(mode));
    this._onKeyDown = (e) => this.hold.keydown(e);
    this._onKeyUp = (e) => this.hold.keyup(e);
    this._onPointerDown = (e) => this.hold.pointerdown(e);
    this._onPointerMove = (e) => {
      this.hold.pointermove(e);
      this._pointer = { x: e.clientX, y: e.clientY };
      if (this.mode) this._schedule();
    };
    this._onBlur = () => this.hold.blur();
    this._onResize = () => { if (this.mode) this._schedule(); };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKeyDown, true);
    window.addEventListener('keyup', this._onKeyUp, true);
    window.addEventListener('pointerdown', this._onPointerDown, true);
    window.addEventListener('pointermove', this._onPointerMove, { capture: true, passive: true });
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('resize', this._onResize);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKeyDown, true);
    window.removeEventListener('keyup', this._onKeyUp, true);
    window.removeEventListener('pointerdown', this._onPointerDown, true);
    window.removeEventListener('pointermove', this._onPointerMove, true);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('resize', this._onResize);
    clearInterval(this._tick);
  }

  // First connection from this browser: up until the chord is tapped.
  showFirstRun() {
    if (seenBefore()) return;
    this.hold.showSticky();
  }

  _setMode(mode) {
    const was = this.mode;
    this.mode = mode;
    if (was === 'sticky' && !mode) markSeen();
    clearInterval(this._tick);
    this._tick = null;
    if (mode) {
      this._tick = setInterval(() => this._refresh(), REFRESH_MS);
      this._refresh();
    } else {
      this._items = [];
      this._placed = new Map();
      this._sig = '';
    }
  }

  _dismiss() {
    this.hold.hide();
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._refresh(); });
  }

  // Re-read the UI: which sections are on screen, which one the pointer is at.
  _refresh() {
    const m = this.manager;
    if (!m || !this.mode) return;
    const sections = [];
    for (const s of helpSections(m)) {
      // A section's outline covers all of its parts, so pointing at ANY of them
      // opens it — not just at whatever element find() names.
      const rect = union([spotRect(s, m), ...(s.details || []).map((d) => spotRect(d, m))]);
      if (rect) sections.push({ spot: s, rect });
    }
    const open = nearestSection(
      sections.filter((s) => s.spot.details?.length).map((s) => ({ ...s, id: s.spot.id })),
      this._pointer);
    const openId = open?.spot.id || null;

    const items = [];
    const terminalArea = union(sections.filter((s) => s.spot.inside && s.spot.id === 'term').map((s) => s.rect))
      || { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    // The intro shrinks to one line while a section is open: the room goes to the
    // notes the pointer asked for.
    items.push({ id: 'intro', kind: 'intro', rect: terminalArea, inside: true, compact: !!openId });
    if (open) {
      for (const d of open.spot.details) {
        const rect = spotRect(d, m);
        if (rect) items.push({ id: d.id, kind: 'detail', spot: d, rect });
      }
    }
    for (const s of sections) {
      const isOpen = s.spot.id === openId;
      items.push({
        id: s.spot.id,
        kind: isOpen ? 'open' : (s.spot.inside ? 'inside' : 'section'),
        spot: s.spot,
        rect: s.rect,
        inside: !!s.spot.inside,
        // While one section is open the rest shrink to their titles: the room
        // goes to the part of the screen the user is asking about.
        compact: !!openId && !isOpen,
      });
    }
    // The open section's own note goes right after its details so it is placed
    // near them; inside notes (the terminal) take whatever room is left.
    items.sort((a, b) => rank(a) - rank(b));
    // Notes squeezed to one line for want of room stay squeezed while the same
    // set of notes is up; a different set gets a fresh try at full size.
    const setKey = items.map((it) => `${it.id}:${it.kind}:${it.compact ? 1 : 0}`).join(',');
    if (setKey !== this._setKey) { this._setKey = setKey; this._squeezed = new Set(); }
    for (const it of items) if (this._squeezed.has(it.id)) it.compact = true;
    this._items = items;
    this._layout();
  }

  _layout() {
    this._measure();
    const vp = { width: window.innerWidth, height: window.innerHeight };
    const obstacles = this._items.filter((it) => !it.inside).map((it) => pad(it.rect, OUTLINE_PAD));
    const ready = this._items.filter((it) => this._sizes.has(this._sizeKey(it)));
    const placed = placeCallouts(ready.map((it) => ({
      id: it.id, target: it.rect, inside: it.inside, size: this._sizes.get(this._sizeKey(it)),
    })), obstacles, vp);
    const sig = JSON.stringify([...placed.entries()].map(([k, v]) => [k, Math.round(v.box.left), Math.round(v.box.top)]))
      + JSON.stringify(this._items.map((it) => [it.id, it.kind, it.compact, Math.round(it.rect.left), Math.round(it.rect.top), Math.round(it.rect.right), Math.round(it.rect.bottom)]));
    // Nowhere free for a note: shrink it rather than let it cover another (it
    // is re-measured on the next render, and placed again).
    for (const it of this._items) {
      if (placed.get(it.id)?.clean === false && !it.compact) {
        it.compact = true;
        this._squeezed.add(it.id);
      }
    }
    if (sig === this._sig) return;
    this._sig = sig;
    this._placed = placed;
    this.requestUpdate();
  }

  _sizeKey(it) { return `${it.id}|${it.kind}|${it.compact ? 1 : 0}|${this.mode}`; }

  // A size change re-places on the next frame, never synchronously: lit chains
  // updates as microtasks, so a layout that kept changing sizes would otherwise
  // never let the page breathe.
  updated() {
    if (this.mode && this._measure()) this._schedule();
  }

  // Sizes of the drawn notes. Re-read on every refresh, not only after a render:
  // a web font arriving reflows them without lit knowing.
  _measure() {
    if (!this.renderRoot) return false;
    let changed = false;
    for (const el of this.renderRoot.querySelectorAll('.note[data-key]')) {
      const key = el.dataset.key;
      const w = el.offsetWidth, h = el.offsetHeight;
      const old = this._sizes.get(key);
      if (!old || old.width !== w || old.height !== h) {
        this._sizes.set(key, { width: w, height: h });
        changed = true;
      }
    }
    return changed;
  }

  _keys(keys) {
    if (!keys?.length) return '';
    return html`<div class="keys">${keys.map((k) => html`
      <span class="chips">${k.chips.map((c) => html`<kbd>${c}</kbd>`)}</span><span class="kd">${k.d}</span>`)}</div>`;
  }

  _note(it) {
    const p = this._placed.get(it.id);
    const key = this._sizeKey(it);
    const pos = p ? `left:${p.box.left}px;top:${p.box.top}px` : '';
    const cls = `note ${it.kind === 'detail' ? 'detail' : ''} ${it.compact ? 'compact' : ''} ${it.kind === 'intro' ? 'intro' : ''} ${p ? '' : 'unplaced'}`;
    if (it.kind === 'intro') return this._intro(cls, key, pos, it.compact);
    const s = it.spot;
    if (it.compact) {
      const tail = s.brief || (s.details?.length || s.inside ? 'point here' : '');
      return html`<div class=${cls} data-key=${key} style=${pos}><span class="title">${s.title}</span>${tail ? html`<span class="more"> · ${tail}</span>` : ''}</div>`;
    }
    return html`<div class=${cls} data-key=${key} style=${pos}>
      <div class="title">${s.title}</div>
      ${s.text ? html`<div class="text">${s.text}</div>` : ''}
      ${it.kind === 'section' && s.details?.length ? '' : this._keys(s.keys)}
      ${s.details?.length && it.kind !== 'open' ? html`<div class="more">Move the pointer here for each part.</div>` : ''}
    </div>`;
  }

  _intro(cls, key, pos, compact) {
    const mods = html`${MOD_CHIPS.map((c) => html`<kbd>${c}</kbd>`)}`;
    const sticky = this.mode === 'sticky';
    if (compact) {
      return html`<div class=${cls} data-key=${key} style=${pos}><span class="title">webtmux help</span>
        <span class="more"> · ${sticky ? html`tap ${mods} to dismiss` : html`let go of ${mods} to hide`} · all keys ${mods}<kbd>/</kbd></span></div>`;
    }
    return html`<div class=${cls} data-key=${key} style=${pos}>
      <h2>webtmux help</h2>
      ${sticky ? html`<p>Hold ${mods} for a moment — with no other key — any time, and this help appears. It stays while you hold them.</p>`
        : html`<p>Showing while ${mods} is held. Let go to hide.</p>`}
      <p>Move the pointer toward any outlined part of the screen to see what each piece does and its keys.</p>
      <p>Keys and clicks still work while this is up — try ${MOD_CHIPS.map((c) => html`<kbd>${c}</kbd>`)}<kbd>F</kbd>.</p>
      <p>Every shortcut, listed: ${MOD_CHIPS.map((c) => html`<kbd>${c}</kbd>`)}<kbd>/</kbd></p>
      ${sticky ? html`<div class="dismiss">Tap ${mods} to dismiss <button @click=${() => this._dismiss()} aria-label="Dismiss help (or tap ${MOD_LABEL})">Got it</button></div>` : ''}
    </div>`;
  }

  _svg() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const holes = this._items.filter((it) => it.kind !== 'intro' && !it.inside).map((it) => pad(it.rect, OUTLINE_PAD));
    const outlines = this._items.filter((it) => it.kind !== 'intro' && !it.inside);
    const arrows = this._items.map((it) => this._placed.get(it.id)?.arrow).filter(Boolean);
    return html`<svg class="layer" viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="none">
      ${svg`
        <defs>
          <mask id="cut">
            <rect x="0" y="0" width=${vw} height=${vh} fill="white"></rect>
            ${holes.map((r) => svg`<rect x=${r.left} y=${r.top} width=${r.right - r.left} height=${r.bottom - r.top} rx="4" fill="black"></rect>`)}
          </mask>
          <marker id="tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path class="head" d="M0,0 L10,5 L0,10 z"></path>
          </marker>
        </defs>
        <rect class="dim" x="0" y="0" width=${vw} height=${vh} mask="url(#cut)"></rect>
        ${outlines.map((it) => { const r = pad(it.rect, OUTLINE_PAD); return svg`<rect class="outline ${it.kind === 'section' || it.kind === 'open' ? 'sec' : ''} ${it.kind === 'open' ? 'open' : ''}" x=${r.left} y=${r.top} width=${r.right - r.left} height=${r.bottom - r.top} rx="4"></rect>`; })}
        ${arrows.map((a) => svg`<path class="arrow" d=${curve(a)} marker-end="url(#tip)"></path>`)}
      `}
    </svg>`;
  }

  render() {
    if (!this.mode) return html``;
    return html`${this._svg()}${this._items.map((it) => this._note(it))}`;
  }
}

// Placement order: intro, the open section's details, the open section, the other
// sections, then the notes that live inside the terminal.
function rank(it) {
  return { intro: 0, detail: 1, open: 2, section: 3, inside: 4 }[it.kind] ?? 5;
}

// A gentle bow in the arrow so a fan of them reads as separate strokes.
function curve({ from, to }) {
  const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(18, len * 0.12);
  const cx = mx - (dy / len) * bow, cy = my + (dx / len) * bow;
  return `M${from.x},${from.y} Q${cx},${cy} ${to.x},${to.y}`;
}

customElements.define('webtmux-help', WebtmuxHelp);
