package webtty

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The scope half of "save this pane's buffer": WHICH of a pane's two buffers a
// save means. The distinction only exists once something has scrolled off, so
// these tests fill a real pane past its 24 rows and then ask for each scope.
//
// What is actually being pinned is that the two scopes disagree — a test that
// only asserted "the scrollback contains the last line" would pass just as well
// against the old screen-only save.

// fillPane prints `lines` numbered lines into the harness session's pane and
// waits until the last one has landed, so the pane's history is deeper than its
// 24-row screen by a known amount.
func fillPane(t *testing.T, sock string, lines int) {
	t.Helper()
	tmuxRun(t, sock, "send-keys", "-t", "services",
		fmt.Sprintf("for i in $(seq 1 %d); do echo scrollback-line-$i; done", lines), "Enter")
	deadline := time.Now().Add(10 * time.Second)
	last := fmt.Sprintf("scrollback-line-%d", lines)
	for time.Now().Before(deadline) {
		out, err := exec.Command("tmux", "-S", sock, "capture-pane", "-p", "-t", "services").Output()
		if err == nil && strings.Contains(string(out), last) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("pane never printed %s", last)
}

func TestSaveScopeScrollbackWritesLinesThatScrolledOffTheScreen(t *testing.T) {
	cwd := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	wt, m, sock := saveHarness(t, cwd)
	fillPane(t, sock, 200)

	req := `{"windowId":"@0","path":"all.txt","scope":"scrollback"}`
	if err := wt.handleTmuxMessage(TmuxSavePaneFile, []byte(req)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	var res saveResultFrame
	if err := json.Unmarshal(nextFrame(t, m, TmuxSaveResult), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !res.OK {
		t.Fatalf("save failed: %s", res.Error)
	}
	body, err := os.ReadFile(res.Path)
	if err != nil {
		t.Fatalf("reported success but no file: %v", err)
	}
	text := string(body)
	// The first line scrolled off long ago — it exists ONLY in tmux's history.
	if !strings.Contains(text, "scrollback-line-1\n") {
		t.Error("scrollback scope did not include the oldest line (it saved the screen)")
	}
	if !strings.Contains(text, "scrollback-line-200") {
		t.Error("scrollback scope did not include the newest line")
	}
	if !strings.HasSuffix(text, "\n") {
		t.Errorf("saved file should end in exactly one newline, got %q", tail(text, 20))
	}
	if strings.HasSuffix(text, "\n\n") {
		t.Errorf("trailing blank screen rows were not trimmed: %q", tail(text, 20))
	}
}

// The other scope, and the pre-existing default: no scope named means the
// visible screen, so a client whose cached JS predates this field keeps getting
// exactly what it asked for.
func TestSaveScopeScreenAndTheAbsentDefaultWriteOnlyTheVisibleScreen(t *testing.T) {
	cwd := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	wt, m, sock := saveHarness(t, cwd)
	fillPane(t, sock, 200)

	for _, tc := range []struct{ name, req string }{
		{"explicit screen scope", `{"windowId":"@0","path":"screen.txt","scope":"screen"}`},
		{"no scope at all", `{"windowId":"@0","path":"default.txt"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := wt.handleTmuxMessage(TmuxSavePaneFile, []byte(tc.req)); err != nil {
				t.Fatalf("handleTmuxMessage: %v", err)
			}
			var res saveResultFrame
			if err := json.Unmarshal(nextFrame(t, m, TmuxSaveResult), &res); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if !res.OK {
				t.Fatalf("save failed: %s", res.Error)
			}
			body, err := os.ReadFile(res.Path)
			if err != nil {
				t.Fatalf("reported success but no file: %v", err)
			}
			text := string(body)
			if strings.Contains(text, "scrollback-line-1\n") {
				t.Error("screen scope wrote history that had scrolled off")
			}
			if !strings.Contains(text, "scrollback-line-200") {
				t.Error("screen scope did not include what is actually on screen")
			}
		})
	}
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

// ---- the browser-download path (TmuxScrollbackRequest) ----------------------

type scrollbackFrame struct {
	WindowID string `json:"windowId"`
	Token    int    `json:"token"`
	Data     string `json:"data"`
	Error    string `json:"error"`
}

func readScrollbackFrame(t *testing.T, m *captureMaster) scrollbackFrame {
	t.Helper()
	var f scrollbackFrame
	if err := json.Unmarshal(nextFrame(t, m, TmuxScrollbackData), &f); err != nil {
		t.Fatalf("unmarshal scrollback frame: %v", err)
	}
	return f
}

func TestScrollbackRequestReturnsTheWholeBufferWithItsToken(t *testing.T) {
	m := &captureMaster{writes: make(chan []byte, 4)}
	wt, err := New(m, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Deliberately not valid UTF-8: a pane that printed a stray byte must reach
	// the file as that byte, which is why the wire carries base64 and not a JSON
	// string (json.Marshal would rewrite it to U+FFFD).
	cp := &countingCapture{scrollback: "history\xffline\n"}
	wt.SetCaptureProvider(cp)

	if err := wt.handleTmuxMessage(TmuxScrollbackRequest, []byte(`{"windowId":"@3","token":7}`)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	f := readScrollbackFrame(t, m)
	if f.Error != "" {
		t.Fatalf("unexpected error: %s", f.Error)
	}
	if f.WindowID != "@3" || f.Token != 7 {
		t.Errorf("reply must echo the request it answers, got %+v", f)
	}
	raw, err := base64.StdEncoding.DecodeString(f.Data)
	if err != nil {
		t.Fatalf("data is not base64: %v", err)
	}
	if string(raw) != "history\xffline\n" {
		t.Errorf("buffer arrived altered: %q", raw)
	}
	if got := cp.scrollbackCalls(); len(got) != 1 || got[0] != "@3" {
		t.Errorf("expected one scrollback read of @3, got %v", got)
	}
}

// A second click while a 100k-line history is still being read is REFUSED, not
// silently dropped: the browser starts its download on the reply, so a dropped
// request is a spinner that never ends.
func TestSecondScrollbackRequestIsRefusedRatherThanDropped(t *testing.T) {
	m := &captureMaster{writes: make(chan []byte, 4)}
	wt, err := New(m, nil)
	if err != nil {
		t.Fatal(err)
	}
	hold := make(chan struct{})
	cp := &countingCapture{scrollback: "slow\n", scrollbackHold: hold}
	wt.SetCaptureProvider(cp)

	if err := wt.handleTmuxMessage(TmuxScrollbackRequest, []byte(`{"windowId":"@0","token":1}`)); err != nil {
		t.Fatalf("first request: %v", err)
	}
	cp.waitScrollback(t, 1) // the first read is now inside the provider, blocked

	if err := wt.handleTmuxMessage(TmuxScrollbackRequest, []byte(`{"windowId":"@0","token":2}`)); err != nil {
		t.Fatalf("second request: %v", err)
	}
	second := readScrollbackFrame(t, m)
	if second.Token != 2 || second.Error == "" {
		t.Fatalf("second request must come back as an answered refusal, got %+v", second)
	}
	if calls := cp.scrollbackCalls(); len(calls) != 1 {
		t.Errorf("the refused request must not have forked a second read: %v", calls)
	}

	close(hold)
	first := readScrollbackFrame(t, m)
	if first.Token != 1 || first.Error != "" {
		t.Errorf("the first request must still complete normally, got %+v", first)
	}
	// …and the slot is free again afterwards.
	if err := wt.handleTmuxMessage(TmuxScrollbackRequest, []byte(`{"windowId":"@0","token":3}`)); err != nil {
		t.Fatalf("third request: %v", err)
	}
	third := readScrollbackFrame(t, m)
	if third.Token != 3 || third.Error != "" {
		t.Errorf("the limiter did not release its slot, got %+v", third)
	}
}

// No tmux (a plain non-tmux backend): the request is answered with a reason
// rather than ignored, for the same "never leave the download hanging" rule.
func TestScrollbackRequestWithoutACaptureProviderIsAnswered(t *testing.T) {
	m := &captureMaster{writes: make(chan []byte, 4)}
	wt, err := New(m, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wt.handleTmuxMessage(TmuxScrollbackRequest, []byte(`{"windowId":"@0","token":9}`)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	f := readScrollbackFrame(t, m)
	if f.Token != 9 || f.Error == "" {
		t.Errorf("expected an answered failure, got %+v", f)
	}
}

// A scrollback read that fails reports a failure — it must not write a file
// containing whatever the screen happened to hold instead.
func TestSaveScopeScrollbackReportsAFailedReadRatherThanSavingTheScreen(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", dir)
	m := &captureMaster{writes: make(chan []byte, 4)}
	wt, err := New(m, nil)
	if err != nil {
		t.Fatal(err)
	}
	wt.SetCaptureProvider(&countingCapture{paneDir: dir, scrollbackErr: os.ErrPermission})

	req := `{"windowId":"@0","path":"all.txt","scope":"scrollback"}`
	if err := wt.handleTmuxMessage(TmuxSavePaneFile, []byte(req)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	var res saveResultFrame
	if err := json.Unmarshal(nextFrame(t, m, TmuxSaveResult), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if res.OK || res.Error == "" {
		t.Fatalf("expected a reported failure, got %+v", res)
	}
	if _, err := os.Stat(filepath.Join(dir, "all.txt")); !os.IsNotExist(err) {
		t.Error("a failed scrollback read must leave no file behind")
	}
}
