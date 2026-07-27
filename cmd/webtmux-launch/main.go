// Command webtmux-launch runs webtmux on a remote machine over SSH and tunnels
// it back, in one command:
//
//	webtmux-launch linuxbox
//
// It works out which webtmux the target needs, gets it from the configured
// binary source (a GitHub release, or a local build directory), installs it over
// SSH, starts it, tunnels the port back, keeps both alive, and opens the
// browser. The target needs no internet, no curl/wget, and no pre-installed
// webtmux: the launcher resolves the binary locally and pushes it down the SSH
// connection it already has open.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
)

// Baked at build time with -ldflags -X, so the launcher is self-describing and
// needs no config file to work.
var (
	Version               = "dev"
	RepoOwner             = ""
	RepoName              = "webtmux"
	DefaultWebtmuxVersion = "v0.1.0"
	// DefaultSource is the local-development seam. Empty (the release build)
	// means "fetch from GitHub"; `make launcher-dev` bakes a local build
	// directory into it, producing a launcher that needs no env var and no
	// network at all. A released launcher MUST leave this empty — a dev default
	// leaking into a release build would send every user's launcher looking for
	// a path on the builder's machine.
	DefaultSource = ""
)

type options struct {
	localPort  int
	remotePort int
	session    string
	noBrowser  bool
	auth       bool
	forceCopy  bool
	arch       string
	verbose    bool
	showVer    bool
	fresh      bool
	adoptOnly  bool

	webtmuxVersion string
	webtmuxSource  string
	webtmuxBinary  string

	target   string
	tmuxArgs []string
}

func usage(fs *flag.FlagSet) func() {
	return func() {
		fmt.Fprintf(fs.Output(), "usage: webtmux-launch [flags] <ssh-target> [-- tmux args…]\n\n")
		fmt.Fprintf(fs.Output(), "<ssh-target> is passed verbatim to ssh, so ~/.ssh/config aliases,\nuser@host forms and ProxyJump bastions all work.\n\n")
		fs.PrintDefaults()
	}
}

func parseArgs(argv []string) (*options, error) {
	o := &options{}
	fs := flag.NewFlagSet("webtmux-launch", flag.ContinueOnError)
	fs.Usage = usage(fs)
	fs.IntVar(&o.localPort, "local-port", 0, "local port for the forward (default: a stable per-target port)")
	fs.IntVar(&o.remotePort, "remote-port", 0, "remote port webtmux listens on (also selects which instance to adopt)")
	fs.StringVar(&o.session, "session", "", "tmux session to attach (default: the only existing session, else \"main\")")
	fs.BoolVar(&o.noBrowser, "no-browser", false, "do not open a browser; just print the URL")
	fs.BoolVar(&o.auth, "auth", false, "keep webtmux's basic auth on (for shared multi-user boxes)")
	fs.BoolVar(&o.forceCopy, "force-copy", false, "push the binary even if the target already has this build")
	fs.StringVar(&o.arch, "arch", "", "override the probed architecture (uname -m form, e.g. aarch64)")
	fs.BoolVar(&o.verbose, "verbose", false, "echo ssh command lines and say which binary source won")
	fs.BoolVar(&o.showVer, "version", false, "print the launcher version and exit")
	fs.BoolVar(&o.fresh, "fresh", false, "ignore a running webtmux and start our own")
	fs.BoolVar(&o.adoptOnly, "adopt-only", false, "fail rather than starting a webtmux")
	fs.StringVar(&o.webtmuxVersion, "webtmux-version", DefaultWebtmuxVersion, "release version to install, or \"latest\"")
	fs.StringVar(&o.webtmuxSource, "webtmux-source", "", "directory of webtmux-<os>-<arch> builds to deploy from")
	fs.StringVar(&o.webtmuxBinary, "webtmux-binary", "", "deploy this exact binary, whatever it is named")
	if err := fs.Parse(argv); err != nil {
		return nil, err
	}
	if o.showVer {
		return o, nil
	}
	rest := fs.Args()
	if len(rest) == 0 {
		fs.Usage()
		return nil, fmt.Errorf("no ssh target given")
	}
	o.target = rest[0]
	o.tmuxArgs = rest[1:]
	if len(o.tmuxArgs) > 0 && o.tmuxArgs[0] == "--" {
		o.tmuxArgs = o.tmuxArgs[1:]
	}
	if o.fresh && o.adoptOnly {
		return nil, fmt.Errorf("--fresh and --adopt-only contradict each other")
	}
	return o, nil
}

func main() {
	o, err := parseArgs(os.Args[1:])
	if err != nil {
		if err != flag.ErrHelp {
			fmt.Fprintln(os.Stderr, "webtmux-launch: "+err.Error())
		}
		os.Exit(2)
	}
	if o.showVer {
		fmt.Printf("webtmux-launch %s (webtmux %s)\n", Version, DefaultWebtmuxVersion)
		return
	}
	// Ctrl-C tears down the child and the mux socket. In launch mode webtmux
	// dies with the connection, which is the point; in adopt mode only our own
	// tunnel goes away.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, o); err != nil {
		fmt.Fprintln(os.Stderr, "webtmux-launch: "+err.Error())
		os.Exit(1)
	}
}

func run(ctx context.Context, o *options) error {
	// Resolve the source ONCE, at startup, before the probe and before any SSH.
	// Everything downstream talks only to the Source interface: that is what
	// keeps the release backend a different Digest/Open pair rather than a
	// different code path through the launcher.
	src, why, err := resolveSource(o, os.Getenv, filepath.Join(homeDir(), ".cache", "webtmux-launch"))
	if err != nil {
		return err
	}
	if o.verbose {
		fmt.Printf("binary source: %s selected by %s\n", src.Kind(), why)
	}

	ssh := newSSHRunner(o.target, o.verbose)
	// Shutdown, not ClearStaleMaster: the mux master owns the forward, and
	// leaving it persisting would hold the local port past our exit.
	defer ssh.Shutdown(context.Background())

	cfg := loadTargetConfig(o.target)
	// A launcher that died abnormally (SIGKILL, a crash) leaves its mux master
	// running for ControlPersist, and the master owns the forward — so our own
	// stored port looks taken and we would silently move to a new URL. Clearing
	// it is only correct when it is ours, which is exactly the case where the
	// stored port is busy. Done before the probe so we never tear down the
	// master this run is riding.
	if cfg.LocalPort != 0 && !localPortFree(cfg.LocalPort) {
		ssh.Shutdown(ctx)
	}

	p, err := runProbe(ctx, ssh, o.arch)
	if err != nil {
		return err
	}
	if o.verbose {
		fmt.Printf("target: %s %s (%s), tmux %s, home %s\n", p.OS, p.Arch, p.Platform,
			strings.TrimPrefix(p.TmuxVer, "tmux "), p.Home)
	}

	if err := cfg.ensure(o.localPort, o.remotePort); err != nil {
		return err
	}

	// Mode selection: adoption is triggered purely by "an instance is already
	// running" — never by detecting a durability problem, which is orthogonal
	// and only changes what gets reported.
	var adopted *instance
	if !o.fresh {
		adopted, err = chooseInstance(p.Instances, o.remotePort)
		if err != nil {
			return err
		}
	}
	if adopted == nil && o.adoptOnly {
		return fmt.Errorf("no webtmux is running on %s and --adopt-only was given", o.target)
	}

	if adopted != nil {
		return adopt(ctx, o, ssh, p, cfg, src, adopted)
	}
	return launch(ctx, o, ssh, p, cfg, src)
}

// launch is the primary path: the launcher works on a machine that has never
// seen webtmux — no config, no pre-deployed binary, no systemd unit.
func launch(ctx context.Context, o *options, ssh *sshRunner, p *probe, cfg *targetConfig, src Source) error {
	digest, err := src.Digest(p.Platform)
	if err != nil {
		return err
	}
	fmt.Println(sourceLine(src, p.Platform, digest))
	if w := staleSourceWarning(src, p.Platform); w != "" {
		fmt.Println(w)
	}

	// --webtmux-binary cannot check the file matches the target's platform, so
	// a mismatch would surface as a bare "Exec format error" after a full
	// transfer. Catch it locally, naming both architectures.
	if fs, ok := src.(*fileSource); ok {
		if err := checkBinaryArch(fs.file, p.Platform); err != nil {
			return err
		}
	}

	dep := planDeploy(p, digest)
	if err := dep.run(ctx, ssh, p, src, o.forceCopy); err != nil {
		return err
	}
	switch {
	case dep.Copied:
		fmt.Printf("deployed: %s\n", dep.BinaryPath)
	case o.verbose:
		fmt.Printf("already present: %s (no transfer)\n", dep.BinaryPath)
	}

	session := chooseSession(o.session, p.Sessions)
	if contains(p.Sessions, session) {
		fmt.Printf("attaching to existing session %q\n", session)
	} else {
		fmt.Printf("creating session %q\n", session)
	}
	// Base session creation is its own one-shot command, run BEFORE webtmux
	// starts, so the session's durability never depends on anything the
	// supervised process does.
	if _, errOut, err := ssh.Run(ctx, dep.setupCommand(p.TmuxPath, session)); err != nil {
		return fmt.Errorf("creating tmux session %q: %v\n%s", session, err, strings.TrimSpace(errOut))
	}

	if w := p.durabilityWarning(); w != "" {
		fmt.Println(w)
	}

	sup := &supervisor{
		ssh:       ssh,
		local:     cfg.LocalPort,
		remote:    cfg.RemotePort,
		url:       cfg.url(),
		out:       os.Stdout,
		noBrowser: o.noBrowser,
		remoteCmd: func() string {
			return remoteCommand(dep, cfg, session, o)
		},
		onPortCollision: func() int {
			p, err := randomHighPort()
			if err != nil {
				return 0
			}
			cfg.RemotePort = p
			_ = cfg.save()
			return p
		},
	}
	if err := cfg.save(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not persist ports for %s: %v\n", o.target, err)
	}
	fmt.Printf("url: %s\n", cfg.url())
	return sup.run(ctx)
}

// remoteCommand is the supervised child: one ssh invocation carrying both the
// forward and the remote process.
//
// It runs the ATTACH SCRIPT, not tmux directly (split-view depends on the
// wrapper), and exports WEBTMUX_SESSION — without which
// server.detectTmuxSession() falls back to the literal "0", because it parses
// -s/-t out of argv only when the command IS tmux, and a wrapper hides them.
// The sidebar would then target a session that does not exist.
//
// WEBTMUX_SOCKET is deliberately left unset: empty means tmux's default socket,
// which is what a native install wants.
//
// --pass-headers is NOT passed. The server injects the Webtmux-Session header
// itself (server/handlers.go), creating the header map when absent, so the
// split-view channel works without it; the flag gates only client-supplied
// request headers.
func remoteCommand(dep *deployment, cfg *targetConfig, session string, o *options) string {
	var b strings.Builder
	fmt.Fprintf(&b, "WEBTMUX_SESSION=%s ", shellQuote(session))
	if o.auth {
		// When a credential is passed it goes through the environment, never
		// -c user:pass, which is visible in ps to every user on that machine.
		fmt.Fprintf(&b, "GOTTY_CREDENTIAL=%s ", shellQuote("webtmux:"+cfg.Secret))
	}
	fmt.Fprintf(&b, "%s -w -a 127.0.0.1 -p %d --path %s --reconnect ",
		shellQuote(dep.BinaryPath), cfg.RemotePort, shellQuote(cfg.urlPath()))
	if !o.auth {
		b.WriteString("--no-auth ")
	}
	b.WriteString(shellQuote(dep.AttachPath))
	for _, a := range o.tmuxArgs {
		b.WriteString(" " + shellQuote(a))
	}
	return tieToConnection(b.String())
}

// tieToConnection is what actually makes webtmux disposable.
//
// The obvious `ssh host 'exec webtmux …'` does NOT die with the connection: for
// a session with no tty, sshd does not SIGHUP the remote command when the
// client goes away — it only closes the channel. The remote webtmux would then
// outlive every launcher exit, hold the remote port (so the next connection
// cannot bind it), and defeat the entire disposable design. The symptom is
// nasty precisely because it looks fine: the first launch works, and only the
// reconnect fails.
//
// So the remote side watches its own stdin instead. The launcher hands ssh a
// pipe it holds open and never writes to (see supervisor.run); stdin EOF
// therefore means "the launcher is gone" — including when it was SIGKILLed and
// could run no cleanup — and the wrapper kills webtmux. The reverse direction
// matters too: if webtmux exits on its own (a port collision, say), `wait`
// returns and the whole command exits with its status rather than blocking on
// the reader forever.
// The `exec 3<&0` is load-bearing and non-obvious: POSIX says a shell with job
// control disabled — which is every non-interactive remote shell — reassigns an
// asynchronous list's stdin to /dev/null. Without saving the channel to fd 3
// first, the backgrounded reader would read EOF from /dev/null instantly and
// kill webtmux the moment it started. Backgrounding webtmux itself gets the same
// /dev/null treatment, which is what we want for it.
func tieToConnection(cmd string) string {
	return "exec 3<&0; { " + cmd + " & } ; p=$!; " +
		"{ cat <&3 >/dev/null; kill -TERM $p 2>/dev/null; } & r=$!; " +
		"wait $p; ec=$?; kill $r 2>/dev/null; exit $ec"
}

// adopt connects to the webtmux that is already running. It skips deploy,
// session creation and launch entirely — the launcher's whole job becomes the
// tunnel plus the browser, and teardown removes only our own tunnel. Getting
// that backwards would destroy the very persistence the user set up.
func adopt(ctx context.Context, o *options, ssh *sshRunner, p *probe, cfg *targetConfig, src Source, inst *instance) error {
	// The build comparison needs only Source.Digest, so adopt mode never pulls
	// 12 MB over the network and never reads the local binary either.
	match := ""
	digest, err := src.Digest(p.Platform)
	switch {
	case err != nil:
		match = "unknown (" + err.Error() + ")"
	case inst.ExeSHA == "":
		match = "unknown (could not read /proc/" + fmt.Sprint(inst.PID) + "/exe)"
	case inst.ExeSHA == digest:
		match = "matches " + src.Kind() + " " + short12(digest)
	case inst.Containerized:
		match = "differs from " + src.Kind() + " " + short12(digest) + " — expected: /proc/<pid>/exe is the container's binary"
	default:
		match = "differs from " + src.Kind() + " " + short12(digest) +
			" — adopting a webtmux that is not the build in " + src.Location(p.Platform)
	}
	for _, line := range inst.report(match) {
		fmt.Println(line)
	}

	if inst.Port == 0 {
		return fmt.Errorf("could not read the running webtmux's port from /proc/%d/cmdline\n(use --fresh to start our own)", inst.PID)
	}
	cfg.RemotePort = inst.Port
	url := fmt.Sprintf("http://127.0.0.1:%d%s", cfg.LocalPort, inst.secretPath())
	if err := cfg.save(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not persist ports for %s: %v\n", o.target, err)
	}
	fmt.Printf("url: %s\n", url)

	sup := &supervisor{
		ssh:       ssh,
		local:     cfg.LocalPort,
		remote:    cfg.RemotePort,
		url:       url,
		out:       os.Stdout,
		noBrowser: o.noBrowser || (inst.needsCredential() && !inst.credentialRecoverable()),
		// nil remoteCmd => a bare `ssh -N -L …` forward. The adopted webtmux is
		// the user's long-lived process and must outlive us.
		remoteCmd: nil,
	}
	if sup.noBrowser && inst.needsCredential() && !inst.credentialRecoverable() {
		fmt.Println("not opening a browser: that instance wants a password we cannot recover, and the URL would just 401")
	}
	return sup.run(ctx)
}

// chooseSession implements the "attach if present, create durably if not"
// default. With no --session and exactly one existing session, prefer it over
// the literal name "main" — the box has already told us what it calls things.
func chooseSession(want string, existing []string) string {
	if want != "" {
		return want
	}
	if len(existing) == 1 {
		return existing[0]
	}
	if contains(existing, "main") || len(existing) == 0 {
		return "main"
	}
	return "main"
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
