package tmux

import (
	"errors"
	"strings"
	"testing"
)

// The properties this file pins down are the ones that make the scrollback
// controls TRUE rather than merely present:
//
//   - a rebuild must not become a change to the default (the option it needs is
//     borrowed and given back);
//   - it must not be reachable by accident on a window doing real work;
//   - it must put the geometry back, which needs tmux's own layout checksum;
//   - and a "clear" must reach every pane, not just the one you can see.

// historyServer is oneSessionServer with a THREE-pane window, since every
// interesting property of a rebuild (order, layout, partial failure) needs more
// than one pane to be visible at all.
func historyServer() *fakeServer {
	f := &fakeServer{
		sessions: []map[string]string{{
			"session_id": "$0", "session_name": "services", "session_windows": "1",
			"session_attached": "1",
		}},
		windows: []map[string]string{{
			"window_id": "@0", "window_index": "0", "window_active": "1",
			"window_name": "shell", "session_id": "$0", "session_name": "services",
			"window_layout": "ce52,120x40,0,0[120x20,0,0{60x20,0,0,0,59x20,61,0,2},120x19,0,21,1]",
		}},
		panes: []map[string]string{
			{"pane_id": "%0", "pane_index": "0", "pane_active": "1",
				"history_limit": "2000", "history_size": "1200", "history_bytes": "98000",
				"pane_current_command": "bash", "pane_current_path": "/srv/app",
				"window_id": "@0", "session_id": "$0", "session_name": "services"},
			{"pane_id": "%2", "pane_index": "1", "pane_active": "0",
				"history_limit": "2000", "history_size": "40", "history_bytes": "3000",
				"pane_current_command": "zsh", "pane_current_path": "/tmp",
				"window_id": "@0", "session_id": "$0", "session_name": "services"},
			{"pane_id": "%1", "pane_index": "2", "pane_active": "0",
				"history_limit": "2000", "history_size": "0", "history_bytes": "700",
				"pane_current_command": "bash", "pane_current_path": "/",
				"window_id": "@0", "session_id": "$0", "session_name": "services"},
		},
		options: map[string]string{"global/history-limit": "2000"},
	}
	return f
}

func historyController(f *fakeServer) *Controller {
	return newControllerWithRunner("services", false, "", f.run)
}

// A report has to state the PANE's capacity, not the option's value — they are
// different numbers the moment anyone changes the option, and the difference is
// the thing the panel exists to show.
func TestHistoryReportSeparatesPaneLimitFromTheDefault(t *testing.T) {
	f := historyServer()
	f.options["global/history-limit"] = "50000" // raised after the panes were born

	rep, err := buildHistoryReport(f.run, "@0")
	if err != nil {
		t.Fatal(err)
	}
	if rep.Default != 50000 || rep.Global != 50000 {
		t.Errorf("default/global = %d/%d, want 50000/50000", rep.Default, rep.Global)
	}
	if len(rep.Panes) != 3 {
		t.Fatalf("got %d panes, want 3", len(rep.Panes))
	}
	for _, p := range rep.Panes {
		if p.Limit != 2000 {
			t.Errorf("pane %s reports limit %d — an existing pane keeps the size it "+
				"was born with; reporting the option instead is the confusion this panel exists to end",
				p.PaneID, p.Limit)
		}
	}
	if rep.Panes[0].Size != 1200 || rep.Panes[0].Bytes != 98000 {
		t.Errorf("usage not read: %+v", rep.Panes[0])
	}
}

// A session-scope override shadows the global, so "set the default" has to check
// that it actually took effect where the user is standing.
func TestSetDefaultFollowsThroughASessionOverride(t *testing.T) {
	f := historyServer()
	f.options["$0/history-limit"] = "500" // this session ignores the global
	c := historyController(f)

	if err := c.SetDefaultHistoryLimit("@0", 50000); err != nil {
		t.Fatal(err)
	}
	if got := f.options["global/history-limit"]; got != "50000" {
		t.Errorf("global = %q, want 50000", got)
	}
	if got := f.options["$0/history-limit"]; got != "50000" {
		t.Errorf("session override left at %q — the global write would have been a "+
			"no-op the user could not see", got)
	}
}

// …and when nothing shadows it, the session is left alone: a global default that
// silently pins itself to every session is a different setting than the one asked for.
func TestSetDefaultLeavesAnUnshadowedSessionAlone(t *testing.T) {
	f := historyServer()
	c := historyController(f)

	if err := c.SetDefaultHistoryLimit("@0", 12345); err != nil {
		t.Fatal(err)
	}
	if _, pinned := f.options["$0/history-limit"]; pinned {
		t.Errorf("session pinned to %q; it should still be inheriting the global",
			f.options["$0/history-limit"])
	}
}

func TestSetDefaultRefusesAnOutOfRangeLimit(t *testing.T) {
	f := historyServer()
	c := historyController(f)
	if err := c.SetDefaultHistoryLimit("@0", HistoryLimitMax+1); !errors.Is(err, ErrRefused) {
		t.Errorf("err = %v, want a refusal", err)
	}
	if n := f.count("set-option"); n != 0 {
		t.Errorf("%d set-option calls; an out-of-range limit must not reach tmux", n)
	}
}

// The rebuild, end to end: every pane replaced by one born with the new limit,
// in the same order, with the geometry put back.
func TestResizeRebuildsEveryPaneAtTheNewLimit(t *testing.T) {
	f := historyServer()
	c := historyController(f)

	res, err := c.ResizeWindowHistory("@0", 50000, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Rebuilt != 3 || res.Skipped != 0 {
		t.Errorf("rebuilt/skipped = %d/%d, want 3/0", res.Rebuilt, res.Skipped)
	}
	if len(res.Restarted) != 0 {
		t.Errorf("restarted %v — all three panes were idle shells", res.Restarted)
	}
	panes, err := historyPanes(f.run, "@0")
	if err != nil {
		t.Fatal(err)
	}
	if len(panes) != 3 {
		t.Fatalf("window has %d panes, want 3", len(panes))
	}
	for _, p := range panes {
		if p.Limit != 50000 {
			t.Errorf("pane %s limit %d, want 50000", p.PaneID, p.Limit)
		}
	}
	// Each new pane inherits the directory of the one it replaced: a rebuilt shell
	// that lands in $HOME instead of where you were working is its own small loss.
	paths := panePaths(f.run, "@0")
	want := []string{"/srv/app", "/tmp", "/"}
	for i, p := range panes {
		if paths[p.PaneID] != want[i] {
			t.Errorf("pane %d landed in %q, want %q", i, paths[p.PaneID], want[i])
		}
	}
	if !res.LayoutRestored {
		t.Error("layout not restored — killing a pane redistributes its rows across " +
			"the whole window, so a rebuild without this silently resizes the user's panes")
	}
}

// The option a rebuild borrows has to be given back EXACTLY — including the fact
// that the session had none of its own.
func TestResizeRestoresTheSessionOptionItBorrowed(t *testing.T) {
	f := historyServer()
	c := historyController(f)

	if _, err := c.ResizeWindowHistory("@0", 50000, false); err != nil {
		t.Fatal(err)
	}
	if v, pinned := f.options["$0/history-limit"]; pinned {
		t.Errorf("session left pinned at %q — resizing ONE window quietly became a "+
			"change to the default for every new one", v)
	}
	if got := f.options["global/history-limit"]; got != "2000" {
		t.Errorf("global = %q, want it untouched at 2000", got)
	}
}

func TestResizeRestoresASessionsOwnValue(t *testing.T) {
	f := historyServer()
	f.options["$0/history-limit"] = "500"
	c := historyController(f)

	if _, err := c.ResizeWindowHistory("@0", 50000, false); err != nil {
		t.Fatal(err)
	}
	if got := f.options["$0/history-limit"]; got != "500" {
		t.Errorf("session option = %q, want its original 500 back", got)
	}
}

// A window running real work is refused without the user's word, and — the part
// that matters — nothing is killed on the way to saying so.
func TestResizeRefusesToKillRunningWorkWithoutForce(t *testing.T) {
	f := historyServer()
	f.panes[1]["pane_current_command"] = "claude"
	c := historyController(f)

	res, err := c.ResizeWindowHistory("@0", 50000, false)
	if !errors.Is(err, ErrRefused) {
		t.Fatalf("err = %v, want a refusal", err)
	}
	if !strings.Contains(err.Error(), "claude") {
		t.Errorf("refusal %q does not name what would be killed", err)
	}
	if res.Rebuilt != 0 || f.count("kill-pane") != 0 || f.count("split-window") != 0 {
		t.Errorf("the refusal was not free: rebuilt=%d kill-pane=%d split-window=%d",
			res.Rebuilt, f.count("kill-pane"), f.count("split-window"))
	}
}

func TestResizeWithForceRebuildsAndReportsWhatItKilled(t *testing.T) {
	f := historyServer()
	f.panes[1]["pane_current_command"] = "claude"
	c := historyController(f)

	res, err := c.ResizeWindowHistory("@0", 50000, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Rebuilt != 3 {
		t.Errorf("rebuilt %d, want 3", res.Rebuilt)
	}
	if len(res.Restarted) != 1 || res.Restarted[0] != "claude" {
		t.Errorf("restarted = %v, want [claude] — the receipt has to name what it cost",
			res.Restarted)
	}
}

// Panes already the right size are left running. Rebuilding them would kill a
// shell for no change at all.
func TestResizeSkipsPanesAlreadyAtTheLimit(t *testing.T) {
	f := historyServer()
	f.panes[0]["history_limit"] = "50000"
	c := historyController(f)

	res, err := c.ResizeWindowHistory("@0", 50000, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Rebuilt != 2 || res.Skipped != 1 {
		t.Errorf("rebuilt/skipped = %d/%d, want 2/1", res.Rebuilt, res.Skipped)
	}
	for _, argv := range f.argv("kill-pane") {
		if argv[len(argv)-1] == "%0" {
			t.Error("killed %0, which already had the requested limit")
		}
	}
}

func TestResizeToTheSizeItAlreadyIsChangesNothing(t *testing.T) {
	f := historyServer()
	c := historyController(f)

	res, err := c.ResizeWindowHistory("@0", 2000, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Rebuilt != 0 || res.Skipped != 3 {
		t.Errorf("rebuilt/skipped = %d/%d, want 0/3", res.Rebuilt, res.Skipped)
	}
	if f.count("split-window")+f.count("kill-pane")+f.count("set-option") != 0 {
		t.Error("a no-op resize still touched tmux")
	}
}

// A split that fails (the pane is too short to divide) stops the walk and says
// how far it got, rather than reporting a resize that only half happened.
func TestResizeStopsAndReportsWhenAPaneCannotBeSplit(t *testing.T) {
	f := historyServer()
	f.fail = map[string]error{"split-window": errors.New("no space for new pane")}
	c := historyController(f)

	res, err := c.ResizeWindowHistory("@0", 50000, false)
	if !errors.Is(err, ErrRefused) {
		t.Fatalf("err = %v, want a refusal explaining the failure", err)
	}
	if res.Rebuilt != 0 {
		t.Errorf("rebuilt %d, want 0", res.Rebuilt)
	}
	if f.count("kill-pane") != 0 {
		t.Error("killed a pane after failing to create its replacement")
	}
	if v, pinned := f.options["$0/history-limit"]; pinned {
		t.Errorf("session left pinned at %q after a failed resize", v)
	}
}

// Clearing has to reach every pane: `clear-history -t @N` only clears the ACTIVE
// one, so a split window would have kept most of its history while the UI said
// it was empty.
func TestClearReachesEveryPaneNotJustTheActiveOne(t *testing.T) {
	f := historyServer()
	c := historyController(f)

	if err := c.ClearWindowHistory("@0"); err != nil {
		t.Fatal(err)
	}
	var targets []string
	for _, argv := range f.argv("clear-history") {
		targets = append(targets, argv[len(argv)-1])
	}
	want := []string{"%0", "%2", "%1"}
	if len(targets) != len(want) {
		t.Fatalf("cleared %v, want one call per pane %v", targets, want)
	}
	for i, tgt := range targets {
		if tgt != want[i] {
			t.Errorf("clear-history[%d] targeted %q, want %q", i, tgt, want[i])
		}
	}
}

// ---- layout re-labelling ---------------------------------------------------

// The checksum is tmux's, not ours: select-layout validates it, so a value we
// merely believe in would be rejected and the geometry would silently stay as the
// rebuild left it. These two pairs were read off a live tmux 3.3a.
func TestLayoutChecksumMatchesTmux(t *testing.T) {
	cases := []struct {
		body string
		want uint16
	}{
		{"120x40,0,0[120x10,0,0,0,120x9,0,11,2,120x19,0,21,1]", 0x9d15},
		{"120x40,0,0[120x20,0,0{60x20,0,0,0,59x20,61,0,2},120x19,0,21,1]", 0xce52},
	}
	for _, tc := range cases {
		if got := layoutChecksum(tc.body); got != tc.want {
			t.Errorf("checksum(%s) = %04x, want %04x", tc.body, got, tc.want)
		}
	}
}

func TestRelabelLayoutRewritesPaneIdsInOrder(t *testing.T) {
	in := "ce52,120x40,0,0[120x20,0,0{60x20,0,0,0,59x20,61,0,2},120x19,0,21,1]"
	got, err := relabelLayout(in, []string{"%3", "%4", "%5"})
	if err != nil {
		t.Fatal(err)
	}
	want := "ce6e,120x40,0,0[120x20,0,0{60x20,0,0,3,59x20,61,0,4},120x19,0,21,5]"
	if got != want {
		t.Errorf("relabelLayout =\n  %s\nwant\n  %s", got, want)
	}
}

// A container cell ("120x40,0,0[") looks like a leaf up to its last comma. Taking
// it for one would rewrite the window's dimensions into a pane id.
func TestRelabelLayoutIgnoresContainerCells(t *testing.T) {
	in := "ce52,120x40,0,0[120x20,0,0{60x20,0,0,0,59x20,61,0,2},120x19,0,21,1]"
	got, err := relabelLayout(in, []string{"%3", "%4", "%5"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "120x40,0,0[") {
		t.Errorf("the root cell was rewritten: %s", got)
	}
}

// A mismatched count is a refusal, not a best effort: a layout applied with the
// wrong ids moves panes to each other's places.
func TestRelabelLayoutRefusesAMismatchedPaneCount(t *testing.T) {
	in := "ce52,120x40,0,0[120x20,0,0{60x20,0,0,0,59x20,61,0,2},120x19,0,21,1]"
	if _, err := relabelLayout(in, []string{"%3", "%4"}); err == nil {
		t.Error("accepted 2 replacements for a 3-pane layout")
	}
	if _, err := relabelLayout("", []string{"%3"}); err == nil {
		t.Error("accepted an empty layout")
	}
}

// ---- what counts as busy ---------------------------------------------------

func TestPaneIsIdleOnlyForShells(t *testing.T) {
	for _, cmd := range []string{"bash", "zsh", "-bash", "fish", " sh "} {
		if !paneIsIdle(cmd) {
			t.Errorf("%q should count as an idle shell", cmd)
		}
	}
	for _, cmd := range []string{"vim", "claude", "ssh", "go", "less", ""} {
		if paneIsIdle(cmd) {
			t.Errorf("%q should count as work worth confirming before killing", cmd)
		}
	}
}

// BusyCommands is what the confirmation names AND what the server refuses on, so
// it must ignore panes that are not going to be touched at all.
func TestBusyCommandsIgnoresPanesAlreadyAtTheLimit(t *testing.T) {
	panes := []PaneHistory{
		{PaneID: "%0", Command: "vim", Limit: 50000},
		{PaneID: "%1", Command: "claude", Limit: 2000},
		{PaneID: "%2", Command: "bash", Limit: 2000},
	}
	got := BusyCommands(panes, 50000)
	if len(got) != 1 || got[0] != "claude" {
		t.Errorf("BusyCommands = %v, want [claude]", got)
	}
}

// ---- carrying the scrollback across ----------------------------------------

// The rebuild must capture each pane BEFORE destroying it, and hand the
// replacement something that prints it back. Without this a resize costs you the
// very thing you resized to keep more of.
func TestResizeCapturesEachPaneAndReplaysItIntoTheReplacement(t *testing.T) {
	f := historyServer()
	c := historyController(f)

	res, err := c.ResizeWindowHistory("@0", 50000, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Replayed != 3 {
		t.Errorf("replayed %d of %d rebuilt panes", res.Replayed, res.Rebuilt)
	}
	captured := map[string]bool{}
	for _, argv := range f.argv("capture-pane") {
		// The whole buffer, colours included, into a buffer of its own.
		if !contains(argv, "-S") || !contains(argv, "-") || !contains(argv, "-e") {
			t.Errorf("capture-pane %v does not read the whole buffer with colours", argv)
		}
		captured[flagValue(argv, "-t")] = true
	}
	for _, id := range []string{"%0", "%2", "%1"} {
		if !captured[id] {
			t.Errorf("pane %s was destroyed without being captured first", id)
		}
	}
	// …and the split carries the command that plays it back.
	for _, argv := range f.argv("split-window") {
		last := argv[len(argv)-1]
		if !strings.Contains(last, "save-buffer") || !strings.Contains(last, "exec ") {
			t.Errorf("split-window's command is not a replay-then-shell: %q", last)
		}
	}
}

// A capture that fails costs the history, not the resize. The old behaviour lost
// the history every time, so falling back to it is never worse.
func TestResizeStillRebuildsWhenTheCaptureFails(t *testing.T) {
	f := historyServer()
	f.fail = map[string]error{"capture-pane": errors.New("nope")}
	c := historyController(f)

	res, err := c.ResizeWindowHistory("@0", 50000, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Rebuilt != 3 {
		t.Errorf("rebuilt %d, want 3 — a failed capture must not abandon the resize", res.Rebuilt)
	}
	if res.Replayed != 0 {
		t.Errorf("replayed %d with every capture failing", res.Replayed)
	}
	for _, argv := range f.argv("split-window") {
		if strings.Contains(argv[len(argv)-1], "save-buffer") {
			t.Error("a pane that could not be captured was still told to replay a buffer")
		}
	}
}

// The replay command must fail SAFE: whatever goes wrong, the pane still becomes
// a shell. A pane that dies on a bad replay is worse than one with no history.
func TestReplayCommandAlwaysEndsInAShell(t *testing.T) {
	cmd := replayCommand("wt-replay-3", "exec '/bin/zsh' -l")
	if !strings.HasSuffix(cmd, "exec '/bin/zsh' -l") {
		t.Errorf("replay command does not end by becoming the shell: %q", cmd)
	}
	if strings.Count(cmd, "2>/dev/null") != 2 {
		t.Errorf("the tmux calls are not failure-tolerant: %q", cmd)
	}
	// `;` not `&&`: a failed replay must not swallow the shell.
	if strings.Contains(cmd, "&&") {
		t.Errorf("a failed replay would skip the shell: %q", cmd)
	}
}

func TestReplayBufferNameIsPerPane(t *testing.T) {
	if a, b := replayBufferName("%0"), replayBufferName("%12"); a == b {
		t.Errorf("two panes share the replay buffer %q — one would overwrite the other", a)
	}
	if got := replayBufferName("%12"); got != "wt-replay-12" {
		t.Errorf("replayBufferName(%%12) = %q", got)
	}
}

// ---- the default that outlives the server ----------------------------------

func TestPersistWritesTheConfigAndTheLiveDefault(t *testing.T) {
	f := historyServer()
	f.options["global/config_files"] = ""
	f.windows[0]["config_files"] = "/home/me/.tmux.conf"
	f.runShellVerdict = "ok|/home/me/.tmux.conf"
	c := historyController(f)

	path, err := c.PersistDefaultHistoryLimit("@0", 50000)
	if err != nil {
		t.Fatal(err)
	}
	if path != "/home/me/.tmux.conf" {
		t.Errorf("reported %q as the file it wrote", path)
	}
	// The live server too: a saved default the current session disagrees with is
	// its own kind of confusing.
	if f.options["global/history-limit"] != "50000" {
		t.Errorf("global history-limit = %q, want the live server updated as well",
			f.options["global/history-limit"])
	}
	if f.count("run-shell") != 1 {
		t.Errorf("run-shell called %d times", f.count("run-shell"))
	}
	// The verdict option is cleaned up, so it never lingers as tmux state of ours.
	if v := f.options["global/"+historyConfOption]; v != "" {
		t.Errorf("%s left behind as %q", historyConfOption, v)
	}
}

// A write that fails must not be reported as a save. The user would go on
// believing their setting survives a restart when it does not.
func TestPersistReportsAFailedWrite(t *testing.T) {
	f := historyServer()
	f.runShellVerdict = "err|/etc/tmux.conf|no permission to write it"
	c := historyController(f)

	if _, err := c.PersistDefaultHistoryLimit("@0", 50000); err == nil {
		t.Fatal("a failed config write was reported as success")
	} else if !strings.Contains(err.Error(), "no permission") {
		t.Errorf("error %q does not carry the reason", err)
	}
}

// No verdict at all means the script never ran to completion. Claiming a write
// nobody saw evidence of is the one answer that must not be given.
func TestPersistWithNoVerdictIsNotASuccess(t *testing.T) {
	f := historyServer()
	c := historyController(f) // runShellVerdict unset

	if _, err := c.PersistDefaultHistoryLimit("@0", 50000); err == nil {
		t.Fatal("an unconfirmed config write was reported as success")
	}
}

// The script has to choose the file ON the tmux host, so its choosing rules are
// asserted on the text it generates.
func TestPersistScriptChoosesTheUsersOwnConfig(t *testing.T) {
	// A system-wide config is never edited: it is not this user's to change.
	s := persistScript([]string{"/etc/tmux.conf"}, 50000)
	if !strings.Contains(s, `case "$f" in "$HOME"/*)`) {
		t.Error("the script does not restrict itself to files under $HOME")
	}
	if !strings.Contains(s, `$HOME/.config/tmux/tmux.conf`) || !strings.Contains(s, `$HOME/.tmux.conf`) {
		t.Error("the script has no fallback for a server that loaded no config")
	}
	// With no candidates at all it must still be valid sh (no empty `for` list).
	if strings.Contains(persistScript(nil, 100), "for f in;") {
		t.Error("an empty candidate list produced a broken `for`")
	}
	// The rewrite is atomic and idempotent: old lines dropped, one appended.
	for _, want := range []string{"history-limit", "grep -vE", "mv \"$tmp\" \"$conf\"", historyConfOption} {
		if !strings.Contains(s, want) {
			t.Errorf("the script is missing %q", want)
		}
	}
	if !strings.Contains(persistScript(nil, 50000), "set -g history-limit 50000") {
		t.Error("the script does not write the requested limit")
	}
}

// A config path is arbitrary text from the user's own environment; it goes into a
// shell program, so it is quoted rather than pasted.
func TestPersistScriptQuotesCandidatePaths(t *testing.T) {
	s := persistScript([]string{"/home/me/my conf'; rm -rf /; #/tmux.conf"}, 100)
	if strings.Contains(s, "rm -rf /; #") && !strings.Contains(s, `'\''`) {
		t.Errorf("a path with a quote in it was not escaped:\n%s", s)
	}
}

func TestParseConfVerdict(t *testing.T) {
	kind, path, _ := parseConfVerdict("ok|/home/me/.tmux.conf")
	if kind != "ok" || path != "/home/me/.tmux.conf" {
		t.Errorf("ok verdict parsed as %q/%q", kind, path)
	}
	kind, path, why := parseConfVerdict("err|/etc/tmux.conf|no permission")
	if kind != "err" || path != "/etc/tmux.conf" || why != "no permission" {
		t.Errorf("err verdict parsed as %q/%q/%q", kind, path, why)
	}
	if k, _, _ := parseConfVerdict(""); k != "" {
		t.Error("an empty verdict was read as an answer")
	}
	if k, _, _ := parseConfVerdict("something else"); k != "" {
		t.Error("an unrecognized verdict was read as an answer")
	}
}

func contains(argv []string, want string) bool {
	for _, a := range argv {
		if a == want {
			return true
		}
	}
	return false
}
