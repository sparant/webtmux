package tmux

import (
	"regexp"
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
		return state, nil

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
