package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"webtmux/pkg/tmux"
	"webtmux/webtty"
)

// sanitizeSessionName restricts a client-supplied tmux session name to a safe
// charset ([A-Za-z0-9_-], capped length). The name flows into tmux target
// syntax and a pty env var, so anything outside this set is dropped rather than
// escaped. Returns "" if nothing usable remains (caller falls back to the base).
func sanitizeSessionName(s string) string {
	if len(s) > 64 {
		s = s[:64]
	}
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (server *Server) generateHandleWS(ctx context.Context, cancel context.CancelFunc, counter *counter) http.HandlerFunc {
	once := new(int64)

	go func() {
		select {
		case <-counter.timer().C:
			cancel()
		case <-ctx.Done():
		}
	}()

	return func(w http.ResponseWriter, r *http.Request) {
		if server.options.Once {
			success := atomic.CompareAndSwapInt64(once, 0, 1)
			if !success {
				http.Error(w, "Server is shutting down", http.StatusServiceUnavailable)
				return
			}
		}

		num := counter.add(1)
		closeReason := "unknown reason"

		defer func() {
			num := counter.done()
			log.Printf(
				"Connection closed by %s: %s, connections: %d/%d",
				closeReason, r.RemoteAddr, num, server.options.MaxConnection,
			)

			if server.options.Once {
				cancel()
			}
		}()

		if int64(server.options.MaxConnection) != 0 {
			if num > server.options.MaxConnection {
				closeReason = "exceeding max number of connections"
				return
			}
		}

		log.Printf("New client connected: %s, connections: %d/%d", r.RemoteAddr, num, server.options.MaxConnection)

		if r.Method != "GET" {
			http.Error(w, "Method not allowed", 405)
			return
		}

		conn, err := server.upgrader.Upgrade(w, r, nil)
		if err != nil {
			closeReason = err.Error()
			return
		}
		defer conn.Close()

		if server.options.PassHeaders {
			err = server.processWSConn(ctx, conn, r.Header)
		} else {
			err = server.processWSConn(ctx, conn, nil)
		}

		switch err {
		case ctx.Err():
			closeReason = "cancelation"
		case webtty.ErrSlaveClosed:
			closeReason = server.factory.Name()
		case webtty.ErrMasterClosed:
			closeReason = "client"
		default:
			closeReason = fmt.Sprintf("an error: %s", err)
		}
	}
}

func (server *Server) processWSConn(ctx context.Context, conn *websocket.Conn, headers map[string][]string) error {
	typ, initLine, err := conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("failed to authenticate websocket connection: %w", err)
	}
	if typ != websocket.TextMessage {
		return errors.New("failed to authenticate websocket connection: invalid message type")
	}

	var init InitMessage
	err = json.Unmarshal(initLine, &init)
	if err != nil {
		return fmt.Errorf("failed to authenticate websocket connection: %w", err)
	}
	if init.AuthToken != server.options.Credential {
		return errors.New("failed to authenticate websocket connection")
	}

	queryPath := "?"
	if server.options.PermitArguments && init.Arguments != "" {
		queryPath = init.Arguments
	}

	query, err := url.Parse(queryPath)
	if err != nil {
		return fmt.Errorf("failed to parse arguments: %w", err)
	}
	params := query.Query()

	// Per-connection tmux session (split-view). The client picks a grouped
	// session name (init.Session); we sanitize it and, when tmux mode is on,
	// thread it into BOTH the pty and this connection's layout controller.
	// Empty / absent => the detected base session (services) — single-view path,
	// unchanged. sessionName is "" when tmux mode is off.
	sessionName := ""
	if server.tmuxSession != "" {
		sessionName = sanitizeSessionName(init.Session)
		if sessionName == "" {
			sessionName = server.tmuxSession
		}
		// Inject the chosen name into the pty as an env var (via the header ->
		// HTTP_* env channel localcommand already implements). attach-web.sh
		// reads HTTP_WEBTMUX_SESSION to join/create the matching grouped session.
		// Only inject for a non-primary (grouped) region; the primary keeps the
		// shared attach so it stays in sync with the ssh console.
		if sessionName != server.tmuxSession {
			if headers == nil {
				headers = map[string][]string{}
			}
			headers["Webtmux-Session"] = []string{sessionName}
		}
	}

	var slave Slave
	slave, err = server.factory.New(params, headers)
	if err != nil {
		return fmt.Errorf("failed to create backend: %w", err)
	}
	defer slave.Close()

	titleVars := server.titleVariables(
		[]string{"server", "master", "slave"},
		map[string]map[string]interface{}{
			"server": server.options.TitleVariables,
			"master": map[string]interface{}{
				"remote_addr": conn.RemoteAddr(),
			},
			"slave": slave.WindowTitleVariables(),
		},
	)

	titleBuf := new(bytes.Buffer)
	err = server.titleTemplate.Execute(titleBuf, titleVars)
	if err != nil {
		return fmt.Errorf("failed to fill window title template: %w", err)
	}

	opts := []webtty.Option{
		webtty.WithWindowTitle(titleBuf.Bytes()),
	}
	if server.options.PermitWrite {
		opts = append(opts, webtty.WithPermitWrite())
	}
	if server.options.EnableReconnect {
		opts = append(opts, webtty.WithReconnect(server.options.ReconnectTime))
	}
	if server.options.Width > 0 {
		opts = append(opts, webtty.WithFixedColumns(server.options.Width))
	}
	if server.options.Height > 0 {
		opts = append(opts, webtty.WithFixedRows(server.options.Height))
	}
	tty, err := webtty.New(&wsWrapper{conn}, slave, opts...)
	if err != nil {
		return fmt.Errorf("failed to create webtty: %w", err)
	}

	// Set up a PER-CONNECTION tmux controller targeting this connection's session
	// (grouped region or the shared base). Each connection owns its own controller
	// so its sidebar reflects/controls only its own current window — the crux of
	// the split-view feature. tmux mode is on iff a base session was detected.
	if server.tmuxSession != "" {
		// A split pane (session != the shared base) always views sessions through
		// its own grouped web-* session; groupBase records the logical session it
		// is viewing (drives self-heal + regroup-on-switch). The primary sits
		// directly on the shared base (groupBase = "" => never re-grouped).
		split := sessionName != server.tmuxSession
		groupBase := ""
		if split {
			groupBase = server.tmuxSession
		}
		ctrl, err := tmux.NewController(sessionName, server.tmuxSocket, split, groupBase)
		if err != nil {
			log.Printf("Warning: failed to create tmux controller for %q: %v", sessionName, err)
		} else if err := func() error {
			// Give the controller the pane's EXACT client identity — the pty's
			// slave tty AND the exec'd tmux client's pid — so client-scoped tmux
			// commands and client-row lookups target this pane's client and
			// nothing else. The pid disambiguates when a host-side client shares
			// our tty STRING across pid namespaces (a bare/collided switch-client
			// historically dragged the ssh console, or switched nothing while
			// the layout claimed otherwise).
			ttyName, pid := "", 0
			if t, ok := slave.(interface{ TtyName() string }); ok {
				ttyName = t.TtyName()
			}
			if p, ok := slave.(interface{ Pid() int }); ok {
				pid = p.Pid()
			}
			ctrl.SetClient(ttyName, pid)
			return ctrl.Start()
		}(); err != nil {
			log.Printf("Warning: failed to start tmux controller for %q: %v", sessionName, err)
		} else {
			defer ctrl.Stop()
			tty.SetTmuxController(ctrl)
			// Hand this connection the ONE server-global capture store (shared by
			// pointer across all connections) so Exposé / optimistic paint read a
			// single deduped capture per window.
			tty.SetCaptureProvider(server.captureStore)
			// Poll for layout changes and broadcast updates for THIS session.
			// The poller gets a PER-CONNECTION context, not ctx (server lifetime):
			// on the server ctx every disconnect would leave the goroutine polling
			// — and, via selfHeal/regroupOnto, MUTATING tmux — forever, forking
			// half a dozen tmux commands per tick on behalf of a dead connection.
			connCtx, cancelConn := context.WithCancel(ctx)
			defer cancelConn()
			go server.handleTmuxEvents(connCtx, tty, ctrl)
		}
	}

	err = tty.Run(ctx)

	return err
}

// handleTmuxEvents polls the given per-connection controller for tmux layout
// changes and sends updates to that connection's client.
func (server *Server) handleTmuxEvents(ctx context.Context, tty *webtty.WebTTY, ctrl *tmux.Controller) {
	if ctrl == nil {
		return
	}

	// Poll for layout changes every 500ms
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	var lastLayout string
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Refresh and check if layout changed
			ctrl.RefreshLayout()
			layout := ctrl.GetLayout()
			if layout == nil {
				continue
			}

			// Simple change detection using JSON
			data, _ := json.Marshal(layout)
			currentLayout := string(data)
			if currentLayout != lastLayout {
				lastLayout = currentLayout
				if err := tty.SendTmuxLayout(); err != nil {
					log.Printf("Failed to send tmux layout: %v", err)
				}
			}
		}
	}
}

func (server *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	indexVars, err := server.indexVariables(r)
	if err != nil {
		http.Error(w, "Internal Server Error", 500)
		return
	}

	indexBuf := new(bytes.Buffer)
	err = server.indexTemplate.Execute(indexBuf, indexVars)
	if err != nil {
		http.Error(w, "Internal Server Error", 500)
		return
	}

	// Never serve a stale page after a rebuild (see noStore rationale).
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Write(indexBuf.Bytes())
}

func (server *Server) handleManifest(w http.ResponseWriter, r *http.Request) {
	indexVars, err := server.indexVariables(r)
	if err != nil {
		http.Error(w, "Internal Server Error", 500)
		return
	}

	indexBuf := new(bytes.Buffer)
	err = server.manifestTemplate.Execute(indexBuf, indexVars)
	if err != nil {
		http.Error(w, "Internal Server Error", 500)
		return
	}

	w.Write(indexBuf.Bytes())
}

func (server *Server) indexVariables(r *http.Request) (map[string]interface{}, error) {
	titleVars := server.titleVariables(
		[]string{"server", "master"},
		map[string]map[string]interface{}{
			"server": server.options.TitleVariables,
			"master": map[string]interface{}{
				"remote_addr": r.RemoteAddr,
			},
		},
	)

	titleBuf := new(bytes.Buffer)
	err := server.titleTemplate.Execute(titleBuf, titleVars)
	if err != nil {
		return nil, err
	}

	indexVars := map[string]interface{}{
		"title": titleBuf.String(),
	}
	return indexVars, err
}

func (server *Server) handleAuthToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript")
	// @TODO hashing?
	w.Write([]byte("var gotty_auth_token = '" + server.options.Credential + "';"))
}

// Build identity, stamped at build time via -ldflags (Makefile BUILD_OPTIONS, fed
// the git short-hash + build time; launch.sh passes the host commit as a build-arg).
// Surfaced to the UI so the toolbar can show which build is actually running.
var (
	BuildCommit = "dev"
	BuildTime   = ""
)

func (server *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript")
	// no-store so a rebuild's new build id is never served from cache.
	w.Header().Set("Cache-Control", "no-store")
	// webtmux_webgl seeds the renderer preference for a client that has never
	// expressed one. It is a default, not an override: a stored preference in
	// the shared tmux UI state wins. Before this the --enable-webgl flag was
	// read by nothing, so it advertised a setting it could not deliver.
	webgl := "false"
	if server.options.EnableWebGL {
		webgl = "true"
	}
	lines := []string{
		"var gotty_term = 'xterm';",
		"var gotty_ws_query_args = '" + server.options.WSQueryArgs + "';",
		"var webtmux_build = '" + BuildCommit + "';",
		"var webtmux_built = '" + BuildTime + "';",
		"var webtmux_webgl = " + webgl + ";",
	}

	w.Write([]byte(strings.Join(lines, "\n")))
}

// titleVariables merges maps in a specified order.
// varUnits are name-keyed maps, whose names will be iterated using order.
func (server *Server) titleVariables(order []string, varUnits map[string]map[string]interface{}) map[string]interface{} {
	titleVars := map[string]interface{}{}

	for _, name := range order {
		vars, ok := varUnits[name]
		if !ok {
			panic("title variable name error")
		}
		for key, val := range vars {
			titleVars[key] = val
		}
	}

	// safe net for conflicted keys
	for _, name := range order {
		titleVars[name] = varUnits[name]
	}

	return titleVars
}
