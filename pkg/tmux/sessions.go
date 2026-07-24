package tmux

import (
	"strconv"
	"strings"
)

// sessionRow is one parsed line of `list-sessions -F sessionsFormat`.
type sessionRow struct {
	id       string
	name     string
	windows  int
	attached bool
	grouped  bool
	group    string
}

const sessionsSep = "|"
const sessionsFields = 6

// sessionsFormat: only #{session_name} is user-arbitrary, so it goes LAST and
// each line is parsed with SplitN — a '|' typed into a session name cannot
// shift the machine fields before it. (tmux sanitizes control bytes in -F
// output, so a non-printable separator is impossible; see capture.go enumSep.)
var sessionsFormat = strings.Join([]string{
	"#{session_id}", "#{session_windows}", "#{session_attached}",
	"#{session_grouped}", "#{session_group}", "#{session_name}",
}, sessionsSep)

func parseSessionRows(out string) []sessionRow {
	var rows []sessionRow
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, sessionsSep, sessionsFields)
		if len(f) < sessionsFields {
			continue
		}
		w, _ := strconv.Atoi(f[1])
		rows = append(rows, sessionRow{
			id:       f[0],
			windows:  w,
			attached: f[2] == "1",
			grouped:  f[3] == "1",
			group:    f[4],
			name:     f[5],
		})
	}
	return rows
}

// isWebShadow reports whether a session is one of the ephemeral per-pane
// grouped sessions the split view creates (web-<rand>, web-h<n>, legacy
// web-<pid>). They are an implementation detail, never user-selectable.
func isWebShadow(r sessionRow) bool {
	return r.grouped && strings.HasPrefix(r.name, "web-")
}

// logicalBase resolves the session a pane is REALLY viewing: for a web-*
// grouped shadow, the non-shadow member of its group; otherwise the session
// itself. Falls back to cur when the group has no non-shadow member.
func logicalBase(rows []sessionRow, cur string) string {
	curGroup := ""
	for _, r := range rows {
		if r.name == cur {
			curGroup = r.group
			break
		}
	}
	if curGroup == "" {
		return cur
	}
	for _, r := range rows {
		if r.group == curGroup && !strings.HasPrefix(r.name, "web-") {
			return r.name
		}
	}
	return cur
}

// buildSessions converts rows to the UI session list: web-* shadows hidden,
// Active set on the session(s) in the same group as the pane's current session
// — so a split pane viewing services through web-abc marks "services" active.
// empty maps a session name to whether it is an idle, nothing-running session
// (see sessionEmptiness); nil leaves every Empty flag false.
func buildSessions(rows []sessionRow, cur string, empty map[string]bool) []Session {
	curGroup := ""
	for _, r := range rows {
		if r.name == cur {
			curGroup = r.group
			break
		}
	}
	var out []Session
	for _, r := range rows {
		if isWebShadow(r) {
			continue
		}
		active := r.name == cur || (curGroup != "" && r.group == curGroup)
		out = append(out, Session{
			ID:       r.id,
			Name:     r.name,
			Windows:  r.windows,
			Attached: r.attached,
			Active:   active,
			Empty:    empty[r.name],
		})
	}
	return out
}

// shellCommands are the pane_current_command values that mean "an idle shell" —
// a pane running only one of these has no foreground program. Login shells report
// with a leading '-' (e.g. "-bash"), stripped before the lookup.
var shellCommands = map[string]bool{
	"bash": true, "zsh": true, "sh": true, "fish": true,
	"dash": true, "ksh": true, "tcsh": true, "csh": true, "ash": true,
}

func isShellCommand(cmd string) bool {
	return shellCommands[strings.TrimPrefix(cmd, "-")]
}
