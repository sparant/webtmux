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
// `cwd`, and returns a WebTTY wired to a fake master that records frames, plus
// the tmux socket (so a test can type into the pane — see save_scope_test.go,
// where the scopes only differ once something has scrolled off).
func saveHarness(t *testing.T, cwd string) (*WebTTY, *captureMaster, string) {
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
	return wt, m, sock
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
	OK     bool    `json:"ok"`
	Path   string  `json:"path"`
	Error  string  `json:"error"`
	Exists bool    `json:"exists"`
	Env    SaveEnv `json:"env"`
}

func TestSaveWritesIntoThePaneDirectoryWhenItIsVisible(t *testing.T) {
	cwd := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	wt, m, _ := saveHarness(t, cwd)

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
	wt, m, _ := saveHarness(t, cwd)

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
	wt, m, _ := saveHarness(t, cwd)

	if err := wt.handleTmuxMessage(TmuxSavePaneFile, []byte(`{"windowId":"@0","path":"/home/you/Projects/services-13.txt"}`)); err != nil {
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
	for _, want := range []string{"/home/you/Projects", "container", "downloading to your browser"} {
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
	wt, m, _ := saveHarness(t, cwd)

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
	wt, m, _ := saveHarness(t, cwd)

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
	wt, m, _ := saveHarness(t, cwd)

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

// The whole overwrite round trip against a real tmux: a save into a name that is
// already taken is REFUSED and flagged, and the same request carrying the user's
// answer goes through. The suggested filename is derived from the session and
// window name, so two saves of one window collide by construction — this is the
// common case, not the exotic one, and it used to destroy the earlier file
// without a word.
func TestSaveRefusesToOverwriteUntilAsked(t *testing.T) {
	cwd := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	wt, m, _ := saveHarness(t, cwd)

	target := filepath.Join(cwd, "out.txt")
	if err := os.WriteFile(target, []byte("PRECIOUS"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := wt.handleTmuxMessage(TmuxSavePaneFile, []byte(`{"windowId":"@0","path":"out.txt"}`)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	var res saveResultFrame
	if err := json.Unmarshal(nextFrame(t, m, TmuxSaveResult), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if res.OK {
		t.Fatal("the save replaced an existing file without asking")
	}
	if !res.Exists {
		t.Errorf("the refusal must be FLAGGED as an overwrite question, not just phrased as one: %+v", res)
	}
	if res.Path != target {
		t.Errorf("the reply should name the file in question: %+v", res)
	}
	if got, _ := os.ReadFile(target); string(got) != "PRECIOUS" {
		t.Fatalf("the existing file was modified anyway: %q", got)
	}

	// The user answers.
	if err := wt.handleTmuxMessage(TmuxSavePaneFile,
		[]byte(`{"windowId":"@0","path":"out.txt","overwrite":true}`)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	if err := json.Unmarshal(nextFrame(t, m, TmuxSaveResult), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !res.OK {
		t.Fatalf("an explicit overwrite was still refused: %s", res.Error)
	}
	if got, _ := os.ReadFile(target); string(got) == "PRECIOUS" {
		t.Error("overwrite:true did not actually replace the file")
	}
}

// Containment, end to end: the resolver refuses and nothing is written.
func TestSaveRefusesAPathOutsideTheAllowedDirectories(t *testing.T) {
	cwd := t.TempDir()
	outside := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	t.Setenv("WEBTMUX_IN_CONTAINER", "1") // no implicit $HOME/cwd roots
	t.Setenv("WEBTMUX_HOME", "")
	wt, m, _ := saveHarness(t, cwd)

	req, _ := json.Marshal(map[string]string{
		"windowId": "@0", "path": filepath.Join(outside, "stolen.txt"),
	})
	if err := wt.handleTmuxMessage(TmuxSavePaneFile, req); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	var res saveResultFrame
	if err := json.Unmarshal(nextFrame(t, m, TmuxSaveResult), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if res.OK {
		t.Fatal("a path outside every declared directory was written")
	}
	if _, err := os.Stat(filepath.Join(outside, "stolen.txt")); err == nil {
		t.Fatal("the file was created despite the refusal")
	}
	if !strings.Contains(res.Error, cwd) {
		t.Errorf("the refusal should name what IS allowed: %s", res.Error)
	}
}
