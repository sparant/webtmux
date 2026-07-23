//go:build !linux

package localcommand

import "os"

// ptsName is only implemented on Linux (TIOCGPTN); elsewhere the controller
// falls back to sole-client discovery on the grouped session.
func ptsName(master *os.File) string {
	return ""
}
