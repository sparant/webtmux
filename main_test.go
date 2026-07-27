package main

import (
	"context"
	"io"
	"strings"
	"testing"

	cli "github.com/urfave/cli/v3"

	"webtmux/backend/localcommand"
	"webtmux/server"
	"webtmux/utils"
)

// run parses argv through the real root command and returns what the Action
// would have seen: the wrapped command and its arguments, with the option
// structs already updated from the flags.
func run(t *testing.T, argv ...string) (*server.Options, *localcommand.Options, []string, error) {
	t.Helper()

	appOptions := &server.Options{}
	backendOptions := &localcommand.Options{}
	cmd, flagMappings, err := newRootCommand(appOptions, backendOptions)
	if err != nil {
		t.Fatalf("newRootCommand: %v", err)
	}

	var passthrough []string
	cmd.Action = func(_ context.Context, cmd *cli.Command) error {
		if err := utils.ApplyFlags(cmd.Flags, flagMappings, cmd, appOptions, backendOptions); err != nil {
			return err
		}
		passthrough = cmd.Args().Slice()
		return nil
	}
	// Discard the usage text a parse failure prints.
	cmd.Writer = io.Discard
	cmd.ErrWriter = io.Discard

	err = cmd.Run(context.Background(), append([]string{"webtmux"}, argv...))
	return appOptions, backendOptions, passthrough, err
}

// The regression this file exists for. urfave/cli v3 parses flags anywhere on
// the command line by default, where v2 stopped at the first positional
// argument. Under v3's default, tmux's own -A is read as a webtmux flag and the
// program refuses to start with "flag provided but not defined: -A" — which is
// the single most common way anyone runs this program.
func TestFlagsAfterTheCommandAreNotOurs(t *testing.T) {
	appOptions, _, args, err := run(t, "-w", "-p", "8899", "tmux", "new-session", "-A", "-s", "main")
	if err != nil {
		t.Fatalf("parsing a normal invocation failed: %v", err)
	}

	if got := strings.Join(args, " "); got != "tmux new-session -A -s main" {
		t.Errorf("command args = %q, want the whole command passed through verbatim", got)
	}
	// Flags before the command must still be ours.
	if !appOptions.PermitWrite {
		t.Error("-w before the command was not applied")
	}
	if appOptions.Port != "8899" {
		t.Errorf("Port = %q, want 8899 from -p before the command", appOptions.Port)
	}
}

// A wrapped command may use a flag we also define; it must still reach the
// command rather than being consumed by webtmux.
func TestACollidingFlagAfterTheCommandGoesToTheCommand(t *testing.T) {
	appOptions, _, args, err := run(t, "-p", "8899", "some-tool", "-p", "1234", "--timeout", "5")
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if got := strings.Join(args, " "); got != "some-tool -p 1234 --timeout 5" {
		t.Errorf("command args = %q, want them passed through untouched", got)
	}
	if appOptions.Port != "8899" {
		t.Errorf("Port = %q — the command's own -p overwrote ours", appOptions.Port)
	}
	if appOptions.Timeout != 0 {
		t.Errorf("Timeout = %d, want the default — the command's --timeout was consumed by webtmux", appOptions.Timeout)
	}
}

// An unknown flag BEFORE the command is still an error, so a typo does not
// silently become an argument.
func TestAnUnknownFlagBeforeTheCommandIsRejected(t *testing.T) {
	if _, _, _, err := run(t, "--not-a-flag", "tmux"); err == nil {
		t.Error("want an error for an unknown flag before the command, got nil")
	}
}

// Defaults reach both option structs, and the backend struct's flags work.
func TestDefaultsAndBackendFlags(t *testing.T) {
	appOptions, backendOptions, _, err := run(t, "--close-signal", "9", "tmux")
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if appOptions.Address != "0.0.0.0" || appOptions.Port != "8080" {
		t.Errorf("defaults not applied: address=%q port=%q", appOptions.Address, appOptions.Port)
	}
	if backendOptions.CloseSignal != 9 {
		t.Errorf("CloseSignal = %d, want 9", backendOptions.CloseSignal)
	}
	if backendOptions.CloseTimeout != -1 {
		t.Errorf("CloseTimeout = %d, want the default -1", backendOptions.CloseTimeout)
	}
}
