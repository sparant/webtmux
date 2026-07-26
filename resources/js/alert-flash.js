// The attention FLASH — one definition of what "this window needs you" looks like,
// shared by every surface that can show a window.
//
// It started as a handful of rules inside the toolbar, for the recents tabs alone.
// It is now on four surfaces (recents tabs, the strip's overflow arrow, the sidebar's
// window rows, the preview/PiP tiles), and a flash that pulses at a different rate or
// in a different red in each of them stops reading as one signal — the same lesson
// stoplight.js already learned about the dot itself. So the colours, the timing and
// the reduced-motion fallback live here and every surface splices in ALERT_CSS.
//
// Two shapes, because the surfaces are two shapes:
//
//   .wt-alert      FILL flash — for tabs, rows and buttons. The whole control goes
//                  solid in the alert colour. Loud, and it can afford to be: these
//                  are small controls with nothing inside them worth reading.
//
//   .wt-alert-ring BORDER flash — for the preview/PiP thumbnails. A thumbnail exists
//                  to be READ, and filling it would hide the very screen the flash is
//                  telling you to look at. An inset ring is used rather than an outer
//                  border so it can't be clipped by the tile's own overflow, and so
//                  it never changes the tile's size mid-animation.
//
// Both take their colour from --flash, set by the .wt-alert-off / .wt-alert-wait
// modifier, whose names come straight from stoplight.js's workClass — so the flash
// colour can never drift from the dot's.
import { css } from 'lit';
import { workClass } from './stoplight.js';

// The class list for an element that should flash. `alert` is the raw @wt_working
// value the window dropped TO ('0' red / '2' amber), or '' for quiet.
// `shape` is 'fill' (default) or 'ring'.
export function alertClass(alert, shape = 'fill') {
  if (!alert) return '';
  const base = shape === 'ring' ? 'wt-alert-ring' : 'wt-alert';
  return `${base} wt-alert-${workClass(alert)}`;
}

// The line a tooltip adds while something is flashing. It has to answer both "why is
// this blinking" and "how do I make it stop", or the flash is just noise you can't act
// on. One wording, so the strip, the sidebar and the tiles explain it identically.
export function alertTip(alert) {
  if (!alert) return '';
  const what = alert === '2' ? 'is prompting you' : 'ran out of work';
  return `\n● It ${what} since you last looked — flashes until you switch to it`;
}

// ATTENTION FLASH: this window's stoplight dropped out of green while you were
// looking at some other window — it either ran out of work (red) or is prompting you
// (amber). The dot alone is an 8px change in the corner of your eye and is easy to
// miss for minutes; the whole control flashing is not. It keeps flashing until you
// go and look at that window (WorkAlerts owns that rule) — it is a "you missed
// something" signal, so it must not expire on its own.
export const ALERT_CSS = css`
  .wt-alert-off  { --flash: #e74c3c; }
  .wt-alert-wait { --flash: #f5c542; }

  .wt-alert { animation: wt-flash 1.05s ease-in-out infinite; }
  @keyframes wt-flash {
    50% {
      background: var(--flash);
      border-color: var(--flash);
      color: #10131f;
      box-shadow: 0 0 10px var(--flash);
    }
    0%, 100% { border-color: var(--flash); }
  }

  .wt-alert-ring { animation: wt-flash-ring 1.05s ease-in-out infinite; }
  @keyframes wt-flash-ring {
    0%, 100% { box-shadow: inset 0 0 0 2px var(--flash); }
    50%      { box-shadow: inset 0 0 0 3px var(--flash), 0 0 12px var(--flash); }
  }

  /* Reduced motion: keep the signal, drop the blinking — a solid ring in the same
     colour, which is still the loudest thing on the surface it sits on. */
  @media (prefers-reduced-motion: reduce) {
    .wt-alert {
      animation: none;
      border-color: var(--flash);
      box-shadow: 0 0 0 2px var(--flash);
    }
    .wt-alert-ring {
      animation: none;
      box-shadow: inset 0 0 0 3px var(--flash);
    }
  }
`;
