package webtty

import (
	"encoding/json"
	"fmt"
	"log"

	"webtmux/pkg/tmux"
)

// tmux settings, as things the toolbar's link menu can show and change.
//
// One message pair, one reply type, and a payload with NAMED fields — see
// message_types.go for why. The whole surface is currently the status line; the
// shape exists so that the next setting is a field rather than a protocol change.
//
// The reply is tmux.Settings itself, unwrapped: it already carries the Error field
// a failure needs, and an outcome envelope around it would give the client two
// places to look for the same "is this answer trustworthy?".

// settingsRequest is the TmuxSettingsAction payload. StatusBar is a *bool rather
// than a bool so "the client said nothing about the status bar" is distinguishable
// from "the client said off" — with a plain bool, an unrelated future setting would
// silently hide the status line every time it was changed.
type settingsRequest struct {
	StatusBar *bool `json:"statusBar"`
}

// handleSettingsRequest answers "what are the tmux settings right now?". Read-only
// (see authority.go), so it works on a server started without `-w`: a viewer who
// can see the status line may certainly be told whether it is drawn.
func (wt *WebTTY) handleSettingsRequest() error {
	return wt.sendSettings(wt.settingsReport(nil))
}

// handleSettingsAction applies one change and answers with the state it left
// behind. Like the scrollback actions, every failure comes back as a sentence in
// the reply rather than a returned error: a returned error would cost the user the
// whole pane (see afterCmd), and this is something a person just clicked.
func (wt *WebTTY) handleSettingsAction(payload []byte) error {
	var req settingsRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		return wt.sendSettings(tmux.Settings{Error: "invalid settings request"})
	}
	if req.StatusBar == nil {
		return wt.sendSettings(tmux.Settings{Error: "settings request changed nothing"})
	}
	set, err := wt.tmuxCtrl.SetStatusBar(*req.StatusBar)
	if err != nil {
		log.Printf("tmux status-bar toggle failed: %v", err)
		return wt.sendSettings(wt.settingsReport(err))
	}
	return wt.sendSettings(set)
}

// settingsReport re-reads the settings and folds an action's failure in. The
// re-read happens either way: on failure the point is to show what tmux ACTUALLY
// looks like now, which after a half-applied change is neither the old state nor
// the requested one.
func (wt *WebTTY) settingsReport(actErr error) tmux.Settings {
	out, err := wt.tmuxCtrl.ReadSettings()
	switch {
	case actErr != nil:
		out.Error = "tmux would not make that change"
	case err != nil:
		log.Printf("reading tmux settings failed: %v", err)
		out.Error = "could not read the tmux settings"
	}
	return out
}

// sendSettings writes one TmuxSettings frame.
func (wt *WebTTY) sendSettings(out tmux.Settings) error {
	data, err := json.Marshal(out)
	if err != nil {
		return fmt.Errorf("failed to marshal tmux settings: %w", err)
	}
	return wt.masterWrite(append([]byte{TmuxSettings}, data...))
}
