package tmux

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// The `after-rename-window` hook, as a tmux ability webtmux SHOWS you.
//
// tmux can run a command every time a window is renamed. That is a real and
// generally useful capability, and it is invisible: it lives in `show-hooks -g`,
// a command almost nobody runs, and nothing about renaming a window in webtmux
// hints that anything else happened. This section makes it a row in the link menu
// next to the status line and the clipboard — what the hook is, verbatim, which
// windows have opted into it, and a switch to stop it.
//
// WEBTMUX DOES NOT COMPOSE THE HOOK, and that is the design, not a limitation.
// The command belongs to whoever set it up: it names a script on the tmux
// server's filesystem, which webtmux (a container with the tmux socket bind-
// mounted) generally cannot see and certainly cannot validate. So the switch is
// SAVE-AND-RESTORE, exactly like the status line's: turning it off stashes the
// hook's commands in @wt_rename_hook_saved and unsets them; turning it on puts
// back what was stashed. A server with neither a hook nor a stash gets an inert
// row that says so — the honest answer, rather than an on/off control over
// something that does not exist.
//
// THE WINDOW LIST is the other half, and the reason this row is worth more than a
// checkbox. A hook fires for every window on the server, but a well-built handler
// acts only on windows that asked for it, by reading an option off the window. The
// convention this reports is @wt_rename_handler — a @wt_* option, the same
// namespace as @wt_working and @wt_state, which webtmux already reads off windows
// it did not write. Listing them answers the question the hook alone cannot:
// "which of my tabs will do something when I rename them, and what?"
//
// PER-WINDOW, the same save-and-restore applies one level down: switching a window
// off moves its handler to @wt_rename_handler_saved. Nothing here ever invents a
// handler name — a window can be turned back on only if webtmux (or the launcher)
// had one to remember.

// renameHookName is the tmux hook this section exposes. `after-<command>` hooks
// fire when the command runs, so this covers a rename from anywhere: webtmux's own
// rename-window, tmux's `,` binding, or a script.
const renameHookName = "after-rename-window"

// renameHookSavedOption holds the hook's commands while the switch is off, as a
// JSON array. An array because the hook is an ARRAY in tmux — `set-hook -a`
// appends, and several unrelated things may be hooked to the same event — and
// JSON because a command line can contain anything, newlines included, so no
// delimiter is safe to invent.
const renameHookSavedOption = "@wt_rename_hook_saved"

// renameHandlerOption is the per-window opt-in a handler reads. webtmux only
// reports and toggles it; the value's meaning belongs to whatever the hook runs.
const renameHandlerOption = "@wt_rename_handler"

// renameHandlerSavedOption is where a window's handler waits while that window is
// switched off. Same save-and-restore shape as the hook, one level down.
const renameHandlerSavedOption = "@wt_rename_handler_saved"

// renameHandlerRe is the character class a handler value must match to be shown.
//
// It is a SANITY rule, not a security one — nothing here executes the value — but
// it does two useful things. It keeps a `|` out of a non-final field of the
// enumeration below (see enumSep's note on why only one arbitrary field can be
// last). And it matches the rule the dispatcher itself applies, so a value webtmux
// displays as active is one the hook would actually accept: showing "handler:
// ../../sh" as if it were live would be a lie the menu had no way to detect.
var renameHandlerRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// RenameWindow is one window that has opted into the rename hook, as the menu
// lists it.
type RenameWindow struct {
	// ID is the tmux window id (@N) — the target a per-window toggle names, and
	// stable for the life of the server.
	ID string `json:"id"`
	// Session and Name label the row the way the sidebar labels a window. A
	// window linked into two sessions is reported once, under a real session in
	// preference to an ephemeral web-* split shadow.
	Session string `json:"session"`
	Name    string `json:"name"`
	// Handler is the value of @wt_rename_handler when the window is on, or the
	// stashed value when it is off — so the row can say what would run either way.
	Handler string `json:"handler"`
	// On is whether the window is currently opted in.
	On bool `json:"on"`
	// Pane is @wt_rename_target: the pane the handler was told to act on. Empty
	// when the window's launcher named no pane.
	Pane string `json:"pane,omitempty"`
	// Synced is whether the last name the hook pushed is the window's CURRENT
	// name. False means a rename did not make it through — the one failure this
	// list can show that no amount of reading the hook would reveal. Computed by
	// tmux (`#{==:…}`) rather than by comparing two arbitrary strings over the
	// wire, so a `|` in either cannot change the answer.
	Synced bool `json:"synced"`
}

// renameEnumFields is the field count of the window enumeration below. The only
// arbitrary field in the final slot is window_name, per enumSep's rule; the
// handler values ahead of it are constrained by renameHandlerRe, and a row whose
// handler fails that check is dropped rather than parsed on.
const renameEnumFields = 7

// readRenameHook returns the hook's commands, in tmux's own order. tmux prints
// them as `after-rename-window[0] <command>`; the index prefix is dropped, since
// what a caller wants is the command, and the index is only meaningful in the
// moment (unsetting element 0 renumbers the rest).
//
// Anchored on the `[` — `show-hooks -g` also prints `after-rename-session`, and a
// prefix match without it reports a session hook as a window one.
func readRenameHook(run tmuxRunner) ([]string, error) {
	out, err := run("show-hooks", "-g")
	if err != nil {
		return nil, err
	}
	prefix := renameHookName + "["
	var cmds []string
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		// `after-rename-window[12] run-shell …` — everything after the first
		// space that follows the `]`.
		close := strings.Index(line, "]")
		if close < 0 || close+2 > len(line) {
			continue
		}
		cmd := strings.TrimSpace(line[close+1:])
		if cmd != "" {
			cmds = append(cmds, cmd)
		}
	}
	return cmds, nil
}

// readRenameWindows lists every window carrying a rename handler — set or stashed.
//
// One fork for the windows and one for the session names, the same pair
// EnumerateWindows makes and for the same reason: a row's session arrives as an id
// so that window_name can hold the one arbitrary-text slot the format allows.
func readRenameWindows(run tmuxRunner) ([]RenameWindow, error) {
	format := strings.Join([]string{
		"#{window_id}", "#{session_id}",
		"#{" + renameHandlerOption + "}", "#{" + renameHandlerSavedOption + "}",
		"#{@wt_rename_target}",
		// tmux answers the comparison, so neither side has to survive the wire.
		"#{==:#{@wt_rename_last},#{window_name}}",
		"#{window_name}",
	}, enumSep)

	out, err := run("list-windows", "-a", "-F", format)
	if err != nil {
		return nil, err
	}
	sessOut, err := run("list-sessions", "-F", sessionsFormat)
	if err != nil {
		return nil, err
	}
	names := sessionNamesByID(parseSessionRows(sessOut))

	var found []RenameWindow
	seen := make(map[string]int) // window_id -> index in found
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, enumSep, renameEnumFields)
		if len(f) < renameEnumFields {
			continue
		}
		handler, saved := f[2], f[3]
		on := renameHandlerRe.MatchString(handler)
		if !on && !renameHandlerRe.MatchString(saved) {
			continue // not opted in, or opted in with a value the hook would refuse
		}
		shown := handler
		if !on {
			shown = saved
		}
		sess := names[f[1]]
		if sess == "" {
			continue // unnameable session: the row could be neither labelled nor targeted
		}
		w := RenameWindow{
			ID: f[0], Session: sess, Name: f[6],
			Handler: shown, On: on, Pane: f[4], Synced: f[5] == "1",
		}
		// One row per WINDOW, not per placement. A window linked into several
		// sessions is one thing to switch on or off, and an ephemeral web-* split
		// shadow is not where a person would expect to find it — so a real
		// session's placement replaces a shadow's, and the first real one wins.
		if i, dup := seen[w.ID]; dup {
			if isWebShadowName(found[i].Session) && !isWebShadowName(sess) {
				found[i] = w
			}
			continue
		}
		seen[w.ID] = len(found)
		found = append(found, w)
	}
	return found, nil
}

// readRenameForward fills in the rename half of a Settings.
//
// Best-effort throughout, like the decisions in ReadSettings: a tmux that will not
// answer a show-hooks costs this ROW its state, never the whole menu. The two
// reads are also independent — a server can have windows opted in with no hook
// installed (the launcher ran, the hook did not), and saying so is the point.
func readRenameForward(run tmuxRunner) (hook []string, saved []string, wins []RenameWindow) {
	hook, _ = readRenameHook(run)
	if raw, err := globalOption(run, renameHookSavedOption); err == nil && strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &saved)
	}
	wins, _ = readRenameWindows(run)
	return hook, saved, wins
}

// SetRenameForward turns the whole hook off (stashing it) or back on (restoring
// what was stashed).
//
// It never composes a command. Turning it on with nothing stashed is refused in
// the only way that is honest — by changing nothing and letting the re-read say
// the hook is still absent — because the alternative is guessing at a path on a
// filesystem webtmux cannot see.
func (c *Controller) SetRenameForward(on bool) (Settings, error) {
	if on {
		var saved []string
		if raw, err := globalOption(c.run, renameHookSavedOption); err == nil {
			_ = json.Unmarshal([]byte(strings.TrimSpace(raw)), &saved)
		}
		for _, cmd := range saved {
			if strings.TrimSpace(cmd) == "" {
				continue
			}
			// -a: append, so restoring joins anything hooked here since, rather
			// than replacing it. The order the commands were stashed in is kept.
			if _, err := c.runTmux("set-hook", "-ga", renameHookName, cmd); err != nil {
				return Settings{}, err
			}
		}
		// The stash is cleared only after every command is back. A restore that
		// died halfway would otherwise have thrown away the half it never wrote.
		_ = c.SetGlobalOption(renameHookSavedOption, "")
		return c.ReadSettings()
	}

	cmds, err := readRenameHook(c.run)
	if err != nil {
		return Settings{}, err
	}
	if len(cmds) == 0 {
		return c.ReadSettings() // nothing hooked; nothing to remember or remove
	}
	blob, err := json.Marshal(cmds)
	if err != nil {
		return Settings{}, err
	}
	// Remembered BEFORE the removal: a stash written after a successful unset
	// would, if it failed, leave a server with the hook gone and no record of what
	// it was — the one outcome this control must never produce.
	if err := c.SetGlobalOption(renameHookSavedOption, string(blob)); err != nil {
		return Settings{}, err
	}
	// Highest index first: unsetting an element renumbers the ones above it, so
	// removing low-to-high would skip every other entry.
	for i := len(cmds) - 1; i >= 0; i-- {
		if _, err := c.runTmux("set-hook", "-gu", renameHookName+"["+strconv.Itoa(i)+"]"); err != nil {
			return Settings{}, err
		}
	}
	return c.ReadSettings()
}

// SetWindowRenameForward switches one window's opt-in, by moving its handler
// between @wt_rename_handler and @wt_rename_handler_saved.
//
// The same save-and-restore, one level down, and for the same reason: webtmux does
// not know what handlers a server has, so the only handler it may ever set on a
// window is one it took off that window.
func (c *Controller) SetWindowRenameForward(target string, on bool) (Settings, error) {
	if !windowIDRe.MatchString(target) {
		return Settings{Error: "that is not a window id"}, nil
	}
	from, to := renameHandlerOption, renameHandlerSavedOption
	if on {
		from, to = renameHandlerSavedOption, renameHandlerOption
	}
	val, err := c.windowOption(target, from)
	if err != nil {
		return Settings{}, err
	}
	val = strings.TrimSpace(val)
	if !renameHandlerRe.MatchString(val) {
		// Nothing to move. Not an error the user needs to see as a failure — the
		// re-read below shows the window in whatever state it is actually in,
		// which is the answer to "did my click do anything?".
		return c.ReadSettings()
	}
	if _, err := c.runTmux("set-option", "-w", "-t", target, to, val); err != nil {
		return Settings{}, err
	}
	if _, err := c.runTmux("set-option", "-w", "-t", target, "-u", from); err != nil {
		return Settings{}, err
	}
	// Switching a window back ON clears the guard the hook keeps, so the next
	// rename is pushed even if it names the window what it is already called —
	// otherwise turning a window on and renaming it back would do nothing, which
	// reads as a broken switch.
	if on {
		_, _ = c.runTmux("set-option", "-w", "-t", target, "-u", "@wt_rename_last")
	}
	return c.ReadSettings()
}

// windowOption reads one window-scoped option. `-q` for the same reason
// globalOption needs it: an unset user option is an ERROR without it, and "unset"
// is the answer being asked for most of the time.
func (c *Controller) windowOption(target, name string) (string, error) {
	return optionValue(c.run, "show-options", "-w", "-t", target, "-q", "-v", name)
}

// windowIDRe is the exact form of a tmux window id. Checked because this value
// arrives from the browser and becomes a `-t` target: an ambiguous target resolves
// against the ACTIVE window, so a malformed one would silently switch the wrong
// window's opt-in rather than failing.
var windowIDRe = regexp.MustCompile(`^@[0-9]+$`)
