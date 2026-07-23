//go:build linux

package localcommand

import (
	"testing"

	"github.com/creack/pty"
)

// After ReservePtys(floor), any newly allocated pty must get a number >= floor:
// every lower number is either held by someone else or by our reservation.
func TestReservePtysFloor(t *testing.T) {
	const floor = 8
	ReservePtys(floor)
	m, s, err := pty.Open()
	if err != nil {
		t.Fatalf("pty.Open: %v", err)
	}
	defer m.Close()
	defer s.Close()
	n, ok := ptsNumber(ptsName(m))
	if !ok {
		t.Fatal("could not read pts number")
	}
	if n < floor {
		t.Errorf("new pty is /dev/pts/%d, want >= %d", n, floor)
	}
}
