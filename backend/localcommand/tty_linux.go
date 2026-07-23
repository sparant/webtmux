//go:build linux

package localcommand

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// ptsName resolves the slave-side device path ("/dev/pts/N") of a pty master
// via the TIOCGPTN ioctl. This is the tty the spawned process (and therefore
// the tmux client it execs into) reports to the tmux server as #{client_tty},
// so it is the deterministic key for client-scoped tmux commands
// (switch-client -c). Returns "" if the ioctl fails.
func ptsName(master *os.File) string {
	var n uint32
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), syscall.TIOCGPTN, uintptr(unsafe.Pointer(&n)))
	if errno != 0 {
		return ""
	}
	return fmt.Sprintf("/dev/pts/%d", n)
}
