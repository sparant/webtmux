package webtty

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"webtmux/pkg/tmux"
)

// End-to-end backend tests for "save this pane's buffer on the machine tmux runs
// on", against a REAL tmux server. The unit tests in savepath_test.go pin the
// resolution rules; these pin the thing that actually broke — the round trip
// through tmux's reported pane directory to a file on disk, and what the browser
// is told when that directory doesn't exist for the process doing the write.

// saveHarness starts a throwaway tmux server with one session whose pane sits in
// `cwd`, and returns a WebTTY wired to a fake master that records frames.
func saveHarness(t *testing.T, cwd string) (*WebTTY, *captureMaster) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed; skipping live save backend test")
	}
	sock := filepath.Join(t.TempDir(), "save.sock")
	t.Cleanup(func() { exec.Command("tmux", "-S", sock, "kill-server").Run() })

	tmuxRun(t, sock, "new-session", "-d", "-s", "services", "-c", cwd, "-x", "80", "-y", "24")
	time.Sleep(200 * time.Millisecond)

	m := &captureMaster{writes: make(chan []byte, 4)}
	wt, err := New(m, nil)
	if err != nil {
		t.Fatal(err)
	}
	wt.SetCaptureProvider(tmux.NewCaptureStore(sock))
	return wt, m
}

// nextFrame waits for one recorded frame of the given type.
func nextFrame(t *testing.T, m *captureMaster, want byte) []byte {
	t.Helper()
	for {
		select {
		case frame := <-m.writes:
			if frame[0] == want {
				return frame[1:]
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no frame of type %q received", want)
		}
	}
}

type saveResultFrame struct {
	OK    bool    `json:"ok"`
	Path  string  `json:"path"`
	Error string  `json:"error"`
	Env   SaveEnv `json:"env"`
}

func TestSaveWritesIntoThePaneDirectoryWhenItIsVisible(t *testing.T) {
	cwd := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	wt, m := saveHarness(t, cwd)

	if err := wt.handleTmuxMessage(TmuxSavePaneFile, []byte(`{"windowId":"@0","path":"out.txt"}`)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	var res saveResultFrame
	if err := json.Unmarshal(nextFrame(t, m, TmuxSaveResult), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !res.OK {
		t.Fatalf("save failed: %s", res.Error)
	}
	want := filepath.Join(cwd, "out.txt")
	if res.Path != want {
		t.Fatalf("saved to %q, want %q", res.Path, want)
	}
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("reported success but no file: %v", err)
	}
	if !res.Env.PaneVisible {
		t.Errorf("pane dir exists here, but env says invisible: %+v", res.Env)
	}
}

// The container case, reproduced without a container: the pane's directory maps
// to somewhere that does not exist for the writing process. The save must still
// produce a file (relative paths land in the configured save dir) and the reply
// must SAY it went elsewhere — that env is what the dropdown turns into English.
func TestSaveFallsBackAndSaysSoWhenThePaneDirectoryIsInvisible(t *testing.T) {
	cwd := t.TempDir()
	saves := filepath.Join(t.TempDir(), "saves")
	t.Setenv("WEBTMUX_PATH_MAP", cwd+"=/definitely/not/here")
	t.Setenv("WEBTMUX_SAVE_DIR", saves)
	wt, m := saveHarness(t, cwd)

	if err := wt.handleTmuxMessage(TmuxSavePaneFile, []byte(`{"windowId":"@0","path":"out.txt"}`)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	var res saveResultFrame
	if err := json.Unmarshal(nextFrame(t, m, TmuxSaveResult), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !res.OK {
		t.Fatalf("save failed: %s", res.Error)
	}
	if res.Path != filepath.Join(saves, "out.txt") {
		t.Fatalf("saved to %q, want it under the fallback dir %q", res.Path, saves)
	}
	if res.Env.PaneVisible {
		t.Errorf("pane dir is not reachable, but env claims it is: %+v", res.Env)
	}
	if res.Env.PaneDir != cwd {
		t.Errorf("env should report the pane dir tmux gave us (%q), got %q", cwd, res.Env.PaneDir)
	}
}

// A path the user types that doesn't exist here must fail with an explanation,
// not a bare open(2) error — that error was the whole bug report.
func TestTypedPathIntoAnInvisibleDirectoryFailsWithAnExplanation(t *testing.T) {
	cwd := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", t.TempDir())
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")
	wt, m := saveHarness(t, cwd)

	if err := wt.handleTmuxMessage(TmuxSavePaneFile, []byte(`{"windowId":"@0","path":"/home/nathan/Projects/services-13.txt"}`)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	var res saveResultFrame
	if err := json.Unmarshal(nextFrame(t, m, TmuxSaveResult), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if res.OK {
		t.Fatal("expected a failure for a directory that does not exist here")
	}
	if strings.Contains(res.Error, "no such file or directory") {
		t.Errorf("still leaking the raw open(2) error: %s", res.Error)
	}
	for _, want := range []string{"/home/nathan/Projects", "container", "Download to browser"} {
		if !strings.Contains(res.Error, want) {
			t.Errorf("error is missing %q:\n  %s", want, res.Error)
		}
	}
}

// The whole ask-me-where round trip: webtmux has nothing shared, the browser
// sends the directory the user named, and the file lands there.
func TestSaveUsesTheDirectoryTheUserNamed(t *testing.T) {
	cwd := t.TempDir()
	mounted := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", cwd+"=/definitely/not/here") // pane dir invisible
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")
	wt, m := saveHarness(t, cwd)

	// Before an answer, the probe says it is blocked — that is what makes the
	// dropdown ask instead of offering a path box that can only fail.
	if err := wt.handleTmuxMessage(TmuxSaveInfoRequest, []byte(`{"windowId":"@0"}`)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	var probe SaveEnv
	if err := json.Unmarshal(nextFrame(t, m, TmuxSaveInfo), &probe); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !probe.Blocked {
		t.Fatalf("expected a blocked probe with nothing shared: %+v", probe)
	}

	// The user names a directory; the save lands in it.
	req, _ := json.Marshal(map[string]string{"windowId": "@0", "path": "out.txt", "dir": mounted})
	if err := wt.handleTmuxMessage(TmuxSavePaneFile, req); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	var res saveResultFrame
	if err := json.Unmarshal(nextFrame(t, m, TmuxSaveResult), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !res.OK {
		t.Fatalf("save failed: %s", res.Error)
	}
	if res.Path != filepath.Join(mounted, "out.txt") {
		t.Fatalf("saved to %q, want it in the chosen dir %q", res.Path, mounted)
	}
	if _, err := os.Stat(res.Path); err != nil {
		t.Fatalf("reported success but no file: %v", err)
	}
	if res.Env.Chosen != mounted {
		t.Errorf("the reply should echo the directory in force: %+v", res.Env)
	}
}

// A remembered directory that has since gone away (the mount changed between
// sessions) must re-open the question, not quietly redirect the file.
func TestAStaleRememberedDirectoryReopensTheQuestion(t *testing.T) {
	cwd := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", cwd+"=/definitely/not/here")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")
	wt, m := saveHarness(t, cwd)

	if err := wt.handleTmuxMessage(TmuxSaveInfoRequest, []byte(`{"windowId":"@0","dir":"/gone/away"}`)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	var probe SaveEnv
	if err := json.Unmarshal(nextFrame(t, m, TmuxSaveInfo), &probe); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if probe.ChosenError == "" || probe.Chosen != "" || !probe.Blocked {
		t.Fatalf("a vanished directory should be reported and still blocked: %+v", probe)
	}
}

// The pre-save probe: read-only, and it must describe the same destination the
// save itself would pick (the hint and the write cannot disagree).
func TestSaveInfoDescribesTheSameDestinationTheSaveWouldUse(t *testing.T) {
	cwd := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	wt, m := saveHarness(t, cwd)

	if err := wt.handleTmuxMessage(TmuxSaveInfoRequest, []byte(`{"windowId":"@0"}`)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	var env SaveEnv
	if err := json.Unmarshal(nextFrame(t, m, TmuxSaveInfo), &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.BaseDir != cwd || !env.PaneVisible {
		t.Fatalf("probe said %+v, want base %q visible", env, cwd)
	}
	if !env.Writable {
		t.Errorf("a temp dir should probe as writable: %+v", env)
	}
	// Read-only: the probe must not have created anything (the write probe cleans
	// up after itself).
	entries, err := os.ReadDir(cwd)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("save-info left files behind: %v", entries)
	}
}
