//go:build unix

package main

import (
	"os/exec"
	"syscall"
)

// ownProcessGroup keeps terminal signals (Ctrl-C) away from a local child, so
// it is torn down only by the launcher's own exit — the same single path an
// SSH-run webtmux has.
func ownProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}
