package tmux

import (
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
)

// Scrollback accounting, and the one way tmux lets you change it.
//
// A tmux pane's history is a fixed-capacity ring: `history-limit` lines, decided
// ONCE when the pane is created, from the session option in force at that moment.
// Nothing that happens afterwards moves it. `set-option -g history-limit 50000`
// is not a resize — it is a change to what the NEXT pane will be built with, and
// the pane you were looking at when you typed it keeps the size it was born with
// until it dies. That was measured, not assumed (tmux 3.3a):
//
//	set-option -g history-limit N   existing pane: unchanged. new pane: N.  ✓
//	set-option -p history-limit N   existing pane: unchanged.
//	respawn-pane -k                 existing pane: unchanged (keeps its old limit).
//
// So "resize this window's buffer" cannot be a command; it has to be a REBUILD.
// For each pane: create a new pane (which is born with the new limit), then kill
// the old one. tmux inserts the new pane immediately after its source, so the
// pane ORDER survives — but the geometry does not, because killing a pane hands
// its rows back to the whole window rather than to its former neighbour. Hence
// the layout string is recorded first, re-labelled with the new pane ids, and
// re-applied (see relabelLayout).
//
// What a rebuild costs is stated here because it is the part no UI can soften:
// the pane is a new pty, so the process running in it is GONE. A pty cannot be
// reparented — there is no tmux command that moves a running process from one
// pane to another, and `move-pane`/`break-pane` move the pane object (grid,
// limit and all) rather than its contents. Moving a process between ptys is an
// OS operation (reptyr does it, via ptrace); it is deliberately not attempted
// here, because it needs a permissive kernel ptrace_scope and an external
// binary, and its failure mode is a program orphaned on a pty nothing reads.
// So ResizeWindowHistory refuses a pane running anything but a shell unless the
// caller says otherwise: the caller's user is the only one who can weigh it.
//
// The SCROLLBACK, though, does not have to be lost, and isn't. The old pane is
// captured whole and replayed into its replacement, so a resize keeps every line
// and its colours — see launchCommand. It goes through a tmux BUFFER rather than
// a temp file on purpose: the buffer lives in the tmux server, so the text never
// has to cross a filesystem that webtmux and tmux might not share (the
// containerized deployment savepath.go exists for).

// The bounds a requested limit must fall in. Zero is meaningful to tmux (keep no
// history at all) and so is allowed; the ceiling is a guard against a typo
// turning into hundreds of megabytes per pane, not a tmux limitation.
const (
	HistoryLimitMin = 0
	HistoryLimitMax = 1000000
)

// PaneHistory is one pane's scrollback accounting: how big its buffer is, how
// much of it holds anything, and what is running in it (which is what decides
// whether rebuilding it is destructive).
type PaneHistory struct {
	PaneID string `json:"paneId"`
	Index  int    `json:"index"`
	Active bool   `json:"active"`
	// Limit is #{history_limit}: this pane's actual capacity in lines, NOT the
	// option. The two disagree the moment the option is changed, and the whole
	// point of showing it is that the disagreement is invisible otherwise.
	Limit int `json:"limit"`
	// Size is #{history_size}: lines currently held in the history (the visible
	// screen is not part of it). Bytes is #{history_bytes}, what they cost.
	Size    int   `json:"size"`
	Bytes   int64 `json:"bytes"`
	Command string `json:"command"`
	// StartCommand is #{pane_start_command}: what tmux itself LAUNCHED this pane
	// with, un-quoted back into something runnable. Empty for a plain shell pane —
	// and empty for anything you started by typing at a prompt, which tmux never
	// saw. It is what lets a rebuild put the pane back as it was rather than as a
	// bare shell; see ResizeWindowHistory's `rerun`.
	StartCommand string `json:"startCommand"`
}

// HistoryReport is what one window's scrollback looks like right now, plus the
// two numbers that decide what the NEXT pane will get.
type HistoryReport struct {
	WindowID string `json:"windowId"`
	// Global is `show-options -g history-limit` — the server-wide default.
	Global int `json:"global"`
	// Default is what a new pane in THIS window's session would actually be born
	// with: the global value unless the session overrides it. They are reported
	// separately because a session-scope override is otherwise a silent reason for
	// "I set the default and nothing changed".
	Default int           `json:"default"`
	Panes   []PaneHistory `json:"panes"`
	// ConfigFiles is `#{config_files}` — the tmux config this server actually
	// loaded, or "" when it loaded none. It is the third scope of "the default",
	// and the only one that survives `kill-server`: Global answers "what will the
	// next WINDOW get", this answers "what will the next tmux SERVER get". They are
	// different questions and a panel that showed only the first would keep sending
	// people back to a config file it never mentioned.
	ConfigFiles string `json:"configFiles"`
}

// HistoryResize is the outcome of a rebuild — deliberately a count of what
// happened rather than a bare error/nil, because a rebuild can be partial (a
// pane too small to split stops the walk) and "it worked" would then be a lie
// about the panes that were left alone.
type HistoryResize struct {
	Rebuilt int `json:"rebuilt"`
	// Skipped is panes that already had the requested limit — nothing was killed
	// for them, which is worth saying when the total is smaller than the window.
	Skipped int `json:"skipped"`
	// Restarted names the non-shell commands that were killed to do it. The client
	// has already shown these in a confirmation; echoing them back is what makes
	// the result a receipt rather than a promise.
	Restarted []string `json:"restarted"`
	// Rerun names the launch commands that were started again in the rebuilt panes.
	Rerun []string `json:"rerun"`
	// Replayed is how many rebuilt panes carried their old scrollback across. It
	// is reported separately from Rebuilt because the two can differ — a pane whose
	// capture fails is still rebuilt, just empty — and "your history came with it"
	// is the claim a user most needs to be true rather than assumed.
	Replayed int `json:"replayed"`
	// LayoutRestored is false when the geometry could not be put back (an
	// unparseable layout, or tmux rejecting the re-labelled one). The panes are
	// correct either way; only their sizes are not.
	LayoutRestored bool `json:"layoutRestored"`
}

// histSep / histFields: the same discipline as EnumerateWindows' format — machine
// fields first, the one free-form field LAST and parsed with SplitN, so a '|' in
// it cannot shift any other column. pane_current_path is NOT in this row: it is
// the second free-form field and only one of them can hold the final slot, so it
// is read separately (panePaths) where a pane id can delimit it unambiguously.
const histSep = "|"
const histFields = 7

// historyPanes reads every pane of a window with its scrollback accounting, in
// pane-index order (which is also layout order — see relabelLayout).
func historyPanes(run tmuxRunner, windowID string) ([]PaneHistory, error) {
	format := strings.Join([]string{
		"#{pane_index}", "#{pane_id}", "#{pane_active}",
		"#{history_limit}", "#{history_size}", "#{history_bytes}",
		"#{pane_current_command}",
	}, histSep)
	out, err := run("list-panes", "-t", windowID, "-F", format)
	if err != nil {
		return nil, err
	}
	var panes []PaneHistory
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, histSep, histFields)
		if len(f) < histFields {
			continue
		}
		idx, _ := strconv.Atoi(f[0])
		limit, _ := strconv.Atoi(f[3])
		size, _ := strconv.Atoi(f[4])
		bytes, _ := strconv.ParseInt(f[5], 10, 64)
		panes = append(panes, PaneHistory{
			PaneID:  f[1],
			Index:   idx,
			Active:  f[2] == "1",
			Limit:   limit,
			Size:    size,
			Bytes:   bytes,
			Command: f[6],
		})
	}
	return panes, nil
}

// panePaths maps pane id -> working directory, for giving a rebuilt pane the
// directory its predecessor was sitting in. Its own fork because a path is
// free-form: the pane id goes first (ids are "%N", no spaces) and everything
// after the first space is the path, so a path containing anything at all —
// spaces, '|', a newline is impossible since tmux prints one row per pane —
// survives intact.
func panePaths(run tmuxRunner, windowID string) map[string]string {
	out, err := run("list-panes", "-t", windowID, "-F", "#{pane_id} #{pane_current_path}")
	if err != nil {
		return nil
	}
	paths := make(map[string]string)
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		i := strings.IndexByte(line, ' ')
		if i <= 0 {
			continue
		}
		if dir := strings.TrimSpace(line[i+1:]); dir != "" {
			paths[line[:i]] = dir
		}
	}
	return paths
}

// paneStartCommands maps pane id -> the command tmux LAUNCHED that pane with,
// ready to run again. Its own fork for the same reason panePaths is one: a launch
// command is free-form (it can contain the field separator, since a shell
// pipeline is a perfectly ordinary thing to launch a pane with), so it needs the
// last slot of a row, and only one field can have it.
//
// Two transformations on the way out, both of which matter:
//
//   - tmux reports the value in its DISPLAY form — wrapped in quotes, with inner
//     quotes escaped. Handing that to a shell would try to run a command whose
//     name is the whole quoted string. unquoteStartCommand puts it back.
//   - a pane that webtmux itself rebuilt was launched with the replay prefix in
//     front of its real command (see launchCommand), so that is stripped. Without
//     it every rebuild would nest one more prefix inside the last one.
func paneStartCommands(run tmuxRunner, windowID string) map[string]string {
	out, err := run("list-panes", "-t", windowID, "-F", "#{pane_id} #{pane_start_command}")
	if err != nil {
		return nil
	}
	cmds := make(map[string]string)
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		i := strings.IndexByte(line, ' ')
		if i <= 0 {
			continue
		}
		if cmd := stripReplayPrefix(unquoteStartCommand(line[i+1:])); cmd != "" {
			cmds[line[:i]] = cmd
		}
	}
	return cmds
}

// unquoteStartCommand turns tmux's displayed form of a launch command back into
// the command itself: one layer of surrounding double quotes off, and the escapes
// inside undone. Verified to round-trip against a live tmux — re-launching a pane
// with the result yields a pane whose own #{pane_start_command} matches the
// original exactly.
func unquoteStartCommand(raw string) string {
	s := strings.TrimSpace(raw)
	if len(s) >= 2 && strings.HasPrefix(s, `"`) && strings.HasSuffix(s, `"`) {
		s = s[1 : len(s)-1]
	}
	s = strings.ReplaceAll(s, `\"`, `"`)
	s = strings.ReplaceAll(s, `\\`, `\`)
	return strings.TrimSpace(s)
}

// sessionIDOfWindow resolves the session a window target lands in, as a
// #{session_id} ("$3").
//
// The id, never the name: `set-option -t` is the one session-targeting command
// with no exact-match syntax (see exactSession's note — it rejects "=name"), so
// a name would be resolved by PREFIX and a session called "dev" would write the
// option of "dev-2". An id cannot be mistaken for another session.
func sessionIDOfWindow(run tmuxRunner, windowID string) (string, error) {
	// `-t` before `-p`, matching the rest of the package: the format is a
	// POSITIONAL argument to -p, so putting the target between them is what lets a
	// reader (and the test fake) tell the format from the next flag.
	out, err := run("display-message", "-t", windowID, "-p", "#{session_id}")
	if err != nil {
		return "", err
	}
	sid := strings.TrimSpace(out)
	if sid == "" {
		return "", fmt.Errorf("%w: could not tell which session %s is in", ErrRefused, windowID)
	}
	return sid, nil
}

// optionValue reads one option as tmux prints it (`show-options -v`), trimmed.
// An unset option at the asked-for scope prints nothing and is NOT an error —
// "" is the answer meaning "inherits from a wider scope".
func optionValue(run tmuxRunner, args ...string) (string, error) {
	out, err := run(args...)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// globalHistoryLimit is the server-wide default (`set-option -g`).
func globalHistoryLimit(run tmuxRunner) (int, error) {
	v, err := optionValue(run, "show-options", "-g", "-v", "history-limit")
	if err != nil {
		return 0, err
	}
	n, _ := strconv.Atoi(v)
	return n, nil
}

// effectiveHistoryLimit is what a pane created in this session RIGHT NOW would
// be born with: -A resolves the inheritance chain, so it answers with the
// session's own value if it has one and the global otherwise.
func effectiveHistoryLimit(run tmuxRunner, sessionID string) (int, error) {
	v, err := optionValue(run, "show-options", "-v", "-A", "-t", sessionID, "history-limit")
	if err != nil {
		return 0, err
	}
	n, _ := strconv.Atoi(v)
	return n, nil
}

// ownHistoryLimit is the session's OWN value, or "" when it merely inherits.
// The distinction is what lets a temporary override be undone exactly: restoring
// an inherited option by writing back the number it resolved to would silently
// pin the session to today's global forever.
func ownHistoryLimit(run tmuxRunner, sessionID string) string {
	v, _ := optionValue(run, "show-options", "-v", "-t", sessionID, "history-limit")
	return v
}

// buildHistoryReport assembles one window's answer. Read-only: three
// `list-panes`/`show-options`/`display-message` forks, no state touched.
func buildHistoryReport(run tmuxRunner, windowID string) (HistoryReport, error) {
	rep := HistoryReport{WindowID: windowID}
	panes, err := historyPanes(run, windowID)
	if err != nil {
		return rep, err
	}
	if starts := paneStartCommands(run, windowID); len(starts) > 0 {
		for i := range panes {
			panes[i].StartCommand = starts[panes[i].PaneID]
		}
	}
	rep.Panes = panes
	if g, err := globalHistoryLimit(run); err == nil {
		rep.Global = g
		rep.Default = g
	}
	// The session's effective value is the one that actually decides new panes;
	// a failure to resolve it leaves the global standing rather than reporting 0.
	if sid, err := sessionIDOfWindow(run, windowID); err == nil {
		if d, err := effectiveHistoryLimit(run, sid); err == nil && d > 0 {
			rep.Default = d
		}
	}
	rep.ConfigFiles, _ = optionValue(run, "display-message", "-p", "#{config_files}")
	return rep, nil
}

// HistoryReport is the CaptureStore's read of one window's scrollback state.
//
// It lives on the store rather than on the Controller for the same reason
// PaneCurrentPath does: it is server-global and read-only, so it is the half a
// connection started without `-w` is still allowed to ask for. Seeing how full a
// buffer is asks nothing of anyone.
func (s *CaptureStore) HistoryReport(windowID string) (HistoryReport, error) {
	return buildHistoryReport(s.run, windowID)
}

// ---- rebuild --------------------------------------------------------------

// idleShells are the commands a pane can be running and still be considered
// EMPTY — a prompt waiting for you, whose loss on a rebuild costs nothing but
// the shell's own in-memory history. Anything else (an editor, an agent, a build,
// an ssh session) is work, and killing it needs the user's word.
//
// Matched on #{pane_current_command}, which is the FOREGROUND process's name: a
// shell that has `vim` in the foreground reports "vim", so this correctly reads
// as busy. A login shell reports with a leading '-' on some systems.
var idleShells = map[string]bool{
	"bash": true, "zsh": true, "sh": true, "dash": true, "fish": true,
	"ksh": true, "mksh": true, "ash": true, "csh": true, "tcsh": true,
}

// paneIsIdle reports whether a pane's FOREGROUND command is just a prompt.
func paneIsIdle(command string) bool {
	c := strings.TrimPrefix(strings.TrimSpace(command), "-")
	return idleShells[c]
}

// paneIsWork is the question the confirmation actually asks: would rebuilding
// this pane destroy something?
//
// #{pane_current_command} alone gets this wrong in one important shape. A pane
// launched as `sh -c "…"` reports `sh`, which reads as an idle prompt — so a
// long-running script started that way would have been rebuilt with no
// confirmation at all. A pane tmux was given a command for is not a bare shell by
// definition, whatever its foreground process happens to be called, and its
// #{pane_start_command} says so.
func paneIsWork(p PaneHistory) bool {
	return !paneIsIdle(p.Command) || p.StartCommand != ""
}

// workName is what the confirmation calls this pane's work. A launch command is
// more use than a process name when there is one ("sh -c \"deploy.sh\"" rather
// than a bare "sh"), and it is what a re-run would put back.
func workName(p PaneHistory) string {
	if p.StartCommand != "" {
		return p.StartCommand
	}
	return p.Command
}

// BusyCommands lists the commands in a report that a rebuild would kill. Exposed
// so the same rule states the warning and enforces it — a confirmation dialog
// that named a different set than the server refuses on is worse than none.
func BusyCommands(panes []PaneHistory, limit int) []string {
	var busy []string
	for _, p := range panes {
		if p.Limit == limit || !paneIsWork(p) {
			continue
		}
		busy = append(busy, workName(p))
	}
	return busy
}

// SetDefaultHistoryLimit sets what NEW windows and panes are born with
// (`set-option -g history-limit`). It changes no existing pane — see the file
// comment; that is what ResizeWindowHistory is for.
//
// It writes the global scope, then checks whether the caller's session actually
// resolves to the new number: a session-scope override shadows the global, and
// the failure mode without this check is the worst kind — the option is set, the
// command succeeded, and new windows keep coming up at the old size with nothing
// anywhere saying why. When that is the case the session's own value is brought
// along, so "set the default" means what it says where the user is standing.
func (c *Controller) SetDefaultHistoryLimit(windowID string, limit int) error {
	if limit < HistoryLimitMin || limit > HistoryLimitMax {
		return fmt.Errorf("%w: a history limit of %d is outside %d..%d",
			ErrRefused, limit, HistoryLimitMin, HistoryLimitMax)
	}
	val := strconv.Itoa(limit)
	if _, err := c.runTmux("set-option", "-g", "history-limit", val); err != nil {
		return err
	}
	if windowID == "" {
		return nil
	}
	sid, err := sessionIDOfWindow(c.run, windowID)
	if err != nil {
		return nil // the global write stands; we just can't check the session
	}
	if eff, err := effectiveHistoryLimit(c.run, sid); err == nil && eff != limit {
		_, _ = c.runTmux("set-option", "-t", sid, "history-limit", val)
	}
	return nil
}

// ---- the default that outlives the server ----------------------------------
//
// `set-option -g history-limit` lasts exactly as long as the tmux SERVER does.
// Kill it — a reboot, a `tmux kill-server`, the last client detaching from a
// server started with a `-` exit — and the next one comes up at whatever
// tmux.conf says, which is why "I set this last week and it's back to 2000" is
// such a common experience. Making it stick means editing the config file.
//
// Two things make that harder than it sounds, and both are answered by doing the
// work INSIDE tmux:
//
//   - The file is on the machine tmux runs on, which need not be the machine
//     webtmux runs on. webtmux is routinely a container with a mounted socket and
//     no sight of the host's home directory (savepath.go). Writing "~/.tmux.conf"
//     from here would confidently edit the wrong file.
//   - Which file it even IS depends on that same filesystem: tmux reads
//     ~/.config/tmux/tmux.conf or ~/.tmux.conf, plus a system-wide one, and only
//     something standing there can look.
//
// `run-shell` runs a command on the tmux SERVER, so both problems dissolve: the
// script below chooses the file, rewrites it, and reports back through a tmux
// user option — a round trip entirely within the tmux server, which webtmux then
// reads like any other option. Measured, not assumed: a fresh server started
// after this comes up at the written value.

// historyConfOption is where the config-writing script leaves its verdict:
// "ok|<path>" or "err|<path>|<why>". A user option rather than the command's
// output because run-shell's output goes to a pane, not to the caller.
const historyConfOption = "@wt_history_conf"

// PersistDefaultHistoryLimit writes `set -g history-limit N` into the tmux config
// file, so a tmux server started later comes up with it — and applies it to the
// running server too, since a control that saved a default the current session
// disagreed with would be its own kind of confusing.
//
// Returns the path actually written.
func (c *Controller) PersistDefaultHistoryLimit(windowID string, limit int) (string, error) {
	if limit < HistoryLimitMin || limit > HistoryLimitMax {
		return "", fmt.Errorf("%w: a history limit of %d is outside %d..%d",
			ErrRefused, limit, HistoryLimitMin, HistoryLimitMax)
	}
	// The live server first: if this fails the config write would be a promise
	// about a future that the present already contradicts.
	if err := c.SetDefaultHistoryLimit(windowID, limit); err != nil {
		return "", err
	}
	// Clear the verdict before asking, so a leftover from an earlier attempt can
	// never be read as this one's answer.
	if _, err := c.runTmux("set-option", "-g", historyConfOption, ""); err != nil {
		return "", err
	}
	files, _ := optionValue(c.run, "display-message", "-p", "#{config_files}")
	if _, err := c.runTmux("run-shell", persistScript(splitConfigFiles(files), limit)); err != nil {
		return "", err
	}
	verdict, _ := optionValue(c.run, "show-options", "-g", "-v", historyConfOption)
	_, _ = c.runTmux("set-option", "-g", "-u", historyConfOption)

	kind, path, why := parseConfVerdict(verdict)
	switch kind {
	case "ok":
		return path, nil
	case "err":
		return path, fmt.Errorf("%w: could not write %s (%s)", ErrRefused, path, why)
	}
	// No verdict at all: run-shell went through but the script never reported.
	// Say so rather than claiming a write nobody has seen evidence of.
	return "", fmt.Errorf("%w: tmux ran the update but did not confirm it — "+
		"check your tmux config by hand", ErrRefused)
}

// splitConfigFiles turns `#{config_files}` (comma-separated) into candidates.
func splitConfigFiles(files string) []string {
	var out []string
	for _, f := range strings.Split(files, ",") {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// parseConfVerdict reads "ok|<path>" / "err|<path>|<why>".
func parseConfVerdict(v string) (kind, path, why string) {
	parts := strings.SplitN(strings.TrimSpace(v), "|", 3)
	if len(parts) < 2 || (parts[0] != "ok" && parts[0] != "err") {
		return "", "", ""
	}
	why = "unknown reason"
	if len(parts) == 3 && parts[2] != "" {
		why = parts[2]
	}
	return parts[0], parts[1], why
}

// persistScript is the sh program run ON THE TMUX SERVER to update the config.
//
// It picks the file the way tmux would: the config tmux actually loaded, if one
// of them is the user's own — a system-wide /etc/tmux.conf is deliberately not
// edited, since it is not this user's to change and would alter it for everyone.
// With no config file at all it creates one, preferring ~/.config/tmux/tmux.conf
// when that directory already exists and ~/.tmux.conf otherwise.
//
// The rewrite drops any existing history-limit line and appends the new one, via
// a temp file and a rename, so an interrupted write cannot leave a truncated
// config — the file that decides how the user's tmux behaves is not one to write
// in place. Everything else in it is passed through untouched. The line moves to
// the end, which is also what makes it idempotent: run it twice and there is
// still exactly one.
func persistScript(candidates []string, limit int) string {
	var b strings.Builder
	b.WriteString("set -u\nconf=\n")
	if len(candidates) > 0 {
		b.WriteString("for f in")
		for _, c := range candidates {
			b.WriteString(" " + shellQuote(c))
		}
		b.WriteString("; do case \"$f\" in \"$HOME\"/*) conf=$f;; esac; done\n")
	}
	b.WriteString(`if [ -z "$conf" ]; then
  if [ -d "$HOME/.config/tmux" ]; then conf=$HOME/.config/tmux/tmux.conf; else conf=$HOME/.tmux.conf; fi
fi
report() { tmux set-option -g ` + historyConfOption + ` "$1"; }
mkdir -p "$(dirname "$conf")" 2>/dev/null
if ! touch "$conf" 2>/dev/null; then report "err|$conf|no permission to write it"; exit 0; fi
tmp=$conf.webtmux-new
if { grep -vE '^[[:space:]]*set(-option)?[[:space:]]+(-g[[:space:]]+)?history-limit([[:space:]]|$)' "$conf" 2>/dev/null; ` +
		`echo ` + shellQuote(fmt.Sprintf("set -g history-limit %d  # webtmux", limit)) + `; } > "$tmp" && mv "$tmp" "$conf"; then
  report "ok|$conf"
else
  rm -f "$tmp" 2>/dev/null
  report "err|$conf|write failed"
fi
`)
	return b.String()
}

// ClearWindowHistory empties every pane's scrollback in one window
// (`clear-history`), leaving the visible screen and the running processes alone.
//
// Per PANE, not per window: `clear-history -t @N` clears only the window's ACTIVE
// pane, so a split window would have kept most of its history while reporting
// that it had been cleared.
func (c *Controller) ClearWindowHistory(windowID string) error {
	panes, err := historyPanes(c.run, windowID)
	if err != nil {
		return err
	}
	if len(panes) == 0 {
		return fmt.Errorf("%w: window %s has no panes", ErrRefused, windowID)
	}
	var firstErr error
	for _, p := range panes {
		if _, err := c.runTmux("clear-history", "-t", p.PaneID); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// ResizeWindowHistory rebuilds every pane of a window so it holds `limit` lines.
//
// The dance, and why each step is there:
//
//  1. Point the SESSION option at the new limit. It has to be the session (not
//     the global) because that is the scope a new pane reads, and a session with
//     its own value would ignore a global write.
//  2. For each pane that isn't already the right size: split it (the new pane is
//     born with the new limit and inherits the old one's directory), then kill
//     the old one. tmux places the new pane immediately after its source, so the
//     pane ORDER is preserved for free.
//  3. Put the option back EXACTLY as it was — including "it was inherited", which
//     is why ownHistoryLimit distinguishes an unset option from one that happens
//     to hold the global's number. A resize of one window must not quietly become
//     a change to the default; that is a separate button.
//  4. Re-apply the recorded layout with the pane ids re-labelled, because killing
//     a pane redistributes its rows across the whole window rather than to the
//     replacement standing next to it.
//  5. Re-select whichever pane was active, since killing it moved the selection.
//
// `force` is the user's answer to "this kills what is running". Without it a
// window holding anything but shells is refused rather than guessed at.
func (c *Controller) ResizeWindowHistory(windowID string, limit int, force, rerun bool) (HistoryResize, error) {
	var res HistoryResize
	if limit < HistoryLimitMin || limit > HistoryLimitMax {
		return res, fmt.Errorf("%w: a history limit of %d is outside %d..%d",
			ErrRefused, limit, HistoryLimitMin, HistoryLimitMax)
	}
	panes, err := historyPanes(c.run, windowID)
	if err != nil {
		return res, err
	}
	if len(panes) == 0 {
		return res, fmt.Errorf("%w: window %s has no panes", ErrRefused, windowID)
	}
	// Read the launch commands HERE rather than trusting the report the caller was
	// looking at: it is as old as the dropdown has been open, and this is the
	// moment panes are about to be replaced on the strength of what it says. They
	// feed BOTH decisions below — whether a pane counts as work at all, and
	// whether it can be put back as it was.
	starts := paneStartCommands(c.run, windowID)
	for i := range panes {
		panes[i].StartCommand = starts[panes[i].PaneID]
	}

	var todo []PaneHistory
	for _, p := range panes {
		if p.Limit == limit {
			res.Skipped++
			continue
		}
		todo = append(todo, p)
	}
	if len(todo) == 0 {
		return res, nil // already the requested size; nothing was killed to say so
	}
	if !force {
		if busy := BusyCommands(todo, limit); len(busy) > 0 {
			return res, fmt.Errorf("%w: rebuilding this window would kill %s — "+
				"tmux cannot move a running program into a new pane",
				ErrRefused, strings.Join(busy, ", "))
		}
	}

	sid, err := sessionIDOfWindow(c.run, windowID)
	if err != nil {
		return res, err
	}
	// Record the geometry BEFORE anything is killed; there is no way to recover it
	// afterwards.
	layoutBefore, _ := optionValue(c.run, "display-message", "-t", windowID, "-p", "#{window_layout}")
	paths := panePaths(c.run, windowID)
	activeBefore := ""
	for _, p := range panes {
		if p.Active {
			activeBefore = p.PaneID
		}
	}

	own := ownHistoryLimit(c.run, sid)
	if _, err := c.runTmux("set-option", "-t", sid, "history-limit", strconv.Itoa(limit)); err != nil {
		return res, err
	}
	defer func() {
		// Unconditional: every path out of here — success, a failed split, a panic
		// unwinding — must leave the session's option exactly as it was found.
		if own == "" {
			_, _ = c.runTmux("set-option", "-u", "-t", sid, "history-limit")
		} else {
			_, _ = c.runTmux("set-option", "-t", sid, "history-limit", own)
		}
	}()

	shellCmd := c.defaultPaneCommand(sid)
	// Which panes may be put back as they were, rather than as bare shells.
	relaunch := map[string]string{}
	if rerun {
		for _, p := range Relaunchable(todo, limit) {
			relaunch[p.PaneID] = p.StartCommand
		}
	}
	newByOld := make(map[string]string, len(todo))
	var walkErr error
	for _, p := range todo {
		args := []string{"split-window", "-d", "-P", "-F", "#{pane_id}", "-t", p.PaneID}
		if dir := paths[p.PaneID]; dir != "" {
			args = append(args, "-c", dir)
		}
		// Capture the old pane BEFORE anything can destroy it, and hand the
		// replacement a command that plays it back. A capture that fails is not a
		// reason to abandon the resize — it costs the history, which is exactly
		// what the old behaviour cost every time — so it degrades to a plain shell.
		replay := c.captureForReplay(p.PaneID)
		// A pane tmux launched with a command comes back running it; anything else
		// comes back as the shell a new pane would be. Note what this is NOT: the
		// program is RESTARTED, not preserved — see the file comment on why nothing
		// can preserve it — so the decision belongs to the caller's user, and
		// `rerun` is their answer.
		cmd := shellCmd
		if rc := relaunch[p.PaneID]; rc != "" {
			cmd = rc
		}
		if replay != "" || cmd != shellCmd {
			args = append(args, launchCommand(replay, cmd, cmd == shellCmd))
		}
		out, err := c.runTmux(args...)
		newID := strings.TrimSpace(out)
		if err != nil || newID == "" {
			c.dropBuffer(replay)
			// The commonest cause by far: the pane is too short to divide. Stop
			// rather than press on — the panes already rebuilt are correct, and the
			// count in the result says how far it got.
			walkErr = fmt.Errorf("%w: could not make a new pane for %s (it may be too "+
				"small to split — make the window bigger and try again)", ErrRefused, p.PaneID)
			break
		}
		if _, err := c.runTmux("kill-pane", "-t", p.PaneID); err != nil {
			// The replacement exists but its predecessor survived, so the window now
			// has one pane too many. Take the new one back out: a failed resize that
			// leaves a stray shell behind is worse than one that changed nothing.
			_, _ = c.runTmux("kill-pane", "-t", newID)
			c.dropBuffer(replay)
			walkErr = fmt.Errorf("%w: could not close the old pane %s", ErrRefused, p.PaneID)
			break
		}
		newByOld[p.PaneID] = newID
		res.Rebuilt++
		if replay != "" {
			res.Replayed++
		}
		if rc := relaunch[p.PaneID]; rc != "" {
			res.Rerun = append(res.Rerun, rc)
		} else if paneIsWork(p) {
			// Only the ones that did NOT come back are "restarted" in the sense the
			// receipt means: work that is simply gone.
			res.Restarted = append(res.Restarted, workName(p))
		}
	}

	if res.Rebuilt > 0 {
		// Re-label the ORIGINAL layout: every pane maps to its replacement, and one
		// that was skipped (or never reached) maps to itself.
		ids := make([]string, 0, len(panes))
		for _, p := range panes {
			if n, ok := newByOld[p.PaneID]; ok {
				ids = append(ids, n)
			} else {
				ids = append(ids, p.PaneID)
			}
		}
		if relabelled, err := relabelLayout(layoutBefore, ids); err == nil {
			if _, err := c.runTmux("select-layout", "-t", windowID, relabelled); err == nil {
				res.LayoutRestored = true
			}
		}
		if activeBefore != "" {
			target := activeBefore
			if n, ok := newByOld[activeBefore]; ok {
				target = n
			}
			_, _ = c.runTmux("select-pane", "-t", target)
		}
		c.RefreshLayout()
	}
	return res, walkErr
}

// ---- carrying the scrollback across ----------------------------------------
//
// A rebuilt pane is a new pty with an empty grid, so without this a resize costs
// you the very thing you were resizing to keep more of. There is no way to hand
// tmux a history — a grid is only ever filled by output — so the old buffer is
// REPLAYED: captured whole (colours included) and printed into the replacement
// before its shell starts. What lands in the new pane's history is a faithful
// transcript rather than the original grid, which for a scrollback is the same
// thing: it is text you scroll back through either way.
//
// It travels in a tmux BUFFER, not a temp file. The buffer lives in the tmux
// server's memory, so the text is written and read entirely on the machine tmux
// runs on — webtmux never has to have a filesystem in common with it. That is not
// hypothetical: webtmux is routinely containerized against a mounted socket, with
// the host's home directory nowhere in sight (see savepath.go).

// replayBufferName is the buffer one pane's rebuild uses. Derived from the pane
// id so two panes rebuilt in the same walk cannot collide, and so a leftover from
// a crashed rebuild is overwritten rather than accumulating.
func replayBufferName(paneID string) string {
	return "wt-replay-" + strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, paneID)
}

// captureForReplay snapshots a pane's whole buffer into a tmux buffer and returns
// its name, or "" if the capture failed (in which case the rebuild simply starts
// the new pane empty — a lost history is not worth abandoning the resize over).
//
// `-e` keeps the colours: the replay is `cat`-ed into a terminal, so the SGR
// sequences are interpreted rather than shown, and the old output comes back
// looking like itself.
func (c *Controller) captureForReplay(paneID string) string {
	name := replayBufferName(paneID)
	if _, err := c.runTmux("capture-pane", "-e", "-S", "-", "-b", name, "-t", paneID); err != nil {
		log.Printf("could not capture %s for replay (rebuilding it empty): %v", paneID, err)
		return ""
	}
	return name
}

// dropBuffer discards a replay buffer whose pane never got rebuilt.
func (c *Controller) dropBuffer(name string) {
	if name == "" {
		return
	}
	_, _ = c.runTmux("delete-buffer", "-b", name)
}

// replayJoint separates the replay preamble from the command the pane is really
// there to run. It is a marker rather than a mere `;` because tmux REMEMBERS the
// whole line as the pane's #{pane_start_command}: without something to cut on,
// every rebuild would read the last rebuild's preamble back as part of the
// command and nest one more copy inside it.
//
// `:` is the shell's no-op builtin, so the marker costs nothing and — unlike a
// `#` comment — does not swallow the rest of the line.
const replayJoint = "; : wt-replay; exec "

// shellJoint marks the other case: the pane is simply a shell, and its command is
// only there because the replay had to be prefixed to something. Distinguishing
// the two is what keeps a rebuilt SHELL from looking like a pane tmux was told to
// run `/bin/bash -l` in — which would make it "work" to the busy check and offer a
// pointless "re-run" for it.
const shellJoint = "; : wt-shell; exec "

// launchCommand is what a replacement pane is spawned with: replay the captured
// buffer if there is one, then become `cmd`.
//
// `tmux save-buffer -b <name> -` writes the buffer to stdout — the pane's own
// terminal — which is what puts those lines into the NEW pane's history. It is
// run from inside the pane, so it reaches the right server through $TMUX with no
// socket path to get wrong, and it runs where the pane runs.
//
// Every step is failure-tolerant. A tmux that isn't on PATH, a buffer that went
// missing: the redirections swallow it and the `exec` still happens, so the worst
// case is the pane you would have had anyway. What must NEVER happen is a pane
// that fails to start its command.
//
// With no buffer to replay the command is passed through ALONE, so the pane's
// #{pane_start_command} reads exactly as it would for a natively created pane.
func launchCommand(buffer, cmd string, isShell bool) string {
	if buffer == "" {
		return cmd
	}
	joint := replayJoint
	if isShell {
		joint = shellJoint
	}
	b := shellQuote(buffer)
	return fmt.Sprintf("tmux save-buffer -b %s - 2>/dev/null; tmux delete-buffer -b %s 2>/dev/null%s%s",
		b, b, joint, cmd)
}

// stripReplayPrefix recovers the real command from a pane webtmux rebuilt, or ""
// when the pane is one webtmux rebuilt as a plain shell.
func stripReplayPrefix(cmd string) string {
	if strings.Contains(cmd, shellJoint) {
		return ""
	}
	if i := strings.Index(cmd, replayJoint); i >= 0 {
		return strings.TrimSpace(cmd[i+len(replayJoint):])
	}
	return cmd
}

// defaultPaneCommand is what tmux itself would have run in a new pane: the
// session's default-command if it has one, else its shell as a LOGIN shell —
// which is what tmux does when default-command is empty. Reproducing that is the
// difference between a rebuilt pane that behaves like a new one and one that
// quietly skipped the user's profile.
func (c *Controller) defaultPaneCommand(sessionID string) string {
	if cmd, _ := optionValue(c.run, "show-options", "-v", "-A", "-t", sessionID, "default-command"); cmd != "" {
		return cmd
	}
	shell, _ := optionValue(c.run, "show-options", "-v", "-A", "-t", sessionID, "default-shell")
	if shell == "" {
		// tmux always has a default-shell, so this is only reachable on a tmux too
		// old to report it; the pane's own $SHELL is the same answer by another route.
		return `"${SHELL:-/bin/sh}" -l`
	}
	return shellQuote(shell) + " -l"
}

// Relaunchable is the subset of a rebuild that could be put back as it was: panes
// doing real work that tmux knows the launch command for. Exposed so the browser
// names exactly what it is offering to restart and the server acts on the same
// set — the same discipline as BusyCommands.
//
// An IDLE pane is never in it, even when it has a start command (a pane webtmux
// rebuilt records one): a shell comes back as a shell either way, so offering to
// "re-run" it would be a checkbox that does nothing anyone can see.
func Relaunchable(panes []PaneHistory, limit int) []PaneHistory {
	var out []PaneHistory
	for _, p := range panes {
		if p.Limit == limit || p.StartCommand == "" {
			continue
		}
		out = append(out, p)
	}
	return out
}

// shellQuote wraps a value for the `sh -c` line tmux runs a pane command through.
// Single quotes, with the one escape single quotes have: end, quote, resume.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// ---- layout re-labelling ---------------------------------------------------

// layoutLeaf matches a LEAF cell of a tmux layout string: "WxH,x,y,<pane id>".
// Container cells look identical up to the coordinates and then open a bracket
// ("120x40,0,0[…]" / "{…}") instead of carrying an id, so requiring a digit after
// the final comma is what tells the two apart.
var layoutLeaf = regexp.MustCompile(`(\d+x\d+,\d+,\d+,)(\d+)`)

// layoutChecksum is tmux's own layout checksum (layout-custom.c): a 16-bit
// rotate-and-add over the layout body. select-layout validates it, so a
// re-labelled layout has to carry a recomputed one — tmux rejects the string
// outright otherwise, and the geometry silently stays as the rebuild left it.
func layoutChecksum(body string) uint16 {
	var csum uint16
	for _, ch := range []byte(body) {
		csum = (csum >> 1) + ((csum & 1) << 15)
		csum += uint16(ch)
	}
	return csum
}

// relabelLayout rewrites a layout string's pane ids, in order, to `ids`.
//
// The order is the load-bearing part: a layout string lists its leaves in the
// same order tmux numbers panes (#{pane_index}), so the k-th id in the string is
// the k-th pane in list-panes output. Callers pass the replacement for each pane
// in that same order.
//
// `ids` are tmux pane ids ("%7"); the layout carries the bare number.
func relabelLayout(layout string, ids []string) (string, error) {
	body := strings.TrimSpace(layout)
	if body == "" {
		return "", fmt.Errorf("no layout to re-apply")
	}
	// Drop the leading "xxxx," checksum; it is recomputed from the result.
	if i := strings.IndexByte(body, ','); i >= 0 {
		body = body[i+1:]
	}
	if got := len(layoutLeaf.FindAllStringIndex(body, -1)); got != len(ids) {
		return "", fmt.Errorf("layout has %d panes, got %d replacements", got, len(ids))
	}
	n := 0
	var bad error
	out := layoutLeaf.ReplaceAllStringFunc(body, func(m string) string {
		sub := layoutLeaf.FindStringSubmatch(m)
		id := strings.TrimPrefix(ids[n], "%")
		n++
		if id == "" {
			bad = fmt.Errorf("empty pane id in layout replacement")
			return m
		}
		return sub[1] + id
	})
	if bad != nil {
		return "", bad
	}
	return fmt.Sprintf("%04x,%s", layoutChecksum(out), out), nil
}
