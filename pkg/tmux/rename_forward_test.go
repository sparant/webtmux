package tmux

import (
	"encoding/json"
	"strings"
	"testing"
)

// The `after-rename-window` row: reading what is hooked, listing the windows that
// opted in, and switching either off and back on without inventing anything.
//
// These use a runner of their own rather than fakeServer. fakeServer models
// tmux's option store and its -F rendering, neither of which is what is
// interesting here: this code's failure modes are a hook ARRAY (which fakeServer
// has no notion of), tmux's index-prefixed `show-hooks` output, and the
// renumbering that makes removing elements low-to-high skip every other one. A
// fake that models exactly those is shorter than the extension to the shared one,
// and says what it is testing.

// hookServer models the two pieces of tmux state this file touches: a global
// option map and the after-rename-window hook ARRAY. `list-windows` output is
// canned per test, since the enumeration's parsing is tested separately.
type hookServer struct {
	options map[string]string
	hooks   []string // after-rename-window, in tmux's order
	windows string   // canned list-windows output
	calls   [][]string
}

func newHookServer() *hookServer {
	return &hookServer{options: map[string]string{}}
}

func (h *hookServer) run(args ...string) (string, error) {
	h.calls = append(h.calls, args)
	switch args[0] {
	case "show-hooks":
		var b strings.Builder
		// tmux prints hooks sorted by name; after-rename-SESSION shares a prefix
		// with the one we want, and is here because a reader that matches on the
		// prefix alone reports it as a window hook.
		b.WriteString("after-rename-session run-shell -b 'not ours'\n")
		for i, cmd := range h.hooks {
			b.WriteString("after-rename-window[")
			b.WriteString(itoa(i))
			b.WriteString("] ")
			b.WriteString(cmd)
			b.WriteString("\n")
		}
		return b.String(), nil
	case "set-hook":
		switch {
		case has(args, "-ga"):
			h.hooks = append(h.hooks, args[len(args)-1])
		case has(args, "-gu"):
			// `after-rename-window[2]` — remove that element and renumber, as
			// tmux does.
			target := args[len(args)-1]
			i := hookIndex(target)
			if i >= 0 && i < len(h.hooks) {
				h.hooks = append(h.hooks[:i], h.hooks[i+1:]...)
			}
		}
		return "", nil
	case "show-options":
		return h.options[args[len(args)-1]], nil
	case "set-option":
		if has(args, "-u") {
			delete(h.options, args[len(args)-1])
			return "", nil
		}
		h.options[args[len(args)-2]] = args[len(args)-1]
		return "", nil
	case "list-windows":
		return h.windows, nil
	case "list-sessions":
		// sessionsFormat's six fields, name LAST: id|windows|attached|grouped|group|name.
		return "$0|3|1|0||services\n$1|3|1|1|services|web-abc\n", nil
	}
	return "", nil
}

func has(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

func hookIndex(target string) int {
	open := strings.Index(target, "[")
	close := strings.Index(target, "]")
	if open < 0 || close < open {
		return -1
	}
	n := 0
	for _, c := range target[open+1 : close] {
		if c < '0' || c > '9' {
			return -1
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	p := len(b)
	for i > 0 {
		p--
		b[p] = byte('0' + i%10)
		i /= 10
	}
	return string(b[p:])
}

func hookController(h *hookServer) *Controller {
	return newControllerWithRunner("services", false, "", h.run)
}

// ── reading ───────────────────────────────────────────────────────────────────

// The index prefix comes off, and after-rename-SESSION does not come along. The
// second half is the point: `after-rename-window` is a prefix of nothing, but
// `after-rename` is a prefix of both, and a HasPrefix on the hook name without the
// `[` reports a session hook as a window one.
func TestReadRenameHookDropsIndexAndOtherHooks(t *testing.T) {
	h := newHookServer()
	h.hooks = []string{`run-shell -b "/s/on-rename.sh a b"`, "run-shell -b true"}
	got, err := readRenameHook(h.run)
	if err != nil {
		t.Fatalf("readRenameHook: %v", err)
	}
	want := []string{`run-shell -b "/s/on-rename.sh a b"`, "run-shell -b true"}
	if len(got) != len(want) {
		t.Fatalf("got %d commands %q, want %d", len(got), got, len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("command %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestReadRenameHookEmptyWhenNothingHooked(t *testing.T) {
	if got, err := readRenameHook(newHookServer().run); err != nil || len(got) != 0 {
		t.Fatalf("readRenameHook = %q, %v; want empty, nil", got, err)
	}
}

// The window list: what is kept, what is dropped, and which placement wins.
func TestReadRenameWindows(t *testing.T) {
	h := newHookServer()
	h.windows = strings.Join([]string{
		// on, synced, with a pane — the ordinary row
		"@1|$0|claude-session||%7|1|claude-cli-4",
		// the same window seen again under an ephemeral web-* split shadow: one
		// window is one thing to switch, and the shadow is not where it lives
		"@1|$1|claude-session||%7|1|claude-cli-4",
		// off: no handler, but one stashed — still listed, so it can come back
		"@2|$0||claude-session||1|scratch",
		// not opted in at all
		"@3|$0||||1|plain",
		// a handler value the hook itself would refuse: not shown as live
		"@4|$0|../../../bin/sh|||1|sneaky",
		// a name containing the field separator, in the final slot where it is safe
		"@5|$0|claude-session|||0|pipes|in|name",
	}, "\n")

	got, err := readRenameWindows(h.run)
	if err != nil {
		t.Fatalf("readRenameWindows: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d windows %+v, want 3 (@1, @2, @5)", len(got), got)
	}

	if got[0].ID != "@1" || got[0].Session != "services" || !got[0].On || got[0].Pane != "%7" || !got[0].Synced {
		t.Errorf("@1 = %+v, want a live services row with pane %%7, synced", got[0])
	}
	if got[1].ID != "@2" || got[1].On || got[1].Handler != "claude-session" {
		t.Errorf("@2 = %+v, want off but remembering claude-session", got[1])
	}
	// The separator in a window NAME reaches the UI whole — that is what putting
	// the one arbitrary field last buys, and it is worth asserting rather than
	// assuming, since it is invisible until somebody names a window with a pipe.
	if got[2].Name != "pipes|in|name" {
		t.Errorf("@5 name = %q, want the whole name including its separators", got[2].Name)
	}
	// Synced=false is the state that says a rename did not propagate. It has to
	// survive as its own value; folding it into "on" would hide the one failure
	// this list can report.
	if got[2].Synced {
		t.Errorf("@5 synced = true, want false")
	}
}

// ── the global switch ─────────────────────────────────────────────────────────

// Off then on is a round trip: the same commands, in the same order. The order
// matters because a hook array is a pipeline, and restoring it shuffled is a
// different configuration wearing the same summary.
func TestRenameForwardRoundTripRestoresEveryCommandInOrder(t *testing.T) {
	h := newHookServer()
	h.hooks = []string{"run-shell -b 'first'", "run-shell -b 'second'", "run-shell -b 'third'"}
	c := hookController(h)

	if _, err := c.SetRenameForward(false); err != nil {
		t.Fatalf("off: %v", err)
	}
	if len(h.hooks) != 0 {
		t.Fatalf("after off, hooks = %q, want none", h.hooks)
	}
	var stashed []string
	if err := json.Unmarshal([]byte(h.options[renameHookSavedOption]), &stashed); err != nil {
		t.Fatalf("stash is not a JSON array: %q (%v)", h.options[renameHookSavedOption], err)
	}
	if len(stashed) != 3 {
		t.Fatalf("stashed %q, want all three", stashed)
	}

	if _, err := c.SetRenameForward(true); err != nil {
		t.Fatalf("on: %v", err)
	}
	want := []string{"run-shell -b 'first'", "run-shell -b 'second'", "run-shell -b 'third'"}
	if len(h.hooks) != len(want) {
		t.Fatalf("after on, hooks = %q, want %q", h.hooks, want)
	}
	for i := range want {
		if h.hooks[i] != want[i] {
			t.Errorf("restored hook %d = %q, want %q", i, h.hooks[i], want[i])
		}
	}
	if h.options[renameHookSavedOption] != "" {
		t.Errorf("stash = %q after restore, want cleared", h.options[renameHookSavedOption])
	}
}

// Removing has to run highest-index-first. tmux renumbers on every unset, so
// removing 0,1,2 in that order deletes the original 0 and 2 and leaves the middle
// one hooked — a switch that says "off" over a hook that still fires.
func TestRenameForwardOffRemovesEveryElement(t *testing.T) {
	h := newHookServer()
	h.hooks = []string{"a", "b", "c", "d", "e"}
	if _, err := hookController(h).SetRenameForward(false); err != nil {
		t.Fatalf("off: %v", err)
	}
	if len(h.hooks) != 0 {
		t.Fatalf("hooks = %q, want none left", h.hooks)
	}
}

// Turning it on with nothing stashed must not invent a hook. webtmux cannot see
// the filesystem the command names, so a guess would be a command that fails on
// every rename for the life of the server.
func TestRenameForwardOnWithNothingSavedHooksNothing(t *testing.T) {
	h := newHookServer()
	set, err := hookController(h).SetRenameForward(true)
	if err != nil {
		t.Fatalf("on: %v", err)
	}
	if len(h.hooks) != 0 {
		t.Fatalf("hooks = %q, want none — nothing was stashed to restore", h.hooks)
	}
	if set.RenameOn {
		t.Errorf("reported RenameOn over a server with no hook")
	}
}

// The stash is written BEFORE the removal. If it were written after, a failure
// between the two would leave the hook gone and no record of what it was — the
// one outcome from which the switch cannot recover.
func TestRenameForwardStashesBeforeItRemoves(t *testing.T) {
	h := newHookServer()
	h.hooks = []string{"run-shell -b 'x'"}
	if _, err := hookController(h).SetRenameForward(false); err != nil {
		t.Fatalf("off: %v", err)
	}
	stashAt, removeAt := -1, -1
	for i, c := range h.calls {
		if c[0] == "set-option" && len(c) > 2 && c[len(c)-2] == renameHookSavedOption {
			stashAt = i
		}
		if c[0] == "set-hook" && has(c, "-gu") && removeAt < 0 {
			removeAt = i
		}
	}
	if stashAt < 0 || removeAt < 0 {
		t.Fatalf("expected both a stash and a removal; calls = %v", h.calls)
	}
	if stashAt > removeAt {
		t.Errorf("stash at call %d, first removal at %d — the hook is removed before it is remembered", stashAt, removeAt)
	}
}

// ── the per-window switch ─────────────────────────────────────────────────────

// A window's handler MOVES between the live option and the stash. Both halves
// matter: leaving it in place would make "off" a lie, and clearing it without
// stashing would make the window unswitchable back on, since webtmux has no way
// to invent a handler name.
func TestWindowRenameForwardMovesTheHandlerBothWays(t *testing.T) {
	h := newHookServer()
	h.options[renameHandlerOption] = "claude-session"
	c := hookController(h)

	if _, err := c.SetWindowRenameForward("@3", false); err != nil {
		t.Fatalf("off: %v", err)
	}
	if h.options[renameHandlerSavedOption] != "claude-session" {
		t.Fatalf("saved = %q, want claude-session", h.options[renameHandlerSavedOption])
	}
	if _, ok := h.options[renameHandlerOption]; ok {
		t.Fatalf("live handler still set after switching the window off")
	}

	if _, err := c.SetWindowRenameForward("@3", true); err != nil {
		t.Fatalf("on: %v", err)
	}
	if h.options[renameHandlerOption] != "claude-session" {
		t.Fatalf("live handler = %q after on, want claude-session", h.options[renameHandlerOption])
	}
}

// Switching a window back ON clears the hook's own "last name pushed" guard.
// Without this, turning a window on and renaming it to what it is already called
// does nothing at all, which reads as a switch that did not work.
func TestWindowRenameForwardOnClearsTheGuard(t *testing.T) {
	h := newHookServer()
	h.options[renameHandlerSavedOption] = "claude-session"
	if _, err := hookController(h).SetWindowRenameForward("@3", true); err != nil {
		t.Fatalf("on: %v", err)
	}
	cleared := false
	for _, c := range h.calls {
		if c[0] == "set-option" && has(c, "-u") && c[len(c)-1] == "@wt_rename_last" {
			cleared = true
		}
	}
	if !cleared {
		t.Errorf("@wt_rename_last was not cleared; calls = %v", h.calls)
	}
}

// A target that is not a window id is refused rather than passed to tmux. An
// ambiguous `-t` resolves against the ACTIVE window, so this would otherwise
// switch a window the user is not looking at and report success.
func TestWindowRenameForwardRefusesANonWindowTarget(t *testing.T) {
	for _, bad := range []string{"", "services", "%4", "@", "@1x", "-t"} {
		h := newHookServer()
		h.options[renameHandlerOption] = "claude-session"
		set, err := hookController(h).SetWindowRenameForward(bad, false)
		if err != nil {
			t.Fatalf("%q: unexpected error %v", bad, err)
		}
		if set.Error == "" {
			t.Errorf("%q was accepted as a window id", bad)
		}
		if _, ok := h.options[renameHandlerSavedOption]; ok {
			t.Errorf("%q reached tmux and moved an option", bad)
		}
	}
}
