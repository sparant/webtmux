package webtty

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"

	"webtmux/pkg/tmux"
)

// The scrollback buffer as an OBJECT you can see and change, rather than a
// setting you edit in tmux.conf and find out about later.
//
// Three things were invisible before this: how many lines a window's panes can
// hold, how much of that they are actually holding, and the fact that changing
// `history-limit` does nothing to a pane that already exists. The last one is the
// reason the first two matter — a person who has just raised the limit and sees
// the pane still reporting the old number learns the rule in one glance instead
// of by losing output they thought they had kept.
//
// The wire is deliberately one REPLY type for both a question and an action
// (TmuxHistoryInfo). An action's outcome and the numbers it produced are the same
// answer; splitting them would let a dropdown report "resized to 50,000" beside a
// panel still showing 2,000, which is precisely the confusion this exists to end.

// historyActions are the three things the dropdown can ask for. Named on the wire
// rather than inferred from which fields are set: "limit is present, so this must
// be a resize" is the kind of encoding that turns a UI bug into a destructive one.
const (
	historyActionInfo    = ""        // no action; just report
	historyActionDefault = "default" // set-option -g history-limit
	historyActionResize  = "resize"  // rebuild this window's panes
	historyActionClear   = "clear"   // clear-history on this window's panes
)

// historyRequest is the TmuxHistoryInfoRequest / TmuxHistoryAction payload.
type historyRequest struct {
	WindowID string `json:"windowId"`
	Action   string `json:"action"`
	Limit    int    `json:"limit"`
	// Force is the user's answer to "this kills what is running in the window".
	// A resize of a window holding anything but shells is refused without it.
	Force bool `json:"force"`
}

// historyOutcome is the TmuxHistoryInfo payload: the report, plus what the action
// that produced it did.
type historyOutcome struct {
	tmux.HistoryReport
	// Action echoes back which request this answers, so a reply that crosses with
	// a later one can be recognized for what it is rather than read as the answer
	// to whatever is on screen now.
	Action string `json:"action"`
	OK     bool   `json:"ok"`
	Error  string `json:"error"`
	// Resize carries the rebuild's receipt (how many panes, what was killed).
	// Absent for the other actions.
	Resize *tmux.HistoryResize `json:"resize,omitempty"`
}

// handleHistoryInfoRequest answers "how big is this scrollback, and how full?"
// for one window. Read-only (see authority.go), so it works on a server started
// without `-w`: looking at a buffer changes nothing.
func (wt *WebTTY) handleHistoryInfoRequest(payload []byte) error {
	var req historyRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		return wt.sendHistory(historyOutcome{Error: "invalid scrollback request"})
	}
	return wt.sendHistory(wt.historyReport(req.WindowID, historyActionInfo, nil, nil))
}

// handleHistoryAction performs one change and answers with the state it left
// behind.
//
// Every failure comes back as a sentence in the reply rather than as a returned
// error: a returned error would cost the user the whole pane (see afterCmd), and
// these are all things a person just clicked and is waiting to hear about.
func (wt *WebTTY) handleHistoryAction(payload []byte) error {
	var req historyRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		return wt.sendHistory(historyOutcome{Error: "invalid scrollback request"})
	}
	if strings.TrimSpace(req.WindowID) == "" {
		return wt.sendHistory(historyOutcome{Action: req.Action, Error: "no window given"})
	}

	var (
		actErr error
		resize *tmux.HistoryResize
	)
	switch req.Action {
	case historyActionDefault:
		actErr = wt.tmuxCtrl.SetDefaultHistoryLimit(req.WindowID, req.Limit)
	case historyActionResize:
		r, err := wt.tmuxCtrl.ResizeWindowHistory(req.WindowID, req.Limit, req.Force)
		resize, actErr = &r, err
	case historyActionClear:
		actErr = wt.tmuxCtrl.ClearWindowHistory(req.WindowID)
	default:
		return wt.sendHistory(historyOutcome{
			Action: req.Action,
			Error:  fmt.Sprintf("unknown scrollback action %q", req.Action),
		})
	}
	if actErr != nil {
		log.Printf("scrollback %s on %s failed: %v", req.Action, req.WindowID, actErr)
	}
	// The report is re-read AFTER the action either way. On success it is the
	// proof; on failure it is what the window actually looks like now, which for a
	// partial rebuild is neither the old state nor the requested one.
	return wt.sendHistory(wt.historyReport(req.WindowID, req.Action, actErr, resize))
}

// historyReport reads the window's current numbers and folds an action's outcome
// in. A failure to READ is reported in the same field as a failure to ACT — from
// the dropdown's side they are the same event (it has nothing true to show) — but
// an action error wins, because it is the one the user asked a question with.
func (wt *WebTTY) historyReport(windowID, action string, actErr error, resize *tmux.HistoryResize) historyOutcome {
	out := historyOutcome{Action: action, Resize: resize}
	out.WindowID = windowID
	if wt.captureProvider == nil {
		out.Error = "scrollback settings are unavailable (not a tmux session)"
		return out
	}
	rep, err := wt.captureProvider.HistoryReport(windowID)
	if err == nil {
		out.HistoryReport = rep
	}
	out.WindowID = windowID // HistoryReport carries it too; keep the asked-for id
	switch {
	case actErr != nil:
		out.Error = historyErrorText(actErr)
	case err != nil:
		log.Printf("scrollback report for %s failed: %v", windowID, err)
		out.Error = "could not read this window's scrollback settings"
	default:
		out.OK = true
	}
	return out
}

// historyErrorText turns a controller error into the sentence shown in the
// dropdown. A REFUSAL already reads as one (the controller writes them for a
// person — "would kill vim", "too small to split"), so only the marker prefix is
// stripped; anything else is a tmux command that failed for reasons the user can
// do nothing with, and gets a plain statement instead of a raw exec error.
func historyErrorText(err error) string {
	if errors.Is(err, tmux.ErrRefused) {
		return strings.TrimPrefix(err.Error(), "refused: ")
	}
	return "tmux would not make that change"
}

// sendHistory writes one TmuxHistoryInfo frame.
func (wt *WebTTY) sendHistory(out historyOutcome) error {
	data, err := json.Marshal(out)
	if err != nil {
		return fmt.Errorf("failed to marshal scrollback info: %w", err)
	}
	return wt.masterWrite(append([]byte{TmuxHistoryInfo}, data...))
}
