// The region picker — "which SPLIT does this window go to?" — shared by the two
// surfaces that list windows you can send somewhere: the toolbar's recents tabs and
// the preview's tiles.
//
// WHY IT EXISTS. Every switcher in the app navigates the FOCUSED region — one rule,
// nothing to aim at. With the view split that rule runs out of answers: a tab or a
// tile can say WHICH window but never WHICH PANE, and a window already on screen in
// the other split could not be moved at all. So a hovered tab (or tile) grows a small
// picture of the split — one chip per region, in the panes' real proportions.
// Pointing at a chip PREVIEWS the window in that pane and clicking commits it there.
//
// It lives in one place for the same reason the hint does (tooltip.js): two copies of
// "which pane is this window in, and how do I move it" would drift, and a preview tile
// that answered the question differently from the tab for the same window would read
// as two mechanisms rather than one app. The timing, the markup and the look are
// shared; each host keeps its own open/close bookkeeping, because what counts as "the
// pointer is still on the thing this picker belongs to" is the host's to know.
import { html, css } from 'lit';

// How long the pointer rests before the picker appears. Shorter than the hint's
// TIP_DELAY: this one is a control you are reaching for rather than a label you are
// reading, and it replaces the hint while it is up. Long enough that sweeping the
// strip (or the bar) end to end pops nothing.
export const PICKER_DELAY = 240;

// …and how long the picker survives the pointer leaving its anchor. The popover sits
// flush against the anchor's edge, so this only has to cover the frame between the
// anchor's mouseleave and the picker's mouseenter — the two fire in that order and
// nothing in between says which one is about to win.
export const PICKER_GRACE = 140;

// "session — window N: name": how every hover surface names a window in full. The
// recents tab's hint, both pickers' heads and the preview tile's hint all say it this
// way, so the same window reads the same wherever you point at it.
export function windowTitle(session, index, name) {
  const win = `window ${index == null || index === '' ? '' : `${index}: `}${name || ''}`;
  return session ? `${session} — ${win}` : win;
}

export const REGION_PICKER_CSS = css`
  /* Fixed, so no host's overflow:hidden can clip it, and flush against its anchor's
     edge rather than the usual 6px off it: the pointer has to travel from the anchor
     into this without crossing a gap, or the hover it depends on ends on the way. */
  .rpick {
    position: fixed;
    z-index: 1000;
    padding: 7px 8px 8px;
    border-radius: 6px;
    background: #0b1020;
    border: 1px solid #4a9eff;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
    font-family: Menlo, Monaco, "Courier New", monospace;
    color: #e8eefc;
    max-width: min(520px, calc(100vw - 16px));
  }
  .rpick-head {
    font-size: 11px; color: #9fb4dc; margin-bottom: 6px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* The chips are laid out in the panes' OWN proportions (flex-grow comes from the
     divider drag), so the row is a small picture of the split rather than a list of
     equal boxes that happen to be numbered. */
  .rpick-row { display: flex; align-items: stretch; gap: 4px; min-width: 260px; }
  .rslot {
    flex: 1 1 0;
    min-width: 62px;
    display: flex; flex-direction: column; gap: 2px;
    padding: 6px 8px;
    border-radius: 4px;
    border: 1px solid #2c4a7a;
    background: #131c33;
    color: #cfe0ff;
    font: inherit; font-size: 11px; text-align: left;
    cursor: pointer;
  }
  .rslot:hover { border-color: #4a9eff; background: #1b2b4d; }
  /* The pane that is focused right now — where an unaimed click would have landed. */
  .rslot.focused { border-color: #4a9eff; }
  /* The pane already showing this window. Still clickable (it means "focus it"),
     but it is not somewhere to send anything. */
  .rslot.here { border-color: #37d17a; background: #12281e; color: #b6ebcd; }
  .rslot-n { font-size: 10px; color: #7d92b8; letter-spacing: 0.04em; }
  .rslot.here .rslot-n { color: #7fc9a3; }
  .rslot-w { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rpick-hint {
    margin-top: 6px; font-size: 10.5px; line-height: 1.4; color: #8fa4cc;
    white-space: normal; max-width: 340px;
  }
`;

// The picker's markup. `win` is {id, session, index, name}; `regions` is
// SplitManager.regionViews(). `extra` is whatever the host adds after the hint — the
// recents tab offers "drag the tab onto a pane", a preview tile does not (its drag is
// a bar reorder), and both append the window's attention flash.
//
// Handlers: onEnter/onLeave for the popover itself (the host's hold bookkeeping),
// onSlotEnter(i)/onSlotPick(i) for a chip — preview in pane i / commit to pane i.
export function regionPickerTemplate({ win, regions, extra = '', onEnter, onLeave, onSlotEnter, onSlotPick }) {
  const list = regions || [];
  const holder = list.find((r) => r.windowId === win.id);
  const label = (r) => (r.name ? `${r.windowIndex == null ? '' : r.windowIndex + ': '}${r.name}` : 'no window');
  return html`
    <div class="rpick" @mouseenter=${onEnter} @mouseleave=${onLeave}>
      <div class="rpick-head">${windowTitle(win.session, win.index, win.name)}</div>
      <div class="rpick-row">
        ${list.map((r) => html`
          <button
            class="rslot ${r.windowId === win.id ? 'here' : ''} ${r.focused ? 'focused' : ''}"
            style="flex-grow: ${r.grow}"
            aria-label=${r.windowId === win.id
              ? `Region ${r.index + 1} is already showing ${win.name}`
              : `Move ${win.name} to region ${r.index + 1}`}
            @mouseenter=${() => onSlotEnter?.(r.index)}
            @click=${() => onSlotPick?.(r.index)}
          >
            <span class="rslot-n">${r.index + 1}${r.windowId === win.id ? ' · here' : ''}${r.focused && r.windowId !== win.id ? ' · focused' : ''}</span>
            <span class="rslot-w">${label(r)}</span>
          </button>
        `)}
      </div>
      <div class="rpick-hint">${holder
        ? html`It is in region ${holder.index + 1}. Pick another and the two panes trade windows.`
        : html`Pick a pane to open it there — hovering one shows it first.`}${extra}</div>
    </div>
  `;
}
