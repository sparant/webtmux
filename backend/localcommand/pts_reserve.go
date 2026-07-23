package localcommand

import (
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/creack/pty"
)

// ptsReserved holds dummy pty masters open for the life of the process so the
// kernel keeps their pts numbers allocated. See ReservePtys.
var ptsReserved []*os.File

// ReservePtys pins this process's REAL ptys to pts numbers >= floor by opening
// (and holding forever) dummy masters for every lower number.
//
// Why: tmux targets clients by tty STRING (`switch-client -c /dev/pts/N`).
// Our panes' ptys live in the container's private devpts, numbered from 0 —
// the same strings host-side clients (ssh consoles attached to the shared
// host tmux server) use. On a collision tmux can resolve the string to the
// WRONG client and drag e.g. the console to another session. Host client ttys
// occupy low numbers; starting ours at `floor` makes the strings disjoint.
//
// The slave fd of each dummy is closed immediately (the number stays allocated
// while the master is open), so the cost is `floor` idle fds. Returns how many
// numbers were reserved; on any error it logs and returns what it got — real
// ptys still work, just without the collision guarantee.
func ReservePtys(floor int) int {
	if floor <= 0 {
		return 0
	}
	reserved := 0
	for i := 0; i < floor+16; i++ { // +16: tolerate pre-allocated low numbers
		m, s, err := pty.Open()
		if err != nil {
			log.Printf("pts floor: stopped reserving at %d: %v", reserved, err)
			break
		}
		s.Close()
		n, ok := ptsNumber(ptsName(m))
		if !ok {
			m.Close()
			log.Printf("pts floor: cannot determine pts number — reservation disabled")
			break
		}
		if n >= floor {
			m.Close() // goal reached: the next real pty allocates >= floor
			break
		}
		ptsReserved = append(ptsReserved, m)
		reserved++
	}
	return reserved
}

// ptsNumber extracts N from "/dev/pts/N".
func ptsNumber(name string) (int, bool) {
	s := strings.TrimPrefix(name, "/dev/pts/")
	if s == name || s == "" {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	return n, err == nil
}
