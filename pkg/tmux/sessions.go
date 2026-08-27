package tmux

import (
	"fmt"
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

// newCmdOption is the per-SESSION tmux user option holding the command line a
// NEW WINDOW in that session should run: the "what is this session for" that a
// session otherwise has no place to record. Empty/unset means a new window is
// just a shell, which is what every session did before this existed.
//
// It is a tmux option, per session, rather than a field in the @wt_state blob,
// for two reasons. tmux is where the thing it describes lives, so it dies with
// the server that owns those sessions — the same argument as @wt_status_show. And
// it has a writer that is not a browser: scripts/stack.sh sets it while building
// the stack (`tmux set-option -t <session_id> @wt_newcmd '<cmd>'`), which is a
// one-liner against an option and would be a JSON read-modify-write against the
// blob.
const newCmdOption = "@wt_newcmd"

// sessionCmdsFormat is a SEPARATE `list-sessions -F` pass from sessionsFormat,
// and the separation is forced rather than stylistic.
//
// parseSessionRows can only be safe about ONE user-arbitrary field per line: the
// last one, taken with SplitN so a '|' inside it cannot shift the fields before
// it. A session name is one such field; a command line — which very often
// contains a pipe — is another. Two of them on one line means a '|' in either
// shifts the other, and no field order fixes that. So the command rides its own
// line, keyed by #{session_id}: that is "$N", which cannot contain a separator,
// leaving the command as the only arbitrary field on the line.
var sessionCmdsFormat = "#{session_id}" + sessionsSep + "#{" + newCmdOption + "}"

// parseSessionCmds maps session id -> new-window command line.
//
// Two things are deliberately dropped rather than guessed at:
//
//   - A line with no separator. An option value containing a NEWLINE arrives as
//     extra lines belonging to no session; attributing them to something would be
//     worse than losing the tail of a command nobody should have written.
//   - A value still wrapped in "#{...}". tmux only learned to expand #{@user}
//     formats in 3.2; an older one echoes the format back verbatim, and that
//     string would then be typed into a shell as if it were the command.
func parseSessionCmds(out string) map[string]string {
	cmds := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		f := strings.SplitN(line, sessionsSep, 2)
		if len(f) < 2 || f[0] == "" {
			continue
		}
		cmd := strings.TrimSpace(f[1])
		if cmd == "" || strings.HasPrefix(cmd, "#{") {
			continue
		}
		cmds[f[0]] = cmd
	}
	return cmds
}

// nextSessionName proposes the name for a session created FROM base: the same
// name with an index appended, "editors" -> "editors (1)", skipping any that
// already exist.
//
// A base that is itself an indexed name is un-indexed first, so a "+" on
// "editors (1)" offers "editors (2)" and not "editors (1) (1)". The alternative
// — nesting — makes the name grow without bound down a chain of derived
// sessions, which is exactly how these get made.
//
// taken is consulted, never assumed complete: tmux refuses a duplicate -s name,
// so a race only costs the caller an error, not a wrong session.
func nextSessionName(base string, taken map[string]bool) string {
	base = strings.TrimSpace(base)
	if base == "" {
		return ""
	}
	base = stripSessionIndex(base)
	for i := 1; ; i++ {
		cand := fmt.Sprintf("%s (%d)", base, i)
		if !taken[cand] {
			return cand
		}
	}
}

// stripSessionIndex removes one trailing " (N)" from a session name. Anything
// else — "(a)", "(1) x", a bare "(1)" with no base left — is left alone: this
// exists to avoid nesting the suffix it just added, not to reinterpret names
// somebody chose.
func stripSessionIndex(name string) string {
	if !strings.HasSuffix(name, ")") {
		return name
	}
	open := strings.LastIndex(name, " (")
	if open <= 0 {
		return name
	}
	inner := name[open+2 : len(name)-1]
	if inner == "" {
		return name
	}
	for _, r := range inner {
		if r < '0' || r > '9' {
			return name
		}
	}
	return name[:open]
}

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

// isWebShadowName matches the names of the ephemeral per-pane grouped sessions
// the split view creates (web-<rand>, web-h<n>, legacy web-<pid>). They are an
// implementation detail, never user-selectable. The one name-shape rule, shared
// by every enumerator that must skip them (sessions, parseAllWindows, captures).
func isWebShadowName(name string) bool {
	return strings.HasPrefix(name, "web-")
}

// isWebShadow is the strict form for contexts that also know the session is
// grouped (a user session someone named web-foo is NOT a shadow).
func isWebShadow(r sessionRow) bool {
	return r.grouped && isWebShadowName(r.name)
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
func buildSessions(rows []sessionRow, cur string, empty map[string]bool, cmds map[string]string) []Session {
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
			NewCmd:   cmds[r.id],
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
