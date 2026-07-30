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

// Every tmux -F format in this package follows one rule, because tmux SANITIZES
// control bytes to '_' in -F output (so a non-printable separator is impossible —
// see enumSep): fields are separated by '|', the MACHINE fields (@/%/$ ids,
// integers, flags) come first, the user-controlled TEXT comes last, and the line is
// split with SplitN capped at the field count so anything the user typed — '|'
// included — stays inside the final field instead of shifting every field after it.
//
// Where a row would need TWO user-controlled fields, the second one is replaced by
// the object's tmux ID and resolved back to a name from a listing we already have.
// That is what `#{session_id}` is doing here: the placement directory needs the
// session a window lives in, and a session named "a | b" alongside a window named
// "c | d" cannot both go last.
const allWindowsSep = "|"
const allWindowsFields = 5

var allWindowsFormat = strings.Join([]string{
	"#{window_id}", "#{session_id}", "#{window_index}", "#{@wt_working}", "#{window_name}",
}, allWindowsSep)

// sessionNamesByID indexes an already-parsed `list-sessions` by tmux session id
// ("$3"), the machine-safe stand-in for a session NAME inside a delimited row.
func sessionNamesByID(rows []sessionRow) map[string]string {
	byID := make(map[string]string, len(rows))
	for _, r := range rows {
		byID[r.id] = r.name
	}
	return byID
}

// parseAllWindows turns `list-windows -a -F allWindowsFormat` output into the two
// server-wide views the UI needs: @wt_working keyed by window id, and the placement
// directory behind Layout.AllWindows.
//
// sessions is the `list-sessions` output from the same refresh, used to turn each
// row's session_id back into a name. A row whose session is unknown (the session
// appeared between the two listings, or list-sessions failed outright) still
// contributes its @wt_working — a window's light does not depend on knowing which
// session it is in — but is left out of the DIRECTORY, which exists to be
// navigated to and cannot name a target it can't resolve.
func parseAllWindows(out string, sessions []sessionRow) (map[string]string, []WindowRef) {
	names := sessionNamesByID(sessions)
	working := make(map[string]string)
	var refs []WindowRef
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, allWindowsSep, allWindowsFields)
		if len(f) < allWindowsFields {
			continue
		}
		working[f[0]] = f[3]
		session, ok := names[f[1]]
		if !ok {
			continue
		}
		// A split's ephemeral web-* grouped session mirrors its base session's window
		// list, so its rows are duplicates of placements already listed under the base
		// — emitting them would double every window for as long as a split is open.
		// (The status map above is keyed by window id, so the duplicate rows there are
		// harmless overwrites of an identical value.)
		if isWebShadowName(session) {
			continue
		}
		idx, _ := strconv.Atoi(f[2])
		refs = append(refs, WindowRef{
			ID:      f[0],
			Working: f[3],
			Session: session,
			Index:   idx,
			Name:    f[4],
		})
	}
	return working, refs
}

// The pane's OWN session identity, from `display-message -p`. session_name is
// user-arbitrary and used to contain a ',' that the old comma-split truncated it
// at — a session called "a, b" reported itself as "a".
const sessionIdentSep = "|"

var sessionIdentFormat = "#{session_id}" + sessionIdentSep + "#{session_name}"

func parseSessionIdent(out string) (id, name string, ok bool) {
	f := strings.SplitN(strings.TrimSpace(out), sessionIdentSep, 2)
	if len(f) < 2 {
		return "", "", false
	}
	return f[0], f[1], true
}

// The per-session window rows behind Layout.Windows. window_name last; the old
// format put it SECOND of five and split on ',', so a window called "build, test"
// shifted the index, the active flag and @wt_working by one field each — the
// sidebar then showed the wrong current window and the wrong stoplight.
const windowsSep = "|"
const windowsFields = 5

var windowsFormat = strings.Join([]string{
	"#{window_id}", "#{window_index}", "#{window_active}", "#{@wt_working}", "#{window_name}",
}, windowsSep)

// parseWindowRows turns `list-windows -t <session> -F windowsFormat` output into
// the per-session window list (panes and SessionCount are filled in by the caller).
func parseWindowRows(out string) []Window {
	var wins []Window
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, windowsSep, windowsFields)
		if len(f) < windowsFields {
			continue
		}
		idx, _ := strconv.Atoi(f[1])
		wins = append(wins, Window{
			ID:     f[0],
			Index:  idx,
			Active: f[2] == "1",
			// Unset @wt_working expands to "" => an unfilled dot in the UI.
			Working: f[3],
			Name:    f[4],
		})
	}
	return wins
}

// The per-window pane rows. TWO fields here are user-controlled and neither can be
// replaced by an id (they ARE the data): pane_title, which any program can set with
// an OSC escape and which routinely carries '|' from a shell prompt, and
// pane_current_command, a process comm name. The riskier one takes the last slot,
// so a '|' in a title is contained; a '|' in a comm name — a binary literally named
// "a|b" — can still bleed into the title, but never into the geometry the layout is
// computed from.
const panesSep = "|"
const panesFields = 10

var panesFormat = strings.Join([]string{
	"#{pane_id}", "#{pane_index}", "#{pane_active}", "#{pane_in_mode}",
	"#{pane_width}", "#{pane_height}", "#{pane_top}", "#{pane_left}",
	"#{pane_current_command}", "#{pane_title}",
}, panesSep)

// parsePaneRows turns `list-panes -t <window> -F panesFormat` output into panes.
func parsePaneRows(out string) []Pane {
	var panes []Pane
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, panesSep, panesFields)
		if len(f) < panesFields {
			continue
		}
		idx, _ := strconv.Atoi(f[1])
		width, _ := strconv.Atoi(f[4])
		height, _ := strconv.Atoi(f[5])
		top, _ := strconv.Atoi(f[6])
		left, _ := strconv.Atoi(f[7])
		panes = append(panes, Pane{
			ID:      f[0],
			Index:   idx,
			Active:  f[2] == "1",
			InMode:  f[3] == "1",
			Width:   width,
			Height:  height,
			Top:     top,
			Left:    left,
			Command: f[8],
			Title:   f[9],
		})
	}
	return panes
}

// identState is the controller's mutable IDENTITY: who this pane is and where it
// is currently looking. Every field here is written by the 500ms layout poller
// (RefreshLayout -> session/discoverClient/selfHeal/regroupOnto) AND, at the same
// time, by the connection's message goroutine (SetClient/SwitchSession) — two
// goroutines, so it lives behind Controller.identMu and is only ever touched
// through ident()/setIdent().
//
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
type identState struct {
	// sessionName is the non-follow controller's own session (mutated by
	// SwitchSession).
	sessionName string
	follow      bool
	// baseSession is the pane's own (grouped) session — the discovery target and
	// the fallback when the client row can't be read.
	baseSession string
	clientTTY   string
	clientPID   int
	// groupBase is the logical session this pane's group currently views
	// ("" = primary, which sits directly on the shared base and is never re-grouped).
	groupBase string
	// regrouping is the single-flight latch for regroupOnto: the poll tick's
	// self-heal and a user's session switch can both decide to re-group, and two
	// interleaved new-session+switch-client pairs leave an orphaned group behind
	// (and can land the client on the loser).
	regrouping bool
}

// Controller manages tmux interactions for a session
type Controller struct {
	// identMu guards every field of id. No tmux command is ever run with it held
	// (copy the snapshot out, act, copy the result back) — the same discipline
	// layoutMu already follows.
	identMu sync.Mutex
	id      identState

	// run executes a tmux subcommand. Bound to the controller's socket in
	// NewController; injectable so tests can drive the controller without a
	// tmux server (see newControllerWithRunner).
	run tmuxRunner

	layoutCache *Layout
	layoutMu    sync.RWMutex

	eventChan chan Event
	closeChan chan struct{}
}

// ident returns a consistent snapshot of the controller's identity. Callers act
// on the snapshot rather than re-reading fields, so a concurrent SwitchSession
// can't change the answer halfway through a decision.
func (c *Controller) ident() identState {
	c.identMu.Lock()
	defer c.identMu.Unlock()
	return c.id
}

// setIdent mutates the identity under the lock. f must not run a tmux command.
func (c *Controller) setIdent(f func(*identState)) {
	c.identMu.Lock()
	defer c.identMu.Unlock()
	f(&c.id)
}

// NewController creates a new tmux controller for the given session on the given
// socket. A non-empty socket (e.g. the mounted host socket /host-tmux/default)
// is passed as `tmux -S <socket>` to EVERY command, so the layout sidebar reads
// the real host server rather than the container's empty default socket. follow=
// true (grouped split panes) tracks the pane's tmux client wherever it roams.
func NewController(sessionName string, socket string, follow bool, groupBase string) (*Controller, error) {
	return newControllerWithRunner(sessionName, follow, groupBase, func(args ...string) (string, error) {
		return runTmuxOn(socket, args...)
	}), nil
}

// newControllerWithRunner is the test seam: the same controller with an injected
// tmux runner, so behaviour that is otherwise only observable through a live tmux
// server (argv shapes, cross-goroutine identity access) can be exercised in a unit
// test.
func newControllerWithRunner(sessionName string, follow bool, groupBase string, run tmuxRunner) *Controller {
	return &Controller{
		id: identState{
			sessionName: sessionName,
			baseSession: sessionName,
			follow:      follow,
			groupBase:   groupBase,
		},
		run:       run,
		eventChan: make(chan Event, 100),
		closeChan: make(chan struct{}),
	}
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
	c.setIdent(func(id *identState) {
		id.clientTTY = tty
		id.clientPID = pid
		id.follow = true
	})
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
	id := c.ident()
	if id.clientTTY == "" {
		return fmt.Errorf("client tty unknown; cannot switch-client safely")
	}
	rows, err := c.listClients()
	if err != nil {
		return err
	}
	if n := countTTY(rows, id.clientTTY); n > 1 {
		return fmt.Errorf("client tty %s is ambiguous (%d clients share it) — refusing switch-client; raise WEBTMUX_PTS_FLOOR", id.clientTTY, n)
	}
	if _, err := c.runTmux("switch-client", "-c", id.clientTTY, "-t", exactSession(target)); err != nil {
		return err
	}
	if id.clientPID > 0 {
		if rows, err := c.listClients(); err == nil {
			if r, ok := findClient(rows, id.clientPID, id.clientTTY); ok && r.session != target {
				log.Printf("switch-client verification failed: client pid=%d tty=%s is on %q, wanted %q",
					id.clientPID, id.clientTTY, r.session, target)
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
	id := c.ident()
	if !id.follow || id.clientTTY == "" || id.groupBase == "" {
		return
	}
	if curSession == id.baseSession {
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

// errRegroupInFlight is returned when a regroup is refused because another one is
// already running on this controller. It is a benign refusal, not a failure: the
// in-flight regroup is doing the same job, and webtty logs a failed tmux command
// without tearing the connection down.
var errRegroupInFlight = fmt.Errorf("regroup already in flight")

// regroupOnto moves this split pane's client into a fresh grouped session on
// `base`, giving it an independent current-window over base's window list.
// Order matters: create the group detached, MOVE the pane's client into it, and
// only THEN arm destroy-unattached — setting it before the client attaches would
// destroy the brand-new (unattached) session immediately. The pane's previous
// grouped session self-reaps via its own destroy-unattached.
//
// SINGLE-FLIGHT. Two callers reach here from different goroutines — the 500ms
// poll's selfHeal and the user's SwitchSession — and a regroup is a multi-step
// tmux mutation (new-session, switch-client, set-option) that publishes its
// result into the identity at the end. Interleaving two of them creates two
// grouped sessions, switches the client twice, and leaves baseSession naming
// whichever finished last while the client sits on the other. The latch makes
// the second caller a no-op instead.
func (c *Controller) regroupOnto(base string) error {
	claimed := false
	c.setIdent(func(id *identState) {
		if !id.regrouping {
			id.regrouping = true
			claimed = true
		}
	})
	if !claimed {
		return errRegroupInFlight
	}
	defer c.setIdent(func(id *identState) { id.regrouping = false })

	newName := fmt.Sprintf("web-h%d", time.Now().UnixNano()%1000000000)
	// -P -F takes the new session's #{session_id} back. That id is the ONLY exact
	// way to name it to set-option, which accepts neither `=name` nor `=name:`; it
	// also spares kill-session a prefix match against a sibling web-h session
	// whose generated name happens to extend this one's. Falling back to the name
	// keeps the previous behaviour if tmux prints nothing.
	out, err := c.runTmux("new-session", "-d", "-t", exactSession(base), "-s", newName, "-P", "-F", "#{session_id}")
	if err != nil {
		return err
	}
	newTarget := strings.TrimSpace(out)
	if newTarget == "" {
		newTarget = newName
	}
	if err := c.switchOurClient(newName); err != nil {
		c.runTmux("kill-session", "-t", newTarget) // couldn't move the client — clean up
		return err
	}
	c.runTmux("set-option", "-t", newTarget, "destroy-unattached", "on")
	c.setIdent(func(id *identState) {
		id.baseSession = newName // discovery target + fallback now points at the fresh group
		id.groupBase = base      // the logical session this pane now views
	})
	return nil
}

// clientCount returns how many tmux clients are attached to the given session.
func (c *Controller) clientCount(session string) int {
	out, err := c.runTmux("list-clients", "-t", exactSession(session), "-F", "#{client_tty}")
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
	id := c.ident()
	if !id.follow {
		return id.sessionName
	}
	if id.clientTTY == "" && id.clientPID <= 0 {
		c.discoverClient()
		id = c.ident() // discovery may have filled the tty in
	}
	if rows, err := c.listClients(); err == nil {
		if r, ok := findClient(rows, id.clientPID, id.clientTTY); ok && r.session != "" {
			return r.session
		}
	}
	return id.baseSession
}

// discoverClient finds the pane's tmux client tty. A grouped split session has
// exactly one client (the pane's pty), so we read it off the base session before
// the client ever roams away. Cached once found.
func (c *Controller) discoverClient() {
	out, err := c.runTmux("list-clients", "-t", exactSession(c.ident().baseSession), "-F", "#{client_tty}")
	if err != nil {
		return
	}
	if lines := strings.Split(strings.TrimSpace(out), "\n"); len(lines) > 0 {
		if tty := strings.TrimSpace(lines[0]); tty != "" {
			c.setIdent(func(id *identState) { id.clientTTY = tty })
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
	name := c.ident().sessionName
	exists := false
	for i := 0; i < 20; i++ {
		if _, err := c.runTmux("has-session", "-t", exactSession(name)); err == nil {
			exists = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !exists {
		// Session never appeared — create it (base bootstrap / non-grouped default).
		// `-s` takes the name as an OPTION ARGUMENT, so a leading '-' cannot be
		// escaped (tmux consumes a `--` as the name itself and then parses the real
		// name as flags). Refuse loudly instead of emitting a command that would
		// fail with an unrelated "unknown option" message.
		if strings.HasPrefix(name, "-") {
			return fmt.Errorf("refusing to create tmux session %q: a leading '-' cannot be passed to new-session -s", name)
		}
		if _, createErr := c.runTmux("new-session", "-d", "-s", name); createErr != nil {
			return fmt.Errorf("failed to create tmux session %s: %w", name, createErr)
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
	sessionOut, err := c.runTmux("display-message", "-t", exactPaneOf(sess), "-p", sessionIdentFormat)
	if err != nil {
		return err
	}
	sessionID, sessionName, ok := parseSessionIdent(sessionOut)
	if !ok {
		return fmt.Errorf("invalid session output: %s", sessionOut)
	}

	layout := &Layout{
		SessionID:   sessionID,
		SessionName: sessionName,
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
	windowsOut, err := c.runTmux("list-windows", "-t", exactSession(sess), "-F", windowsFormat)
	if err != nil {
		return err
	}

	for _, win := range parseWindowRows(windowsOut) {
		// Distinct logical sessions holding this window; default to 1 (it's at
		// least in the session we're listing) when the lookup came back empty.
		if sc := linkCounts[win.ID]; sc > 0 {
			win.SessionCount = sc
		} else {
			win.SessionCount = 1
		}

		if win.Active {
			layout.ActiveWinID = win.ID
		}

		// Get panes for this window (window ids are already exact tmux targets).
		panesOut, err := c.runTmux("list-panes", "-t", win.ID, "-F", panesFormat)
		if err != nil {
			continue
		}

		win.Panes = parsePaneRows(panesOut)
		for _, pane := range win.Panes {
			if pane.Active && win.Active {
				layout.ActivePaneID = pane.ID
				layout.ActivePaneInMode = pane.InMode
			}
		}

		layout.Windows = append(layout.Windows, win)
	}

	// Global @wt_working across ALL sessions, keyed by window_id, plus the window
	// DIRECTORY those ids refer to. The per-session Windows list above only covers
	// `sess`, so a window in another session (e.g. a claude-editors window while this
	// region views services) would carry no status and its recent-tab dot would go
	// blank/stale as the focus roams between sessions. One `list-windows -a` makes
	// every window's light foreground-independent — and, since the fork is already
	// happening, carries the session/index/name that make such a window NAVIGABLE
	// (see Layout.AllWindows).
	if allOut, err := c.runTmux("list-windows", "-a", "-F", allWindowsFormat); err == nil {
		layout.AllWorking, layout.AllWindows = parseAllWindows(allOut, rows)
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
		target = exactWindow(c.session(), idx)
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
	// `--` so a name the user began with '-' is a NAME, not a flag. Window ids are
	// already exact tmux targets, so `-t` needs no `=`.
	_, err := c.runTmux("rename-window", "-t", windowID, "--", name)
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

// sessionWindowOrder lists session's window indices in ascending (display) order,
// plus the ordinal position and the tmux index of windowID within that order
// (-1, -1 when it isn't there).
//
// The layout cache only ever holds the pane's OWN session, so it cannot answer this
// for another one — and the sidebar's tree view shows every session on the server,
// where a drag can reorder (or an × can unlink) a window the pane isn't attached to.
// That is one extra `list-windows` fork per such action, which is nothing next to
// how rare the action is; the pane's own session keeps using the cache (below).
func (c *Controller) sessionWindowOrder(session, windowID string) ([]int, int, int) {
	out, err := c.runTmux("list-windows", "-t", exactSession(session), "-F", "#{window_index} #{window_id}")
	if err != nil {
		return nil, -1, -1
	}
	return parseWindowOrder(out, windowID)
}

// parseWindowOrder turns `list-windows -F "#{window_index} #{window_id}"` output
// into the ascending index order, the ordinal position of windowID within it, and
// that window's own index (-1, -1 when it isn't listed). Split out from the tmux
// call so the arithmetic every reorder depends on is testable without a tmux server.
func parseWindowOrder(out, windowID string) ([]int, int, int) {
	type row struct {
		index int
		id    string
	}
	rows := make([]row, 0, 8)
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		n, err := strconv.Atoi(f[0])
		if err != nil {
			continue
		}
		rows = append(rows, row{n, f[1]})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].index < rows[j].index })
	order := make([]int, 0, len(rows))
	pos, idx := -1, -1
	for p, r := range rows {
		order = append(order, r.index)
		if r.id == windowID {
			pos, idx = p, r.index
		}
	}
	return order, pos, idx
}

// MoveWindow reorders windowID so it lands at ordinal position targetPos (0-based,
// in index order) within the window list of `session` — or of the pane's own
// session when that is empty. It is realized as a sequence of adjacent swap-window
// calls that "bubble" the window across the fixed index slots — unlike move-window,
// swap-window never collides with an occupied index, and because grouped sessions
// share the window list one reorder moves it for every pane. The client sends the
// desired final position; we compute the swaps.
//
// `session` is what makes a reorder possible from the sidebar's tree view, where the
// row being dragged may belong to a session no region is attached to. Empty keeps
// the original behavior exactly: the pane's own session, read from the warm layout
// cache without an extra tmux call.
func (c *Controller) MoveWindow(windowID string, targetPos int, session string) error {
	var order []int
	var srcPos int
	sess := session
	if session == "" {
		sess = c.session()
		order, srcPos = c.windowOrderAndPos(windowID)
		if srcPos < 0 {
			// Stale cache — refresh once and retry the lookup.
			c.RefreshLayout()
			order, srcPos = c.windowOrderAndPos(windowID)
		}
	} else {
		order, srcPos, _ = c.sessionWindowOrder(session, windowID)
	}
	if srcPos < 0 || len(order) == 0 {
		return fmt.Errorf("move-window: window %s not found in session %q", windowID, sess)
	}
	if targetPos < 0 {
		targetPos = 0
	}
	if targetPos > len(order)-1 {
		targetPos = len(order) - 1
	}
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
		"-s", exactWindow(sess, a),
		"-t", exactWindow(sess, b))
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
	id := c.ident()
	// Discovery (sole client of the pane's grouped session) is only valid for
	// split panes — on the primary's shared base session it could grab the
	// CONSOLE's tty and drag the console along with the switch.
	if id.clientTTY == "" && id.groupBase != "" {
		c.discoverClient()
		id = c.ident()
	}
	if id.groupBase != "" && id.clientTTY != "" {
		if sessionName == id.groupBase {
			return nil // already viewing this session's group
		}
		if err := c.regroupOnto(sessionName); err != nil {
			return err
		}
		c.RefreshLayout()
		return nil
	}
	if id.clientTTY != "" {
		if err := c.switchOurClient(sessionName); err != nil {
			return err
		}
	} else {
		// Legacy fallback (no tty known — non-Linux): bare switch-client resolves
		// to an arbitrary client; no safe alternative exists without the tty.
		if _, err := c.runTmux("switch-client", "-t", exactSession(sessionName)); err != nil {
			return err
		}
	}
	c.setIdent(func(id *identState) { id.sessionName = sessionName })
	c.RefreshLayout()
	return nil
}

// SplitPane splits the current pane
func (c *Controller) SplitPane(horizontal bool) error {
	flag := "-v"
	if horizontal {
		flag = "-h"
	}
	_, err := c.runTmux("split-window", "-t", exactPaneOf(c.session()), flag)
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

// EnterCopyMode enters copy mode on the active pane. Idempotent: tmux accepts
// `copy-mode` on a pane that is already in it (exit 0, no-op).
func (c *Controller) EnterCopyMode() error {
	_, err := c.runTmux("copy-mode", "-t", exactPaneOf(c.session()))
	return err
}

// ExitCopyMode leaves copy/view mode on the active pane.
//
// `copy-mode -q`, NOT `send-keys -X cancel`. Every `-X` command is rejected
// ("not in a mode", exit 1) unless the pane is in a mode at that instant — and
// the browser cannot know that it is. Its copy-mode flag comes from a 500ms
// poll, so the pane may have left copy mode on its own since (a `q`, a `y` that
// copies-and-cancels, Enter, Escape, a mouse copy, or the ssh console sharing
// the session) and the next paste still asks for an exit. That spurious exit is
// the single most common way the old code produced a failed tmux command — and
// a failed tmux command used to kill the connection (see webtty.afterCmd), which
// is what the user saw as `[lost tty]` right after a copy/paste.
//
// `-q` quits the mode if there is one and exits 0 if there isn't (verified on
// tmux 3.6), which is the idempotence every caller here actually wants.
func (c *Controller) ExitCopyMode() error {
	_, err := c.runTmux("copy-mode", "-q", "-t", exactPaneOf(c.session()))
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
	if tty := c.ident().clientTTY; tty != "" {
		_, err := c.runTmux("refresh-client", "-t", tty)
		return err
	}
	_, err := c.runTmux("refresh-client")
	return err
}

// ScrollUp scrolls back through the pane's history.
//
// It enters copy mode first when the pane isn't already in it, because that IS
// what scrolling into the scrollback means in tmux — and because the caller's
// idea of the mode can be stale (see ExitCopyMode). `copy-mode` is idempotent,
// so this costs nothing when we're already there, and it turns a wheel notch
// that used to be rejected outright into the scroll the user asked for.
//
// One `-N <lines>` send moves the whole notch: the old loop forked tmux once per
// line, so a fast wheel spin was dozens of processes and dozens of chances for
// one of them to fail.
func (c *Controller) ScrollUp(lines int) error {
	sess := exactPaneOf(c.session())
	if _, err := c.runTmux("copy-mode", "-t", sess); err != nil {
		return err
	}
	_, err := c.runTmux("send-keys", "-t", sess, "-N", strconv.Itoa(lines), "-X", "scroll-up")
	return err
}

// ScrollDown scrolls forward again, toward the live screen.
//
// Guarded by `#{pane_in_mode}` rather than entering copy mode like ScrollUp
// does: a pane at the live prompt has nothing below it, so a wheel-down that
// arrives while the browser thinks we're scrolled up must be a no-op — entering
// copy mode there would scroll the user INTO the scrollback for a gesture that
// means the exact opposite. `if -F` evaluates the format and runs the command
// under the same target in one tmux invocation, exiting 0 either way.
func (c *Controller) ScrollDown(lines int) error {
	_, err := c.runTmux("if-shell", "-F", "-t", exactPaneOf(c.session()), "#{pane_in_mode}",
		fmt.Sprintf("send-keys -N %d -X scroll-down", lines))
	return err
}

// NewWindow creates a new window in `session` — or in the pane's own session when
// that is empty, which is what the toolbar chord and the default sidebar view send.
//
// The sidebar's tree view lists every session with its own "+", so the target has to
// be nameable: `new-window -t <session>` appends there without this pane following
// it, which is the point — you are adding a window to a session you are looking at,
// not one you are working in. (tmux makes the new window current WITHIN that
// session; no client is switched.)
func (c *Controller) NewWindow(session string) error {
	target := session
	if target == "" {
		target = c.session()
	}
	_, err := c.runTmux("new-window", "-t", exactSession(target))
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
	if _, err := c.runTmux("kill-session", "-t", exactSession(sessionName)); err != nil {
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
	target := exactSession(targetSession)
	if idx >= 0 {
		target = exactWindow(targetSession, idx)
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
func (c *Controller) UnlinkWindow(windowID string, session string) error {
	if windowID == "" {
		return nil
	}
	var idx int
	var ok bool
	base := session
	if session == "" {
		// The pane's own session: its window list is the warm layout cache.
		base = c.logicalSession()
		idx, ok = c.windowIndex(windowID)
		if !ok {
			c.RefreshLayout()
			idx, ok = c.windowIndex(windowID)
		}
	} else {
		// A session this pane isn't attached to — the sidebar's tree view can remove a
		// window from any of them, so the index has to be read from tmux directly.
		_, pos, i := c.sessionWindowOrder(session, windowID)
		idx, ok = i, pos >= 0
	}
	if !ok || base == "" {
		return fmt.Errorf("unlink-window: window %s not found in session %q", windowID, base)
	}
	if _, err := c.runTmux("unlink-window", "-t", exactWindow(base, idx)); err != nil {
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
	out, err := c.runTmux("list-windows", "-t", exactSession(session), "-F", "#{window_id}")
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
	out, err := c.runTmux("list-windows", "-t", exactSession(session), "-F", "#{window_index}")
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
	// window_id is "@N" (no separator chars); session_name is the row's ONLY
	// user-arbitrary field, so it takes the last slot and SplitN(…, 2) hands it back
	// whole — no id indirection needed here. Deliberately NOT switched to
	// #{session_id} like the other listings: an id this refresh's `list-sessions`
	// can't name would have to be dropped, and a dropped placement UNDERCOUNTS the
	// links, which is the direction that turns the sidebar's × from an unlink into
	// a kill. Counting a session we can name is the fail-safe side.
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

// emptinessSep/emptinessFormat: `list-panes -a` reduced to (owning session,
// running command). BOTH would be user-controlled as text, so the session takes
// its machine-safe id form and is resolved from the session listing we already
// have — a session called "a | b" used to be counted under "a", i.e. as a
// DIFFERENT, always-empty session, which is the state that skips the kill confirm.
const emptinessSep = "|"

var emptinessFormat = "#{session_id}" + emptinessSep + "#{pane_current_command}"

// sessionEmptiness maps a session name to whether it's "empty": a single window
// with a single pane running only an idle shell. Computed from one `list-panes
// -a` fork; ephemeral web-* grouped shadows are skipped (they mirror their base's
// panes, which are counted under the base's own name). A nil/failed query yields
// a nil map (every session then reports non-empty, so the kill confirm stays).
func (c *Controller) sessionEmptiness(rows []sessionRow) map[string]bool {
	out, err := c.runTmux("list-panes", "-a", "-F", emptinessFormat)
	if err != nil {
		return nil
	}
	return parseSessionEmptiness(out, rows)
}

// parseSessionEmptiness is the pure half of sessionEmptiness.
func parseSessionEmptiness(out string, rows []sessionRow) map[string]bool {
	shadow := map[string]bool{}
	names := make(map[string]string, len(rows))
	for _, r := range rows {
		names[r.id] = r.name
		if isWebShadow(r) {
			shadow[r.id] = true
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
		f := strings.SplitN(line, emptinessSep, 2)
		if len(f) < 2 {
			continue
		}
		id, cmd := f[0], f[1]
		if shadow[id] {
			continue
		}
		name, ok := names[id]
		if !ok {
			continue // a session we can't name is one the UI can't ask about
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
//
// `-t =old` is what makes this safe: with a prefix-matched target, renaming a
// stale "dev" happily renames "dev-2" instead — and the user is then looking at a
// session that silently changed name under them. `--` lets the NEW name start
// with '-' (tmux takes it as a positional argument, which would otherwise parse
// as flags and fail with an unrelated "unknown option" message).
func (c *Controller) RenameSession(oldName, newName string) error {
	if oldName == "" || newName == "" {
		return nil
	}
	if _, err := c.runTmux("rename-session", "-t", exactSession(oldName), "--", newName); err != nil {
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

// exactSession renders a session name as a tmux EXACT-match target: `=name`.
//
// Without it tmux resolves a `-t` session by PREFIX, so a stale "dev" target
// happily resolves to "dev-2" — and the operations that take one include
// kill-session, rename-session, unlink-window and swap-window. `=` also makes a
// name that starts with '-' safe wherever it appears as a `-t` VALUE, because the
// argument no longer begins with a dash. Empty in, empty out: a bare "=" matches
// nothing, and the callers that can be handed "" already mean "the default target".
//
// It is only ever applied to SESSION names. Window (@N) and pane (%N) ids are
// already unique tmux identifiers and must be passed through untouched.
func exactSession(name string) string {
	if name == "" {
		return ""
	}
	return "=" + name
}

// exactWindow renders `session:index` as an exact-match window target
// (`=session:index`).
func exactWindow(session string, index int) string {
	return fmt.Sprintf("%s:%d", exactSession(session), index)
}

// exactPaneOf renders "the active pane of the current window of this session" as
// an exact-match TARGET-PANE: `=session:`.
//
// The trailing colon is load-bearing and was measured, not assumed (tmux 3.2a):
// a bare `=name` is rejected by every command whose -t is a target-pane —
// split-window, copy-mode and send-keys fail with "can't find pane: =name", and
// display-message does something worse, expanding its whole format to the empty
// string with exit status 0. With the colon tmux resolves the session half
// exactly (`=dev-:` refuses to match "dev-2") and then takes its current
// window's active pane, which is what every one of these callers means.
//
// `set-option -t` accepts NEITHER form ("no such session: =name") — the one
// session-targeting command that has no exact syntax at all. Its single caller
// here targets the session by #{session_id} instead; see regroupOnto.
func exactPaneOf(session string) string {
	if session == "" {
		return ""
	}
	return "=" + session + ":"
}

// runTmux executes a tmux command with the given arguments through the
// controller's runner (bound to `tmux -S <socket>` in NewController, so every
// layout query and action targets the mounted host server).
func (c *Controller) runTmux(args ...string) (string, error) {
	return c.run(args...)
}

// runTmuxOn is the one place a tmux command is exec'd (argv, never a shell):
// against the given socket path, or tmux's default when empty. Shared with the
// CaptureStore so the two can't drift on socket/exec/error handling.
func runTmuxOn(socket string, args ...string) (string, error) {
	if socket != "" {
		args = append([]string{"-S", socket}, args...)
	}
	output, err := exec.Command("tmux", args...).Output()
	if err != nil {
		return "", fmt.Errorf("tmux command failed: %w", err)
	}
	return string(output), nil
}
