package webtty

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Unit tests for transfer.go — the path rules behind uploading and downloading
// whole files.
//
// These are not tests about formatting. A file transfer is an arbitrary read and
// an arbitrary write on the machine tmux runs on, offered to whoever can open the
// web UI, and the only thing standing between that and the rest of the filesystem
// is the containment allowlist these functions consult. So the cases that matter
// are the ones where somebody is TRYING: a `..` in a browser-supplied folder
// path, a symlink sitting in an allowed directory and pointing out of it, an
// absolute path typed straight into the box.

// transferEnvFor builds an env whose only root is `dir`, which is what makes
// "outside the allowlist" testable: WEBTMUX_SAVE_DIR names it, and the container
// flag keeps the process's own home and cwd from quietly joining the root list
// (see saveRoots).
func transferEnvFor(t *testing.T, dir string) SaveEnv {
	t.Helper()
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")
	t.Setenv("WEBTMUX_SAVE_DIR", dir)
	t.Setenv("WEBTMUX_HOME", dir)
	t.Setenv("WEBTMUX_PATH_MAP", "")
	return TransferEnv("", dir)
}

func writeFile(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// ---- the source of a download ----------------------------------------------------

func TestResolveTransferSourceAcceptsFileAndFolder(t *testing.T) {
	dir := t.TempDir()
	env := transferEnvFor(t, dir)
	writeFile(t, filepath.Join(dir, "build.log"), "hello")
	if err := os.MkdirAll(filepath.Join(dir, "out"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, isDir, err := ResolveTransferSource(env, filepath.Join(dir, "build.log"))
	if err != nil || isDir {
		t.Fatalf("file: got (%q, %v, %v)", got, isDir, err)
	}

	// A folder is a legitimate answer, not an error — it downloads as a zip. This
	// is the one place a transfer deliberately disagrees with a save, which
	// refuses a directory outright.
	got, isDir, err = ResolveTransferSource(env, filepath.Join(dir, "out"))
	if err != nil || !isDir {
		t.Fatalf("folder: got (%q, %v, %v)", got, isDir, err)
	}
}

func TestResolveTransferSourceRefusesOutsideTheAllowlist(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir() // exists, is readable, and is nobody's declared root
	env := transferEnvFor(t, dir)
	secret := writeFile(t, filepath.Join(outside, "secret"), "shh")

	_, _, err := ResolveTransferSource(env, secret)
	if err == nil {
		t.Fatal("an absolute path outside the roots was accepted")
	}
	// The refusal has to name what IS reachable: "outside the allowed folders" is
	// unactionable when the reader cannot see which ones those are.
	if !strings.Contains(err.Error(), dir) {
		t.Errorf("refusal does not name the reachable folder: %v", err)
	}
	if !strings.Contains(err.Error(), "read") {
		t.Errorf("a download refusal should talk about reading, not writing: %v", err)
	}
}

// The interesting one: the path IS inside an allowed directory. Only following
// the symlink shows that what it names is not.
func TestResolveTransferSourceRefusesSymlinkOutOfTheAllowlist(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	env := transferEnvFor(t, dir)
	secret := writeFile(t, filepath.Join(outside, "secret"), "shh")

	link := filepath.Join(dir, "innocent.txt")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, _, err := ResolveTransferSource(env, link); err == nil {
		t.Fatal("a symlink pointing out of the allowlist was accepted")
	}
}

func TestResolveTransferSourceRefusesIrregularFiles(t *testing.T) {
	dir := t.TempDir()
	env := transferEnvFor(t, dir)
	// A unix socket rather than a fifo only because net can make one in pure Go;
	// the rule under test covers both. Not pedantry either way: opening a fifo
	// blocks until a writer appears, and reading a socket file is meaningless —
	// from the browser both look exactly like a download that hung.
	sock := filepath.Join(dir, "a.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Skipf("cannot create a unix socket here: %v", err)
	}
	defer ln.Close()

	_, _, err = ResolveTransferSource(env, sock)
	if err == nil {
		t.Fatal("a socket was accepted as a transfer source")
	}
	if !strings.Contains(err.Error(), "socket") {
		t.Errorf("the refusal should say what it is: %v", err)
	}
}

func TestResolveTransferSourceReportsAMissingPathPerMachine(t *testing.T) {
	dir := t.TempDir()
	env := transferEnvFor(t, dir)
	_, _, err := ResolveTransferSource(env, filepath.Join(dir, "nope"))
	if err == nil {
		t.Fatal("a missing source was accepted")
	}
	// The container trap: the user is looking at a shell in a directory that
	// plainly exists, so the message must say WHICH machine is missing it.
	if !strings.Contains(err.Error(), "container") {
		t.Errorf("missing-source message does not explain the two filesystems: %v", err)
	}
}

// ---- the destination of an upload ------------------------------------------------

func TestResolveTransferDestWantsAnExistingFolder(t *testing.T) {
	dir := t.TempDir()
	env := transferEnvFor(t, dir)

	if _, err := ResolveTransferDest(env, dir); err != nil {
		t.Fatalf("the declared directory was refused: %v", err)
	}
	// An upload names a place to PUT things. A directory webtmux would have to
	// invent is not one the user has looked at and decided on.
	if _, err := ResolveTransferDest(env, filepath.Join(dir, "not-there")); err == nil {
		t.Error("a nonexistent destination was accepted")
	}
	writeFile(t, filepath.Join(dir, "afile"), "x")
	if _, err := ResolveTransferDest(env, filepath.Join(dir, "afile")); err == nil {
		t.Error("a plain file was accepted as a destination folder")
	} else if !strings.Contains(err.Error(), "is a file, not a folder") {
		t.Errorf("a file destination should say so plainly: %v", err)
	}
}

// ---- the name a browser supplies for each uploaded file --------------------------

func TestUploadRelNameRefusesEscapes(t *testing.T) {
	// Every one of these is a way out of the folder the user chose. None of them
	// is something a browser produces by accident, so each is refused rather than
	// repaired — a caller that meant something by `..` should be told no, not
	// quietly handed a different destination.
	for _, bad := range []string{
		"../escape.txt",
		"a/../../escape.txt",
		`..\escape.txt`,      // a Windows-shaped escape, after backslash folding
		`a\..\..\escape.txt`, //
		"C:/Windows/x.txt",   // a drive letter is not a relative path by any reading
		"",
		"   ",
		".",
		"./",
	} {
		if got, err := uploadRelName(bad); err == nil {
			t.Errorf("uploadRelName(%q) = %q, want a refusal", bad, got)
		}
	}
}

func TestUploadRelNameKeepsFolderShape(t *testing.T) {
	// The whole point of a folder upload: the tree arrives as a tree. Flattening
	// it to basenames would silently merge every src/index.js in the selection.
	for in, want := range map[string]string{
		"report.txt":            "report.txt",
		"src/lib/util.js":       "src/lib/util.js",
		`src\lib\util.js`:       "src/lib/util.js", // dragged from a Windows browser
		"/leading/slash.txt":    "leading/slash.txt",
		"./src/./a.js":          "src/a.js",
		"deep//double//sep.txt": "deep/double/sep.txt",
	} {
		got, err := uploadRelName(in)
		if err != nil {
			t.Errorf("uploadRelName(%q) refused: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("uploadRelName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestResolveUploadTargetBuildsTheTreeInsideTheDestination(t *testing.T) {
	dir := t.TempDir()
	env := transferEnvFor(t, dir)

	got, err := ResolveUploadTarget(env, dir, "src/lib/util.js")
	if err != nil {
		t.Fatalf("refused: %v", err)
	}
	want := filepath.Join(dir, "src", "lib", "util.js")
	if got != want {
		t.Fatalf("target = %q, want %q", got, want)
	}
	// The intermediate directories must exist by now: the caller streams straight
	// into the returned path and has nowhere to create them.
	if !dirExists(filepath.Dir(want)) {
		t.Error("the parent directories were not created")
	}
}

// String cleaning alone cannot catch this one: "logs/x" contains no `..` and is
// perfectly relative, but a symlink already sitting in the destination sends it
// somewhere else entirely. Only a containment check AFTER the directories are
// resolved can tell.
func TestResolveUploadTargetRefusesASymlinkedSubdirectory(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	env := transferEnvFor(t, dir)

	if err := os.Symlink(outside, filepath.Join(dir, "logs")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := ResolveUploadTarget(env, dir, "logs/passwd"); err == nil {
		t.Fatal("an upload through a symlinked subdirectory was accepted")
	}
	if _, err := os.Stat(filepath.Join(outside, "passwd")); err == nil {
		t.Fatal("the refused upload created a file outside the allowlist anyway")
	}
}

// ---- walking a folder for a zip --------------------------------------------------

func TestWalkTransferDirNamesWhatItLeavesOut(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "project")
	writeFile(t, filepath.Join(src, "a.txt"), "a")
	writeFile(t, filepath.Join(src, "nested", "b.txt"), "b")
	if err := os.Symlink("/etc/passwd", filepath.Join(src, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	entries, skipped, err := WalkTransferDir(src)
	if err != nil {
		t.Fatal(err)
	}
	// Archive names begin with the folder's own name, so unzipping produces ONE
	// folder instead of scattering files into whatever directory you were in.
	var names []string
	for _, e := range entries {
		names = append(names, e.Name)
	}
	for _, want := range []string{"project/a.txt", "project/nested/b.txt"} {
		if !contains(names, want) {
			t.Errorf("entry %q missing from %v", want, names)
		}
	}
	// Following it would turn "download this folder" into "download /etc/passwd".
	for _, n := range names {
		if strings.HasSuffix(n, "link") {
			t.Errorf("a symlink was archived: %v", names)
		}
	}
	// Skipping silently is the real failure: an archive quietly missing things is
	// what nobody thinks to check.
	if len(skipped) != 1 || !strings.Contains(skipped[0], "symlink") {
		t.Errorf("skipped = %v, want the symlink named", skipped)
	}
}

func contains(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}
