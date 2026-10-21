//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// ownProcessGroup keeps the console's Ctrl-C away from a local child (wsl.exe),
// so it is torn down only by the launcher's own exit — the same single path as
// on Unix, where the child gets its own process group.
func ownProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= syscall.CREATE_NEW_PROCESS_GROUP
}
