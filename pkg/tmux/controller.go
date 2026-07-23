package tmux

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Controller manages tmux interactions for a session
type Controller struct {
	sessionName string
	socket      string // tmux -S socket path; "" = tmux's default socket

	// Follow the pane's real tmux client. A pane is a live tmux client (the pty)
	// the user can drive natively (Ctrl+B w/s) to any session — so a fixed session
	// name goes stale/miscorrelated. For grouped split panes we DISCOVER the pane's
	// client (the sole client of its grouped session) and read #{client_session}
	// each refresh, so the layout always reflects where the pane actually is.
	// baseSession = the session it started on (client discovery + fallback). The
	// primary (shared base) doesn't follow — many clients — it tracks via SwitchSession.
	follow      bool
	baseSession string
	clientTTY   string
	groupBase   string // the real base session splits are grouped on (for self-heal)

	layoutCache *Layout
	layoutMu    sync.RWMutex

	eventChan chan Event
	closeChan chan struct{}
}

// NewController creates a new tmux controller for the given session on the given
// socket. A non-empty socket (e.g. the mounted host socket /host-tmux/default)
// is passed as `tmux -S <socket>` to EVERY command, so the layout sidebar reads
// the real host server rather than the container's empty default socket. follow=
// true (grouped split panes) tracks the pane's tmux client wherever it roams.
func NewController(sessionName string, socket string, follow bool, groupBase string) (*Controller, error) {
	c := &Controller{
		sessionName: sessionName,
		baseSession: sessionName,
		follow:      follow,
		groupBase:   groupBase,
		socket:      socket,
		eventChan:   make(chan Event, 100),
		closeChan:   make(chan struct{}),
	}

	return c, nil
}

// selfHeal keeps a split from staying SYNCED. If the pane's client has landed on a
// session shared with another client (e.g. it was driven — via native Ctrl+B — onto
// the base/console session, coupling it with the console-following primary), we
// transparently move it into a FRESH grouped session on the base: it keeps showing
// the same window but regains its own independent current-window, so it decouples.
// A pane that is the sole client of its (grouped) session is healthy — left alone.
func (c *Controller) selfHeal(curSession string) {
	if !c.follow || c.clientTTY == "" || c.groupBase == "" {
		return
	}
	if curSession == c.baseSession {
		return // still the sole client of its own group — healthy
	}
	if c.clientCount(curSession) <= 1 {
		return // alone on this session (no coupling) — leave it (user's deliberate move)
	}
	// Coupled with another client. Re-group onto a fresh grouped session on the base.
	// Order matters: create the group detached, MOVE the pane's client into it, and
	// only THEN arm destroy-unattached — setting it before the client attaches would
	// destroy the brand-new (unattached) session immediately.
	newName := fmt.Sprintf("web-h%d", time.Now().UnixNano()%1000000000)
	if _, err := c.runTmux("new-session", "-d", "-t", c.groupBase, "-s", newName); err != nil {
		return
	}
	if _, err := c.runTmux("switch-client", "-c", c.clientTTY, "-t", newName); err != nil {
		c.runTmux("kill-session", "-t", newName) // couldn't move the client — clean up
		return
	}
	c.runTmux("set-option", "-t", newName, "destroy-unattached", "on")
	c.baseSession = newName // discovery target + fallback now points at the fresh group
}

// clientCount returns how many tmux clients are attached to the given session.
func (c *Controller) clientCount(session string) int {
	out, err := c.runTmux("list-clients", "-t", session, "-F", "#{client_tty}")
	if err != nil {
		return 0
	}
	n := 0
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) != "" {
			n++
		}
	}
	return n
}

// session returns the session the pane is CURRENTLY on. Without follow, that's the
// controller's own name (mutated by SwitchSession). With follow, it's the pane's
// tmux client's current session (so native Ctrl+B session hops are reflected),
// falling back to the base session if the client can't be read yet.
func (c *Controller) session() string {
	if !c.follow {
		return c.sessionName
	}
	if c.clientTTY == "" {
		c.discoverClient()
	}
	if c.clientTTY != "" {
		// Find OUR client in the global client list by its tty and read the session
		// it's currently on (survives the client roaming to another session).
		if out, err := c.runTmux("list-clients", "-F", "#{client_tty},#{client_session}"); err == nil {
			for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
				parts := strings.SplitN(strings.TrimSpace(line), ",", 2)
				if len(parts) == 2 && parts[0] == c.clientTTY {
					if s := strings.TrimSpace(parts[1]); s != "" {
						return s
					}
				}
			}
		}
	}
	return c.baseSession
}

// discoverClient finds the pane's tmux client tty. A grouped split session has
// exactly one client (the pane's pty), so we read it off the base session before
// the client ever roams away. Cached once found.
func (c *Controller) discoverClient() {
	out, err := c.runTmux("list-clients", "-t", c.baseSession, "-F", "#{client_tty}")
	if err != nil {
		return
	}
	if lines := strings.Split(strings.TrimSpace(out), "\n"); len(lines) > 0 {
		if tty := strings.TrimSpace(lines[0]); tty != "" {
			c.clientTTY = tty
		}
	}
}

// Start initializes the controller and gets initial layout
func (c *Controller) Start() error {
	// Wait briefly for the session to exist. For a grouped split region the pty's
	// attach-web.sh creates the session (`new-session -t <base> -s <name>`) at
	// about the same moment this runs, so we must NOT race in and create a
	// *standalone* session of the same name (it would not be grouped with the
	// base). Poll has-session for up to ~2s; only if it never appears do we fall
	// back to creating one (the base-session bootstrap when webtmux starts first).
	exists := false
	for i := 0; i < 20; i++ {
		if _, err := c.runTmux("has-session", "-t", "="+c.sessionName); err == nil {
			exists = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !exists {
		// Session never appeared — create it (base bootstrap / non-grouped default).
		if _, createErr := c.runTmux("new-session", "-d", "-s", c.sessionName); createErr != nil {
			return fmt.Errorf("failed to create tmux session %s: %w", c.sessionName, createErr)
		}
	}

	// Get initial layout
	if err := c.RefreshLayout(); err != nil {
		return fmt.Errorf("failed to get initial layout: %w", err)
	}

	return nil
}

// Stop closes the controller
func (c *Controller) Stop() error {
	close(c.closeChan)
	return nil
}

// Events returns the channel for tmux events
func (c *Controller) Events() <-chan Event {
	return c.eventChan
}

// GetLayout returns the cached layout
func (c *Controller) GetLayout() *Layout {
	c.layoutMu.RLock()
	defer c.layoutMu.RUnlock()
	return c.layoutCache
}

// RefreshLayout fetches the current tmux layout
func (c *Controller) RefreshLayout() error {
	sess := c.session() // where the pane actually is (follows a roaming client)
	// If a split has drifted onto a shared session (synced), decouple it first.
	c.selfHeal(sess)
	sess = c.session()
	// Get session info
	sessionOut, err := c.runTmux("display-message", "-t", sess, "-p", "#{session_id},#{session_name}")
	if err != nil {
		return err
	}
	sessionParts := strings.Split(strings.TrimSpace(sessionOut), ",")
	if len(sessionParts) < 2 {
		return fmt.Errorf("invalid session output: %s", sessionOut)
	}

	layout := &Layout{
		SessionID:   sessionParts[0],
		SessionName: sessionParts[1],
	}

	// Get all sessions
	sessionsOut, err := c.runTmux("list-sessions", "-F", "#{session_id},#{session_name},#{session_windows},#{session_attached}")
	if err == nil {
		for _, line := range strings.Split(strings.TrimSpace(sessionsOut), "\n") {
			if line == "" {
				continue
			}
			parts := strings.Split(line, ",")
			if len(parts) < 4 {
				continue
			}
			winCount, _ := strconv.Atoi(parts[2])
			attached := parts[3] == "1"
			session := Session{
				ID:       parts[0],
				Name:     parts[1],
				Windows:  winCount,
				Attached: attached,
				Active:   parts[1] == sess,
			}
			layout.Sessions = append(layout.Sessions, session)
		}
	}

	// Get windows
	windowsOut, err := c.runTmux("list-windows", "-t", sess, "-F", "#{window_id},#{window_name},#{window_index},#{window_active}")
	if err != nil {
		return err
	}

	for _, line := range strings.Split(strings.TrimSpace(windowsOut), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) < 4 {
			continue
		}

		idx, _ := strconv.Atoi(parts[2])
		active := parts[3] == "1"

		win := Window{
			ID:     parts[0],
			Name:   parts[1],
			Index:  idx,
			Active: active,
		}

		if active {
			layout.ActiveWinID = win.ID
		}

		// Get panes for this window
		panesOut, err := c.runTmux("list-panes", "-t", win.ID, "-F",
			"#{pane_id},#{pane_index},#{pane_active},#{pane_in_mode},#{pane_width},#{pane_height},#{pane_top},#{pane_left},#{pane_current_command},#{pane_title}")
		if err != nil {
			continue
		}

		for _, paneLine := range strings.Split(strings.TrimSpace(panesOut), "\n") {
			if paneLine == "" {
				continue
			}
			paneParts := strings.Split(paneLine, ",")
			if len(paneParts) < 10 {
				continue
			}

			paneIdx, _ := strconv.Atoi(paneParts[1])
			paneActive := paneParts[2] == "1"
			paneInMode := paneParts[3] == "1"
			width, _ := strconv.Atoi(paneParts[4])
			height, _ := strconv.Atoi(paneParts[5])
			top, _ := strconv.Atoi(paneParts[6])
			left, _ := strconv.Atoi(paneParts[7])

			pane := Pane{
				ID:      paneParts[0],
				Index:   paneIdx,
				Active:  paneActive,
				InMode:  paneInMode,
				Width:   width,
				Height:  height,
				Top:     top,
				Left:    left,
				Command: paneParts[8],
				Title:   paneParts[9],
			}

			if paneActive && active {
				layout.ActivePaneID = pane.ID
				layout.ActivePaneInMode = pane.InMode
			}

			win.Panes = append(win.Panes, pane)
		}

		layout.Windows = append(layout.Windows, win)
	}

	c.layoutMu.Lock()
	c.layoutCache = layout
	c.layoutMu.Unlock()

	return nil
}

// SelectPane switches to the specified pane
func (c *Controller) SelectPane(paneID string) error {
	_, err := c.runTmux("select-pane", "-t", paneID)
	if err != nil {
		return err
	}
	c.RefreshLayout()
	return nil
}

// SelectWindow switches THIS controller's session to the specified window.
//
// Grouped sessions share the window list (same @ids + indexes) but keep an
// independent current window, so a bare `select-window -t @id` is ambiguous
// across the group. We qualify the target to this session by window INDEX —
// `select-window -t <session>:<index>` — which the A.1 spike confirmed moves
// only this session. The client sends a window @id, so we map @id -> index via
// the layout cache (refreshing once if it's not found).
func (c *Controller) SelectWindow(windowID string) error {
	idx, ok := c.windowIndex(windowID)
	if !ok {
		// Stale cache — refresh once and retry the lookup.
		c.RefreshLayout()
		idx, ok = c.windowIndex(windowID)
	}

	target := windowID // last-resort fallback: bare @id (single-session correctness)
	if ok {
		target = fmt.Sprintf("%s:%d", c.session(), idx)
	}

	if _, err := c.runTmux("select-window", "-t", target); err != nil {
		return err
	}
	c.RefreshLayout()
	return nil
}

// windowIndex returns the window_index for a given window @id from the cached
// layout (grouped sessions share indexes, so this session's index matches).
func (c *Controller) windowIndex(windowID string) (int, bool) {
	c.layoutMu.RLock()
	defer c.layoutMu.RUnlock()
	if c.layoutCache == nil {
		return 0, false
	}
	for _, w := range c.layoutCache.Windows {
		if w.ID == windowID {
			return w.Index, true
		}
	}
	return 0, false
}

// RenameWindow renames a window by id. tmux disables automatic-rename for a
// manually-renamed window, so the name sticks.
func (c *Controller) RenameWindow(windowID, name string) error {
	_, err := c.runTmux("rename-window", "-t", windowID, name)
	if err != nil {
		return err
	}
	c.RefreshLayout()
	return nil
}

// SwitchSession switches to the specified session
func (c *Controller) SwitchSession(sessionName string) error {
	_, err := c.runTmux("switch-client", "-t", sessionName)
	if err != nil {
		return err
	}
	c.sessionName = sessionName
	c.RefreshLayout()
	return nil
}

// SplitPane splits the current pane
func (c *Controller) SplitPane(horizontal bool) error {
	flag := "-v"
	if horizontal {
		flag = "-h"
	}
	_, err := c.runTmux("split-window", "-t", c.session(), flag)
	if err != nil {
		return err
	}
	c.RefreshLayout()
	return nil
}

// ClosePane closes the specified pane
func (c *Controller) ClosePane(paneID string) error {
	_, err := c.runTmux("kill-pane", "-t", paneID)
	if err != nil {
		return err
	}
	c.RefreshLayout()
	return nil
}

// EnterCopyMode enters copy mode on the active pane
func (c *Controller) EnterCopyMode() error {
	_, err := c.runTmux("copy-mode", "-t", c.session())
	return err
}

// ExitCopyMode exits copy mode
func (c *Controller) ExitCopyMode() error {
	_, err := c.runTmux("send-keys", "-t", c.session(), "-X", "cancel")
	return err
}

// ScrollUp scrolls up in copy mode
func (c *Controller) ScrollUp(lines int) error {
	for i := 0; i < lines; i++ {
		_, err := c.runTmux("send-keys", "-t", c.session(), "-X", "scroll-up")
		if err != nil {
			return err
		}
	}
	return nil
}

// ScrollDown scrolls down in copy mode
func (c *Controller) ScrollDown(lines int) error {
	for i := 0; i < lines; i++ {
		_, err := c.runTmux("send-keys", "-t", c.session(), "-X", "scroll-down")
		if err != nil {
			return err
		}
	}
	return nil
}

// NewWindow creates a new window
func (c *Controller) NewWindow() error {
	_, err := c.runTmux("new-window", "-t", c.session())
	if err != nil {
		return err
	}
	c.RefreshLayout()
	return nil
}

// runTmux executes a tmux command with the given arguments, prefixing the
// `-S <socket>` flag when a socket path is configured so every layout query and
// action targets the mounted host server.
func (c *Controller) runTmux(args ...string) (string, error) {
	if c.socket != "" {
		args = append([]string{"-S", c.socket}, args...)
	}
	cmd := exec.Command("tmux", args...)
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("tmux command failed: %w", err)
	}
	return string(output), nil
}

