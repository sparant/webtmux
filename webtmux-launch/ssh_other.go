//go:build !linux

package main

import "os/exec"

// tieToParent is a no-op everywhere but Linux: there is no portable way to ask
// the kernel to signal a child when its parent dies. See the Linux version for
// what this costs on macOS.
func tieToParent(cmd *exec.Cmd) {}
