// What the save dropdown says about WHERE a save will land.
//
// "Save on the machine tmux runs on" quietly assumes webtmux and tmux share a
// filesystem. They often don't: webtmux commonly runs in a container whose only
// window onto the host is the tmux control socket, so tmux reports a pane
// directory like /home/nathan/Projects that the process doing the write cannot
// see. The old hint stated the rule ("relative paths save in the focused pane's
// current directory") as though it always held, and the first sign that it
// didn't was an open(2) error naming a directory the user has a shell sitting in.
//
// The server answers "where would this land?" before a save (a SaveEnv; see
// webtty/savepath.go) and this module turns that answer into one line of
// English. It lives apart from the toolbar so it can be unit-tested: the text is
// the entire feature — a wrong-but-confident hint is worse than no hint.
//
// A SaveEnv is {paneDir, baseDir, paneVisible, mapped, container, home, writable}.

// Shown before the server has answered (and if it never does). Deliberately the
// pre-existing wording: it describes the intended rule, which is what holds
// whenever webtmux and tmux do share a filesystem.
export const DEFAULT_SAVE_HINT =
  "Relative paths save in the focused pane's current directory; ~ and absolute paths are honored as-is.";

// Build the hint for a SaveEnv. Returns {text, level} where level is 'info' for
// the boring cases and 'warn' when the destination is NOT what the label above
// the input implies — the case that has to look different, not just read
// differently.
export function saveHint(info) {
  // A directory the user named was rejected. Say why and keep asking — silently
  // falling back to somewhere else is how a file ends up nowhere they'll look.
  if (info && info.chosenError) {
    return { level: 'warn', text: `⚠ ${info.chosenError}` };
  }
  // Nothing shared to write into (a container mounting only the tmux socket —
  // the default deployment here). webtmux can't tell a bind mount from its own
  // filesystem, but the person who started the container can, so ASK rather than
  // either guessing or shutting the feature off.
  if (info && info.blocked) {
    return {
      level: 'warn',
      text: 'webtmux runs in a container and does not know a directory it shares with the machine '
        + 'tmux runs on, so a file saved now could vanish with the container. Name one above — a path '
        + 'as webtmux sees it (e.g. /workspace), mounted from outside — and it will be remembered. '
        + '"Download to browser" needs no directory at all.',
    };
  }
  if (!info || !info.baseDir) return { text: DEFAULT_SAVE_HINT, level: 'info' };

  const where = info.baseDir;
  const tail = '~ and absolute paths are honored as-is.';

  if (info.chosen && info.baseDir === info.chosen) {
    // Their own answer is in force, so this is settled — checked BEFORE the
    // pane-directory warning below, which would otherwise keep warning about a
    // question they have already answered.
    return {
      level: 'info',
      text: `Relative paths save in ${where}, the directory you chose (remembered). ${tail}`,
    };
  }

  if (!info.paneVisible) {
    // The container case. Name BOTH directories: the one the user believes they
    // are in and the one the file will actually appear in — without both, the
    // message reads as a refusal rather than an explanation.
    const why = info.container
      ? 'webtmux runs in a container and cannot see that filesystem'
      : 'that directory does not exist on the machine webtmux runs on';
    const pane = info.paneDir || "the pane's directory";
    return {
      level: 'warn',
      text: `⚠ ${pane} — ${why}. A plain file name saves in ${where} instead; "Download to browser" always works.`,
    };
  }

  if (!info.writable) {
    return {
      level: 'warn',
      text: `⚠ webtmux cannot write to ${where}. Try another directory, or "Download to browser".`,
    };
  }

  if (info.mapped) {
    // A mapping is in force, so the path in the reply is NOT the path tmux
    // reports. Say so, or the success banner's directory looks like a typo.
    return {
      level: 'info',
      text: `Relative paths save in ${where} (webtmux reaches ${info.paneDir} there). ${tail}`,
    };
  }

  return { level: 'info', text: `Relative paths save in ${where}. ${tail}` };
}

// The success banner. Normally just the path — but when the file did NOT land in
// the pane's own directory, the banner is the one thing the user is looking at,
// so it carries the reason too.
export function saveOkText(path, info) {
  const p = path || '';
  if (info && info.baseDir && !info.paneVisible && p.startsWith(info.baseDir)) {
    return `Saved: ${p}\n(not ${info.paneDir || "the pane's directory"} — webtmux cannot see it)`;
  }
  return `Saved: ${p}`;
}
