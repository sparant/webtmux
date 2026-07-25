package tmux

import "encoding/json"

// Session represents a tmux session
type Session struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Windows  int    `json:"windows"`
	Attached bool   `json:"attached"`
	Active   bool   `json:"active"`
	// Empty is true when the session has nothing running: a single window with a
	// single pane sitting at an idle shell prompt. The sidebar skips the kill
	// confirmation for such sessions (there's no live work to protect).
	Empty bool `json:"empty"`
}

// Layout represents the complete tmux state
type Layout struct {
	SessionID   string `json:"sessionId"`
	SessionName string `json:"sessionName"`
	// SessionBase is the LOGICAL session this pane is viewing: for a split pane
	// (whose own session is an ephemeral web-* grouped shadow) it is the group's
	// base session; otherwise it equals SessionName. The UI displays/compares
	// sessions by this, never by the shadow name.
	SessionBase  string    `json:"sessionBase"`
	Sessions     []Session `json:"sessions"`
	Windows      []Window  `json:"windows"`
	ActiveWinID  string    `json:"activeWindowId"`
	ActivePaneID string    `json:"activePaneId"`
	// ActivePaneInMode is true when the active pane of the active window is in a
	// tmux mode (copy-mode / view-mode) rather than normal input — the ground
	// truth the toolbar uses to show/toggle copy mode. Read from #{pane_in_mode}.
	ActivePaneInMode bool `json:"activePaneInMode"`
	// AllWorking maps EVERY tmux window_id (across ALL sessions) to its @wt_working
	// value ("1"/"0"/"2"/""), read once per refresh via `list-windows -a`. Windows above
	// only covers the attached session `sess`, so a window living in another session
	// (e.g. a claude-editors window while this region views services) would otherwise
	// have no status. Recent-tab dots read from this so each window's light reflects
	// its OWN @wt_working regardless of which session is currently focused.
	AllWorking map[string]string `json:"allWorking,omitempty"`
	// State is the opaque UI visual-state blob stored in the tmux SERVER-global user
	// option @wt_state (written via TmuxSetState). It rides every layout push so any
	// client that attaches — even after a webtmux server/client restart — converges
	// on the same shared visual state. Unset / empty / non-JSON => omitted.
	State json.RawMessage `json:"state,omitempty"`
}

// Window represents a tmux window
type Window struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Index  int    `json:"index"`
	Active bool   `json:"active"`
	// Working is the window's self-reported work status, read from the @wt_working
	// tmux user option: "1" = working (green dot), "0" = stopped (red dot),
	// "2" = waiting for user input (amber dot — an agent asked a question or needs a
	// permission decision, so the window is blocked on a human, which is distinct
	// from simply being idle), "" = unset (unfilled dot). Clients set it with
	// `tmux set -w @wt_working 1|0|2`.
	Working string `json:"working"`
	Panes   []Pane `json:"panes"`
	// SessionCount is how many DISTINCT logical sessions this window is linked into
	// (ephemeral web-* grouped shadows collapse onto their base, so a window shared
	// by a split's grouped sessions still counts as one). >1 means the sidebar ×
	// unlinks it from the current session rather than killing it.
	SessionCount int `json:"sessionCount"`
}

// Pane represents a tmux pane
type Pane struct {
	ID      string `json:"id"`
	Index   int    `json:"index"`
	Active  bool   `json:"active"`
	InMode  bool   `json:"inMode"` // pane is in a tmux mode (copy-mode/view-mode)
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Top     int    `json:"top"`
	Left    int    `json:"left"`
	Command string `json:"command"`
	Title   string `json:"title"`
}

// ModeState represents the current mode of a pane (normal, copy, etc.)
type ModeState struct {
	PaneID         string `json:"paneId"`
	InCopyMode     bool   `json:"inCopyMode"`
	ScrollPosition int    `json:"scrollPosition"`
	HistorySize    int    `json:"historySize"`
}

// Event represents a tmux control mode event
type Event struct {
	Type    string
	Payload string
}
