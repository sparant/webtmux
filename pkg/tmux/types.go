package tmux

// Session represents a tmux session
type Session struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Windows  int    `json:"windows"`
	Attached bool   `json:"attached"`
	Active   bool   `json:"active"`
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
}

// Window represents a tmux window
type Window struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Index  int    `json:"index"`
	Active bool   `json:"active"`
	Panes  []Pane `json:"panes"`
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
