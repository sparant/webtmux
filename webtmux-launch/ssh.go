package main

// The SSH layer. We shell out to the system `ssh` rather than using
// x/crypto/ssh: it inherits ~/.ssh/config, ProxyJump bastions, ssh-agent,
// 1Password/YubiKey, known_hosts and 2FA for free, and reimplementing that is
// exactly the "complicated for people" surface this tool removes.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type sshRunner struct {
	target      string
	controlPath string
	verbose     bool
	stderr      io.Writer
	// local runs every command with `sh -c` on this machine instead of over
	// ssh, and the "tunnel" is the command alone (see local.go).
	local bool
}

// newLocalRunner is the runner for a target that is this machine: same
// methods, no ssh, no mux, no forward.
func newLocalRunner(verbose bool) *sshRunner {
	return &sshRunner{target: "localhost", verbose: verbose, stderr: os.Stderr, local: true}
}

// where names the machine webtmux runs on, for the console.
func (r *sshRunner) where() string {
	if r.local {
		return "this machine"
	}
	return "the target"
}

// command builds the process for one remote shell command: ssh with args, or
// the local shell in local mode. ssh starts the command in the user's home
// with sshd's environment; the local shell is given the same starting point.
func (r *sshRunner) command(ctx context.Context, args []string, remote string) *exec.Cmd {
	if r.local {
		if r.verbose {
			fmt.Fprintf(r.stderr, "+ sh -c %s\n", shellQuote(remote))
		}
		cmd := exec.CommandContext(ctx, "/bin/sh", "-c", remote)
		cmd.Dir = homeDir()
		cmd.Env = localEnv()
		return cmd
	}
	r.logArgs(args)
	return exec.CommandContext(ctx, "ssh", args...)
}

// newSSHRunner sets up connection multiplexing so ONE password/2FA prompt
// covers the whole setup phase — probe, copy, session checks — instead of one
// per step. The long-lived tunnel deliberately does NOT ride it; see
// TunnelCommand.
//
// Deviation from the plan, deliberate: the plan suggested ControlPath
// ~/.ssh/cm-webtmux-%C. We hash the target ourselves instead, because after a
// network drop the master dies and can leave a stale socket behind — and
// removing that socket requires knowing its path, which %C (expanded inside
// ssh) does not give us. The hash keeps the path just as short, which is the
// property %C was there for (macOS caps unix socket paths near 104 chars).
func newSSHRunner(target string, verbose bool) *sshRunner {
	sum := sha256.Sum256([]byte(target))
	dir := filepath.Join(homeDir(), ".ssh")
	_ = os.MkdirAll(dir, 0o700)
	return &sshRunner{
		target:      target,
		controlPath: filepath.Join(dir, "cm-webtmux-"+hex.EncodeToString(sum[:])[:12]),
		verbose:     verbose,
		stderr:      os.Stderr,
	}
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return os.Getenv("HOME")
}

// baseArgs is passed on every SETUP ssh invocation (Run, RunWithStdin, the mux
// control commands), identically.
//
// The mux gotcha that makes "identically" non-negotiable: keepalive options set
// on a mux *client* are ignored — only the connection that becomes master owns
// the TCP link and its ServerAlive* behaviour. With ControlMaster=auto,
// whichever call runs first becomes master and carries the keepalives;
// everything later rides it.
func (r *sshRunner) baseArgs() []string {
	return append([]string{
		"-o", "ControlMaster=auto",
		"-o", "ControlPath=" + r.controlPath,
		"-o", "ControlPersist=60s",
	}, keepaliveArgs...)
}

// keepaliveArgs: a dead link is declared after ~15s (5s x 3) rather than ~45s.
// The launcher's typical client is a laptop that sleeps and changes networks,
// and after a network switch ssh stays alive on a dead TCP connection until
// these give up — 15s is the difference between "it reconnected" and "it is
// broken, I will restart it". The same values scripts that kept tunnels up for
// a long time settled on.
//
// ServerAliveInterval does double duty: it detects a dead link, AND it prevents
// the most common cause of perceived flakiness outright — NAT/firewall idle
// timeouts — by keeping traffic flowing.
var keepaliveArgs = []string{
	"-o", "ServerAliveInterval=5",
	"-o", "ServerAliveCountMax=3",
	"-o", "ConnectTimeout=10",
}

// tunnelArgs is the long-lived tunnel's own option set: its OWN TCP connection,
// never a client of the setup mux.
//
// It used to ride the mux, and every tunnel bug came from that. Under a live
// master, `ssh -N -L` hands its forward to the master and exits 0 at once, so
// the supervisor watched a process that had nothing to do with the tunnel and
// "reconnected" forever; the forward then lived only as long as the master's
// ControlPersist, kept alive by those spurious reconnects; and a master killed
// by a network drop left a stale socket every reconnect had to clear first.
// With its own connection, the process the supervisor waits on IS the link: it
// exits exactly when the tunnel is gone, and nothing else can take it down.
//
// Cost: one more authentication when the tunnel starts and on each reconnect —
// nothing with a key or agent; one prompt for password/2FA users, who already
// re-authenticated on any reconnect whose master had died.
//
// ControlPath=none disables multiplexing outright, whatever ~/.ssh/config says.
// ssh takes the FIRST value it sees for an option, so this must never be
// combined with baseArgs.
func tunnelArgs() []string {
	return append([]string{
		"-o", "ControlMaster=no",
		"-o", "ControlPath=none",
		"-o", "ExitOnForwardFailure=yes",
		// "channel N: open failed: connect failed" for every readiness poll
		// that lands before webtmux listens is INFO-level noise; real failures
		// (auth, host key, unreachable) are errors and still print.
		"-o", "LogLevel=ERROR",
	}, keepaliveArgs...)
}

func (r *sshRunner) logArgs(args []string) {
	if r.verbose {
		fmt.Fprintf(r.stderr, "+ ssh %s\n", strings.Join(args, " "))
	}
}

// Run executes a remote shell command and returns its stdout. ssh's own stderr
// is returned rather than swallowed — its messages are better than anything we
// would invent.
func (r *sshRunner) Run(ctx context.Context, remote string) (string, string, error) {
	cmd := r.command(ctx, append(r.baseArgs(), r.target, remote), remote)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	return out.String(), errb.String(), err
}

// RunWithStdin streams data to a remote command over the existing connection.
func (r *sshRunner) RunWithStdin(ctx context.Context, remote string, stdin io.Reader) (string, error) {
	cmd := r.command(ctx, append(r.baseArgs(), r.target, remote), remote)
	cmd.Stdin = stdin
	var errb bytes.Buffer
	cmd.Stderr = &errb
	cmd.Stdout = io.Discard
	err := cmd.Run()
	if err != nil {
		return errb.String(), fmt.Errorf("%v: %s", err, strings.TrimSpace(errb.String()))
	}
	return errb.String(), nil
}

// TunnelCommand builds the one supervised subprocess: a local forward and the
// remote process in a single ssh invocation, on its own connection (see
// tunnelArgs). When remote is empty this is a bare forward (-N), which is what
// adopt mode wants — there the remote webtmux is the user's own long-lived
// process and must not die with our connection.
//
// ExitOnForwardFailure turns a port collision into a clean failure instead of a
// tunnel-less session that looks fine until the browser cannot connect.
//
// In local mode there is nothing to forward: the command runs as is, in its own
// process group so a Ctrl-C at the terminal reaches only the launcher — webtmux
// then goes the way it does over SSH, when the liveness pipe closes. Adopt
// mode's bare forward becomes a placeholder that just waits, so the supervisor
// and its health check work unchanged.
func (r *sshRunner) TunnelCommand(ctx context.Context, localPort, remotePort int, remote string) *exec.Cmd {
	if r.local {
		if remote == "" {
			remote = "exec sleep 2147483647"
		}
		cmd := r.command(ctx, nil, remote)
		tieToParent(cmd)
		ownProcessGroup(cmd)
		// The wrapper's stdin watcher inherits the shell's stderr, and it exits
		// only once the launcher closes the liveness pipe — which it does after
		// Wait returns. Over SSH, ssh is the pipe's only holder; here, without a
		// bound, Wait would sit on that stderr forever and the launcher would
		// never exit (nor, therefore, webtmux).
		cmd.WaitDelay = time.Second
		return cmd
	}
	args := append(tunnelArgs(),
		"-L", fmt.Sprintf("127.0.0.1:%d:127.0.0.1:%d", localPort, remotePort),
	)
	if remote == "" {
		args = append(args, "-N", r.target)
	} else {
		args = append(args, r.target, remote)
	}
	r.logArgs(args)
	cmd := exec.CommandContext(ctx, "ssh", args...)
	tieToParent(cmd)
	return cmd
}

// Shutdown tears the setup mux master down on exit, rather than leaving it to
// ControlPersist. The tunnel no longer rides it, but a master left by an OLDER
// launcher may still own a -L forward — holding our stored local port, so the
// next run would silently move to a new URL. main calls this when it finds its
// stored port busy for exactly that reason.
func (r *sshRunner) Shutdown(ctx context.Context) {
	if r.local {
		return
	}
	args := append(r.baseArgs(), "-O", "exit", r.target)
	_ = exec.CommandContext(ctx, "ssh", args...).Run()
	_ = os.Remove(r.controlPath)
}

// shellQuote wraps a string for safe interpolation into a remote sh command.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
