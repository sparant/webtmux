package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	cli "github.com/urfave/cli/v3"

	"webtmux/backend/localcommand"
	"webtmux/server"
	"webtmux/utils"
)

// stopAfterCommandName is cli.Command.StopOnNthArg's value: 1, meaning flag
// parsing stops once the first positional argument (the wrapped command) has
// been seen. It is a variable only because that field is a *int.
var stopAfterCommandName = 1

// newRootCommand builds the root command: defaults applied to the option
// structs, one flag per tagged field, and v2's stop-at-the-first-positional
// parsing. It returns the command with its flags installed, plus the flag ->
// field mapping ApplyFlags needs. The caller supplies the Action.
//
// This is a function rather than inline in main so the argument-passthrough
// rule below can be tested — it is not something the type system can catch.
func newRootCommand(appOptions *server.Options, backendOptions *localcommand.Options) (*cli.Command, map[string]string, error) {
	if err := utils.ApplyDefaultValues(appOptions); err != nil {
		return nil, nil, err
	}
	if err := utils.ApplyDefaultValues(backendOptions); err != nil {
		return nil, nil, err
	}

	cliFlags, flagMappings, err := utils.GenerateFlags(appOptions, backendOptions)
	if err != nil {
		return nil, nil, err
	}

	// urfave/cli v3 has no App type: the root of the command tree is a Command
	// like any other. v3 also has no transitive dependencies at all, which is
	// why this project is on it — v2 pulled in go-md2man, blackfriday and
	// sanitized_anchor_name purely to render man pages from --help.
	cmd := &cli.Command{
		Name:    "webtmux",
		Version: Version,
		Usage:   "Web terminal for tmux with visual pane layout",
		// v2 derived the usage line's trailing "[arguments...]" on its own; v3
		// prints exactly what ArgsUsage says. Without this the usage line would
		// stop mentioning the command argument, which is not optional here —
		// webtmux has nothing to serve without one.
		ArgsUsage: "<command> [<arguments...>]",
		// THE load-bearing line of the v2 -> v3 migration. v2 stopped parsing
		// flags at the first positional argument; v3 by default keeps parsing
		// them anywhere on the command line. That silently breaks the primary
		// invocation of this program:
		//
		//     webtmux -w -p 8080 tmux new-session -A -s main
		//
		// because tmux's own -A is then read as a webtmux flag and rejected
		// with "flag provided but not defined: -A". Every wrapped command's
		// flags would collide with ours.
		//
		// StopOnNthArg: 1 restores v2's rule exactly — parse flags up to the
		// first positional argument, then hand everything from the command
		// onward through untouched.
		StopOnNthArg:    &stopAfterCommandName,
		HideHelpCommand: true,
		Flags:           cliFlags,
	}
	return cmd, flagMappings, nil
}

func main() {
	appOptions := &server.Options{}
	backendOptions := &localcommand.Options{}

	cmd, flagMappings, err := newRootCommand(appOptions, backendOptions)
	if err != nil {
		exit(err, 3)
	}
	cliFlags := cmd.Flags

	cmd.Action = func(_ context.Context, cmd *cli.Command) error {
		if cmd.NArg() == 0 {
			msg := "Error: No command given."
			cli.ShowAppHelp(cmd)
			exit(errors.New(msg), 1)
		}

		if err := utils.ApplyFlags(cliFlags, flagMappings, cmd, appOptions, backendOptions); err != nil {
			exit(err, 3)
		}

		if appOptions.Quiet {
			log.SetFlags(0)
			log.SetOutput(io.Discard)
		}

		// Handle authentication
		if appOptions.NoAuth {
			appOptions.EnableBasicAuth = false
			log.Printf("WARNING: Authentication disabled. Terminal is publicly accessible!")
		} else if cmd.IsSet("credential") {
			appOptions.EnableBasicAuth = true
		} else {
			// Generate random credentials
			appOptions.EnableBasicAuth = true
			appOptions.Credential = "admin:" + generateRandomPassword(32)
			fmt.Printf("\n")
			fmt.Printf("========================================\n")
			fmt.Printf("  Authentication Required (default)\n")
			fmt.Printf("  Username: admin\n")
			fmt.Printf("  Password: %s\n", strings.Split(appOptions.Credential, ":")[1])
			fmt.Printf("========================================\n")
			fmt.Printf("  Use -c user:pass to set custom credentials\n")
			fmt.Printf("  Use --no-auth to disable (not recommended)\n")
			fmt.Printf("========================================\n")
			fmt.Printf("\n")
		}

		if cmd.IsSet("tls-ca-crt") {
			appOptions.EnableTLSClientAuth = true
		}

		err = appOptions.Validate()
		if err != nil {
			exit(err, 6)
		}

		// Reserve low pts numbers BEFORE any pane pty exists, so our panes'
		// "/dev/pts/N" names can never collide with host-side tmux clients (tmux
		// targets clients by tty STRING; a cross-namespace collision lets
		// switch-client act on the wrong client). WEBTMUX_PTS_FLOOR overrides
		// the default of 256; 0 disables.
		floor := 256
		if v := os.Getenv("WEBTMUX_PTS_FLOOR"); v != "" {
			if n, perr := strconv.Atoi(v); perr == nil {
				floor = n
			}
		}
		if n := localcommand.ReservePtys(floor); n > 0 {
			log.Printf("Reserved %d low pts numbers (floor %d) to keep pane ttys collision-free", n, floor)
		}

		args := cmd.Args()
		factory, err := localcommand.NewFactory(args.First(), args.Tail(), backendOptions)
		if err != nil {
			exit(err, 3)
		}

		hostname, _ := os.Hostname()
		appOptions.TitleVariables = map[string]interface{}{
			"command":  args.First(),
			"argv":     args.Tail(),
			"hostname": hostname,
		}

		srv, err := server.New(factory, appOptions)
		if err != nil {
			exit(err, 3)
		}

		ctx, cancel := context.WithCancel(context.Background())
		gCtx, gCancel := context.WithCancel(context.Background())

		log.Printf("WebTmux is starting with command: %s", strings.Join(args.Slice(), " "))

		errs := make(chan error, 1)
		go func() {
			errs <- srv.Run(ctx, server.WithGracefullContext(gCtx))
		}()
		err = waitSignals(errs, cancel, gCancel)

		if err != nil && err != context.Canceled {
			fmt.Printf("Error: %s\n", err)
			exit(err, 8)
		}

		return nil
	}
	// v3's Run takes a context and returns the error v2 also returned but that
	// this main discarded — which meant "flag provided but not defined" printed
	// a usage message and then exited 0. The message is already on stderr by the
	// time it comes back, so exiting non-zero is all that is left to do.
	if err := cmd.Run(context.Background(), os.Args); err != nil {
		os.Exit(1)
	}
}

func exit(err error, code int) {
	if err != nil {
		fmt.Println(err)
	}
	os.Exit(code)
}

func waitSignals(errs chan error, cancel context.CancelFunc, gracefullCancel context.CancelFunc) error {
	sigChan := make(chan os.Signal, 1)
	signal.Notify(
		sigChan,
		syscall.SIGINT,
		syscall.SIGTERM,
	)

	select {
	case err := <-errs:
		return err

	case s := <-sigChan:
		switch s {
		case syscall.SIGINT:
			gracefullCancel()
			fmt.Println("C-C to force close")
			select {
			case err := <-errs:
				return err
			case <-sigChan:
				fmt.Println("Force closing...")
				cancel()
				return <-errs
			}
		default:
			cancel()
			return <-errs
		}
	}
}

func generateRandomPassword(length int) string {
	b := make([]byte, length)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)[:length]
}
