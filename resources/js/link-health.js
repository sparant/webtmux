// LinkHealth — how sure are we, RIGHT NOW, that this region's link to tmux is live?
//
// The toolbar spinner used to answer that question with a boolean, and the boolean
// was optimistic in exactly the moment it mattered most. Close the laptop, open it an
// hour later: the socket is still OPEN as far as the browser is concerned, nothing has
// arrived from the server since yesterday, clicks go nowhere — and the spinner sat
// green for another ten seconds or so before admitting it. The old heartbeat did that
// deliberately: waking from a suspend it saw a huge silence, correctly reasoned that
// OUR clock had stopped rather than the server's, and resolved the ambiguity by
// declaring the link healthy and skipping that beat's probe. Forgiving the silence is
// right. Calling it health is not — what we actually knew at that instant was nothing
// at all, and the honest move is to ASK immediately and judge on the answer.
//
// So this module replaces "connected / lost" with three states and one rule:
//
//   live — nothing is outstanding, or what is outstanding is still within its budget
//   slow — we asked and have not been answered for longer than a round trip should
//          take. The link is late, not gone; a loaded box lands here and climbs back
//          out by itself when the answer arrives.
//   lost — the socket is closed, the browser says there is no network, or an ask has
//          gone unanswered past the point where "slow" stops being credible.
//
// WHAT COUNTS AS AN ANSWER. Only a Pong. The server replies to Ping from the same
// serialized handler loop that writes your keystrokes into the pty, so a Pong is proof
// of precisely the thing typing needs. Ordinary Output is NOT proof: it travels the
// other way (pty -> socket) and can keep streaming from a window that is busy printing
// while the input loop behind it is wedged — which is the failure that strands you.
// Output therefore only defers the idle probe (a link that is visibly streaming does
// not need to be interrogated on a timer); it never discharges an ask.
//
// WHAT COUNTS AS AN ASK. A probe, or anything the user did — a keystroke, a window
// switch, a rename. That is the other half of the fix: the moment you interact with a
// wedged link is the moment you deserve to be told, and your interaction is a free
// probe. Ask, wait a beat for the shell to answer on its own, then Ping; if neither
// arrives, the spinner has something true to say and says it in about two seconds
// instead of eleven.
//
// This module is pure on purpose — no timers, no DOM, no clock. Every method takes
// `now`, so the whole state machine is testable under node (test/link-health.test.mjs)
// and the awkward cases (suspend, throttled tab, a Pong that arrives just after we
// gave up) can be driven exactly rather than waited for. TerminalUnit owns the timers
// and the socket; SplitManager owns the page-level events. This owns the judgement.

// How long a visible, silent link may go uninterrogated. This is the ONLY recurring
// traffic here, and it is the part with a genuine cost/benefit to argue about: without
// it a link that dies while you are reading a window stays green until you touch
// something, and with it a wholly idle tab talks to the server forever. Six seconds is
// the compromise — any inbound frame defers it, so a window that is doing anything at
// all never probes, and a hidden tab does not probe at all (see setActive).
export const IDLE_PROBE_MS = 6000;
// How long after an interaction we wait for the shell to answer on its own before
// spending a Ping. Long enough that ordinary echo beats us to it (so typing does not
// generate a probe per keystroke), short enough that a dead link is caught while you
// are still looking at what you clicked.
export const INTERACTION_GRACE_MS = 1000;
// Minimum spacing between probes, answered or not.
//
// This is the ONLY thing that limits how often we Ping, and it deliberately does not
// wait for the previous probe to come back. An earlier version used "is a probe
// outstanding?" as the gate and deadlocked: a link that went mute swallowed one probe,
// which then blocked every future probe forever — so when the server came back (without
// the socket ever closing, which is exactly how a wedge clears) nothing was left that
// could ask it anything, and the spinner stayed coloured against a perfectly live link.
// The browser run caught it; the unit tests had not, because they had no case where a
// link recovered from a swallowed probe. Spacing them instead also means a probe lost in
// transit is retried rather than fatal.
export const PROBE_SPACING_MS = 1000;
// The floor under "this is taking too long". A local tmux answers in single-digit
// milliseconds, so anything past a second is worth colouring even though it may yet
// arrive — but the floor has to survive a laggy link without crying wolf, hence the
// EWMA below: the real budget is whichever is larger.
export const MIN_SLOW_MS = 1200;
export const SLOW_RTT_FACTOR = 4;
// The point where "slow" stops being a credible story. Unchanged from the original
// heartbeat: comfortably longer than any tmux command round trip on a loaded box.
export const STALL_MS = 8000;

export const LIVE = 'live';
export const SLOW = 'slow';
export const LOST = 'lost';

export class LinkHealth {
  constructor({
    idleProbeMs = IDLE_PROBE_MS,
    graceMs = INTERACTION_GRACE_MS,
    spacingMs = PROBE_SPACING_MS,
    minSlowMs = MIN_SLOW_MS,
    stallMs = STALL_MS,
  } = {}) {
    this.idleProbeMs = idleProbeMs;
    this.graceMs = graceMs;
    this.spacingMs = spacingMs;
    this.minSlowMs = minSlowMs;
    this.stallMs = stallMs;

    this._open = false;
    // Has this link ever been open? A socket that has never connected is BOOTING, not
    // lost, and must not paint a warning on every page load — the same latch the old
    // connectionLost() carried, kept here so the whole verdict lives in one place.
    this._everOpen = false;
    this._online = true;      // navigator.onLine
    this._active = true;      // is the tab visible? (hidden tabs do not idle-probe)
    this._lastInboundAt = 0;  // any frame from the server: defers the idle probe
    this._awaitingSince = 0;  // oldest ask we have not been answered for (0 = none)
    this._probeAt = 0;        // the most recent unanswered Ping (0 = none outstanding)
    this._lastProbeAt = 0;    // the most recent Ping, answered or not: paces the next
    this._rttAmbiguous = false; // a probe went out while another was still unanswered,
                                // so the next Pong cannot be attributed to either
    this._suspect = false;    // positive reason to doubt: probe at the first chance
    this._rtt = 0;            // EWMA of measured probe round trips (0 = never measured)
  }

  // ----- what the socket did ----------------------------------------------------

  opened(now) {
    this._open = true;
    this._everOpen = true;
    this._lastInboundAt = now;
    this._clearPending();
  }

  closed() {
    this._open = false;
    // Nothing is outstanding on a socket that is gone: the retry loop will open a new
    // one, and carrying the old asks across would make the fresh socket start life
    // already late.
    this._clearPending();
  }

  // Forget everything we were waiting on, and forget that we have recently probed —
  // so the next thing that wants to ask is free to ask immediately.
  _clearPending() {
    this._awaitingSince = 0;
    this._probeAt = 0;
    this._lastProbeAt = 0;
    this._rttAmbiguous = false;
    this._suspect = false;
  }

  // ----- what we know from outside the socket -----------------------------------

  // The browser's own verdict. Worth having because it is free and instant: when the
  // OS says there is no network there is no point waiting out a stall timer.
  setOnline(v) { this._online = !!v; }

  // Is this tab visible? A hidden tab is not idle-probed — its timers are throttled to
  // uselessness anyway, and nobody is looking at the spinner. The state it left behind
  // is not trusted on the way back in, either: see resumed().
  setActive(v) { this._active = !!v; }

  // Our clock stopped, not theirs — a suspended laptop, a throttled background tab, or
  // simply the tab becoming visible again after a while.
  //
  // Two things happen, and the second is the whole point of this module. We FORGIVE the
  // elapsed silence (it is ours, and reporting it as a lost connection would greet you
  // with a false alarm every time you came back to a tab); and we do NOT conclude
  // anything from that forgiveness. Whatever we believed before the gap was true about
  // a world that has since moved on, so the link is put back on the clock and probed at
  // the first opportunity, and the answer — or the missing answer — decides.
  resumed(now) {
    this._lastInboundAt = now;
    this._clearPending();
    this._suspect = true;
  }

  // ----- what crossed the wire --------------------------------------------------

  // Any frame from the server. Defers the idle probe; deliberately does NOT discharge
  // an ask (see the header — Output does not prove the input loop is turning).
  inbound(now) { this._lastInboundAt = now; }

  // The one frame that IS an answer.
  pong(now) {
    // Only time a Pong we can attribute: with more than one probe outstanding this
    // could be answering either, and a sample measured from the wrong one would widen
    // the amber budget on the strength of a link that is in fact struggling.
    if (this._probeAt && !this._rttAmbiguous && now >= this._probeAt) {
      const sample = now - this._probeAt;
      // EWMA, 1/4 weight on the newest sample: enough to follow a link that has genuinely
      // got slower, slow enough that one unlucky round trip doesn't widen the budget.
      this._rtt = this._rtt ? this._rtt * 0.75 + sample * 0.25 : sample;
    }
    this._probeAt = 0;
    this._rttAmbiguous = false;
    this._awaitingSince = 0;
    this._lastInboundAt = now;
  }

  // We sent something that the user is waiting on (a keystroke, a tmux command).
  // Only the OLDEST outstanding ask is tracked: how long we have been unanswered is
  // the question, and a burst of typing is one wait, not thirty.
  asked(now) {
    if (!this._awaitingSince) this._awaitingSince = now;
  }

  // A Ping went out.
  probeSent(now) {
    if (this._probeAt) this._rttAmbiguous = true;   // the previous one is still unanswered
    this._probeAt = now;
    this._lastProbeAt = now;
    if (!this._awaitingSince) this._awaitingSince = now;
    this._suspect = false;
  }

  // ----- the verdict ------------------------------------------------------------

  // How long may an ask go unanswered before it is worth colouring? Whichever is
  // longer: the floor, or four round trips on this link as we have actually measured
  // it. A link that always takes 400ms should not sit amber half the time.
  slowAfter() {
    return Math.max(this.minSlowMs, this._rtt * SLOW_RTT_FACTOR);
  }

  state(now) {
    if (!this._online) return LOST;
    if (!this._open) return this._everOpen ? LOST : LIVE;
    if (!this._awaitingSince) return LIVE;
    const waited = now - this._awaitingSince;
    if (waited > this.stallMs) return LOST;
    if (waited > this.slowAfter()) return SLOW;
    return LIVE;
  }

  // How long the oldest outstanding ask has gone unanswered — what the tooltip counts
  // out loud. 0 when nothing is outstanding.
  waitedMs(now) {
    return this._awaitingSince ? Math.max(0, now - this._awaitingSince) : 0;
  }

  // Is this an open socket that has stopped answering (as opposed to one that closed)?
  // The two need different words: a closed socket is already being retried, a mute one
  // is not being retried by anybody, because as far as the browser is concerned nothing
  // is wrong.
  isMute(now) {
    return this._open && this._online && this.state(now) === LOST;
  }

  // Should a Ping go out right now?
  //
  // Note what does NOT appear here: "is a probe already outstanding". Probes are PACED,
  // not serialized — see PROBE_SPACING_MS for the deadlock that taught us the
  // difference. An unanswered probe must never be able to prevent the next one.
  dueProbe(now) {
    if (!this._open || !this._online) return false;
    if (this._lastProbeAt && now - this._lastProbeAt < this._spacing(now)) return false;
    if (this._suspect) return true;           // we have a reason; visibility doesn't gate it
    if (!this._active) return false;          // hidden: no probing on spec
    if (this._awaitingSince && now - this._awaitingSince >= this.graceMs) return true;
    return now - this._lastInboundAt >= this.idleProbeMs;
  }

  // How long we must leave between probes. Normally the spacing constant — but once a
  // link has gone red, back off to the idle cadence: a mute socket that nobody is going
  // to unwedge should not be pinged once a second for as long as the tab is left open,
  // and a server that DOES come back is still noticed within one idle period.
  _spacing(now) {
    return this.state(now) === LOST ? Math.max(this.spacingMs, this.idleProbeMs) : this.spacingMs;
  }

  // When could anything change without another event arriving? Returns a timestamp, or
  // 0 if this link is quiescent and only an event can move it.
  //
  // This is what lets the caller run on ONE self-scheduling timer instead of a poll:
  // it wakes exactly when a probe comes due or a colour boundary is crossed, and not
  // at all when there is nothing to wake for (a hidden tab, a closed socket).
  nextEventAt(now) {
    if (!this._open || !this._online) return 0;
    const at = [];
    // The earliest a probe may go out at all, whatever else is true.
    const canProbe = this._lastProbeAt ? this._lastProbeAt + this._spacing(now) : now;
    if (this._suspect) {
      at.push(canProbe);
    } else {
      if (this._awaitingSince) at.push(Math.max(canProbe, this._awaitingSince + this.graceMs));
      if (this._active) at.push(Math.max(canProbe, this._lastInboundAt + this.idleProbeMs));
    }
    if (this._awaitingSince) {
      const slow = this._awaitingSince + this.slowAfter();
      const lost = this._awaitingSince + this.stallMs;
      if (slow > now) at.push(slow);
      if (lost > now) at.push(lost);
    }
    if (!at.length) return 0;
    return Math.max(now, Math.min(...at));
  }
}
