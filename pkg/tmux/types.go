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
	// NewCmds is this session's NEW-WINDOW MENU: the ordered list of commands its
	// "+" offers, from the session's @wt_newcmds user option. The sidebar draws one
	// "+" per entry, captioned with what it runs.
	//
	// A property of the SESSION, not of webtmux: a session holds windows that do
	// the same kind of thing, but rarely only one kind — claude-editors wants a
	// host shell, a shell inside the secure daemon, and "launch the next claude".
	// Before this, the only place that intent lived was in whoever remembered which
	// command to type. scripts/stack.sh declares the menu for the sessions it
	// builds, so one arrives already knowing what its "+" buttons mean.
	//
	// Empty/absent = one plain "+", which is what every session did before this.
	NewCmds []NewCmd `json:"newCmds,omitempty"`
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
	// (e.g. an `editors` window while this region views `services`) would otherwise
	// have no status. Recent-tab dots read from this so each window's light reflects
	// its OWN @wt_working regardless of which session is currently focused.
	AllWorking map[string]string `json:"allWorking,omitempty"`
	// AllWorkingSince maps a window id to the unix epoch (as a string) it last
	// TRANSITIONED to its current AllWorking value, from @wt_working_since. The
	// bridge stamps it only on an actual change (see tmux-stoplight-bridge.sh), so
	// a window that has re-asserted the same colour for hours still reads the time
	// it first reached it -- the answer to "how long has it been like this", which
	// a colour alone can't give someone scanning a wall of windows. Unset (a window
	// with no hook, or one from before this option existed) => "" => the UI shows
	// no duration rather than guessing one.
	AllWorkingSince map[string]string `json:"allWorkingSince,omitempty"`
	// AllActivity maps a window id to tmux's own #{window_activity} -- the unix
	// epoch (as a string) of the last time ANYTHING was written to that window,
	// tracked by tmux internally regardless of the `monitor-activity` option (which
	// only gates the bell/flag, not this timestamp -- verified against a real tmux
	// server). Unlike AllWorkingSince this needs no hook and exists for every
	// window on the server, agent or not: it answers "how long has this pane been
	// silent", a different question from "how long has the agent been in this
	// state" -- a background build can keep printing (activity moves) while the
	// stoplight itself hasn't changed colour in an hour.
	AllActivity map[string]string `json:"allActivity,omitempty"`
	// AllWindows is the server-wide window DIRECTORY: one entry per (session, window)
	// placement, from the same `list-windows -a` that fills AllWorking. AllWorking
	// answers "what is that window doing" but is keyed by window id alone, so a
	// window outside every attached session could be known to be waiting and still be
	// unreachable — the UI had no session to switch to, no name to show and no index
	// to label it with. The attention arrow at the end of the recents strip navigates
	// to exactly those windows, so it needs the placement, not just the light.
	//
	// Ephemeral web-* grouped split shadows are omitted: they mirror their base
	// session's window list, so including them would double every window in a split.
	AllWindows []WindowRef `json:"allWindows,omitempty"`
	// State is the opaque UI visual-state blob stored in the tmux SERVER-global user
	// option @wt_state (written via TmuxSetState). It rides every layout push so any
	// client that attaches — even after a webtmux server/client restart — converges
	// on the same shared visual state. Unset / empty / non-JSON => omitted.
	State json.RawMessage `json:"state,omitempty"`
	// ServerStart identifies the tmux SERVER instance this push came from (its
	// `#{start_time}`, sanitized). It exists for one job: the browser keys its
	// offline @wt_state cache by it.
	//
	// State above is client-authoritative and versioned by a `rev` the CLIENT bumps.
	// Point the same browser at a different tmux server — another socket, or the same
	// one killed and restarted — and that server's rev sequence starts again at 1
	// while the browser's cache still holds, say, rev 40. Under a single cache key the
	// stale rev suppresses every push until the new server has climbed past it, and
	// the UI sits on state belonging to a server that no longer exists. A per-server
	// cache key makes that impossible.
	//
	// Omitted when tmux does not report it (too old to know the format), and the
	// client then falls back to its single legacy cache key — i.e. today's behavior.
	ServerStart string `json:"serverStart,omitempty"`
}

// WindowRef is one (session, window) placement in Layout.AllWindows — enough to
// name a window, label it, and navigate to it, for windows that no attached region
// currently lists. Deliberately NOT a full Window: it carries no panes, because the
// directory covers every window on the server and running list-panes over all of
// them on every 500ms refresh would be a real cost for data nothing reads.
type WindowRef struct {
	ID      string `json:"id"`
	Session string `json:"session"`
	Index   int    `json:"index"`
	Name    string `json:"name"`
	// Working is the same @wt_working value as AllWorking[ID] — carried here too so
	// a consumer walking the directory doesn't have to join two structures.
	Working string `json:"working"`
	// WorkingSince / Activity mirror AllWorkingSince[ID] / AllActivity[ID] for the
	// same join-avoidance reason as Working above.
	WorkingSince string `json:"workingSince,omitempty"`
	Activity     string `json:"activity,omitempty"`
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
	// from simply being idle), "3" = working in the background (green ring — it is
	// waiting on something it started and will carry on by itself, but it is sitting
	// at a prompt meanwhile, so it can take input; distinct from "1" because you can
	// interrupt it for free, and from "0" because it is not out of work),
	// "" = unset (unfilled dot). Clients set it with `tmux set -w @wt_working 1|3|2|0`.
	//
	// Deliberately carried as an opaque string, not an enum: the server's job is to
	// relay whatever the window claimed, and stoplight.js decides what it means. A
	// value this end has never heard of degrades to an unfilled dot in the UI, which
	// is how a new state can be rolled out to the hooks before the server knows it.
	Working string `json:"working"`
	// WorkingSince / Activity are this window's own copies of AllWorkingSince[ID] /
	// AllActivity[ID] (see Layout), read from the SAME `list-windows` call as
	// Working. The per-session Windows list is what the sidebar renders before the
	// global `list-windows -a` pass has necessarily arrived, so these travel with
	// Working rather than being available only via the global maps.
	WorkingSince string `json:"workingSince,omitempty"`
	Activity     string `json:"activity,omitempty"`
	Panes        []Pane `json:"panes"`
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
