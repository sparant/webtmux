package tmux

import (
	"fmt"
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
// the pane is a new pty, so the process running in it is GONE and its scrollback
// with it. A pty cannot be reparented — there is no tmux command that moves a
// running process from one pane to another, and `move-pane`/`break-pane` move the
// pane object (grid, limit and all) rather than its contents. That is why
// ResizeWindowHistory refuses a pane running anything but a shell unless the
// caller says otherwise: the caller's user is the only one who can weigh it.

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

// paneIsIdle reports whether rebuilding this pane would kill anything a person
// would miss.
func paneIsIdle(command string) bool {
	c := strings.TrimPrefix(strings.TrimSpace(command), "-")
	return idleShells[c]
}

// BusyCommands lists the commands in a report that a rebuild would kill. Exposed
// so the same rule states the warning and enforces it — a confirmation dialog
// that named a different set than the server refuses on is worse than none.
func BusyCommands(panes []PaneHistory, limit int) []string {
	var busy []string
	for _, p := range panes {
		if p.Limit == limit || paneIsIdle(p.Command) {
			continue
		}
		busy = append(busy, p.Command)
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
func (c *Controller) ResizeWindowHistory(windowID string, limit int, force bool) (HistoryResize, error) {
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

	newByOld := make(map[string]string, len(todo))
	var walkErr error
	for _, p := range todo {
		args := []string{"split-window", "-d", "-P", "-F", "#{pane_id}", "-t", p.PaneID}
		if dir := paths[p.PaneID]; dir != "" {
			args = append(args, "-c", dir)
		}
		out, err := c.runTmux(args...)
		newID := strings.TrimSpace(out)
		if err != nil || newID == "" {
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
			walkErr = fmt.Errorf("%w: could not close the old pane %s", ErrRefused, p.PaneID)
			break
		}
		newByOld[p.PaneID] = newID
		res.Rebuilt++
		if !paneIsIdle(p.Command) {
			res.Restarted = append(res.Restarted, p.Command)
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
