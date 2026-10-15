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
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path"
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
	tmuxPath   string
	verbose    bool
	showVer    bool
	fresh      bool
	adoptOnly  bool

	webtmuxVersion string
	webtmuxSource  string
	webtmuxBinary  string

	target   string
	tmuxArgs []string

	// platformHint is filled in from the probe before the source is resolved.
	// The "beside the launcher" fallback needs to know which asset name to look
	// for, and that is not known until the target has been probed.
	platformHint string
}

func usage(fs *flag.FlagSet) func() {
	return func() {
		fmt.Fprintf(fs.Output(), "usage: webtmux-launch [flags] <ssh-target> [-- tmux args…]\n\n")
		fmt.Fprint(fs.Output(), `<ssh-target> is passed to ssh exactly as typed — anything ssh accepts works:

  linuxbox                         a host, or a ~/.ssh/config alias
  you@203.0.113.10                 user@host, port 22
  ssh://you@203.0.113.10:38242     another SSH port (an ssh:// URL)
  ssh://you@[2001:db8::5]:38242    IPv6 with a port

user@host:port does NOT work: ssh reads it as a host named "host:port". For a
port, use the ssh:// form or put Port in ~/.ssh/config, which is also where a
jump host (ProxyJump), a key file or any other ssh option belongs.

`)
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
	fs.StringVar(&o.tmuxPath, "tmux-path", "", "absolute path to tmux on the target (skips the probe's search)")
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
	// Validate an explicitly configured source BEFORE any SSH. Full resolution
	// has to wait for the probe (the "beside the launcher" fallback needs the
	// target's platform), but a typo'd directory should fail in milliseconds
	// rather than after a round trip.
	if err := validateSourceConfig(o, os.Getenv); err != nil {
		return err
	}

	ssh := newSSHRunner(o.target, o.verbose)
	// Close the setup mux on exit rather than leaving it to ControlPersist.
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

	p, err := runProbe(ctx, ssh, o.arch, o.tmuxPath)
	if err != nil {
		return err
	}
	o.platformHint = p.Platform
	if o.verbose {
		fmt.Printf("target: %s %s (%s), tmux %s, home %s\n", p.OS, p.Arch, p.Platform,
			strings.TrimPrefix(p.TmuxVer, "tmux "), p.Home)
	}
	if err := cfg.ensure(o.localPort, o.remotePort); err != nil {
		return err
	}

	ask := newChooser()

	// --- steps 1 and 2: an already-running webtmux wins, and several means ask.
	//
	// Adoption is triggered purely by "an instance is already running" — never
	// by detecting a durability problem, which is orthogonal and only changes
	// what gets reported.
	if !o.fresh {
		adopted, err := pickInstance(p.Instances, o.remotePort, ask)
		if err != nil {
			return err
		}
		if adopted != nil {
			return adopt(ctx, o, ssh, p, cfg, adopted)
		}
	}
	if o.adoptOnly {
		return fmt.Errorf("no webtmux is running on %s and --adopt-only was given", o.target)
	}

	// --- step 3: nothing running, so decide which tmux session to attach to.
	session, existed, why := pickSession(o.session, p)
	if existed {
		if why != "" {
			fmt.Printf("attaching to existing session %q — %s\n", session, why)
		} else {
			fmt.Printf("attaching to existing session %q\n", session)
		}
	} else {
		fmt.Printf("creating session %q\n", session)
	}

	// --- step 4: and only now does a binary matter.
	return launch(ctx, o, ssh, p, cfg, session)
}

// resolveBinary is step 4: what should the remote command actually exec?
//
// Reusing a webtmux already on the target is checked FIRST because it is both
// the cheapest outcome (no transfer, no download, no local read) and the one the
// user is most likely to have arranged deliberately by installing webtmux there.
// It is gated on the version matching what this launcher expects — an unknown
// build is not a saving, it is a debugging session six months from now.
func resolveBinary(ctx context.Context, o *options, ssh *sshRunner, p *probe) (*deployment, error) {
	if !o.forceCopy && p.WebtmuxPath != "" && webtmuxVersionMatches(p.WebtmuxVer, o.webtmuxVersion) {
		dep := planDeploy(p, "")
		dep.SkipBinary = true
		dep.BinaryPath = p.WebtmuxPath
		fmt.Printf("using the webtmux already on the target: %s (%s)\n", p.WebtmuxPath, versionToken(p.WebtmuxVer))
		return dep, nil
	}
	if p.WebtmuxPath != "" && o.verbose {
		fmt.Printf("target has %s (%s), which is not %s — fetching the expected build\n",
			p.WebtmuxPath, versionToken(p.WebtmuxVer), o.webtmuxVersion)
	}

	src, why, err := resolveSource(o, os.Getenv, filepath.Join(homeDir(), ".cache", "webtmux-launch"))
	if err != nil {
		return nil, err
	}
	if o.verbose {
		fmt.Printf("binary source: %s selected by %s\n", src.Kind(), why)
	}
	digest, err := src.Digest(p.Platform)
	if err != nil {
		return nil, err
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
			return nil, err
		}
	}

	dep := planDeploy(p, digest)
	err = dep.run(ctx, ssh, p, src, o.forceCopy)
	var rep *republishedError
	if errors.As(err, &rep) {
		fmt.Println(rep.Error())
		dir := rep.src.cacheDir
		ok, askErr := newChooser().confirm(
			fmt.Sprintf("Trust the release as GitHub serves it now, and replace the cached copy in %s?", dir),
			fmt.Sprintf("not trusted (no terminal to ask). To accept the release as it is now:\n  rm -rf %s\nand re-run.", dir))
		if askErr != nil {
			return nil, askErr
		}
		if !ok {
			return nil, fmt.Errorf("not trusted; nothing was installed. To accept it later: rm -rf %s and re-run", dir)
		}
		if err := rep.trust(); err != nil {
			return nil, fmt.Errorf("updating %s: %v", dir, err)
		}
		if digest, err = src.Digest(p.Platform); err != nil {
			return nil, err
		}
		fmt.Printf("updated %s; now installing %s\n", dir, short12(digest))
		dep = planDeploy(p, digest)
		err = dep.run(ctx, ssh, p, src, o.forceCopy)
	}
	if err != nil {
		return nil, err
	}
	switch {
	case dep.FetchedRemotely:
		fmt.Printf("target downloaded it: %s\n", dep.BinaryPath)
	case dep.Copied:
		fmt.Printf("deployed: %s (pushed over SSH from this machine)\n", dep.BinaryPath)
	default:
		fmt.Printf("already present: %s (on the target from an earlier run; no transfer)\n", dep.BinaryPath)
	}
	return dep, nil
}

// launch is the primary path: the launcher works on a machine that has never
// seen webtmux — no config, no pre-deployed binary, no systemd unit.
func launch(ctx context.Context, o *options, ssh *sshRunner, p *probe, cfg *targetConfig, session string) error {
	dep, err := resolveBinary(ctx, o, ssh, p)
	if err != nil {
		return err
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
			return remoteCommand(dep, cfg, session, p.TmuxPath, o)
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
	logPath := dep.logPath(cfg.RemotePort)
	fmt.Printf("run: %s\n", displayCommand(dep, cfg, o))
	fmt.Printf("     started by this launcher over SSH and stopped when it exits — tmux and its sessions keep running\n")
	fmt.Printf("     webtmux's log on the target: %s\n", logPath)
	fmt.Println(tunnelLine(cfg.LocalPort, cfg.RemotePort, "if it drops, the launcher reconnects and starts webtmux again"))
	fmt.Printf("url: %s\n", cfg.url())
	if o.auth {
		// Chrome dropped http://user:pass@host URLs, so the credential cannot
		// ride in the link — it has to be printed for the user to paste.
		fmt.Printf("login: %s\n", loginLine("webtmux:"+cfg.Password))
	}
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
func remoteCommand(dep *deployment, cfg *targetConfig, session string, tmuxPath string, o *options) string {
	var b strings.Builder
	// Put tmux's directory on PATH rather than threading its absolute path
	// through. The attach script calls bare `tmux`, and so does webtmux's own
	// layout controller (pkg/tmux: exec.Command("tmux", …)) — and the remote
	// command runs in a non-interactive shell whose PATH never saw the user's rc
	// files. One PATH prefix fixes both without either of them knowing.
	if dir := path.Dir(tmuxPath); tmuxPath != "" && dir != "." && dir != "/" {
		fmt.Fprintf(&b, "PATH=%s:$PATH ", shellQuote(dir))
	}
	fmt.Fprintf(&b, "WEBTMUX_SESSION=%s ", shellQuote(session))
	if o.auth {
		// When a credential is passed it goes through the environment, never
		// -c user:pass, which is visible in ps to every user on that machine.
		fmt.Fprintf(&b, "GOTTY_CREDENTIAL=%s ", shellQuote("webtmux:"+cfg.Password))
	}
	fmt.Fprintf(&b, "%s -w -a 127.0.0.1 -p %d --url-path %s --reconnect ",
		shellQuote(dep.BinaryPath), cfg.RemotePort, shellQuote(cfg.urlPath()))
	if !o.auth {
		b.WriteString("--no-auth ")
	}
	b.WriteString(shellQuote(dep.AttachPath))
	for _, a := range o.tmuxArgs {
		b.WriteString(" " + shellQuote(a))
	}
	return tieToConnection(b.String(), dep.logPath(cfg.RemotePort))
}

// displayCommand is the webtmux invocation as the user should read it: the
// binary and its arguments, without the environment plumbing and the
// connection-tying wrapper around it — and never a credential.
func displayCommand(dep *deployment, cfg *targetConfig, o *options) string {
	parts := []string{dep.BinaryPath, "-w", "-a", "127.0.0.1", "-p", fmt.Sprint(cfg.RemotePort),
		"--url-path", cfg.urlPath(), "--reconnect"}
	if !o.auth {
		parts = append(parts, "--no-auth")
	}
	parts = append(parts, dep.AttachPath)
	parts = append(parts, o.tmuxArgs...)
	return strings.Join(parts, " ")
}

// tunnelLine says how the browser reaches webtmux and what keeps that working.
func tunnelLine(local, remote int, onDrop string) string {
	return fmt.Sprintf("tunnel: 127.0.0.1:%d on this machine -> 127.0.0.1:%d on the target, over its own SSH connection;\n"+
		"        checked every %ds — %s", local, remote, int(defaultHealthEvery.Seconds()), onDrop)
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
//
// webtmux's own output goes to logPath on the target, not back over the
// connection: it logs every request, which buried the launcher's own lines in
// the console. When it exits non-zero the log's tail is replayed on stderr, so a
// startup failure still reaches the user — and the supervisor's port-collision
// check, which reads that stderr, still sees "address already in use".
func tieToConnection(cmd, logPath string) string {
	log := shellQuote(logPath)
	return "mkdir -p " + shellQuote(path.Dir(logPath)) + "; exec 3<&0; { " + cmd + " >" + log + " 2>&1 & } ; p=$!; " +
		"{ cat <&3 >/dev/null; kill -TERM $p 2>/dev/null; } & r=$!; " +
		"wait $p; ec=$?; kill $r 2>/dev/null; " +
		"[ $ec -eq 0 ] || [ $ec -eq 143 ] || tail -n 20 " + log + " >&2; exit $ec"
}

// adopt connects to the webtmux that is already running. It skips deploy,
// session creation and launch entirely — the launcher's whole job becomes the
// tunnel plus the browser, and teardown removes only our own tunnel. Getting
// that backwards would destroy the very persistence the user set up.
func adopt(ctx context.Context, o *options, ssh *sshRunner, p *probe, cfg *targetConfig, inst *instance) error {
	// The build comparison is BEST EFFORT and never blocks adoption. Adopting is
	// step 1 of the priority order and must stay the cheap path: if no source is
	// configured, or the release is unreachable, the right answer is to say the
	// build is unknown and carry on connecting — not to fail on the way to a
	// process that is already running perfectly well.
	//
	// It needs only Source.Digest, so even when it does run it never pulls 12 MB
	// and never reads the local binary.
	digest, srcDesc, err := bestEffortDigest(o, p)
	match := ""
	switch {
	case err != nil:
		match = "not compared (" + err.Error() + ")"
	case inst.ExeSHA == "":
		match = "unknown (could not read /proc/" + fmt.Sprint(inst.PID) + "/exe)"
	case inst.ExeSHA == digest:
		match = "matches " + srcDesc + " " + short12(digest)
	case inst.Containerized:
		match = "not the " + srcDesc + " binary (" + short12(digest) + "), as expected for a container's own build — informational, nothing to do"
	default:
		match = "not the " + srcDesc + " binary (" + short12(digest) + ") — informational; it is connected to as-is (--fresh starts the release build instead)"
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
	fmt.Printf("run: nothing started — using the webtmux already running (pid %d), which keeps running after the launcher exits\n", inst.PID)
	fmt.Println(tunnelLine(cfg.LocalPort, cfg.RemotePort, "if it drops, the launcher reconnects"))
	fmt.Printf("url: %s\n", url)

	sup := &supervisor{
		ssh:       ssh,
		local:     cfg.LocalPort,
		remote:    cfg.RemotePort,
		url:       url,
		out:       os.Stdout,
		noBrowser: o.noBrowser || (inst.needsCredential() && !inst.credentialRecoverable()),
		// nil remoteCmd => a bare `ssh -N -L …` forward on the tunnel's own
		// connection. The adopted webtmux is the user's long-lived process and
		// must outlive us, so nothing runs on the remote side at all.
		remoteCmd: nil,
	}
	if sup.noBrowser && inst.needsCredential() && !inst.credentialRecoverable() {
		fmt.Println("not opening a browser: that instance wants a password we cannot recover, and the URL would just 401")
	}
	return sup.run(ctx)
}

// bestEffortDigest answers "what would this launcher install?" without ever
// being a reason to fail. Used only to annotate an adoption.
func bestEffortDigest(o *options, p *probe) (digest, describe string, err error) {
	src, _, err := resolveSource(o, os.Getenv, filepath.Join(homeDir(), ".cache", "webtmux-launch"))
	if err != nil {
		return "", "", err
	}
	d, err := src.Digest(p.Platform)
	if err != nil {
		return "", "", err
	}
	return d, src.Kind(), nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
