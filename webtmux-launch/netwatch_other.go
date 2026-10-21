//go:build !linux && !darwin

package main

import (
	"context"
	"errors"
)

// osNetEvents has no OS source here; the address poll alone covers it.
func osNetEvents(ctx context.Context, notify func()) error {
	return errors.New("no network-change notifications on this platform")
}
