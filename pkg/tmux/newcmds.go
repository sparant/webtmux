package tmux

import (
	"encoding/json"
	"path"
	"strings"
)

// A session's NEW-WINDOW MENU: the ordered list of commands its "+" offers.
//
// A session holds windows that do the same kind of thing, but rarely only ONE
// kind: a claude-editors session wants a plain host shell, a shell inside the
// secure daemon, and "launch the next claude" — three different starting points
// for the same session. So the session carries a LIST, the sidebar draws one "+"
// per entry, and each one names what it will run.

// newCmdsOption is the per-SESSION tmux user option holding that list, as JSON.
//
// JSON, rather than a delimited string, because the payload is arbitrary command
// lines: a pipeline contains '|', a for-loop contains ';', and any single-byte
// delimiter picked here would be one somebody's command needs. @wt_state already
// establishes JSON-in-a-tmux-option in this codebase.
const newCmdsOption = "@wt_newcmds"

// NewCmd is one entry of that menu.
type NewCmd struct {
	// Label is what the "+" button shows. Optional: derived from Cmd when empty
	// (see Display), because a button captioned with a 120-character docker exec
	// is not a button. scripts/stack.sh names the entries it declares; entries
	// added in the browser name themselves.
	Label string `json:"label,omitempty"`
	// Cmd is the command line typed into the new window's shell. Empty means the
	// window is just a shell — which is a legitimate menu entry, not a missing
	// one, and is what the first "+" of a session usually wants to be.
	Cmd string `json:"cmd"`
}

// Display is the caption for this entry's button: the label if it has one, else a
// short name derived from the command.
//
// The rule, in order, and every clause is there because a plausible command got a
// useless caption without it:
//
//  1. Stop at the first shell operator. `printf ran > /tmp/marker` is "printf", not
//     "marker" — a redirect target is where output goes, not what runs. Same for
//     the right-hand side of a pipe.
//  2. Prefer the LAST path-shaped token (one with a '/' or an extension). The FIRST
//     token is so often a wrapper: `run-in-daemon.sh -w /workspace launch_new.sh`
//     is "launch_new" to a person, and taking the first would caption every daemon
//     entry the same thing.
//  3. Otherwise the first non-flag token — `tail -F x | grep y` is "tail".
//
// It is still a heuristic, which is why an explicit label always wins.
func (c NewCmd) Display() string {
	if l := strings.TrimSpace(c.Label); l != "" {
		return l
	}
	cmd := strings.TrimSpace(c.Cmd)
	if cmd == "" {
		return "shell"
	}
	fields := strings.Fields(cmd)
	// (1) truncate at the first shell operator.
	for i, f := range fields {
		if isShellOperator(f) {
			fields = fields[:i]
			break
		}
	}
	// (2) the last path-shaped token.
	for i := len(fields) - 1; i >= 0; i-- {
		if f := fields[i]; !strings.HasPrefix(f, "-") && looksLikePath(f) {
			if name := commandName(f); name != "" {
				return name
			}
		}
	}
	// (3) the first token that is not a flag.
	for _, f := range fields {
		if !strings.HasPrefix(f, "-") {
			if name := commandName(f); name != "" {
				return name
			}
		}
	}
	return "run"
}

// isShellOperator reports whether a token ends the part of a command line that
// says what RUNS — a pipe, a list separator, or a redirect, including the
// fd-prefixed redirects that are their own token ("2>").
//
// Whole tokens only: a redirect GLUED to its filename ("2>/dev/null") is left
// alone, because properly splitting shell syntax is not this function's job and a
// caption is not worth a tokenizer. Such a command falls through to rule (3) and is
// named after its first word, which is the right answer anyway.
func isShellOperator(f string) bool {
	switch f {
	case "|", "||", "&&", ";", ">", ">>", "<", "<<", "&", "|&":
		return true
	}
	// "2>", "2>>", "10<" — digits then a redirect, nothing else.
	i := 0
	for i < len(f) && f[i] >= '0' && f[i] <= '9' {
		i++
	}
	if i == 0 || i == len(f) {
		return false
	}
	switch f[i:] {
	case ">", ">>", "<":
		return true
	}
	return false
}

// looksLikePath reports whether a token names a file: it has a directory part or
// an extension. Used to tell `launch_new.sh` from `-w` and from `error`.
func looksLikePath(f string) bool {
	return strings.Contains(f, "/") || path.Ext(f) != ""
}

// commandName reduces a token to the name a person would use for it: basename,
// extension removed, surrounding quotes stripped.
func commandName(f string) string {
	f = strings.Trim(f, `"'`)
	base := path.Base(f)
	if base == "" || base == "." || base == ".." || base == "/" {
		return ""
	}
	if ext := path.Ext(base); ext != "" && ext != base {
		base = strings.TrimSuffix(base, ext)
	}
	return base
}

// encodeNewCmds renders the menu for storage in a tmux option.
//
// TWO characters are written as \uXXXX escapes rather than themselves, and
// neither is cosmetic — each one would otherwise destroy the whole menu:
//
//   - '$', because tmux 3.4 rewrites a '$' in an option value to '\$'. Measured,
//     on every read path, with no input that round-trips one:
//     'A$B' reads back 'A\$B'; 'A\$B' reads back 'A\\$B'. And '\$' is not a legal
//     JSON escape, so one dollar in one command makes the menu unparseable and
//     every button on the session vanishes.
//   - the layout field separator '|', because the menu shares a `list-sessions -F`
//     line with another field and is split off from the LEFT. A command containing
//     a pipeline — which is most of the interesting ones — would otherwise take
//     the split with it. JSON is self-delimiting but not separator-free; assuming
//     otherwise is exactly the bug this comment exists to stop returning.
//
// Both are invisible to tmux and to the splitter, and any JSON decoder puts them
// back. tmux 3.3a escapes nothing; this is correct on both, with no version
// sniffing. Newlines and control bytes need no handling here: json.Marshal has
// already escaped them, which is the other half of why the transport is JSON.
func encodeNewCmds(cmds []NewCmd) (string, error) {
	if len(cmds) == 0 {
		return "", nil
	}
	b, err := json.Marshal(cmds)
	if err != nil {
		return "", err
	}
	// Safe as textual passes: after Marshal both characters only ever occur inside
	// a JSON string literal (the keys are fixed and contain neither), so each one
	// is a character to escape rather than syntax.
	out := strings.ReplaceAll(string(b), "$", `\u0024`)
	// Derived from sessionsSep so the two cannot drift apart.
	return strings.ReplaceAll(out, sessionsSep, `\u007c`), nil
}

// decodeNewCmds parses a stored menu. A value that is not a JSON array is not an
// error worth propagating — it is an option somebody set by hand, or one written
// by a newer webtmux — so it yields no menu rather than breaking the layout.
func decodeNewCmds(raw string) []NewCmd {
	raw = strings.TrimSpace(raw)
	if raw == "" || !strings.HasPrefix(raw, "[") {
		return nil
	}
	var cmds []NewCmd
	if err := json.Unmarshal([]byte(raw), &cmds); err != nil {
		return nil
	}
	out := make([]NewCmd, 0, len(cmds))
	for _, c := range cmds {
		// A '$' that tmux escaped anyway (an option set by hand, pre-encoding) is
		// left exactly as it is: guessing would corrupt a deliberate backslash.
		out = append(out, NewCmd{Label: strings.TrimSpace(c.Label), Cmd: strings.TrimSpace(c.Cmd)})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// legacyNewCmd adapts the single-command option this feature shipped with
// (@wt_newcmd, a bare string) into a one-entry menu.
//
// Read only when @wt_newcmds is absent, so a session configured before the list
// existed keeps working until something rewrites it — which matters because the
// sessions carrying one are live and the value was set by a stack.sh run that may
// not have happened again yet.
func legacyNewCmd(raw string) []NewCmd {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.HasPrefix(raw, "#{") {
		return nil
	}
	return []NewCmd{{Cmd: raw}}
}
