// Unit tests for CopyModeArbiter — telling "driving tmux copy mode" apart from
// "typing at a pane that happens to be scrolled up". Run with:
//
//     node --test test/
//
// copy-mode.js is dependency-free, so it loads directly under node. Timers are
// injected so the "lone motion, then a pause" path is exercised without waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CopyModeArbiter, layoutModeWins, COPY_TRUST_MS } from '../resources/js/copy-mode.js';

// Records what the arbiter did, and lets a test fire the pending pause timer by hand.
function arb(opts = {}) {
  const log = { sent: [], exits: 0 };
  let pending = null;
  const a = new CopyModeArbiter({
    sendKeys: (s) => log.sent.push(s),
    exitCopyMode: () => log.exits++,
    setTimer: (fn) => { pending = fn; return 1; },
    clearTimer: () => { pending = null; },
    ...opts,
  });
  // Everything the pane received, in order — the thing that actually matters.
  log.stream = () => log.sent.join('');
  log.pause = () => { const f = pending; pending = null; if (f) f(); };
  log.pausePending = () => pending !== null;
  return [a, log];
}

// Feed a string one keystroke at a time, as xterm would. Returns the keys the
// arbiter declined (which the caller would have sent itself).
function type(a, s) {
  let passedThrough = '';
  for (const ch of s) if (!a.handle(ch)) passedThrough += ch;
  return passedThrough;
}

test('a run of motions stays in copy mode and reaches tmux intact', () => {
  const [a, log] = arb();
  type(a, 'jjj');
  assert.equal(log.exits, 0, 'never leaves copy mode');
  assert.equal(log.stream(), 'jjj', 'and the motions are delivered');
});

test('a typed word leaves copy mode and lands whole, in order', () => {
  const [a, log] = arb();
  // 'h' is a motion, 'e' is not — so the word declares itself on the second key, and
  // the rest ("llo", which contains two motion letters) must NOT be re-held.
  const through = type(a, 'hello');
  assert.equal(log.exits, 1, 'copy mode is exited exactly once, not once per motion run');
  assert.equal(log.stream() + through, 'hello', 'not one character is lost or reordered');
  assert.equal(a.held, '', 'nothing is left waiting on a timer');
});

test('entering copy mode again rearms the arbiter after a typing verdict', () => {
  const [a, log] = arb();
  type(a, 'hi');                       // decides "typing" and latches
  assert.equal(a.handle('j'), false, 'still latched: keys pass straight through');

  a.reset();                           // the pane entered copy mode again
  assert.equal(a.handle('j'), true, 'arbitrating once more');
  log.pause();
  assert.equal(log.stream(), 'hij', 'and the motion is delivered as a motion');
  assert.equal(log.exits, 1, 'no second exit');
});

test('copy mode is exited BEFORE the held keys are sent, so they hit the prompt', () => {
  const order = [];
  const a = new CopyModeArbiter({
    sendKeys: (s) => order.push(`send:${s}`),
    exitCopyMode: () => order.push('exit'),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  type(a, 'hi');
  assert.deepEqual(order, ['exit', 'send:hi'], 'exit first, then the keys');
});

test('q quits copy mode itself and is passed straight through', () => {
  const [a, log] = arb();
  const through = type(a, 'q');
  assert.equal(through, 'q', 'the arbiter does not swallow it');
  assert.equal(log.exits, 0, 'and does not send its own exit — q already does that');
});

test('a lone motion is delivered once the pause says it was not a word', () => {
  const [a, log] = arb();
  a.handle('j');
  assert.equal(log.stream(), '', 'held while we wait to see if more follows');
  assert.equal(a.held, 'j');
  log.pause();
  assert.equal(log.stream(), 'j', 'released as a motion');
  assert.equal(log.exits, 0);
});

test('a word beginning with motion letters still breaks out', () => {
  // 'j','k' are motions; 'q' would be decisive, so use a word that turns typed on a
  // plain letter: "ll" are motions, "c" is not.
  const [a, log] = arb();
  const through = type(a, 'llc');
  assert.equal(log.exits, 1);
  assert.equal(log.stream() + through, 'llc', 'the held motions come back as text');
});

test('decisive keys settle a pending hold as copy-mode keys, not as typing', () => {
  const [a, log] = arb();
  a.handle('j');            // held
  const through = type(a, ' ');  // space = start selection, decisive
  assert.equal(log.exits, 0, 'stays in copy mode');
  assert.equal(log.stream(), 'j', 'the held motion is flushed as a motion');
  assert.equal(through, ' ', 'and the decisive key passes through');
});

test('escape sequences (arrow keys) are pure navigation and never trigger an exit', () => {
  const [a, log] = arb();
  const through = type2(a, ['\x1b[A', '\x1b[B', '\x1b[5~']);
  assert.equal(log.exits, 0);
  assert.equal(through, '\x1b[A\x1b[B\x1b[5~', 'passed through untouched');

  function type2(arbiter, chunks) {
    let out = '';
    for (const c of chunks) if (!arbiter.handle(c)) out += c;
    return out;
  }
});

test('a paste is content, so it leaves copy mode and is delivered in full', () => {
  const [a, log] = arb();
  a.handle('git status --porcelain');
  assert.equal(log.exits, 1);
  assert.equal(log.stream(), 'git status --porcelain');
});

test('a pending hold is flushed as typing when copy mode ends from elsewhere', () => {
  const [a, log] = arb();
  a.handle('j');
  assert.equal(a.held, 'j');
  a.flush('typing');       // e.g. tmux reported copy mode ended (toolbar pill, q, …)
  assert.equal(log.stream(), 'j', 'the held key is not swallowed');
  assert.equal(a.held, '');
});

test('a settled hold leaves no timer behind to fire later', () => {
  const [a, log] = arb();
  a.handle('j');
  assert.equal(log.pausePending(), true);
  type(a, 'x');            // typing verdict
  assert.equal(log.pausePending(), false, 'the pause timer is cancelled');
  assert.equal(a.held, '');
});

// ---------------------------------------------------------------------------
// layoutModeWins — who is right about copy mode, us or the layout poll.
//
// The browser sets the copy-mode flag optimistically (a wheel notch enters copy
// mode, a paste leaves it) and tmux reports the truth in every layout push, but
// that push is a snapshot up to a poll interval old. These decide which one to
// believe; getting it wrong in either direction is how the flag went stale, and
// a stale flag is how copy-mode-only commands reached a pane in normal mode.
// ---------------------------------------------------------------------------

test('the layout is believed when nothing was ever assumed locally', () => {
  assert.equal(layoutModeWins(0, 10_000), true);
  assert.equal(layoutModeWins(null, 10_000), true);
});

test('a fresh local assumption outranks a layout snapshot older than it', () => {
  const now = 10_000;
  assert.equal(layoutModeWins(now - 100, now), false, 'the poll cannot have seen it yet');
});

test('an assumption older than the trust window loses to the layout', () => {
  const now = 10_000;
  assert.equal(layoutModeWins(now - COPY_TRUST_MS, now), true);
  assert.equal(layoutModeWins(now - 5_000, now), true, 'a long-stale flag never wins');
});

test('the trust window covers the 500ms layout poll with margin', () => {
  assert.ok(COPY_TRUST_MS > 500, 'a snapshot from the previous poll must not win');
});
