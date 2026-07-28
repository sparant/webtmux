package main

// Content-addressed deploy: resolve from the configured source, then install to
// ~/.cache/webtmux/webtmux-<sha256[:12]> on the target.
//
// Order matters — digest before transfer. Source.Digest is a few hundred bytes
// over HTTP, or one local sha256; the binary is ~12 MB. So: digest, derive the
// install path from it, check whether that path is already there (answered from
// the probe's directory listing, at no extra round trip), and only then read and
// push the bytes.
//
// Three properties come free from naming the install path after its content:
// "is a copy needed?" is a plain existence check with no version parsing;
// ETXTBSY is structurally impossible, because a new build never writes over the
// path a running binary was exec'd from; and multiple versions coexist.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"path"
	"strings"
)

// keepCacheEntries is how many deployed binaries to leave on the target. A dev
// loop produces a new sha per build, so without pruning the cache grows ~12 MB
// per rebuild.
const keepCacheEntries = 3

type deployment struct {
	Digest     string
	CacheDir   string // <home>/.cache/webtmux
	BinaryPath string // <cache>/webtmux-<sha12>
	AttachPath string // <cache>/attach-<sha12 of the script>.sh
	Copied     bool   // a transfer actually happened
	AttachSent bool
}

func cacheDir(home string) string { return path.Join(home, ".cache", "webtmux") }

// plan computes what the install would look like. No SSH, no transfer.
func planDeploy(p *probe, digest string) *deployment {
	dir := cacheDir(p.Home)
	scriptSum := sha256.Sum256([]byte(attachScript))
	return &deployment{
		Digest:     digest,
		CacheDir:   dir,
		BinaryPath: path.Join(dir, "webtmux-"+short12(digest)),
		AttachPath: path.Join(dir, "attach-"+hex.EncodeToString(scriptSum[:])[:12]+".sh"),
	}
}

// deploy pushes whatever is missing. It is a no-op — one existence check
// against the probe listing, no reads of the binary at all — when the target
// already has this exact build, which is the common case on a repeat launch and
// on a rebuild-free dev iteration.
func (d *deployment) run(ctx context.Context, r *sshRunner, p *probe, src Source, force bool) error {
	needBinary := force || !p.hasCached(path.Base(d.BinaryPath))
	needAttach := force || !p.hasCached(path.Base(d.AttachPath))

	if needBinary {
		rc, err := src.Open(p.Platform)
		if err != nil {
			return err
		}
		blob, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return fmt.Errorf("reading %s: %v", src.Location(p.Platform), err)
		}
		// Verify before transfer, never after. For a release that catches a
		// corrupt or truncated download on this machine rather than remotely.
		// For a local source it catches the file being rewritten by a
		// concurrent `make cross-compile` BETWEEN the digest and the read — a
		// genuinely likely race in a dev loop, and one that would otherwise
		// install a binary under the wrong sha and poison the content-addressed
		// cache for every later run.
		got := sha256.Sum256(blob)
		if hex.EncodeToString(got[:]) != d.Digest {
			return fmt.Errorf("%s changed under us: expected sha %s, got %s\n(a concurrent build? re-run)",
				src.Location(p.Platform), short12(d.Digest), short12(hex.EncodeToString(got[:])))
		}
		if err := d.push(ctx, r, d.BinaryPath, blob, "755"); err != nil {
			return fmt.Errorf("deploying webtmux: %v", err)
		}
		d.Copied = true
	}

	if needAttach {
		if err := d.push(ctx, r, d.AttachPath, []byte(attachScript), "755"); err != nil {
			return fmt.Errorf("deploying the attach script: %v", err)
		}
		d.AttachSent = true
	}
	return nil
}

// push streams bytes to a temp path in the destination directory, then chmods
// and atomically renames. Same directory means same filesystem, so the rename
// cannot fail across devices.
func (d *deployment) push(ctx context.Context, r *sshRunner, dest string, blob []byte, mode string) error {
	// $$ (the remote shell's pid) is appended outside the quotes so it still
	// expands while a $HOME containing spaces stays safe.
	tmp := shellQuote(path.Join(path.Dir(dest), ".tmp-"+path.Base(dest)+".")) + "$$"
	cmd := fmt.Sprintf("set -e; mkdir -p %s; cat > %s; chmod %s %s; mv -f %s %s",
		shellQuote(path.Dir(dest)), tmp, mode, tmp, tmp, shellQuote(dest))
	_, err := r.RunWithStdin(ctx, cmd, bytes.NewReader(blob))
	return err
}

// setupCommand is the one-shot SSH command run during setup, before webtmux
// starts: create the base session detached, then prune the cache.
//
// -d creates the session DETACHED, so it belongs to the tmux server daemon from
// the moment it exists — not to any client, not to webtmux, not to the SSH
// process tree. tmux double-forks and reparents to init, so the session
// survives an SSH disconnect by design. Doing this as its own step (rather than
// relying on -A inside the supervised child) means the session's durability
// never depends on anything the supervised process does.
func (d *deployment) setupCommand(tmuxPath, session string) string {
	tmuxq := shellQuote(tmuxPath)
	var b strings.Builder
	fmt.Fprintf(&b, "set -e; %s has-session -t %s 2>/dev/null || %s new-session -d -s %s\n",
		tmuxq, shellQuote("="+session), tmuxq, shellQuote(session))
	b.WriteString(d.pruneCommand())
	return b.String()
}

// pruneCommand keeps the N most recent cache entries by mtime, regardless of
// which source deployed them, and never deletes the entries this run is using.
// Retention must not assume the running binary is among the newest: adopt mode
// can be attached to something much older.
//
// Written without xargs -r, which is GNU-only — the targets include darwin and
// freebsd.
func (d *deployment) pruneCommand() string {
	return fmt.Sprintf(`(cd %s 2>/dev/null || exit 0
for pfx in webtmux- attach-; do
  ls -t 2>/dev/null | grep "^$pfx" | tail -n +%d | while read -r f; do
    [ "$f" = %s ] || [ "$f" = %s ] || rm -f -- "$f"
  done
done) || true`,
		shellQuote(d.CacheDir), keepCacheEntries+1,
		shellQuote(path.Base(d.BinaryPath)), shellQuote(path.Base(d.AttachPath)))
}
