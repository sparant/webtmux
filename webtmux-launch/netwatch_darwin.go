//go:build darwin

package main

import (
	"context"
	"syscall"
)

// osNetEvents reads the routing socket — what `route -n monitor` prints. Only
// interface and address messages count: route add/delete messages also cover
// the per-destination host routes macOS clones during ordinary traffic, which
// would turn every new connection into a "network change".
func osNetEvents(ctx context.Context, notify func()) error {
	fd, err := syscall.Socket(syscall.AF_ROUTE, syscall.SOCK_RAW, syscall.AF_UNSPEC)
	if err != nil {
		return err
	}
	syscall.CloseOnExec(fd)
	keep := func(msg []byte) bool {
		// rt_msghdr / ifa_msghdr / if_msghdr all start: u16 msglen, u8 version, u8 type.
		if len(msg) < 4 {
			return false
		}
		switch msg[3] {
		case syscall.RTM_NEWADDR, syscall.RTM_DELADDR, syscall.RTM_IFINFO:
			return true
		}
		return false
	}
	return readNotifications(ctx, fd, keep, notify)
}
