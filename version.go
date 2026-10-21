package main

import (
	"fmt"
	"io"
	"os"

	cli "github.com/urfave/cli/v3"

	"webtmux/server"
)

var Version = "unknown_version"

// printVersion is `webtmux --version`. The first line is the long-standing
// "webtmux version <version>", unchanged: launchers before v0.4.0 read only
// that line, and the release script checks it against the tag. The commit and
// build-time lines after it
// let webtmux-launch name a running build that is not a tag — a container's
// "local" build, a dev build copied over — and say when it was built. They are
// the same two stamps as the UI's build chip.
func printVersion(cmd *cli.Command) {
	var w io.Writer = os.Stdout
	if root := cmd.Root(); root != nil && root.Writer != nil {
		w = root.Writer
	}
	fmt.Fprintf(w, "%s version %s\n", cmd.Name, cmd.Version)
	fmt.Fprintf(w, "commit %s\n", server.BuildCommit)
	if server.BuildTime != "" {
		fmt.Fprintf(w, "built %s\n", server.BuildTime)
	}
}
