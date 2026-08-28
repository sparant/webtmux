// A session's NEW-WINDOW MENU: the ordered list of commands its "+" buttons offer.
//
// Pure view model, import-free, so the button captions and the add/remove/edit
// arithmetic can be tested without a browser or an xterm. The wire shape is a
// contract with pkg/tmux/newcmds.go — the server derives captions the same way for
// nothing (it never draws them), but the DERIVATION RULE is shared knowledge and a
// test on each side is what keeps them saying the same thing about the same menu.

// A session with no menu still has one "+": a plain shell, which is what every
// session did before menus existed. Returned as a fresh array so callers can edit
// it without writing through to the layout they got it from.
export function menuFor(session) {
  const list = Array.isArray(session?.newCmds) ? session.newCmds : [];
  const menu = list
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({ label: String(e.label || ''), cmd: String(e.cmd || '') }));
  return menu.length ? menu : [{ label: '', cmd: '' }];
}

// The caption for one entry's button: its label if it has one, else a short name
// derived from the command.
//
// Mirrors Display() in pkg/tmux/newcmds.go — same rule, same order, tested on both
// sides. Every clause earns its place by a plausible command that got a useless
// caption without it:
//
//   1. Stop at the first shell operator. `printf ran > /tmp/marker` is "printf",
//      not "marker" — a redirect target is where output goes, not what runs.
//   2. Prefer the LAST path-shaped token (one with a '/' or an extension), because
//      the first is so often a wrapper: `run-in-daemon.sh -w /workspace
//      launch_new.sh` is "launch_new" to a person.
//   3. Otherwise the first non-flag token — `tail -F x | grep y` is "tail".
//
// Still a heuristic, which is why an explicit label always wins.
// A pipe, a list separator, or a redirect — including the fd-prefixed redirects
// that are their own token ("2>"). Whole tokens only: a redirect glued to its
// filename ("2>/dev/null") falls through to rule (3) and is named after the first
// word, which is the right answer anyway. Mirrors isShellOperator in Go.
const SHELL_OPERATORS = new Set(['|', '||', '&&', ';', '>', '>>', '<', '<<', '&', '|&']);
const isShellOperator = (t) => SHELL_OPERATORS.has(t) || /^\d+(>>?|<)$/.test(t);
const isFlag = (t) => t.startsWith('-');
const looksLikePath = (t) => t.includes('/') || /\.[^.\/]+$/.test(t);

function commandName(token) {
  const t = token.replace(/^["']+|["']+$/g, '');
  const base = t.split('/').pop();
  if (!base || base === '.' || base === '..') return '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function displayName(entry) {
  const label = String(entry?.label || '').trim();
  if (label) return label;
  const cmd = String(entry?.cmd || '').trim();
  if (!cmd) return 'shell';
  let tokens = cmd.split(/\s+/);
  const stop = tokens.findIndex(isShellOperator);
  if (stop >= 0) tokens = tokens.slice(0, stop);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!isFlag(tokens[i]) && looksLikePath(tokens[i])) {
      const name = commandName(tokens[i]);
      if (name) return name;
    }
  }
  for (const t of tokens) {
    if (!isFlag(t)) {
      const name = commandName(t);
      if (name) return name;
    }
  }
  return 'run';
}

// What the button's tooltip says. The caption is short by design, so this is the
// only place the whole command is legible — including the fact that there isn't
// one.
export function describe(entry, session) {
  const cmd = String(entry?.cmd || '').trim();
  const where = session ? ` in ${session}` : '';
  if (!cmd) return `New window${where} — a plain shell.\nDouble-click to give it a command.`;
  return `New window${where}, running:\n${cmd}\n\nDouble-click to edit · × to remove`;
}

// ---- editing arithmetic ------------------------------------------------------
// Menus are edited by replacing the whole list (one message, one tmux write), so
// these return a NEW list rather than mutating: a half-applied local edit that
// never reached the server is the failure mode to avoid.

export function withCmdAt(menu, index, cmd) {
  const out = menu.map((e) => ({ ...e }));
  if (index < 0 || index >= out.length) return out;
  out[index] = { ...out[index], cmd: String(cmd) };
  return out;
}

export function withoutIndex(menu, index) {
  return menu.filter((_, i) => i !== index).map((e) => ({ ...e }));
}

export function withAppended(menu) {
  return [...menu.map((e) => ({ ...e })), { label: '', cmd: '' }];
}

// True when the list says nothing a stored menu needs to say: one entry, no
// command, no label — i.e. exactly the default a session with NO menu already
// gets. Storing that would be indistinguishable from storing nothing, so the
// caller clears the option instead and the session keeps its single plain "+".
export function isDefaultMenu(menu) {
  return menu.length === 1 && !menu[0].cmd.trim() && !menu[0].label.trim();
}
