package tmux

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The scrollback rebuild, against a REAL tmux.
//
// Everything else in this package can be proved against a fake runner, because
// everything else is about the argv webtmux sends. This is not: the whole design
// rests on claims about what tmux DOES —
//
//	a pane's history-limit is fixed at creation and no option changes it;
//	a new pane is born with the option in force at that moment;
//	killing a pane redistributes its rows rather than handing them to its neighbour;
//	select-layout accepts a re-labelled layout string if its checksum is right;
//
// — and a fake that agrees with those claims proves only that we wrote it to. So
// this drives tmux itself on a private socket and asserts against what tmux
// reports afterwards.
//
// Skipped, not failed, where tmux is absent: it is a legitimate build environment
// (the release cross-compiles), and a test that cannot run is not a test that failed.

func liveTmux(t *testing.T) (tmuxRunner, func()) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed — skipping the live scrollback test")
	}
	// A socket of our own: this test kills panes and rewrites options, and must not
	// be able to reach a tmux server anybody is using.
	socket := filepath.Join(t.TempDir(), "wt-history.sock")
	run := func(args ...string) (string, error) { return runTmuxOn(socket, args...) }
	if _, err := run("new-session", "-d", "-s", "live", "-x", "120", "-y", "40"); err != nil {
		t.Skipf("could not start a tmux server: %v", err)
	}
	cleanup := func() { _, _ = run("kill-server") }
	t.Cleanup(cleanup)
	// The shell in a fresh pane takes a moment to be the thing #{pane_current_command}
	// reports; without this the idle/busy check reads whatever is still exec'ing.
	waitFor(t, run, func() bool {
		out, err := run("display-message", "-t", "live", "-p", "#{pane_current_command}")
		return err == nil && paneIsIdle(strings.TrimSpace(out))
	})
	return run, cleanup
}

// waitFor polls a condition for a second — tmux is a separate process and every
// assertion here is about state it settles into, not state it returns.
func waitFor(t *testing.T, run tmuxRunner, ok func() bool) {
	t.Helper()
	for i := 0; i < 50; i++ {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func liveField(t *testing.T, run tmuxRunner, target, format string) string {
	t.Helper()
	out, err := run("display-message", "-t", target, "-p", format)
	if err != nil {
		t.Fatalf("display-message %s %s: %v", target, format, err)
	}
	return strings.TrimSpace(out)
}

// The premise the whole feature is built on. If tmux ever gains a real resize,
// this is the test that will notice.
func TestLiveHistoryLimitIsFixedAtPaneCreation(t *testing.T) {
	run, _ := liveTmux(t)
	win := liveField(t, run, "live", "#{window_id}")

	before := liveField(t, run, win, "#{history_limit}")
	if _, err := run("set-option", "-g", "history-limit", "12345"); err != nil {
		t.Fatal(err)
	}
	if after := liveField(t, run, win, "#{history_limit}"); after != before {
		t.Fatalf("an existing pane's limit changed from %s to %s — tmux can now resize "+
			"a live buffer, and the rebuild this package does is no longer necessary",
			before, after)
	}
	// …but a NEW pane gets it, which is what makes the rebuild work at all.
	if _, err := run("split-window", "-d", "-t", win); err != nil {
		t.Fatal(err)
	}
	panes, err := historyPanes(run, win)
	if err != nil {
		t.Fatal(err)
	}
	if len(panes) != 2 || panes[1].Limit != 12345 {
		t.Fatalf("a new pane was not born with the new limit: %+v", panes)
	}
}

// The rebuild itself, on a three-pane window with an uneven layout and something
// running in one of the panes.
func TestLiveResizeRebuildsAWindowAndKeepsItsShape(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)
	win := liveField(t, run, "live", "#{window_id}")

	if _, err := run("split-window", "-d", "-t", win); err != nil {
		t.Fatal(err)
	}
	if _, err := run("split-window", "-d", "-h", "-t", win); err != nil {
		t.Fatal(err)
	}
	// An uneven layout, so "the geometry was restored" is a claim with content.
	if _, err := run("resize-pane", "-t", win+".0", "-y", "8"); err != nil {
		t.Fatal(err)
	}
	// Something running, so the busy check and the force flag are both exercised.
	if _, err := run("respawn-pane", "-k", "-t", win+".1", "sleep 600"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, run, func() bool {
		panes, err := historyPanes(run, win)
		return err == nil && len(panes) == 3 && !paneIsIdle(panes[1].Command)
	})

	before, err := historyPanes(run, win)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 3 {
		t.Fatalf("expected a 3-pane window, got %d", len(before))
	}
	layoutBefore := liveField(t, run, win, "#{window_layout}")
	geomBefore := paneGeometry(layoutBefore)

	// Without force it must refuse, and cost nothing.
	if _, err := c.ResizeWindowHistory(win, 50000, false, false); err == nil {
		t.Fatal("resized a window running `sleep` without being told to")
	}
	if after, _ := historyPanes(run, win); len(after) != 3 || after[0].PaneID != before[0].PaneID {
		t.Fatal("the refusal disturbed the window")
	}

	res, err := c.ResizeWindowHistory(win, 50000, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Rebuilt != 3 {
		t.Errorf("rebuilt %d panes, want 3", res.Rebuilt)
	}
	if len(res.Restarted) != 1 || !strings.Contains(res.Restarted[0], "sleep") {
		t.Errorf("restarted = %v, want the sleep it killed", res.Restarted)
	}
	if !res.LayoutRestored {
		t.Error("the layout was not restored")
	}

	after, err := historyPanes(run, win)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 3 {
		t.Fatalf("window has %d panes after the rebuild, want 3", len(after))
	}
	for _, p := range after {
		if p.Limit != 50000 {
			t.Errorf("pane %s (index %d) holds %d lines, want 50000", p.PaneID, p.Index, p.Limit)
		}
		if !paneIsIdle(p.Command) {
			t.Errorf("pane %s is running %q — the rebuild should leave fresh shells",
				p.PaneID, p.Command)
		}
	}
	// The shape, cell for cell. This is the assertion the layout re-labelling and
	// its checksum exist for: without them tmux redistributes the killed panes'
	// rows and the window comes back a different shape.
	if got := paneGeometry(liveField(t, run, win, "#{window_layout}")); got != geomBefore {
		t.Errorf("geometry changed:\n before %s\n  after %s", geomBefore, got)
	}
	// The window keeps its identity — same window, same name, same place in the
	// session. Only its panes were replaced.
	if liveField(t, run, win, "#{window_id}") != win {
		t.Error("the window id changed")
	}
}

// A resize must not become a change to the default. tmux has no way to create a
// pane at a given size other than by pointing the option at it first, so the
// option is borrowed — and this is the proof it is given back.
func TestLiveResizeDoesNotChangeTheDefaultForNewWindows(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)
	win := liveField(t, run, "live", "#{window_id}")

	if _, err := run("set-option", "-g", "history-limit", "3000"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ResizeWindowHistory(win, 50000, true, false); err != nil {
		t.Fatal(err)
	}
	global, err := globalHistoryLimit(run)
	if err != nil {
		t.Fatal(err)
	}
	if global != 3000 {
		t.Errorf("global history-limit is now %d — resizing one window silently "+
			"changed what every new one gets", global)
	}
	// And the proof that matters to the user: the NEXT window still comes up at the
	// old default.
	if _, err := run("new-window", "-d", "-t", "live:"); err != nil {
		t.Fatal(err)
	}
	fresh := liveField(t, run, "live:$", "#{history_limit}")
	if fresh != "3000" {
		t.Errorf("a new window came up at %s lines, want the untouched default of 3000", fresh)
	}
}

// Setting the default, on the other hand, must reach the next window — and leave
// the one you are looking at exactly as it was.
func TestLiveSetDefaultAffectsNewWindowsOnly(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)
	win := liveField(t, run, "live", "#{window_id}")
	before := liveField(t, run, win, "#{history_limit}")

	if err := c.SetDefaultHistoryLimit(win, 44444); err != nil {
		t.Fatal(err)
	}
	if now := liveField(t, run, win, "#{history_limit}"); now != before {
		t.Errorf("the existing window changed from %s to %s", before, now)
	}
	if _, err := run("new-window", "-d", "-t", "live:"); err != nil {
		t.Fatal(err)
	}
	if fresh := liveField(t, run, "live:$", "#{history_limit}"); fresh != "44444" {
		t.Errorf("a new window came up at %s lines, want 44444", fresh)
	}
}

// A session-scope override is the silent reason "I set the default and nothing
// changed" — so the default-setter follows through it.
func TestLiveSetDefaultBeatsASessionOverride(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)
	win := liveField(t, run, "live", "#{window_id}")
	sid := liveField(t, run, win, "#{session_id}")

	if _, err := run("set-option", "-t", sid, "history-limit", "500"); err != nil {
		t.Fatal(err)
	}
	if err := c.SetDefaultHistoryLimit(win, 44444); err != nil {
		t.Fatal(err)
	}
	if _, err := run("new-window", "-d", "-t", "live:"); err != nil {
		t.Fatal(err)
	}
	if fresh := liveField(t, run, "live:$", "#{history_limit}"); fresh != "44444" {
		t.Errorf("a new window came up at %s lines — the session's own value went on "+
			"shadowing the global write, with nothing on screen to say so", fresh)
	}
}

// Clearing has to empty every pane, and disturb nothing else.
func TestLiveClearEmptiesEveryPane(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)
	win := liveField(t, run, "live", "#{window_id}")

	if _, err := run("split-window", "-d", "-t", win); err != nil {
		t.Fatal(err)
	}
	for _, p := range mustPanes(t, run, win) {
		if _, err := run("send-keys", "-t", p.PaneID,
			"for i in $(seq 1 300); do echo history-line-$i; done", "Enter"); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, run, func() bool {
		for _, p := range mustPanesQuiet(run, win) {
			if p.Size == 0 {
				return false
			}
		}
		return true
	})
	before := mustPanes(t, run, win)
	for _, p := range before {
		if p.Size == 0 {
			t.Fatalf("pane %s never filled; the clear would prove nothing", p.PaneID)
		}
	}

	if err := c.ClearWindowHistory(win); err != nil {
		t.Fatal(err)
	}
	after := mustPanes(t, run, win)
	if len(after) != len(before) {
		t.Fatalf("clearing changed the pane count: %d -> %d", len(before), len(after))
	}
	for _, p := range after {
		if p.Size != 0 {
			t.Errorf("pane %s still holds %d lines — `clear-history -t @win` only "+
				"reaches the ACTIVE pane, which is why this walks them", p.PaneID, p.Size)
		}
		if !paneIsIdle(p.Command) {
			t.Errorf("pane %s is no longer a shell — a clear must disturb nothing", p.PaneID)
		}
	}
}

func mustPanes(t *testing.T, run tmuxRunner, win string) []PaneHistory {
	t.Helper()
	panes, err := historyPanes(run, win)
	if err != nil {
		t.Fatal(err)
	}
	return panes
}

func mustPanesQuiet(run tmuxRunner, win string) []PaneHistory {
	panes, _ := historyPanes(run, win)
	return panes
}

// paneGeometry strips a layout string down to the cell rectangles, dropping the
// checksum and the pane ids — "the same shape", which is the property a rebuild
// has to preserve, as opposed to "the same panes", which by definition it cannot.
func paneGeometry(layout string) string {
	if i := strings.IndexByte(layout, ','); i >= 0 {
		layout = layout[i+1:]
	}
	return layoutLeaf.ReplaceAllString(layout, "${1}#")
}

// The point of the whole exercise: a bigger buffer that still holds what you had.
//
// Against a real tmux, because the replay is a claim about what lands in a NEW
// pane's grid when text is printed into it, and no fake can tell you that.
func TestLiveResizeCarriesTheScrollbackAcross(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)
	win := liveField(t, run, "live", "#{window_id}")

	// Deeper than a screen, so most of it is HISTORY rather than what is visible —
	// the part a rebuild used to throw away.
	if _, err := run("send-keys", "-t", win,
		`clear; for i in $(seq 1 600); do printf '\033[32mkeep-me-%s\033[0m\n' $i; done`, "Enter"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, run, func() bool {
		panes, err := historyPanes(run, win)
		return err == nil && len(panes) == 1 && panes[0].Size > 500
	})
	before := mustPanes(t, run, win)[0]
	if before.Size < 500 {
		t.Fatalf("the pane never filled (size %d); the replay would prove nothing", before.Size)
	}

	res, err := c.ResizeWindowHistory(win, 50000, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Replayed != 1 {
		t.Fatalf("replayed %d of %d panes", res.Replayed, res.Rebuilt)
	}
	// The replacement's shell has to finish printing the buffer before the history
	// is there to read.
	waitFor(t, run, func() bool {
		panes, err := historyPanes(run, win)
		return err == nil && len(panes) == 1 && panes[0].Size > 500
	})
	afterPanes, err := buildHistoryReport(run, win)
	if err != nil {
		t.Fatal(err)
	}
	after := afterPanes.Panes[0]
	if after.Limit != 50000 {
		t.Errorf("the rebuilt pane holds %d lines, want 50000", after.Limit)
	}
	if after.Size < before.Size {
		t.Errorf("history shrank from %d to %d lines in the rebuild", before.Size, after.Size)
	}
	// Not just a count — the OLDEST line, the one furthest from the screen, is the
	// one a truncated replay would lose first.
	whole, err := run("capture-pane", "-p", "-S", "-", "-t", win)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"keep-me-1\n", "keep-me-600"} {
		if !strings.Contains(whole, want) {
			t.Errorf("%q did not survive the rebuild", strings.TrimSuffix(want, "\n"))
		}
	}
	// Colours too: the capture is taken with -e and replayed into a terminal, so
	// the old output should come back looking like itself.
	coloured, err := run("capture-pane", "-p", "-e", "-S", "-", "-t", win)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(coloured, "\033[32m") {
		t.Error("the replay came back colourless")
	}
	// And it is a working pane, not a `cat` that ended: the shell has to be there.
	waitFor(t, run, func() bool {
		panes, _ := historyPanes(run, win)
		return len(panes) == 1 && paneIsIdle(panes[0].Command)
	})
	if got := mustPanes(t, run, win)[0].Command; !paneIsIdle(got) {
		t.Errorf("the rebuilt pane is running %q, not a shell", got)
	}
}

// Persisting the default: the config file is rewritten, and — the only claim that
// matters — a tmux server started AFTERWARDS comes up with it.
func TestLivePersistSurvivesAServerRestart(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)
	win := liveField(t, run, "live", "#{window_id}")

	home := os.Getenv("HOME")
	if home == "" {
		t.Skip("no HOME to write a tmux config into")
	}
	conf := filepath.Join(home, ".tmux.conf")
	// A config with content worth preserving, including a history-limit line that
	// must be REPLACED rather than duplicated.
	original := "# my settings\nset -g mouse on\nset -g history-limit 4000\nset -g status-style bg=blue\n"
	if err := os.WriteFile(conf, []byte(original), 0o644); err != nil {
		t.Skipf("cannot write %s: %v", conf, err)
	}
	t.Cleanup(func() { _ = os.Remove(conf) })

	path, err := c.PersistDefaultHistoryLimit(win, 77000)
	if err != nil {
		t.Fatal(err)
	}
	if path != conf {
		t.Errorf("wrote %q, want %q", path, conf)
	}
	body, err := os.ReadFile(conf)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if !strings.Contains(text, "set -g history-limit 77000") {
		t.Errorf("the new limit is not in the config:\n%s", text)
	}
	if strings.Contains(text, "history-limit 4000") {
		t.Errorf("the old history-limit line survived, so the config now has two:\n%s", text)
	}
	// Everything else in the file is the user's and must come through untouched.
	for _, keep := range []string{"# my settings", "set -g mouse on", "set -g status-style bg=blue"} {
		if !strings.Contains(text, keep) {
			t.Errorf("the rewrite dropped %q:\n%s", keep, text)
		}
	}

	// The claim: a FRESH tmux server reads it. This is the whole difference between
	// this control and the one next to it.
	if _, err := run("kill-server"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, run, func() bool {
		_, err := run("list-sessions")
		return err != nil // the old server is gone
	})
	if _, err := run("new-session", "-d", "-s", "reborn", "-x", "80", "-y", "24"); err != nil {
		t.Fatal(err)
	}
	if got, _ := globalHistoryLimit(run); got != 77000 {
		t.Errorf("the new server came up at %d lines — the setting did not survive", got)
	}
	if got := liveField(t, run, "reborn", "#{history_limit}"); got != "77000" {
		t.Errorf("a pane in the new server holds %s lines, want 77000", got)
	}

	// Idempotent: doing it again leaves one line, not two.
	c2 := newControllerWithRunner("reborn", false, "", run)
	win2 := liveField(t, run, "reborn", "#{window_id}")
	if _, err := c2.PersistDefaultHistoryLimit(win2, 88000); err != nil {
		t.Fatal(err)
	}
	body, _ = os.ReadFile(conf)
	if n := strings.Count(string(body), "history-limit"); n != 1 {
		t.Errorf("the config has %d history-limit lines after two saves:\n%s", n, body)
	}
}

// A system-wide config is not the user's to rewrite.
func TestLivePersistCreatesAUserConfigRatherThanEditingASystemOne(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)
	win := liveField(t, run, "live", "#{window_id}")

	home := os.Getenv("HOME")
	if home == "" {
		t.Skip("no HOME")
	}
	conf := filepath.Join(home, ".tmux.conf")
	_ = os.Remove(conf) // this server loaded no user config
	t.Cleanup(func() { _ = os.Remove(conf) })

	path, err := c.PersistDefaultHistoryLimit(win, 33000)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(path, home) {
		t.Errorf("wrote %q, which is outside the user's home", path)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("reported writing %s but it is not there: %v", path, err)
	}
}

// A window tmux launched with a command comes back running it — at the new size,
// with its scrollback. Against a real tmux, because the whole mechanism rests on
// tmux's own quoting of #{pane_start_command} round-tripping through a respawn.
func TestLiveResizeRelaunchesTheWindowsCommand(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)

	// A pane tmux itself launched, with arguments and nested quotes — the shape
	// most likely to be mangled by a naive un-quote.
	if _, err := run("new-window", "-d", "-t", "live:", "-n", "job",
		`sh -c "echo LAUNCHED-ONCE; sleep 600"`); err != nil {
		t.Fatal(err)
	}
	win := liveField(t, run, "live:job", "#{window_id}")
	waitFor(t, run, func() bool {
		panes, err := historyPanes(run, win)
		return err == nil && len(panes) == 1 && !paneIsIdle(panes[0].Command)
	})
	rep, err := buildHistoryReport(run, win)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Panes) != 1 || rep.Panes[0].StartCommand == "" {
		t.Fatalf("tmux reported no launch command: %+v", rep.Panes)
	}
	want := rep.Panes[0].StartCommand

	res, err := c.ResizeWindowHistory(win, 50000, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Rerun) != 1 {
		t.Fatalf("rerun = %v, want the launch command", res.Rerun)
	}
	waitFor(t, run, func() bool {
		panes, err := historyPanes(run, win)
		return err == nil && len(panes) == 1 && !paneIsIdle(panes[0].Command)
	})
	afterPanes, err := buildHistoryReport(run, win)
	if err != nil {
		t.Fatal(err)
	}
	after := afterPanes.Panes[0]
	if after.Limit != 50000 {
		t.Errorf("the relaunched pane holds %d lines, want 50000", after.Limit)
	}
	// `sh -c "…"` reports its foreground process as `sh`, so "did it come back
	// running something" is answered by the launch command tmux recorded for the
	// NEW pane, not by the process name.
	if !paneIsWork(after) {
		t.Errorf("the pane came back as a bare shell (%q), not running its command", after.Command)
	}
	// It really RAN: the marker is printed on each launch, and the replayed
	// scrollback carries the first one, so there are two.
	whole, err := run("capture-pane", "-p", "-S", "-", "-t", win)
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(whole, "LAUNCHED-ONCE"); n < 2 {
		t.Errorf("found %d launches in the buffer, want the replayed one plus the new one:\n%s", n, whole)
	}
	// And the rebuilt pane records the SAME launch command, so a second rebuild
	// sees the command rather than the replay preamble wrapped around it.
	rep2, err := buildHistoryReport(run, win)
	if err != nil {
		t.Fatal(err)
	}
	if got := rep2.Panes[0].StartCommand; got != want {
		t.Errorf("launch command after the rebuild = %q, want %q — a third rebuild "+
			"would nest another preamble inside it", got, want)
	}
}
