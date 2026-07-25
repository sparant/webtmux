package tmux

import (
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"sort"
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
	// name goes stale/miscorrelated. The server passes the pane's exact client
	// identity — tty (via TIOCGPTN) + pid (the exec'd tmux client) — through
	// SetClient, so EVERY pane, the primary included, is followed and switched
	// deterministically. The PID is the unambiguous row key (tty strings collide
	// across pid namespaces: our container's /dev/pts/N vs a host console's);
	// switch-client can only target by tty string, so switches additionally
	// refuse when the string is ambiguous (see switchOurClient) — ReservePtys
	// keeps it unique in practice. When neither is known we fall back to
	// discovering the sole client of the pane's grouped session.
	// baseSession = the pane's own (grouped) session (discovery + fallback);
	// groupBase = the logical session that group currently views ("" = primary,
	// which sits directly on the shared base and is never re-grouped).
	follow      bool
	baseSession string
	clientTTY   string
	clientPID   int
	groupBase   string

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

// SetClient hands the controller the pane's exact tmux client identity: the
// pty's slave tty (read via TIOCGPTN) and the spawned child's pid
// (attach-web.sh execs into the tmux client, so it IS #{client_pid}). With
// either known, the pane is followed deterministically — no discovery
// heuristics — so following is enabled for every pane, the primary included.
func (c *Controller) SetClient(tty string, pid int) {
	if tty == "" && pid <= 0 {
		return
	}
	c.clientTTY = tty
	c.clientPID = pid
	c.follow = true
}

// listClients fetches every client on the server with pid/tty/session.
func (c *Controller) listClients() ([]clientRow, error) {
	out, err := c.runTmux("list-clients", "-F", clientsFormat)
	if err != nil {
		return nil, err
	}
	return parseClientRows(out), nil
}

// switchOurClient moves OUR pane's client to the target session — and refuses
// when the tty string is ambiguous: tmux resolves `-c` by STRING, so if a
// host-side client shares our "/dev/pts/N" it could move the WRONG client
// (historically: the ssh console, or leaving this pane visibly unswitched
// while the layout claimed otherwise). ReservePtys makes collisions
// ~impossible; this guard turns any residual one into a safe, loud no-op
// instead of a wrong-client move. Verifies the landing by pid and logs a miss.
func (c *Controller) switchOurClient(target string) error {
	if c.clientTTY == "" {
		return fmt.Errorf("client tty unknown; cannot switch-client safely")
	}
	rows, err := c.listClients()
	if err != nil {
		return err
	}
	if n := countTTY(rows, c.clientTTY); n > 1 {
		return fmt.Errorf("client tty %s is ambiguous (%d clients share it) — refusing switch-client; raise WEBTMUX_PTS_FLOOR", c.clientTTY, n)
	}
	if _, err := c.runTmux("switch-client", "-c", c.clientTTY, "-t", target); err != nil {
		return err
	}
	if c.clientPID > 0 {
		if rows, err := c.listClients(); err == nil {
			if r, ok := findClient(rows, c.clientPID, c.clientTTY); ok && r.session != target {
				log.Printf("switch-client verification failed: client pid=%d tty=%s is on %q, wanted %q",
					c.clientPID, c.clientTTY, r.session, target)
			}
		}
	}
	return nil
}

// selfHeal keeps a split from staying SYNCED. If the pane's client has landed on a
// session shared with another client (e.g. it was driven — via native Ctrl+B — onto
// the base/console session, coupling it with the console-following primary), we
// transparently move it into a FRESH grouped session on the session it is looking
// at: it keeps showing the same window list but regains its own independent
// current-window, so it decouples. A pane that is the sole client of its session
// is healthy — left alone (a deliberate native move to an otherwise-empty session).
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
	// Coupled with another client. Re-group onto the session the pane is actually
	// viewing (NOT the original base — regrouping there would teleport a pane that
	// had navigated to a different session back to the base's windows).
	c.regroupOnto(curSession)
}

// regroupOnto moves this split pane's client into a fresh grouped session on
// `base`, giving it an independent current-window over base's window list.
// Order matters: create the group detached, MOVE the pane's client into it, and
// only THEN arm destroy-unattached — setting it before the client attaches would
// destroy the brand-new (unattached) session immediately. The pane's previous
// grouped session self-reaps via its own destroy-unattached.
func (c *Controller) regroupOnto(base string) error {
	newName := fmt.Sprintf("web-h%d", time.Now().UnixNano()%1000000000)
	if _, err := c.runTmux("new-session", "-d", "-t", base, "-s", newName); err != nil {
		return err
	}
	if err := c.switchOurClient(newName); err != nil {
		c.runTmux("kill-session", "-t", newName) // couldn't move the client — clean up
		return err
	}
	c.runTmux("set-option", "-t", newName, "destroy-unattached", "on")
	c.baseSession = newName // discovery target + fallback now points at the fresh group
	c.groupBase = base      // the logical session this pane now views
	return nil
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
// falling back to the base session if the client can't be read yet. The row is
// matched by PID first (unambiguous even when a host-side client shares our tty
// string — see findClient), tty only as a fallback.
func (c *Controller) session() string {
	if !c.follow {
		return c.sessionName
	}
	if c.clientTTY == "" && c.clientPID <= 0 {
		c.discoverClient()
	}
	if rows, err := c.listClients(); err == nil {
		if r, ok := findClient(rows, c.clientPID, c.clientTTY); ok && r.session != "" {
			return r.session
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

	// All sessions with grouping info. This drives the sidebar session list, its
	// Active flag, and the pane's LOGICAL session (SessionBase): a split pane's
	// own session is an ephemeral web-* group, but the UI must present the
	// group's base session as "where this pane is".
	var rows []sessionRow
	sessionsOut, err := c.runTmux("list-sessions", "-F", sessionsFormat)
	if err == nil {
		rows = parseSessionRows(sessionsOut)
		layout.SessionBase = logicalBase(rows, sess)
		layout.Sessions = buildSessions(rows, sess, c.sessionEmptiness(rows))
	}
	if layout.SessionBase == "" {
		layout.SessionBase = sess
	}

	// How many distinct logical sessions each window is linked into (for the
	// sidebar's unlink-vs-kill × affordance). Computed once per refresh.
	linkCounts := c.windowLinkCounts(rows)

	// Get windows
	windowsOut, err := c.runTmux("list-windows", "-t", sess, "-F", "#{window_id},#{window_name},#{window_index},#{window_active},#{@wt_working}")
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

		// @wt_working rides as the LAST field (appended to the format), so read it
		// from the tail — robust even if a window name contains a comma. Unset =>
		// tmux expands it to "" => empty trailing field => unfilled dot in the UI.
		if len(parts) >= 5 {
			win.Working = parts[len(parts)-1]
		}

		// Distinct logical sessions holding this window; default to 1 (it's at
		// least in the session we're listing) when the lookup came back empty.
		if sc := linkCounts[win.ID]; sc > 0 {
			win.SessionCount = sc
		} else {
			win.SessionCount = 1
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

	// Global @wt_working across ALL sessions, keyed by window_id. The per-session
	// Windows list above only covers `sess`, so a window in another session (e.g. a
	// claude-editors window while this region views services) would carry no status
	// and its recent-tab dot would go blank/stale as the focus roams between
	// sessions. One `list-windows -a` makes every window's light foreground-
	// independent. `|` is a safe delimiter here: both fields are tmux-controlled
	// (window_id is `@<n>`, @wt_working is ""/"0"/"1").
	if allOut, err := c.runTmux("list-windows", "-a", "-F", "#{window_id}|#{@wt_working}"); err == nil {
		working := make(map[string]string)
		for _, line := range strings.Split(strings.TrimSpace(allOut), "\n") {
			if line == "" {
				continue
			}
			if id, val, ok := strings.Cut(line, "|"); ok {
				working[id] = val
			}
		}
		layout.AllWorking = working
	}

	// Shared UI visual-state blob (@wt_state SERVER-global option). Rides this push
	// so every attaching client converges on the same visual state. Unset => "" =>
	// omitted; a non-JSON value is ignored rather than breaking the layout marshal.
	if raw, err := c.runTmux("show-options", "-gqv", "@wt_state"); err == nil {
		if s := strings.TrimSpace(raw); s != "" && json.Valid([]byte(s)) {
			layout.State = json.RawMessage(s)
		}
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

// windowOrderAndPos returns the current window indices in ascending (display)
// order plus the ordinal position of windowID within that order (-1 if absent).
// Grouped sessions share the window list, so this order is the same for every
// pane. Read under the layout lock from the cache the 500ms poll keeps warm.
func (c *Controller) windowOrderAndPos(windowID string) ([]int, int) {
	c.layoutMu.RLock()
	defer c.layoutMu.RUnlock()
	if c.layoutCache == nil {
		return nil, -1
	}
	idxs := make([]int, 0, len(c.layoutCache.Windows))
	srcIndex, found := 0, false
	for _, w := range c.layoutCache.Windows {
		idxs = append(idxs, w.Index)
		if w.ID == windowID {
			srcIndex, found = w.Index, true
		}
	}
	sort.Ints(idxs)
	if !found {
		return idxs, -1
	}
	for p, ix := range idxs {
		if ix == srcIndex {
			return idxs, p
		}
	}
	return idxs, -1
}

// MoveWindow reorders windowID so it lands at ordinal position targetPos (0-based,
// in index order) within the shared window list. It is realized as a sequence of
// adjacent swap-window calls that "bubble" the window across the fixed index slots
// — unlike move-window, swap-window never collides with an occupied index, and
// because grouped sessions share the window list one reorder moves it for every
// pane. The client sends the desired final position; we compute the swaps.
func (c *Controller) MoveWindow(windowID string, targetPos int) error {
	order, srcPos := c.windowOrderAndPos(windowID)
	if srcPos < 0 {
		// Stale cache — refresh once and retry the lookup.
		c.RefreshLayout()
		order, srcPos = c.windowOrderAndPos(windowID)
	}
	if srcPos < 0 || len(order) == 0 {
		return fmt.Errorf("move-window: window %s not found in layout", windowID)
	}
	if targetPos < 0 {
		targetPos = 0
	}
	if targetPos > len(order)-1 {
		targetPos = len(order) - 1
	}
	sess := c.session()
	// swap-window exchanges the two windows AND their indices, so bubbling the
	// source one fixed index slot at a time walks it to the target position while
	// the intervening windows shift by one — exactly an insertion reorder.
	for srcPos < targetPos {
		if err := c.swapWindows(sess, order[srcPos], order[srcPos+1]); err != nil {
			return err
		}
		srcPos++
	}
	for srcPos > targetPos {
		if err := c.swapWindows(sess, order[srcPos], order[srcPos-1]); err != nil {
			return err
		}
		srcPos--
	}
	c.RefreshLayout()
	return nil
}

func (c *Controller) swapWindows(sess string, a, b int) error {
	_, err := c.runTmux("swap-window",
		"-s", fmt.Sprintf("%s:%d", sess, a),
		"-t", fmt.Sprintf("%s:%d", sess, b))
	return err
}

// NewSession creates a fresh, empty tmux session and switches THIS pane's view to
// it — parity with NewWindow (which creates + focuses a window). tmux auto-names
// the session (next free numeric name); -P -F prints the chosen name so we can
// switch onto it. A split pane re-groups onto the new session via SwitchSession.
func (c *Controller) NewSession() error {
	out, err := c.runTmux("new-session", "-d", "-P", "-F", "#{session_name}")
	if err != nil {
		return err
	}
	name := strings.TrimSpace(out)
	if name == "" {
		c.RefreshLayout()
		return nil
	}
	return c.SwitchSession(name)
}

// SwitchSession moves THIS pane's view to the specified session.
//
// A split pane (groupBase != "") never sits directly on a shared session — that
// would couple its current-window with every other client there. Instead it is
// re-grouped onto the target: a fresh grouped session on `sessionName` keeps an
// independent current-window while sharing the target's window list.
//
// The primary switches its OWN client (-c <tty>) directly. Without the tty a
// bare `switch-client -t` resolves to an arbitrary client — historically this
// dragged the ssh console along — so we only fall back to it when the tty is
// genuinely unknown.
func (c *Controller) SwitchSession(sessionName string) error {
	// Discovery (sole client of the pane's grouped session) is only valid for
	// split panes — on the primary's shared base session it could grab the
	// CONSOLE's tty and drag the console along with the switch.
	if c.clientTTY == "" && c.groupBase != "" {
		c.discoverClient()
	}
	if c.groupBase != "" && c.clientTTY != "" {
		if sessionName == c.groupBase {
			return nil // already viewing this session's group
		}
		if err := c.regroupOnto(sessionName); err != nil {
			return err
		}
		c.RefreshLayout()
		return nil
	}
	if c.clientTTY != "" {
		if err := c.switchOurClient(sessionName); err != nil {
			return err
		}
	} else {
		// Legacy fallback (no tty known — non-Linux): bare switch-client resolves
		// to an arbitrary client; no safe alternative exists without the tty.
		if _, err := c.runTmux("switch-client", "-t", sessionName); err != nil {
			return err
		}
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

// RefreshClient forces tmux to fully repaint THIS pane's client. The browser
// paints a hover preview by blitting another window's cached capture into the
// region's xterm; when the hover ends the region's real screen has to come back,
// and only tmux can reproduce it. Targeting the pane's own client tty (not the
// session) keeps the repaint scoped to this region — a grouped split's siblings
// and the ssh console are untouched. Falls back to the session when the tty is
// unknown (the redraw is then whatever client(s) that session has, still safe:
// refresh-client only repaints, it never changes what is displayed).
func (c *Controller) RefreshClient() error {
	if c.clientTTY != "" {
		_, err := c.runTmux("refresh-client", "-t", c.clientTTY)
		return err
	}
	_, err := c.runTmux("refresh-client")
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

// KillWindow closes a window by id. Grouped sessions share the window list, so a
// single kill-window by @id removes it from every pane at once (parity with
// SelectWindow's @id targeting). tmux moves any pane viewing it to a neighbour.
func (c *Controller) KillWindow(windowID string) error {
	if _, err := c.runTmux("kill-window", "-t", windowID); err != nil {
		return err
	}
	c.RefreshLayout()
	return nil
}

// KillSession destroys a session by name (the logical name shown in the sidebar).
// If it's the session this pane is currently viewing, tmux switches remaining
// clients to another session; the layout refresh reflects wherever we land.
func (c *Controller) KillSession(sessionName string) error {
	if sessionName == "" {
		return nil
	}
	if _, err := c.runTmux("kill-session", "-t", sessionName); err != nil {
		return err
	}
	c.RefreshLayout()
	return nil
}

// LinkWindow links windowID into targetSession so the window (and its running
// processes) appears in both sessions. Grouped sessions share a window list, so
// linking into any logical session makes it visible to that whole group. We link
// at the next free index of the target to avoid an "index in use" collision.
func (c *Controller) LinkWindow(windowID, targetSession string) error {
	if windowID == "" || targetSession == "" {
		return nil
	}
	// Don't re-link a window into a session it's already in (a no-op that tmux
	// would reject as "index in use").
	if c.windowInSession(windowID, targetSession) {
		return nil
	}
	idx := c.nextWindowIndex(targetSession)
	target := targetSession
	if idx >= 0 {
		target = fmt.Sprintf("%s:%d", targetSession, idx)
	}
	if _, err := c.runTmux("link-window", "-s", windowID, "-t", target); err != nil {
		return err
	}
	c.RefreshLayout()
	return nil
}

// UnlinkWindow removes windowID from the session this pane is logically viewing,
// leaving it running in whatever other sessions it's linked into. Targeted by
// logical base:index (the pane's own session is an ephemeral grouped shadow whose
// window list is shared with the base, so unlinking from the base removes it from
// the whole group). The caller only reaches here when the window is linked
// elsewhere, so tmux never has to kill it — but we omit -k so a stale count can
// never silently destroy the last link.
func (c *Controller) UnlinkWindow(windowID string) error {
	if windowID == "" {
		return nil
	}
	idx, ok := c.windowIndex(windowID)
	if !ok {
		c.RefreshLayout()
		idx, ok = c.windowIndex(windowID)
	}
	base := c.logicalSession()
	if !ok || base == "" {
		return fmt.Errorf("unlink-window: window %s not found in layout", windowID)
	}
	if _, err := c.runTmux("unlink-window", "-t", fmt.Sprintf("%s:%d", base, idx)); err != nil {
		return err
	}
	c.RefreshLayout()
	return nil
}

// logicalSession returns the base session this pane is viewing (the group's base
// for a split's web-* shadow), read from the cached layout.
func (c *Controller) logicalSession() string {
	c.layoutMu.RLock()
	defer c.layoutMu.RUnlock()
	if c.layoutCache != nil && c.layoutCache.SessionBase != "" {
		return c.layoutCache.SessionBase
	}
	return c.session()
}

// windowInSession reports whether windowID is already linked into session.
func (c *Controller) windowInSession(windowID, session string) bool {
	out, err := c.runTmux("list-windows", "-t", session, "-F", "#{window_id}")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) == windowID {
			return true
		}
	}
	return false
}

// nextWindowIndex returns one past the highest window index in session (a free
// slot to link into), or -1 if it can't be read.
func (c *Controller) nextWindowIndex(session string) int {
	out, err := c.runTmux("list-windows", "-t", session, "-F", "#{window_index}")
	if err != nil {
		return -1
	}
	max := -1
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if n, err := strconv.Atoi(strings.TrimSpace(line)); err == nil && n > max {
			max = n
		}
	}
	if max < 0 {
		return -1
	}
	return max + 1
}

// windowLinkCounts maps each window @id to the number of DISTINCT logical
// sessions it's linked into. `list-windows -a` lists every window in every
// session including the ephemeral web-* grouped shadows; those collapse onto
// their group's base via logicalBase, so a window shared only by a split's
// grouped sessions counts once. rows is the already-parsed session list (used
// for the shadow→base resolution); a nil/failed query yields a nil map (callers
// default such windows to a link count of 1).
func (c *Controller) windowLinkCounts(rows []sessionRow) map[string]int {
	// window_id is "@N" (no separator chars); session_name is user-arbitrary so it
	// goes last and each line is split on the first '|'.
	out, err := c.runTmux("list-windows", "-a", "-F", "#{window_id}|#{session_name}")
	if err != nil {
		return nil
	}
	bases := map[string]map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, "|", 2)
		if len(f) < 2 {
			continue
		}
		winID, sess := f[0], f[1]
		base := logicalBase(rows, sess)
		if bases[winID] == nil {
			bases[winID] = map[string]bool{}
		}
		bases[winID][base] = true
	}
	counts := make(map[string]int, len(bases))
	for id, set := range bases {
		counts[id] = len(set)
	}
	return counts
}

// sessionEmptiness maps a session name to whether it's "empty": a single window
// with a single pane running only an idle shell. Computed from one `list-panes
// -a` fork; ephemeral web-* grouped shadows are skipped (they mirror their base's
// panes, which are counted under the base's own name). A nil/failed query yields
// a nil map (every session then reports non-empty, so the kill confirm stays).
func (c *Controller) sessionEmptiness(rows []sessionRow) map[string]bool {
	out, err := c.runTmux("list-panes", "-a", "-F", "#{session_name}|#{pane_current_command}")
	if err != nil {
		return nil
	}
	shadow := map[string]bool{}
	for _, r := range rows {
		if isWebShadow(r) {
			shadow[r.name] = true
		}
	}
	type agg struct {
		panes    int
		allShell bool
	}
	byName := map[string]*agg{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, "|", 2)
		if len(f) < 2 {
			continue
		}
		name, cmd := f[0], f[1]
		if shadow[name] {
			continue
		}
		a := byName[name]
		if a == nil {
			a = &agg{allShell: true}
			byName[name] = a
		}
		a.panes++
		if !isShellCommand(cmd) {
			a.allShell = false
		}
	}
	empty := make(map[string]bool, len(byName))
	for name, a := range byName {
		empty[name] = a.panes == 1 && a.allShell
	}
	return empty
}

// RenameSession renames a session. tmux keys sessions by name, so this targets the
// logical name the client sends (the base session; grouped web-* shadows keep
// their own names and are unaffected).
func (c *Controller) RenameSession(oldName, newName string) error {
	if oldName == "" || newName == "" {
		return nil
	}
	if _, err := c.runTmux("rename-session", "-t", oldName, newName); err != nil {
		return err
	}
	c.RefreshLayout()
	return nil
}

// SetGlobalOption sets a tmux SERVER-global user option (`set-option -g`). Used to
// persist the shared UI visual-state blob in @wt_state: it lives in the tmux server
// process, so it survives client detach/reattach and webtmux restarts (but not
// kill-server — by design, since the sessions it describes are gone then too). The
// value passes as a single argv element (exec, no shell), so no escaping is needed.
func (c *Controller) SetGlobalOption(key, val string) error {
	_, err := c.runTmux("set-option", "-g", key, val)
	return err
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

