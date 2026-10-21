//go:build !unix && !windows

package main

import "os/exec"

// ownProcessGroup is a no-op where there are no process groups.
func ownProcessGroup(cmd *exec.Cmd) {}
