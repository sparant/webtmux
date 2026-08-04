package tmux

import (
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// fakeServer is a tiny in-process stand-in for a tmux server, good enough to drive
// a whole Controller.RefreshLayout without forking anything.
//
// It renders the -F format the controller ACTUALLY asks for against a table of
// variable values, instead of returning a hard-coded line. That is the point: the
// field ORDER of every format in this package is a correctness property we are
// free to change (user-controlled text has to sit last), and a fixture written as
// a literal line would have to be rewritten — silently agreeing with whatever the
// code now emits — every time it moves. Rendering keeps the fixture stated in
// terms of values, so a reorder is exercised rather than re-baselined.
//
// It is also the argv recorder the targeting tests assert against: every call is
// captured verbatim, which is the only way to see that a destructive command was
// sent with tmux's exact-match `=` prefix.
type fakeServer struct {
	mu    sync.Mutex
	calls [][]string

	// Each row is a tmux variable map ("session_name" -> "services"). Windows and
	// panes carry their owning session/window variables so the -t filters work.
	sessions []map[string]string
	windows  []map[string]string
	panes    []map[string]string
	clients  []map[string]string

	state string // @wt_state, returned by show-options -gqv

	// options models tmux's SCOPED option store, keyed "<scope>/<name>" where scope
	// is "global" or a session id ("$0"). Only consulted for named options other
	// than @wt_state, so the state tests above are untouched. `-A` resolves the
	// inheritance chain (session, then global) exactly as tmux does — which is the
	// distinction the scrollback code depends on: an option a session merely
	// INHERITS must read back empty without it, or a temporary override could never
	// be undone (see ownHistoryLimit).
	options map[string]string
	// nextPane numbers the panes split-window creates, so a test can watch a
	// rebuild replace a window's panes one at a time.
	nextPane int

	// fail maps a tmux subcommand name to an error to return instead of output.
	fail map[string]error
	// hook, when set, runs before a subcommand is answered. Used to block inside a
	// command so a second goroutine can be observed racing it.
	hook func(args []string)
}

var formatVar = regexp.MustCompile(`#\{[^}]*\}`)

// renderFormat expands a tmux -F/-p format string against one row's variables.
// An unknown variable expands to "" — exactly what tmux does for an unset one.
func renderFormat(format string, vars map[string]string) string {
	return formatVar.ReplaceAllStringFunc(format, func(m string) string {
		return vars[strings.TrimSuffix(strings.TrimPrefix(m, "#{"), "}")]
	})
}

// flagValue returns the argument following the named flag ("" if absent).
func flagValue(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

// targetSession strips tmux target syntax down to a session name: the exact-match
// `=` prefix and any `:window` suffix (tmux forbids ':' inside a session name).
func targetSession(target string) string {
	t := strings.TrimPrefix(target, "=")
	if i := strings.IndexByte(t, ':'); i >= 0 {
		t = t[:i]
	}
	return t
}

func (f *fakeServer) record(args []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := append([]string(nil), args...)
	f.calls = append(f.calls, cp)
}

// argv returns the recorded calls whose subcommand is name.
func (f *fakeServer) argv(name string) [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out [][]string
	for _, c := range f.calls {
		if len(c) > 0 && c[0] == name {
			out = append(out, append([]string(nil), c...))
		}
	}
	return out
}

// count returns how many times a subcommand was called.
func (f *fakeServer) count(name string) int { return len(f.argv(name)) }

func (f *fakeServer) rows(format string, rows []map[string]string) string {
	var b strings.Builder
	for _, r := range rows {
		b.WriteString(renderFormat(format, r))
		b.WriteByte('\n')
	}
	return b.String()
}

func (f *fakeServer) run(args ...string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	f.record(args)
	if f.hook != nil {
		f.hook(args)
	}
	f.mu.Lock()
	if err, ok := f.fail[args[0]]; ok {
		f.mu.Unlock()
		return "", err
	}
	sessions, windows, panes, clients, state := f.sessions, f.windows, f.panes, f.clients, f.state
	f.mu.Unlock()

	format := flagValue(args, "-F")
	target := flagValue(args, "-t")

	switch args[0] {
	case "list-sessions":
		return f.rows(format, sessions), nil

	case "list-clients":
		rows := clients
		if target != "" {
			sess := targetSession(target)
			rows = nil
			for _, c := range clients {
				if c["client_session"] == sess {
					rows = append(rows, c)
				}
			}
		}
		return f.rows(format, rows), nil

	case "list-windows":
		rows := windows
		if !hasFlag(args, "-a") {
			sess := targetSession(target)
			rows = nil
			for _, w := range windows {
				if w["session_name"] == sess {
					rows = append(rows, w)
				}
			}
		}
		return f.rows(format, rows), nil

	case "list-panes":
		rows := panes
		if !hasFlag(args, "-a") {
			rows = nil
			for _, p := range panes {
				if p["window_id"] == target || p["session_name"] == targetSession(target) {
					rows = append(rows, p)
				}
			}
		}
		return f.rows(format, rows), nil

	case "display-message":
		// A window/pane target resolves against that row (which carries its owning
		// session's variables), not against a session name — `display-message -t @3
		// '#{session_id}'` is how the scrollback code asks which session a window
		// lives in, and answering it from "the current session" would make the
		// distinction untestable.
		if strings.HasPrefix(target, "@") || strings.HasPrefix(target, "%") {
			for _, r := range append(append([]map[string]string{}, windows...), panes...) {
				if r["window_id"] == target || r["pane_id"] == target {
					return renderFormat(flagValue(args, "-p"), r) + "\n", nil
				}
			}
			return "", nil
		}
		sess := targetSession(target)
		for _, s := range sessions {
			if s["session_name"] == sess {
				return renderFormat(flagValue(args, "-p"), s) + "\n", nil
			}
		}
		// tmux falls back to the current session; the first row stands in for it.
		if len(sessions) > 0 {
			return renderFormat(flagValue(args, "-p"), sessions[0]) + "\n", nil
		}
		return "", nil

	case "show-options":
		// @wt_state keeps its dedicated slot; everything else comes from the scoped
		// option store.
		name := args[len(args)-1]
		if name != "@wt_state" {
			return f.showOption(args, name), nil
		}
		return state, nil

	case "set-option":
		f.setOption(args)
		return "", nil

	case "split-window":
		// Model the one property the rebuild depends on: a NEW pane is born with the
		// history-limit in force RIGHT NOW for its session, while existing panes keep
		// theirs. That is the whole reason a resize has to rebuild.
		return f.splitWindow(args), nil

	case "kill-pane":
		f.killPane(target)
		return "", nil

	case "new-session":
		// `-P -F` asks tmux to print something about the session it just made; the
		// controller uses it to learn the session id it will then target exactly.
		if hasFlag(args, "-P") {
			return renderFormat(flagValue(args, "-F"), map[string]string{
				"session_id":   "$77",
				"session_name": flagValue(args, "-s"),
			}) + "\n", nil
		}
	}
	return "", nil
}

// ---- scoped options + pane lifecycle ---------------------------------------

// optionScope reads the scope out of a set/show-options argv: "global" for -g,
// the -t target otherwise (a session id in this package), "" for neither.
func optionScope(args []string) string {
	if hasFlag(args, "-g") {
		return "global"
	}
	if t := flagValue(args, "-t"); t != "" {
		return t
	}
	return ""
}

// showOption answers `show-options [-g] [-A] [-v] -t <scope> <name>`. Without -A
// an inherited option reads back EMPTY, which is how the caller tells "the
// session has its own value" from "it is borrowing the global's".
func (f *fakeServer) showOption(args []string, name string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	scope := optionScope(args)
	if v, ok := f.options[scope+"/"+name]; ok {
		return v + "\n"
	}
	if hasFlag(args, "-A") && scope != "global" {
		if v, ok := f.options["global/"+name]; ok {
			return v + "\n"
		}
	}
	return ""
}

// setOption applies `set-option [-g] [-u] -t <scope> <name> [value]`.
func (f *fakeServer) setOption(args []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.options == nil {
		f.options = map[string]string{}
	}
	scope := optionScope(args)
	if hasFlag(args, "-u") {
		delete(f.options, scope+"/"+args[len(args)-1])
		return
	}
	if len(args) < 2 {
		return
	}
	name, value := args[len(args)-2], args[len(args)-1]
	f.options[scope+"/"+name] = value
}

// paneLimit is what a pane created in `sessionID` right now would be born with.
func (f *fakeServer) paneLimit(sessionID string) string {
	if v, ok := f.options[sessionID+"/history-limit"]; ok {
		return v
	}
	if v, ok := f.options["global/history-limit"]; ok {
		return v
	}
	return "2000"
}

// splitWindow inserts a fresh pane immediately after its source — tmux's own
// placement, and the reason a rebuild preserves pane ORDER — and prints its id
// when asked with -P -F.
func (f *fakeServer) splitWindow(args []string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	target := flagValue(args, "-t")
	at := -1
	for i, p := range f.panes {
		if p["pane_id"] == target || p["window_id"] == target {
			at = i
			break
		}
	}
	if at < 0 {
		return ""
	}
	src := f.panes[at]
	f.nextPane++
	dir := flagValue(args, "-c")
	if dir == "" {
		dir = src["pane_current_path"]
	}
	fresh := map[string]string{
		"pane_id": "%" + strconv.Itoa(100+f.nextPane), "pane_active": "0",
		"pane_in_mode": "0", "pane_width": src["pane_width"], "pane_height": src["pane_height"],
		"pane_top": src["pane_top"], "pane_left": src["pane_left"],
		"pane_current_command": "bash", "pane_current_path": dir,
		"history_limit": f.paneLimit(src["session_id"]), "history_size": "0", "history_bytes": "0",
		"window_id": src["window_id"], "session_id": src["session_id"],
		"session_name": src["session_name"],
	}
	rest := append([]map[string]string{}, f.panes[at+1:]...)
	f.panes = append(append(f.panes[:at+1:at+1], fresh), rest...)
	f.renumberPanes()
	if hasFlag(args, "-P") {
		return renderFormat(flagValue(args, "-F"), fresh) + "\n"
	}
	return ""
}

// killPane removes a pane; if it was the active one, its successor in the window
// takes over — the reason a rebuild has to re-select at the end.
func (f *fakeServer) killPane(target string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var kept []map[string]string
	killedActive, window := false, ""
	for _, p := range f.panes {
		if p["pane_id"] == target {
			killedActive = p["pane_active"] == "1"
			window = p["window_id"]
			continue
		}
		kept = append(kept, p)
	}
	f.panes = kept
	if killedActive {
		for _, p := range f.panes {
			if p["window_id"] == window {
				p["pane_active"] = "1"
				break
			}
		}
	}
	f.renumberPanes()
}

// renumberPanes restates #{pane_index} as tmux does: position within the window.
func (f *fakeServer) renumberPanes() {
	seen := map[string]int{}
	for _, p := range f.panes {
		w := p["window_id"]
		p["pane_index"] = strconv.Itoa(seen[w])
		seen[w]++
	}
}

// oneSessionServer is the common fixture: a single session "services" with two
// windows, one pane each, and one attached client on /dev/pts/1.
func oneSessionServer() *fakeServer {
	return &fakeServer{
		sessions: []map[string]string{{
			"session_id": "$0", "session_name": "services", "session_windows": "2",
			"session_attached": "1", "session_grouped": "0", "session_group": "",
		}},
		windows: []map[string]string{
			{"window_id": "@0", "window_index": "0", "window_active": "1",
				"window_name": "shell", "@wt_working": "1",
				"session_id": "$0", "session_name": "services"},
			{"window_id": "@1", "window_index": "1", "window_active": "0",
				"window_name": "build", "@wt_working": "",
				"session_id": "$0", "session_name": "services"},
		},
		panes: []map[string]string{
			{"pane_id": "%0", "pane_index": "0", "pane_active": "1", "pane_in_mode": "0",
				"pane_width": "80", "pane_height": "24", "pane_top": "0", "pane_left": "0",
				"pane_current_command": "bash", "pane_title": "shell",
				"window_id": "@0", "session_id": "$0", "session_name": "services"},
			{"pane_id": "%1", "pane_index": "0", "pane_active": "1", "pane_in_mode": "0",
				"pane_width": "80", "pane_height": "24", "pane_top": "0", "pane_left": "0",
				"pane_current_command": "go", "pane_title": "build",
				"window_id": "@1", "session_id": "$0", "session_name": "services"},
		},
		clients: []map[string]string{
			{"client_pid": "4242", "client_tty": "/dev/pts/1", "client_session": "services"},
		},
	}
}
