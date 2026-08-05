package webtty

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"webtmux/pkg/tmux"
)

// The scrollback wire, and the one property that makes the panel trustworthy:
// EVERY reply carries the numbers as they are AFTER whatever was asked for. A
// protocol where the outcome and the figures arrive separately lets a dropdown
// say "resized to 50,000" beside a panel still reading 2,000, which is precisely
// the confusion this feature exists to end.

// historyFrames pulls the TmuxHistoryInfo payloads out of what was written back.
func historyFrames(t *testing.T, m *recordMaster) []historyOutcome {
	t.Helper()
	var out []historyOutcome
	for _, f := range m.sent() {
		if len(f) == 0 || f[0] != TmuxHistoryInfo {
			continue
		}
		var o historyOutcome
		if err := json.Unmarshal(f[1:], &o); err != nil {
			t.Fatalf("bad TmuxHistoryInfo payload %q: %v", f[1:], err)
		}
		out = append(out, o)
	}
	return out
}

func lastHistory(t *testing.T, m *recordMaster) historyOutcome {
	t.Helper()
	frames := historyFrames(t, m)
	if len(frames) == 0 {
		t.Fatal("no TmuxHistoryInfo frame was sent — the dropdown is left waiting forever")
	}
	return frames[len(frames)-1]
}

// sampleReport is what a two-pane window looks like: a capacity, some of it used,
// and a pane running something that a rebuild would kill.
func sampleReport() *tmux.HistoryReport {
	return &tmux.HistoryReport{
		Global:  2000,
		Default: 2000,
		Panes: []tmux.PaneHistory{
			{PaneID: "%0", Index: 0, Active: true, Limit: 2000, Size: 1990, Bytes: 90000, Command: "bash"},
			{PaneID: "%1", Index: 1, Limit: 2000, Size: 12, Bytes: 800, Command: "claude"},
		},
	}
}

func TestHistoryInfoRequestAnswersWithTheNumbers(t *testing.T) {
	wt, m, _ := newFailingWebTTY(t, &tmux.Layout{})
	wt.SetCaptureProvider(&countingCapture{history: sampleReport()})

	if err := wt.handleTmuxMessage(TmuxHistoryInfoRequest, []byte(`{"windowId":"@7"}`)); err != nil {
		t.Fatal(err)
	}
	got := lastHistory(t, m)
	if !got.OK || got.Error != "" {
		t.Fatalf("info request failed: %+v", got)
	}
	if got.WindowID != "@7" {
		t.Errorf("windowId = %q, want @7", got.WindowID)
	}
	if got.Action != historyActionInfo {
		t.Errorf("action = %q, want the empty (no-action) marker", got.Action)
	}
	if len(got.Panes) != 2 || got.Panes[0].Size != 1990 || got.Panes[1].Command != "claude" {
		t.Errorf("panes not reported: %+v", got.Panes)
	}
	if got.Default != 2000 {
		t.Errorf("default = %d, want 2000", got.Default)
	}
}

// Reading the sizes must work with no controller at all — it is a view-only
// message, and the capture provider is the read side (authority.go).
func TestHistoryInfoNeedsNoController(t *testing.T) {
	m := &recordMaster{}
	wt, err := New(m, nil) // deliberately NO tmux controller
	if err != nil {
		t.Fatal(err)
	}
	wt.SetCaptureProvider(&countingCapture{history: sampleReport()})
	if err := wt.handleTmuxMessage(TmuxHistoryInfoRequest, []byte(`{"windowId":"@7"}`)); err != nil {
		t.Fatal(err)
	}
	if got := lastHistory(t, m); !got.OK {
		t.Errorf("info refused without a controller: %+v", got)
	}
}

// Each action reaches the controller, and each answers with a frame — including
// the ones that fail, since a click with no reply is a dropdown that says
// "Asking tmux…" forever.
func TestEveryHistoryActionAnswers(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload string
	}{
		{"default", `{"windowId":"@7","action":"default","limit":50000}`},
		{"persist", `{"windowId":"@7","action":"persist","limit":50000}`},
		{"resize", `{"windowId":"@7","action":"resize","limit":50000,"force":true}`},
		{"clear", `{"windowId":"@7","action":"clear"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wt, m, ctrl := newFailingWebTTY(t, &tmux.Layout{})
			wt.SetCaptureProvider(&countingCapture{history: sampleReport()})
			wt.permitWrite = true

			if err := wt.handleMasterReadEvent(append([]byte{TmuxHistoryAction}, tc.payload...)); err != nil {
				t.Fatalf("a failing tmux command tore the connection down: %v", err)
			}
			if ctrl.calls != 1 {
				t.Errorf("the action reached tmux %d times: %v", ctrl.calls, ctrl.seen)
			}
			got := lastHistory(t, m)
			if got.Action != tc.name {
				t.Errorf("action echoed as %q, want %q", got.Action, tc.name)
			}
			// failCtrl fails everything, so this is the failure path: a sentence, and
			// still the current numbers beside it.
			if got.OK || got.Error == "" {
				t.Errorf("a failed action reported ok=%v error=%q", got.OK, got.Error)
			}
			if len(got.Panes) != 2 {
				t.Error("the reply dropped the report — the panel would be left blank " +
					"by a failure, with nothing to correct")
			}
		})
	}
}

// A refusal is the controller's own sentence (it names what would be killed);
// anything else is an exec failure the user can do nothing with.
func TestHistoryRefusalKeepsItsExplanation(t *testing.T) {
	wt, m, _ := newFailingWebTTY(t, &tmux.Layout{})
	wt.SetTmuxController(&refuseHistoryCtrl{})
	wt.SetCaptureProvider(&countingCapture{history: sampleReport()})

	if err := wt.handleTmuxMessage(TmuxHistoryAction,
		[]byte(`{"windowId":"@7","action":"resize","limit":50000}`)); err != nil {
		t.Fatal(err)
	}
	got := lastHistory(t, m)
	if !strings.Contains(got.Error, "would kill claude") {
		t.Errorf("error = %q, want the controller's own explanation", got.Error)
	}
	if strings.HasPrefix(got.Error, "refused:") {
		t.Errorf("error = %q — the marker prefix is for the log, not for a person", got.Error)
	}
}

func TestUnknownHistoryActionIsNamedNotGuessedAt(t *testing.T) {
	wt, m, ctrl := newFailingWebTTY(t, &tmux.Layout{})
	wt.SetCaptureProvider(&countingCapture{history: sampleReport()})

	if err := wt.handleTmuxMessage(TmuxHistoryAction,
		[]byte(`{"windowId":"@7","action":"obliterate","limit":1}`)); err != nil {
		t.Fatal(err)
	}
	if ctrl.calls != 0 {
		t.Errorf("an unknown action ran %v", ctrl.seen)
	}
	if got := lastHistory(t, m); !strings.Contains(got.Error, "obliterate") {
		t.Errorf("error = %q, want it to name the action it did not recognize", got.Error)
	}
}

func TestHistoryActionWithoutAWindowIsRefused(t *testing.T) {
	wt, m, ctrl := newFailingWebTTY(t, &tmux.Layout{})
	if err := wt.handleTmuxMessage(TmuxHistoryAction, []byte(`{"action":"clear"}`)); err != nil {
		t.Fatal(err)
	}
	if ctrl.calls != 0 {
		t.Errorf("acted on no window at all: %v", ctrl.seen)
	}
	if got := lastHistory(t, m); got.Error == "" {
		t.Error("said nothing about a request it could not act on")
	}
}

func TestMalformedHistoryPayloadsAnswerRatherThanDrop(t *testing.T) {
	for _, msg := range []byte{TmuxHistoryInfoRequest, TmuxHistoryAction} {
		wt, m, _ := newFailingWebTTY(t, &tmux.Layout{})
		if err := wt.handleTmuxMessage(msg, []byte(`{not json`)); err != nil {
			t.Fatalf("%q: %v", msg, err)
		}
		if got := lastHistory(t, m); got.Error == "" {
			t.Errorf("%q: a malformed payload produced a silent success", msg)
		}
	}
}

// A "persist" has to name the file it wrote. The file is chosen on the tmux
// server (see pkg/tmux/history.go), so the browser has no way to know which of
// the user's configs just changed unless the reply says.
func TestPersistReportsTheFileItWrote(t *testing.T) {
	wt, m, _ := newFailingWebTTY(t, &tmux.Layout{})
	wt.SetTmuxController(&persistCtrl{path: "/home/me/.tmux.conf"})
	wt.SetCaptureProvider(&countingCapture{history: sampleReport()})

	if err := wt.handleTmuxMessage(TmuxHistoryAction,
		[]byte(`{"windowId":"@7","action":"persist","limit":50000}`)); err != nil {
		t.Fatal(err)
	}
	got := lastHistory(t, m)
	if !got.OK {
		t.Fatalf("persist reported a failure: %+v", got)
	}
	if got.SavedTo != "/home/me/.tmux.conf" {
		t.Errorf("savedTo = %q, want the path it wrote", got.SavedTo)
	}
}

// …and on failure it must STILL name it: "which file did you just try to change?"
// is the first thing anyone asks either way.
func TestPersistNamesTheFileEvenWhenTheWriteFails(t *testing.T) {
	wt, m, _ := newFailingWebTTY(t, &tmux.Layout{})
	wt.SetTmuxController(&persistCtrl{
		path: "/etc/tmux.conf",
		err:  fmt.Errorf("%w: could not write /etc/tmux.conf (no permission)", tmux.ErrRefused),
	})
	wt.SetCaptureProvider(&countingCapture{history: sampleReport()})

	if err := wt.handleTmuxMessage(TmuxHistoryAction,
		[]byte(`{"windowId":"@7","action":"persist","limit":50000}`)); err != nil {
		t.Fatal(err)
	}
	got := lastHistory(t, m)
	if got.OK {
		t.Error("a failed config write was reported as a success")
	}
	if got.SavedTo != "/etc/tmux.conf" {
		t.Errorf("savedTo = %q — the failure does not say which file it tried", got.SavedTo)
	}
	if !strings.Contains(got.Error, "no permission") {
		t.Errorf("error = %q, want the reason", got.Error)
	}
}

// A resize's receipt has to survive the trip: how many panes, and what it cost.
func TestResizeReceiptReachesTheBrowser(t *testing.T) {
	wt, m, _ := newFailingWebTTY(t, &tmux.Layout{})
	wt.SetTmuxController(&resizeCtrl{res: tmux.HistoryResize{
		Rebuilt: 2, Skipped: 1, Restarted: []string{"claude"}, LayoutRestored: true,
	}})
	wt.SetCaptureProvider(&countingCapture{history: sampleReport()})

	if err := wt.handleTmuxMessage(TmuxHistoryAction,
		[]byte(`{"windowId":"@7","action":"resize","limit":50000,"force":true}`)); err != nil {
		t.Fatal(err)
	}
	got := lastHistory(t, m)
	if !got.OK {
		t.Fatalf("resize reported a failure: %+v", got)
	}
	if got.Resize == nil || got.Resize.Rebuilt != 2 || got.Resize.Skipped != 1 {
		t.Fatalf("resize receipt = %+v", got.Resize)
	}
	if len(got.Resize.Restarted) != 1 || got.Resize.Restarted[0] != "claude" {
		t.Errorf("restarted = %v, want [claude]", got.Resize.Restarted)
	}
}

// ---- fakes -----------------------------------------------------------------

// refuseHistoryCtrl refuses a resize the way the real controller does: with
// ErrRefused and a sentence naming what would be killed.
type refuseHistoryCtrl struct{ failCtrl }

func (c *refuseHistoryCtrl) ResizeWindowHistory(string, int, bool, bool) (tmux.HistoryResize, error) {
	c.calls++
	c.seen = append(c.seen, "resize-history")
	return tmux.HistoryResize{}, fmt.Errorf("%w: rebuilding this window would kill claude", tmux.ErrRefused)
}

// persistCtrl answers the config write with a canned path (and optional failure).
type persistCtrl struct {
	failCtrl
	path string
	err  error
}

func (c *persistCtrl) PersistDefaultHistoryLimit(string, int) (string, error) {
	c.calls++
	c.seen = append(c.seen, "persist history-limit")
	return c.path, c.err
}

// resizeCtrl succeeds and hands back a receipt.
type resizeCtrl struct {
	failCtrl
	res tmux.HistoryResize
}

func (c *resizeCtrl) ResizeWindowHistory(string, int, bool, bool) (tmux.HistoryResize, error) {
	c.calls++
	c.seen = append(c.seen, "resize-history")
	return c.res, nil
}
