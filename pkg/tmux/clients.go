package tmux

import (
	"strconv"
	"strings"
)

// clientRow is one parsed line of `list-clients -F clientsFormat`.
type clientRow struct {
	pid     int
	tty     string
	session string
}

const clientsSep = "|"
const clientsFields = 3

// clientsFormat: the session name is the only user-arbitrary field, so it goes
// LAST and each line is parsed with SplitN (a '|' in a session name cannot
// shift the machine fields before it).
var clientsFormat = strings.Join([]string{
	"#{client_pid}", "#{client_tty}", "#{client_session}",
}, clientsSep)

func parseClientRows(out string) []clientRow {
	var rows []clientRow
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, clientsSep, clientsFields)
		if len(f) < clientsFields {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		rows = append(rows, clientRow{pid: pid, tty: f[1], session: f[2]})
	}
	return rows
}

// findClient picks OUR pane's client row. The pid is authoritative when known:
// attach-web.sh execs into the tmux client so the pid we spawned IS
// #{client_pid}, and pids are unique among this server's own panes. A tty
// string alone is ambiguous across pid namespaces — a host-side console can
// share "/dev/pts/N" with one of our container ptys — so tty is only the
// fallback when the pid is unknown.
func findClient(rows []clientRow, pid int, tty string) (clientRow, bool) {
	if pid > 0 {
		for _, r := range rows {
			if r.pid == pid && (tty == "" || r.tty == tty) {
				return r, true
			}
		}
		for _, r := range rows { // pid alone (tty may read differently across namespaces)
			if r.pid == pid {
				return r, true
			}
		}
		return clientRow{}, false // our client isn't attached (yet) — don't guess by tty
	}
	for _, r := range rows {
		if r.tty == tty && tty != "" {
			return r, true
		}
	}
	return clientRow{}, false
}

// countTTY returns how many clients share the given tty string — >1 means a
// `-c tty` command is ambiguous and could act on the wrong client.
func countTTY(rows []clientRow, tty string) int {
	if tty == "" {
		return 0
	}
	n := 0
	for _, r := range rows {
		if r.tty == tty {
			n++
		}
	}
	return n
}
