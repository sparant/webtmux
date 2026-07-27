//go:build linux

package main

import (
	"os/exec"
	"syscall"
)

// tieToParent makes the kernel signal the ssh child when THIS process dies,
// including when it is SIGKILLed and can run no cleanup of its own.
//
// Without it, killing the launcher outright orphans ssh: the tunnel stays up,
// the remote webtmux keeps running, and the local port stays bound — so the next
// run has to allocate a different local port and the URL changes, which is
// exactly the stability the per-target config exists to provide.
//
// Linux only. macOS has no equivalent, so there a SIGKILLed launcher does leave
// the connection up until ssh notices; the next run then adopts the surviving
// webtmux (which is the designed behaviour) on a freshly allocated local port.
func tieToParent(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
}
