//go:build linux || darwin

package main

import (
	"context"
	"os"
	"syscall"
)

// readNotifications reads a notification socket until ctx ends, calling
// notify for each message keep accepts. The fd goes through os.File so the
// read sits in Go's poller and Close (on ctx end) unblocks it.
func readNotifications(ctx context.Context, fd int, keep func([]byte) bool, notify func()) error {
	if err := syscall.SetNonblock(fd, true); err != nil {
		syscall.Close(fd)
		return err
	}
	f := os.NewFile(uintptr(fd), "netwatch")
	go func() { <-ctx.Done(); f.Close() }()
	buf := make([]byte, 64*1024)
	for {
		n, err := f.Read(buf)
		if err != nil {
			return err
		}
		if keep(buf[:n]) {
			notify()
		}
	}
}
