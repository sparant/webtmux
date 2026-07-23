package webtty

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"webtmux/pkg/tmux"
)

// captureMaster is a fake PTY master that records frames written by the server.
type captureMaster struct{ writes chan []byte }

func (m *captureMaster) Read(p []byte) (int, error) { select {} } // never called (no Run)
func (m *captureMaster) Write(p []byte) (int, error) { // record + signal
	m.writes <- append([]byte(nil), p...)
	return len(p), nil
}

func tmuxRun(t *testing.T, sock string, args ...string) {
	t.Helper()
	if err := exec.Command("tmux", append([]string{"-S", sock}, args...)...).Run(); err != nil {
		t.Fatalf("tmux %v: %v", args, err)
	}
}

// TestCaptureRequestBackendAcceptance is the B.4 acceptance: send a
// TmuxCaptureRequest {"windows":"all"} and confirm ONE TmuxCaptureData frame
// comes back with exactly one capture per window_id — grouped sessions
// (services + web-a share @0/@1) must be deduped — each carrying non-empty
// base64 ANSI and sane dims.
func TestCaptureRequestBackendAcceptance(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed; skipping live backend acceptance")
	}
	sock := filepath.Join(t.TempDir(), "cap.sock")
	defer exec.Command("tmux", "-S", sock, "kill-server").Run()

	tmuxRun(t, sock, "new-session", "-d", "-s", "services", "-x", "80", "-y", "24")
	tmuxRun(t, sock, "new-window", "-t", "services", "-n", "editor")
	tmuxRun(t, sock, "new-session", "-d", "-t", "services", "-s", "web-a") // grouped: shares @0/@1
	time.Sleep(200 * time.Millisecond)

	store := tmux.NewCaptureStore(sock)
	m := &captureMaster{writes: make(chan []byte, 4)}
	wt, err := New(m, nil)
	if err != nil {
		t.Fatal(err)
	}
	wt.SetCaptureProvider(store)

	if err := wt.handleTmuxMessage(TmuxCaptureRequest, []byte(`{"windows":"all"}`)); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}

	select {
	case frame := <-m.writes:
		if frame[0] != TmuxCaptureData {
			t.Fatalf("expected TmuxCaptureData ('A') frame, got %q", frame[0])
		}
		var payload struct {
			Captures []tmux.CaptureWire `json:"captures"`
		}
		if err := json.Unmarshal(frame[1:], &payload); err != nil {
			t.Fatalf("unmarshal payload: %v", err)
		}
		if len(payload.Captures) != 2 {
			t.Fatalf("expected 2 deduped captures (@0,@1), got %d: %+v", len(payload.Captures), payload.Captures)
		}
		seen := map[string]bool{}
		for _, c := range payload.Captures {
			if seen[c.WindowID] {
				t.Errorf("duplicate window_id in response: %s", c.WindowID)
			}
			seen[c.WindowID] = true
			if c.Data == "" {
				t.Errorf("empty capture data for %s", c.WindowID)
			}
			if c.Cols == 0 || c.Rows == 0 {
				t.Errorf("bad dims for %s: %dx%d", c.WindowID, c.Cols, c.Rows)
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no TmuxCaptureData frame received")
	}
}
