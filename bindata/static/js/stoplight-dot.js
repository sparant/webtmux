// The work-status dot's LOOK — one stylesheet for every surface that draws one.
//
// stoplight.js owns what @wt_working MEANS (class names, words, legend); this owns
// what it LOOKS like (the dot and the time-in-state badge beside it). Each surface (recents tabs, sidebar, preview tiles, Exposé)
// used to carry its own copy of these rules, and the copies drifted: the preview
// and Exposé dots never received the background-work class, so a green ring showed
// there as the grey "not reporting" circle. Now every dot carries the `stoplight`
// class, includes STOPLIGHT_CSS in its static styles, and keeps only its own
// placement (and, via --stoplight-size, its size) locally.
//
// Kept apart from stoplight.js because this imports lit, and stoplight.js must stay
// import-free for the node test runner.

import { css } from 'lit';

export const STOPLIGHT_CSS = css`
  /* green = working, green ring = working in the background, amber = prompting
     (blocked on your answer), red = waiting for work to do, unfilled = not reporting. */
  .stoplight {
    flex: 0 0 auto;
    width: var(--stoplight-size, 8px); height: var(--stoplight-size, 8px);
    border-radius: 50%;
    border: 1px solid #5a6a8a;
    background: transparent;
    box-sizing: border-box;
  }
  .stoplight.on   { background: #2ecc71; border-color: #2ecc71; box-shadow: 0 0 4px #2ecc71; }
  .stoplight.off  { background: #e74c3c; border-color: #e74c3c; }
  /* Waiting on background work it started. Green, because across a screenful of
     windows the only question you are asking is "does this one need me", and the
     answer is the same as green's. HOLLOW, because the follow-up question — can I
     talk to it — has a different answer here: it is sitting at a prompt. Same hue,
     so it never reads as a fourth kind of trouble; open centre, so it is still
     findable when you are looking for the one you can interrupt. */
  .stoplight.bg   { background: transparent; border-color: #2ecc71; border-width: 2px; box-shadow: 0 0 4px rgba(46, 204, 113, 0.75); }
  /* Waiting for user input — pulses, because unlike the other states it is a
     request: something is blocked until you go and answer it. */
  .stoplight.wait { background: #f5c542; border-color: #f5c542; box-shadow: 0 0 5px #f5c542; animation: wt-wait 1.4s ease-in-out infinite; }
  @keyframes wt-wait { 50% { opacity: 0.35; } }

  /* The "how long has it been like this" badge beside a dot (workBadge() in
     stoplight.js). Muted but readable at a glance — 9px measured too small. The
     .cyclable variant (both readings exist) invites a click to switch readings. */
  .work-age {
    flex: 0 0 auto; font-size: 11px; color: #9fb4dc; line-height: 1;
    white-space: nowrap; letter-spacing: 0.02em; cursor: default;
  }
  .work-age.cyclable { cursor: pointer; }
  .work-age.cyclable:hover { color: #cfe0ff; text-decoration: underline dotted; }
`;
