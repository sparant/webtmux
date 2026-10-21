//go:build linux

package main

import (
	"context"
	"syscall"
)

// rtnetlink multicast groups (linux/rtnetlink.h); package syscall does not
// export them.
const (
	rtmgrpLink       = 0x1
	rtmgrpIPv4Ifaddr = 0x10
	rtmgrpIPv4Route  = 0x40
	rtmgrpIPv6Ifaddr = 0x100
	rtmgrpIPv6Route  = 0x400
)

// osNetEvents subscribes to rtnetlink: links going up or down, addresses
// added or removed, routes changing. Any message is a notification; the
// watcher's settle step coalesces the burst one change produces.
func osNetEvents(ctx context.Context, notify func()) error {
	fd, err := syscall.Socket(syscall.AF_NETLINK, syscall.SOCK_RAW|syscall.SOCK_CLOEXEC, syscall.NETLINK_ROUTE)
	if err != nil {
		return err
	}
	sa := &syscall.SockaddrNetlink{
		Family: syscall.AF_NETLINK,
		Groups: rtmgrpLink | rtmgrpIPv4Ifaddr | rtmgrpIPv6Ifaddr | rtmgrpIPv4Route | rtmgrpIPv6Route,
	}
	if err := syscall.Bind(fd, sa); err != nil {
		syscall.Close(fd)
		return err
	}
	return readNotifications(ctx, fd, func([]byte) bool { return true }, notify)
}
