// Unit tests for link-health.js — the three-state answer to "is the link to tmux
// live". Run with:
//
//     node --test test/
//
// The module is import-free and takes its clock as an argument, so every case that
// matters here can be driven exactly rather than waited for: a laptop shut for an hour,
// a Pong that arrives one millisecond after we gave up, a tab throttled in the
// background. Those are precisely the cases that were impossible to test before, and
// the reason the judgement was pulled out of TerminalUnit's timer in the first place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LinkHealth, LIVE, SLOW, LOST,
  IDLE_PROBE_MS, INTERACTION_GRACE_MS, PROBE_SPACING_MS, MIN_SLOW_MS, STALL_MS,
} from '../resources/js/link-health.js';

// A link that is up and has just been heard from. t is an arbitrary epoch.
const T = 1_000_000;
function open(t = T, opts) {
  const h = new LinkHealth(opts);
  h.opened(t);
  return h;
}

test('a socket that has never opened is booting, not lost', () => {
  // The bug this guards: warning on every page load. The first connect spends its
  // opening moments looking exactly like a failed retry.
  const h = new LinkHealth();
  assert.equal(h.state(T), LIVE);
  h.opened(T);
  h.closed();
  assert.equal(h.state(T), LOST, 'but once it has been up, a close IS a loss');
});

test('an open link with nothing outstanding is live', () => {
  const h = open();
  assert.equal(h.state(T + 60_000), LIVE, 'silence alone is not evidence of anything');
});

test('an unanswered ask goes amber, then red, and never skips amber', () => {
  const h = open();
  h.asked(T);
  assert.equal(h.state(T + 100), LIVE, 'a fresh ask is not yet late');
  assert.equal(h.state(T + MIN_SLOW_MS + 1), SLOW);
  assert.equal(h.state(T + STALL_MS - 1), SLOW, 'still late, not yet gone');
  assert.equal(h.state(T + STALL_MS + 1), LOST);
});

test('a late answer takes it back to live', () => {
  // The whole point of amber: "slow" is a state you climb out of.
  const h = open();
  h.asked(T);
  h.probeSent(T + INTERACTION_GRACE_MS);
  assert.equal(h.state(T + 3000), SLOW);
  h.pong(T + 3500);
  assert.equal(h.state(T + 3500), LIVE);
});

test('only a Pong discharges an ask — Output does not', () => {
  // A window busy printing while the input loop behind it is wedged is the failure
  // that strands you; if streaming Output cleared the wait, that is exactly the case
  // the spinner would stay green through.
  const h = open();
  h.asked(T);
  h.inbound(T + 500);
  h.inbound(T + 1500);
  assert.equal(h.state(T + MIN_SLOW_MS + 100), SLOW, 'output is not an answer');
  h.pong(T + MIN_SLOW_MS + 200);
  assert.equal(h.state(T + MIN_SLOW_MS + 200), LIVE);
});

test('a burst of typing is ONE wait, timed from the first keystroke', () => {
  const h = open();
  h.asked(T);
  for (let i = 1; i <= 20; i++) h.asked(T + i * 50);
  assert.equal(h.waitedMs(T + 2000), 2000, 'not 2000 minus the last keystroke');
});

// ----- the bug this module exists for ----------------------------------------

test('waking from a suspend forgives the silence but does NOT claim health', () => {
  const h = open();
  const wake = T + 3600_000;               // an hour with the lid shut

  h.resumed(wake);
  assert.equal(h.state(wake), LIVE, 'the hour of silence was ours, so no false alarm');
  assert.ok(h.dueProbe(wake), 'but we ask immediately rather than assuming');

  // …and if nothing answers that probe, the colour arrives on the ordinary schedule
  // measured from the WAKE, not eleven seconds later after a wasted beat.
  h.probeSent(wake);
  assert.equal(h.state(wake + MIN_SLOW_MS + 1), SLOW);
  assert.equal(h.state(wake + STALL_MS + 1), LOST);
});

test('a healthy wake produces no amber flicker', () => {
  const h = open();
  const wake = T + 3600_000;
  h.resumed(wake);
  h.probeSent(wake);
  h.pong(wake + 8);                        // a local tmux answers in single digits
  assert.equal(h.state(wake + 8), LIVE);
  assert.equal(h.state(wake + 5000), LIVE);
});

test('the browser reporting no network is believed at once, and unbelieved at once', () => {
  const h = open();
  h.setOnline(false);
  assert.equal(h.state(T), LOST, 'no waiting out a stall timer for something we know');
  assert.equal(h.dueProbe(T), false, 'and no probing into a dead network');
  h.setOnline(true);
  assert.equal(h.state(T), LIVE);
});

// ----- when we spend a probe ---------------------------------------------------

test('a visible idle link is probed on the idle schedule, and output defers it', () => {
  const h = open();
  assert.equal(h.dueProbe(T + IDLE_PROBE_MS - 1), false);
  assert.equal(h.dueProbe(T + IDLE_PROBE_MS), true);
  h.inbound(T + IDLE_PROBE_MS);            // a frame arrived: nothing to interrogate
  assert.equal(h.dueProbe(T + IDLE_PROBE_MS + 1), false);
});

test('a hidden tab is not probed on spec, but IS probed when it comes back', () => {
  const h = open();
  h.setActive(false);
  assert.equal(h.dueProbe(T + IDLE_PROBE_MS * 10), false, 'nobody is looking at the spinner');
  h.setActive(true);
  h.resumed(T + IDLE_PROBE_MS * 10);
  assert.equal(h.dueProbe(T + IDLE_PROBE_MS * 10), true);
});

test('an interaction is probed after the grace period, not instantly', () => {
  // Instantly would mean a Ping per keystroke; the grace lets ordinary echo answer
  // first, which it almost always does.
  const h = open();
  h.asked(T);
  assert.equal(h.dueProbe(T + INTERACTION_GRACE_MS - 1), false);
  assert.equal(h.dueProbe(T + INTERACTION_GRACE_MS), true);
});

test('probes are PACED, not serialized — an unanswered one never blocks the next', () => {
  // The deadlock this locks out, caught in the browser and not by the first draft of
  // these tests: gating on "is a probe outstanding" meant one swallowed probe blocked
  // every future probe forever, so a link that came back — without the socket ever
  // closing, which is exactly how a wedge clears — had nothing left that could ask it
  // anything, and the spinner stayed coloured against a live link.
  const h = open();
  h.asked(T);
  h.probeSent(T + INTERACTION_GRACE_MS);
  assert.equal(h.dueProbe(T + INTERACTION_GRACE_MS + 500), false, 'not a flood, either');
  const retry = T + INTERACTION_GRACE_MS + PROBE_SPACING_MS;
  assert.equal(h.dueProbe(retry), true, 'the swallowed probe is retried, not waited on');

  // …and when one of them finally gets an answer, the link is simply live again.
  h.probeSent(retry);
  h.pong(retry + 40);
  assert.equal(h.state(retry + 40), LIVE);
  assert.equal(h.waitedMs(retry + 40), 0);
});

test('a link that recovers on its own goes back to normal without a reload', () => {
  // The same bug from the other end: mute for long enough to go red, then the server
  // comes back. Nothing closes; the only thing that can notice is a probe.
  const h = open();
  h.asked(T);
  h.probeSent(T + INTERACTION_GRACE_MS);
  assert.equal(h.state(T + STALL_MS + 1), LOST);
  const back = T + 30_000;
  assert.equal(h.dueProbe(back), true, 'a red link is still probed, on the backed-off cadence');
  h.probeSent(back);
  h.pong(back + 30);
  assert.equal(h.state(back + 30), LIVE);
});

test('a red link backs off rather than pinging once a second forever', () => {
  const h = open();
  h.asked(T);
  h.probeSent(T + INTERACTION_GRACE_MS);
  const red = T + STALL_MS + 1;
  h.probeSent(red);                         // one of the retries, still unanswered
  assert.equal(h.dueProbe(red + PROBE_SPACING_MS), false, 'not the live cadence any more');
  assert.equal(h.dueProbe(red + IDLE_PROBE_MS), true, 'but still noticed within an idle period');
});

test('a closed link is neither probed nor scheduled', () => {
  const h = open();
  h.closed();
  assert.equal(h.dueProbe(T + 60_000), false);
  assert.equal(h.nextEventAt(T), 0, 'nothing can change without the retry loop opening one');
});

// ----- the budget adapts to the link -------------------------------------------

test('a consistently slow link widens its own amber threshold', () => {
  const h = open();
  for (let i = 0; i < 12; i++) {           // settle the EWMA around 600ms
    const at = T + i * 10_000;
    h.probeSent(at);
    h.pong(at + 600);
  }
  assert.ok(h.slowAfter() > MIN_SLOW_MS, 'four round trips beats the floor here');
  assert.ok(h.slowAfter() < STALL_MS, 'but never past the point where late becomes gone');
});

test('the floor holds for a fast link', () => {
  const h = open();
  h.probeSent(T);
  h.pong(T + 3);
  assert.equal(h.slowAfter(), MIN_SLOW_MS, '12ms of budget would be amber every other frame');
});

// ----- what the caller schedules against ---------------------------------------

test('nextEventAt wakes for the earliest of probe-due and colour-change', () => {
  const h = open();
  // Nothing outstanding, visible: the only pending thing is the idle probe.
  assert.equal(h.nextEventAt(T), T + IDLE_PROBE_MS);
  // With an ask outstanding, the probe grace comes first…
  h.asked(T);
  assert.equal(h.nextEventAt(T), T + INTERACTION_GRACE_MS);
  // …and once it has been spent, the next thing that can happen is amber.
  h.probeSent(T + INTERACTION_GRACE_MS);
  assert.equal(h.nextEventAt(T + INTERACTION_GRACE_MS), T + MIN_SLOW_MS);
  // Past amber, the next thing due is the probe RETRY (the first one went unanswered),
  // which lands before the red boundary — and nothing it returns is ever in the past.
  const late = T + MIN_SLOW_MS + 500;
  assert.equal(h.nextEventAt(late), T + INTERACTION_GRACE_MS + PROBE_SPACING_MS);
  assert.ok(h.nextEventAt(T + STALL_MS + 5000) > 0,
    'even a red link keeps a wake-up scheduled — that is how it climbs back out');
});

test('a suspect link asks to be probed right now', () => {
  const h = open();
  h.resumed(T + 3600_000);
  assert.equal(h.nextEventAt(T + 3600_000), T + 3600_000, 'not on the next beat — now');
});
