// Osc52Stream — the OSC 52 clipboard scanner, pulled out of the output path so it
// can be tested without a DOM.
//
// WHAT OSC 52 IS AND WHY IT IS THE WHOLE FEATURE. A program running in a terminal
// cannot touch your clipboard; it can only write bytes. OSC 52 is the one portable
// way across that gap: the program writes
//
//     ESC ] 52 ; <selection> ; <base64 of the text> BEL        (or … ESC \)
//
// and the terminal emulator at the far end decodes it onto ITS clipboard. When the
// far end is webtmux, "its clipboard" is the clipboard of the machine running the
// browser — which is the machine the person is actually sitting at. That is the
// entire reason "(c to copy)" in a program on a remote box can put something on a
// local clipboard at all.
//
// WHY THIS IS A STREAM AND NOT A regex OVER ONE CHUNK. The sequence arrives inside
// pty output, which is chopped into websocket frames at arbitrary byte offsets.
// One copy is one sequence, but it is NOT necessarily one frame:
//
//   • a URL's base64 runs to several hundred bytes and a copied scrollback to
//     megabytes, so the split is normal rather than exotic;
//   • the cut can land ANYWHERE — including inside the five-byte introducer, so a
//     frame can end with a bare "\x1b]5" and the next one begin with "2;".
//
// Scanning a single chunk gets the common case and silently loses the rest: the
// copy never happens AND the fragment is painted into the terminal as mojibake.
// So an unterminated sequence (or a partial introducer) is HELD here and completed
// by the next chunk. Held bytes are not written to the terminal — they are part of
// a control sequence, not content — and are released as ordinary text if the hold
// ever turns out not to be one after all.
//
// Import-free on purpose, like copy-buffers.js and mru-order.js: this is where the
// parsing that can be got subtly wrong lives, so it has to load under
// `node --test` without a browser. The clipboard, the ring and the terminal are
// somebody else's file — see copy-buffer-store.js and terminal-unit.js.

// The introducer. Everything up to and including the semicolon after "52".
const INTRO = '\x1b]52;';

// BEL — the terminator most programs use, tmux included.
const BEL = '\x07';

// How many bytes may be held waiting for a terminator before the hold is
// abandoned and released as text.
//
// A hold is a PAUSE in the terminal output, so an introducer that never terminates
// — a truncated sequence, a program writing "\x1b]52;" as literal text — would
// otherwise freeze the pane for as long as the connection lasts. 4 MiB is far
// above any real copy and small enough that the stall is bounded.
export const MAX_HOLD = 4 * 1024 * 1024;

// The end of the OSC payload that starts at `from`: BEL, or ST (ESC \).
// Returns {end, termLen}, with end = -1 when the terminator has not arrived yet.
function findTerminator(data, from) {
  for (let i = from; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 0x07) return { end: i, termLen: 1 };
    if (c === 0x1b) {
      // ESC at the very end of what we have could be the first half of an ST —
      // that is an INCOMPLETE terminator, not a missing one, so hold and wait.
      if (i + 1 >= data.length) return { end: -1, termLen: 0 };
      if (data[i + 1] === '\\') return { end: i, termLen: 2 };
    }
  }
  return { end: -1, termLen: 0 };
}

// How many trailing characters of `tail` are a proper prefix of `INTRO` — i.e. how
// much of an introducer may have been cut off the end of this chunk. Longest match
// wins, so "…\x1b]5" holds three characters rather than one.
function danglingIntro(tail) {
  const max = Math.min(INTRO.length - 1, tail.length);
  for (let n = max; n > 0; n--) {
    if (tail.endsWith(INTRO.slice(0, n))) return n;
  }
  return 0;
}

// Decode one OSC 52 payload — "<selection>;<base64>" — to the text it carries, or
// null when there is nothing to copy.
//
// A Pd of "?" is a QUERY: the program is asking what the clipboard holds. webtmux
// answers nothing (see the note in pkg/tmux/settings.go about the trust here being
// one-directional), so it decodes to null and is stripped from the output like any
// other control sequence rather than being drawn.
function decodePayload(payload) {
  const semi = payload.indexOf(';');
  if (semi === -1) return null;
  const b64 = payload.slice(semi + 1);
  if (!b64 || b64 === '?') return null;
  try {
    // base64 -> bytes -> UTF-8. Going straight through atob would mangle every
    // non-ASCII character, and a copy that silently corrupts an accented word or
    // an emoji is worse than one that does not happen.
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    // Malformed base64 from a program that meant something else by these bytes.
    // Dropping it is right; the sequence is still stripped, because whatever it
    // was, it was not text to draw.
    return null;
  }
}

export class Osc52Stream {
  constructor({ maxHold = MAX_HOLD } = {}) {
    this._held = '';
    this._maxHold = maxHold > 0 ? maxHold : MAX_HOLD;
  }

  // Bytes currently held back waiting for the rest of a sequence. Read by tests;
  // a non-zero value between frames is normal and momentary.
  get pending() { return this._held.length; }

  // Feed one chunk of terminal output (a binary string — one char per byte).
  // Returns {text, copies}:
  //
  //   text   — what to write to the terminal: the chunk with every complete OSC 52
  //            removed and any incomplete one held back for the next call.
  //   copies — the decoded text of each complete sequence, in arrival order. More
  //            than one per chunk is possible and is not a duplicate: a program can
  //            legitimately copy twice inside one write.
  feed(chunk) {
    const data = this._held + String(chunk ?? '');
    this._held = '';
    const copies = [];
    let out = '';
    let i = 0;

    for (;;) {
      const at = data.indexOf(INTRO, i);
      if (at === -1) break;
      const { end, termLen } = findTerminator(data, at + INTRO.length);
      if (end === -1) {
        // The sequence has started but not finished. Everything before it is
        // ordinary output and goes out now; the rest waits for the next chunk.
        out += data.slice(i, at);
        const hold = data.slice(at);
        if (hold.length > this._maxHold) {
          // Not a copy anyone is waiting for. Release it as text rather than hold
          // the pane hostage — see MAX_HOLD.
          out += hold;
        } else {
          this._held = hold;
        }
        return { text: out, copies };
      }
      out += data.slice(i, at);
      const text = decodePayload(data.slice(at + INTRO.length, end));
      if (text !== null) copies.push(text);
      i = end + termLen;
    }

    // No sequence in flight — but the chunk may end PART WAY into an introducer,
    // which the indexOf above cannot see. Hold that much and no more.
    const tail = data.slice(i);
    const dangling = danglingIntro(tail);
    if (dangling) {
      out += tail.slice(0, tail.length - dangling);
      this._held = tail.slice(tail.length - dangling);
    } else {
      out += tail;
    }
    return { text: out, copies };
  }
}

// Build one OSC 52 sequence. Used by the tests, and by anything that needs to say
// what the wire form of a copy looks like rather than describe it.
export function osc52(text, { selection = 'c', st = false } = {}) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `${INTRO}${selection};${btoa(bin)}${st ? '\x1b\\' : BEL}`;
}
