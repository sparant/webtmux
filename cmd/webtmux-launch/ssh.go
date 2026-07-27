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
)

type sshRunner struct {
	target      string
	controlPath string
	verbose     bool
	stderr      io.Writer
}

// newSSHRunner sets up connection multiplexing so ONE password/2FA prompt
// covers the probe, the copy and the tunnel instead of three.
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

// baseArgs is passed on EVERY ssh invocation, identically.
//
// The mux gotcha that makes this non-negotiable: keepalive options set on a mux
// *client* are ignored — only the connection that becomes master owns the TCP
// link and its ServerAlive* behaviour. So keepalives cannot be "the supervised
// command's concern" and mux options "the probe's". With ControlMaster=auto,
// whichever call runs first becomes master and carries the keepalives;
// everything later rides it.
//
// ServerAliveInterval does double duty: it detects a dead link, AND it prevents
// the most common cause of perceived flakiness outright — NAT/firewall idle
// timeouts — by keeping traffic flowing.
func (r *sshRunner) baseArgs() []string {
	return []string{
		"-o", "ControlMaster=auto",
		"-o", "ControlPath=" + r.controlPath,
		"-o", "ControlPersist=60s",
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=3",
		"-o", "ConnectTimeout=10",
	}
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
	args := append(r.baseArgs(), r.target, remote)
	r.logArgs(args)
	cmd := exec.CommandContext(ctx, "ssh", args...)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	return out.String(), errb.String(), err
}

// RunWithStdin streams data to a remote command over the existing connection.
func (r *sshRunner) RunWithStdin(ctx context.Context, remote string, stdin io.Reader) (string, error) {
	args := append(r.baseArgs(), r.target, remote)
	r.logArgs(args)
	cmd := exec.CommandContext(ctx, "ssh", args...)
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
// remote process in a single ssh invocation. When remote is empty this is a
// bare forward (-N), which is what adopt mode wants — there the remote webtmux
// is the user's own long-lived process and must not die with our connection.
//
// ExitOnForwardFailure turns a port collision into a clean failure instead of a
// tunnel-less session that looks fine until the browser cannot connect.
func (r *sshRunner) TunnelCommand(ctx context.Context, localPort, remotePort int, remote string) *exec.Cmd {
	args := append(r.baseArgs(),
		"-o", "ExitOnForwardFailure=yes",
		"-L", fmt.Sprintf("127.0.0.1:%d:127.0.0.1:%d", localPort, remotePort),
	)
	if remote == "" {
		args = append(args, "-N", r.target)
	} else {
		args = append(args, r.target, remote)
	}
	r.logArgs(args)
	return exec.CommandContext(ctx, "ssh", args...)
}

// ClearStaleMaster drops a dead mux master between reconnect attempts. Without
// this a reconnect hangs on a socket whose connection is gone instead of
// establishing a fresh one.
func (r *sshRunner) ClearStaleMaster(ctx context.Context) {
	args := append(r.baseArgs(), "-O", "check", r.target)
	if err := exec.CommandContext(ctx, "ssh", args...).Run(); err == nil {
		return // master alive — leave it
	}
	exit := append(r.baseArgs(), "-O", "exit", r.target)
	_ = exec.CommandContext(ctx, "ssh", exit...).Run()
	// -O exit fails too when the master is already gone; the socket file can
	// survive that, and ssh will try to use it. Remove it ourselves — the
	// reason this type owns an explicit ControlPath.
	_ = os.Remove(r.controlPath)
}

// shellQuote wraps a string for safe interpolation into a remote sh command.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
