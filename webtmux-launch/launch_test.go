package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRemoteCommandShape(t *testing.T) {
	p := &probe{Home: "/home/dev", Platform: "linux-amd64", TmuxPath: "/usr/bin/tmux"}
	dep := planDeploy(p, strings.Repeat("a", 64))
	cfg := &targetConfig{LocalPort: 1234, RemotePort: 9999, Secret: "s3cr3t"}
	cmd := remoteCommand(dep, cfg, "main", "/usr/local/bin/tmux", &options{})

	// WEBTMUX_SESSION is not optional: detectTmuxSession() parses -s/-t out of
	// argv only when the command IS tmux, and a wrapper script hides them, so
	// without it the sidebar controller targets the literal session "0".
	if !strings.Contains(cmd, "WEBTMUX_SESSION='main' ") {
		t.Errorf("command must export WEBTMUX_SESSION: %s", cmd)
	}
	// The command must be the attach script, never tmux directly — split-view
	// depends on the wrapper reading HTTP_WEBTMUX_SESSION.
	if !strings.Contains(cmd, "'"+dep.AttachPath+"' &") {
		t.Errorf("webtmux's command must be the attach script: %s", cmd)
	}
	// And the whole thing must be tied to the connection: without the stdin
	// watcher the remote webtmux outlives every launcher exit (sshd does not
	// SIGHUP a tty-less remote command), holds the remote port, and the FIRST
	// RECONNECT fails — a failure that looks like success on the first launch.
	// exec 3<&0 is the load-bearing part: a non-interactive shell reassigns a
	// background list's stdin to /dev/null, so a reader that did not save the
	// channel first would EOF instantly and kill webtmux at startup.
	for _, want := range []string{"exec 3<&0", "cat <&3 >/dev/null", "kill -TERM $p", "wait $p"} {
		if !strings.Contains(cmd, want) {
			t.Errorf("remote command is not tied to the connection (%q missing): %s", want, cmd)
		}
	}
	for _, want := range []string{"'" + dep.BinaryPath + "'", "-a 127.0.0.1", "-p 9999", "--path '/s3cr3t/'", "--no-auth", "--reconnect", "-w"} {
		if !strings.Contains(cmd, want) {
			t.Errorf("command lacks %q: %s", want, cmd)
		}
	}
	// tmux's directory goes on PATH: the attach script calls bare `tmux`, and so
	// does webtmux's own layout controller — and the remote command runs in a
	// non-interactive shell whose PATH never saw the user's rc files.
	if !strings.Contains(cmd, "PATH='/usr/local/bin':$PATH") {
		t.Errorf("tmux's directory is not on PATH: %s", cmd)
	}
	// WEBTMUX_SOCKET must stay unset — empty means tmux's default socket, which
	// is what a native install wants.
	if strings.Contains(cmd, "WEBTMUX_SOCKET") {
		t.Errorf("native installs must not set WEBTMUX_SOCKET: %s", cmd)
	}
}

// With --auth the credential goes through the environment, NEVER -c user:pass,
// which is visible in ps to every user on that machine.
func TestAuthModeUsesEnvNotArgv(t *testing.T) {
	p := &probe{Home: "/home/dev"}
	dep := planDeploy(p, strings.Repeat("b", 64))
	cfg := &targetConfig{LocalPort: 1, RemotePort: 2, Secret: "urlsecret", Password: "pw"}
	cmd := remoteCommand(dep, cfg, "main", "/usr/bin/tmux", &options{auth: true})
	if strings.Contains(cmd, "-c ") || strings.Contains(cmd, "--credential") {
		t.Errorf("credential must not appear in argv: %s", cmd)
	}
	if !strings.Contains(cmd, "GOTTY_CREDENTIAL='webtmux:pw'") {
		t.Errorf("credential should ride the environment: %s", cmd)
	}
	// The password must not BE the secret path: whoever learns the URL would
	// then already have the password, and basic auth would add nothing on the
	// shared box it exists for.
	if strings.Contains(cmd, "webtmux:urlsecret") {
		t.Errorf("password reuses the secret path: %s", cmd)
	}
	if strings.Contains(cmd, "--no-auth") {
		t.Errorf("--auth must not also pass --no-auth: %s", cmd)
	}
}

func TestTrailingArgsReachTheAttachScript(t *testing.T) {
	dep := planDeploy(&probe{Home: "/h"}, strings.Repeat("c", 64))
	cfg := &targetConfig{Secret: "x"}
	cmd := remoteCommand(dep, cfg, "main", "/usr/bin/tmux", &options{tmuxArgs: []string{"htop", "-d", "5"}})
	if !strings.Contains(cmd, "'htop' '-d' '5' &") {
		t.Errorf("trailing args lost: %s", cmd)
	}
}

func TestContentAddressedPaths(t *testing.T) {
	p := &probe{Home: "/home/dev"}
	digest := strings.Repeat("f", 64)
	dep := planDeploy(p, digest)
	if dep.BinaryPath != "/home/dev/.cache/webtmux/webtmux-"+digest[:12] {
		t.Errorf("binary path = %s", dep.BinaryPath)
	}
	// The attach script is addressed by its OWN content, so editing it
	// redeploys even when the binary has not changed.
	if !strings.HasPrefix(filepath.Base(dep.AttachPath), "attach-") || !strings.HasSuffix(dep.AttachPath, ".sh") {
		t.Errorf("attach path = %s", dep.AttachPath)
	}
	other := planDeploy(p, strings.Repeat("e", 64))
	if other.AttachPath != dep.AttachPath {
		t.Errorf("attach path must not depend on the binary sha")
	}
	// A different build gets a different path, which is what makes ETXTBSY
	// structurally impossible.
	if other.BinaryPath == dep.BinaryPath {
		t.Errorf("different digests collided on %s", dep.BinaryPath)
	}
}

func TestPruneKeepsCurrentAndNewest(t *testing.T) {
	dep := planDeploy(&probe{Home: "/home/dev"}, strings.Repeat("a", 64))
	cmd := dep.pruneCommand()
	if !strings.Contains(cmd, "tail -n +4") {
		t.Errorf("retention is not 3 entries: %s", cmd)
	}
	if !strings.Contains(cmd, filepath.Base(dep.BinaryPath)) || !strings.Contains(cmd, filepath.Base(dep.AttachPath)) {
		t.Errorf("prune does not exempt the entries in use: %s", cmd)
	}
	// xargs -r is GNU-only and the targets include darwin and freebsd.
	if strings.Contains(cmd, "xargs") {
		t.Errorf("prune must stay portable: %s", cmd)
	}
}

func TestSetupCreatesSessionDetached(t *testing.T) {
	dep := planDeploy(&probe{Home: "/h"}, strings.Repeat("a", 64))
	cmd := dep.setupCommand("/usr/bin/tmux", "main")
	// -d is what makes the session belong to the tmux server daemon rather than
	// to any client, webtmux, or the SSH process tree.
	if !strings.Contains(cmd, "new-session -d -s 'main'") {
		t.Errorf("session must be created detached: %s", cmd)
	}
	if !strings.Contains(cmd, "has-session -t '=main'") {
		t.Errorf("existence check should be exact-match (=name): %s", cmd)
	}
}

func TestChooseSession(t *testing.T) {
	if got := chooseSession("", nil); got != "main" {
		t.Errorf("no sessions: %s", got)
	}
	// With exactly one existing session, prefer it: the box has already told us
	// what it calls things.
	if got := chooseSession("", []string{"services"}); got != "services" {
		t.Errorf("single session: %s", got)
	}
	if got := chooseSession("", []string{"a", "b"}); got != "main" {
		t.Errorf("ambiguous: %s", got)
	}
	if got := chooseSession("pick", []string{"a"}); got != "pick" {
		t.Errorf("--session ignored: %s", got)
	}
}

func TestAttachScriptKeepsSplitViewAndUTF8(t *testing.T) {
	// Mode 1 IS split-view: a grouped session sharing the base's window list.
	if !strings.Contains(attachScript, "HTTP_WEBTMUX_SESSION") {
		t.Error("attach script no longer reads the injected session header")
	}
	if !strings.Contains(attachScript, `new-session -t "$BASE" -s "$NAME"`) {
		t.Error("grouped-session attach (mode 1) is missing — split-view would silently mirror regions")
	}
	if !strings.Contains(attachScript, "destroy-unattached on") {
		t.Error("grouped regions must be disposable")
	}
	if !strings.Contains(attachScript, "new-session -A -s") {
		t.Error("mode 2 must be atomic attach-or-create")
	}
	// tmux flags the client utf8=0 in a POSIX locale and downgrades every wide
	// glyph it sends to the browser; that is a server->client downgrade no
	// client-side font change can fix.
	if !strings.Contains(attachScript, "C.UTF-8") || strings.Count(attachScript, "tmux -u") < 2 {
		t.Error("the UTF-8 guards (locale exports + tmux -u) are not both present")
	}
	// A native install wants tmux's default socket, not the container's.
	if strings.Contains(attachScript, "/host-tmux/") {
		t.Error("container socket default leaked into the native attach script")
	}
	if strings.Contains(attachScript, "WEBTMUX_GROUPED") {
		t.Error("the legacy all-grouped mode should be gone")
	}
}

func TestBinaryPlatformSniffing(t *testing.T) {
	// Build a minimal ELF header by hand: aarch64, little endian.
	hdr := make([]byte, 64)
	copy(hdr, []byte{0x7f, 'E', 'L', 'F', 2, 1, 1})
	hdr[16], hdr[17] = 2, 0       // e_type EXEC
	hdr[18], hdr[19] = 0xB7, 0x00 // e_machine aarch64
	dir := t.TempDir()
	p := filepath.Join(dir, "webtmux")
	if err := os.WriteFile(p, hdr, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := binaryPlatform(p)
	if err != nil {
		t.Fatal(err)
	}
	if got != "linux-arm64" {
		t.Fatalf("sniffed %q", got)
	}
	// A wrong-arch --webtmux-binary is refused locally, before any transfer.
	if err := checkBinaryArch(p, "linux-amd64"); err == nil {
		t.Fatal("expected a refusal for an arm64 binary against an amd64 target")
	} else if !strings.Contains(err.Error(), "arm64") || !strings.Contains(err.Error(), "linux-amd64") {
		t.Errorf("error must name both architectures: %v", err)
	}
	if err := checkBinaryArch(p, "linux-arm64"); err != nil {
		t.Errorf("matching arch refused: %v", err)
	}
	// Something that is not a recognised executable never blocks a deliberate
	// deploy.
	sh := filepath.Join(dir, "wrapper.sh")
	os.WriteFile(sh, []byte("#!/bin/sh\necho hi\n"), 0o755)
	if err := checkBinaryArch(sh, "linux-amd64"); err != nil {
		t.Errorf("unknown format should not be refused: %v", err)
	}
}

func TestConfigPathSanitisesTarget(t *testing.T) {
	got := filepath.Base(configPath("dev@box.example.com"))
	if strings.ContainsAny(got, "@/") {
		t.Errorf("unsafe filename: %s", got)
	}
	if !strings.HasSuffix(got, ".json") {
		t.Errorf("bad suffix: %s", got)
	}
}

func TestTargetConfigReusesStoredValues(t *testing.T) {
	c := &targetConfig{path: filepath.Join(t.TempDir(), "t.json")}
	if err := c.ensure(0, 0); err != nil {
		t.Fatal(err)
	}
	first := *c
	if len(c.Secret) != 32 {
		t.Errorf("secret length %d", len(c.Secret))
	}
	if err := c.save(); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(c.path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Errorf("config mode %v — the secret is shell-equivalent", st.Mode().Perm())
	}
	// A second run must reuse the URL, so an already-open browser tab revives
	// through its own --reconnect loop.
	c2 := loadTargetConfigFrom(c.path)
	if err := c2.ensure(0, 0); err != nil {
		t.Fatal(err)
	}
	if c2.Secret != first.Secret || c2.RemotePort != first.RemotePort {
		t.Errorf("ports/secret not stable across runs: %+v vs %+v", c2, first)
	}
}

func TestIsPortCollision(t *testing.T) {
	if !isPortCollision("listen tcp 127.0.0.1:8080: bind: address already in use") {
		t.Error("missed the common form")
	}
	if isPortCollision("Connection closed by remote host") {
		t.Error("false positive")
	}
}
