// Call-outs for README screenshots: a ring around the control a section is about,
// with an optional arrow and label, so a toolbar strip says where to look.
//
// Drawn as one fixed, pointer-events:none SVG layer over the page, so it rides
// along in page.screenshot() and in recorded video, and never intercepts input.
// Magenta, because nothing in the UI is: the stoplights are green/amber/red and the
// chrome is navy and blue.
const COLOR = '#ff2d95';

// marks: [{ rect: {x,y,width,height} (CSS px), label?, arrow?: 'below'|'above'|'none' }]
// band: optional {y, height} — a dark strip laid behind arrows/labels so terminal
// text under the toolbar doesn't compete with them.
async function annotate(page, marks, { band } = {}) {
  await page.evaluate(([marks, band, COLOR]) => {
    document.getElementById('__wt_annot')?.remove();
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.id = '__wt_annot';
    Object.assign(svg.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh',
      pointerEvents: 'none', zIndex: 2147483647 });
    const el = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      svg.appendChild(e); return e;
    };
    const defs = el('defs', {});
    const m = document.createElementNS(NS, 'marker');
    for (const [k, v] of Object.entries({ id: 'wtHead', markerWidth: 8, markerHeight: 8, refX: 6, refY: 4, orient: 'auto' })) m.setAttribute(k, v);
    const head = document.createElementNS(NS, 'path');
    head.setAttribute('d', 'M0,0 L8,4 L0,8 Z'); head.setAttribute('fill', COLOR);
    m.appendChild(head); defs.appendChild(m);
    if (band) el('rect', { x: 0, y: band.y, width: window.innerWidth, height: band.height, fill: '#0b1020', opacity: 0.97 });
    for (const mk of marks) {
      const r = mk.rect, pad = 4;
      el('rect', { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad,
        rx: 7, fill: 'none', stroke: COLOR, 'stroke-width': 3 });
      const cx = r.x + r.width / 2;
      const dir = mk.arrow || 'below';
      if (dir === 'none') continue;
      const tip = dir === 'below' ? r.y + r.height + pad + 4 : r.y - pad - 4;
      const tail = dir === 'below' ? tip + 46 : tip - 46;
      el('line', { x1: cx, y1: tail, x2: cx, y2: tip, stroke: COLOR, 'stroke-width': 3, 'marker-end': 'url(#wtHead)' });
      if (mk.label) {
        const t = el('text', { x: Math.max(8, cx), y: dir === 'below' ? tail + 18 : tail - 8, fill: COLOR,
          'font-family': 'Inter, system-ui, sans-serif', 'font-size': 15, 'font-weight': 700,
          'text-anchor': mk.anchor || 'middle' });
        t.textContent = mk.label;
      }
    }
    document.body.appendChild(svg);
  }, [marks, band || null, COLOR]);
}

async function clearAnnotations(page) {
  await page.evaluate(() => document.getElementById('__wt_annot')?.remove());
}

// Rect of an element inside a host's shadow root (CSS px), or null.
async function rectOf(page, host, sel) {
  return page.evaluate(([h, s]) => {
    const root = document.querySelector(h);
    const t = s ? root?.shadowRoot?.querySelector(s) : root;
    if (!t) return null;
    const b = t.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }, [host, sel]);
}

module.exports = { annotate, clearAnnotations, rectOf };
