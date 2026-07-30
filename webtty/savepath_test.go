package webtty

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The invariant worth testing here is not "filepath.Join works" — it's that a
// save NEVER silently targets a directory that doesn't exist on the machine
// doing the write, and that when the two filesystems disagree the user is told
// which one is missing what.

func TestPathMapRewritesOnBoundaries(t *testing.T) {
	maps := parsePathMap("/home/nathan/Projects=/workspace, /var/log=/logs")

	got, ok := applyPathMap(maps, "/home/nathan/Projects/webtmux/out.txt")
	if !ok || got != "/workspace/webtmux/out.txt" {
		t.Fatalf("prefix rewrite = %q (%v), want /workspace/webtmux/out.txt", got, ok)
	}
	// The prefix itself maps.
	if got, ok := applyPathMap(maps, "/home/nathan/Projects"); !ok || got != "/workspace" {
		t.Fatalf("bare prefix = %q (%v), want /workspace", got, ok)
	}
	// A path that merely STARTS WITH the same characters must not match — the
	// whole point of a prefix map is that it follows directory boundaries.
	if got, ok := applyPathMap(maps, "/home/nathan/Projects-old/x"); ok {
		t.Fatalf("boundary violation: /home/nathan/Projects-old/x mapped to %q", got)
	}
	// Unmapped paths pass through untouched.
	if got, ok := applyPathMap(maps, "/etc/hosts"); ok || got != "/etc/hosts" {
		t.Fatalf("unmapped = %q (%v), want /etc/hosts (false)", got, ok)
	}
}

func TestPathMapPrefersTheLongestMatch(t *testing.T) {
	maps := parsePathMap("/home=/h,/home/nathan/Projects=/workspace")
	got, _ := applyPathMap(maps, "/home/nathan/Projects/a.txt")
	if got != "/workspace/a.txt" {
		t.Fatalf("longest-match = %q, want /workspace/a.txt", got)
	}
}

func TestPathMapIgnoresMalformedEntries(t *testing.T) {
	// A typo'd mapping must degrade to "no mapping" rather than break saving.
	maps := parsePathMap("garbage,=/nowhere,/from=,/a=/b")
	if len(maps) != 1 || maps[0].from != "/a" || maps[0].to != "/b" {
		t.Fatalf("parsePathMap kept %+v, want only {/a /b}", maps)
	}
}

func TestRelativeSaveUsesTheBaseDir(t *testing.T) {
	dir := t.TempDir()
	env := SaveEnv{BaseDir: dir, PaneVisible: true, Home: dir}

	got, err := resolveSavePath(env, "out.txt")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != filepath.Join(dir, "out.txt") {
		t.Fatalf("resolved = %q, want %q", got, filepath.Join(dir, "out.txt"))
	}
}

func TestTildeExpandsToTheConfiguredHome(t *testing.T) {
	home := t.TempDir()
	env := SaveEnv{BaseDir: t.TempDir(), Home: home}

	got, err := resolveSavePath(env, "~/notes.txt")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != filepath.Join(home, "notes.txt") {
		t.Fatalf("resolved = %q, want %q", got, filepath.Join(home, "notes.txt"))
	}
}

// The bug this whole file exists for: tmux reports a host directory, webtmux is
// in a container and can't see it, and the user gets a bare open(2) error about
// a path that plainly exists in their own shell.
func TestMissingDirectoryIsExplainedNotJustReported(t *testing.T) {
	env := SaveEnv{
		PaneDir:   "/home/nathan/Projects",
		BaseDir:   t.TempDir(),
		Container: true,
	}
	_, err := resolveSavePath(env, "/home/nathan/Projects/services-13.txt")
	if err == nil {
		t.Fatal("expected an error for a directory that does not exist here")
	}
	msg := err.Error()
	for _, want := range []string{"/home/nathan/Projects", "container", env.BaseDir, "Download to browser"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error message is missing %q:\n  %s", want, msg)
		}
	}
}

func TestTypedHostPathIsMappedRatherThanFailing(t *testing.T) {
	server := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "/home/nathan/Projects="+server)

	env := SaveEnv{BaseDir: server, Home: server}
	got, err := resolveSavePath(env, "/home/nathan/Projects/out.txt")
	if err != nil {
		t.Fatalf("a mapped host path should resolve, got: %v", err)
	}
	if got != filepath.Join(server, "out.txt") {
		t.Fatalf("resolved = %q, want %q", got, filepath.Join(server, "out.txt"))
	}
}

func TestSaveToADirectoryIsRefusedWithAUsefulMessage(t *testing.T) {
	dir := t.TempDir()
	if _, err := resolveSavePath(SaveEnv{BaseDir: dir, Home: dir}, "."); err == nil {
		t.Fatal("saving onto a directory should fail")
	} else if !strings.Contains(err.Error(), "file name") {
		t.Fatalf("unhelpful message: %v", err)
	}
}

func TestEmptyPathIsRejected(t *testing.T) {
	if _, err := resolveSavePath(SaveEnv{BaseDir: t.TempDir()}, "   "); err == nil {
		t.Fatal("empty path should fail")
	}
}

func TestDescribeSaveEnvUsesThePaneDirWhenItIsVisible(t *testing.T) {
	pane := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", t.TempDir())

	env := describeSaveEnv(pane, "")
	if !env.PaneVisible || env.BaseDir != pane {
		t.Fatalf("visible pane dir should be the base: %+v", env)
	}
	if env.Mapped {
		t.Fatalf("no mapping was configured, but env reports one: %+v", env)
	}
	if !env.Writable {
		t.Fatalf("a temp dir should be writable: %+v", env)
	}
}

// The deployment default here: a container that mounts only the tmux socket. The
// image's own home is present and writable, so the tempting fallback is to write
// there — and report success for a file that dies with the container. It must
// refuse instead, and say what does work.
func TestContainerWithNoSharedDirectoryRefusesToSave(t *testing.T) {
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")

	env := describeSaveEnv("/home/nathan/Projects", "")
	if !env.Blocked || env.BaseDir != "" {
		t.Fatalf("expected a blocked env with no base dir, got %+v", env)
	}
	if env.Writable {
		t.Errorf("a blocked env cannot be writable: %+v", env)
	}
	for _, path := range []string{"out.txt", "~/out.txt", "./sub/out.txt"} {
		_, err := resolveSavePath(env, path)
		if err == nil {
			t.Fatalf("%q should be refused when nothing is shared", path)
		}
		for _, want := range []string{"Download to browser", "WEBTMUX_SAVE_DIR", "container"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("refusal for %q is missing %q:\n  %s", path, want, err)
			}
		}
	}
}

// The user can answer the question the operator didn't: they know which paths
// inside the container are mounted, and webtmux cannot.
func TestAUserChosenDirectoryUnblocksAContainer(t *testing.T) {
	mounted := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")

	env := describeSaveEnv("/home/nathan/Projects", mounted)
	if env.Blocked || env.Chosen != mounted || env.ChosenError != "" {
		t.Fatalf("a valid chosen dir should unblock saving: %+v", env)
	}
	got, err := resolveSavePath(env, "out.txt")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != filepath.Join(mounted, "out.txt") {
		t.Fatalf("resolved = %q, want it under %q", got, mounted)
	}
}

// The user's answer outranks the operator's default — it is the more specific
// and more recent statement of where THIS file should go.
func TestAUserChosenDirectoryOutranksTheConfiguredOne(t *testing.T) {
	configured, chosen := t.TempDir(), t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", configured)
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")

	env := describeSaveEnv("/nowhere/visible", chosen)
	if env.BaseDir != chosen {
		t.Fatalf("BaseDir = %q, want the user's choice %q", env.BaseDir, chosen)
	}
}

// A directory that isn't there (a mount that went away, or a typo) must be
// REPORTED, never silently swapped for something else — that is precisely how a
// file ends up somewhere nobody thinks to look.
func TestABadChosenDirectoryIsReportedNotSubstituted(t *testing.T) {
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")

	for _, bad := range []string{"/definitely/not/mounted", "workspace"} {
		env := describeSaveEnv("/home/nathan/Projects", bad)
		if env.ChosenError == "" {
			t.Fatalf("%q should have been rejected: %+v", bad, env)
		}
		if env.Chosen != "" {
			t.Errorf("%q was rejected but still echoed as in force: %+v", bad, env)
		}
		if !env.Blocked {
			t.Errorf("%q was rejected, so there is still nowhere to save: %+v", bad, env)
		}
		if !strings.Contains(env.ChosenError, bad) {
			t.Errorf("the reason should name the directory: %s", env.ChosenError)
		}
	}
}

// `~` means a home on the machine the USER is thinking of. In a container it is
// the image's home — real, writable, and wrong — so it must refuse rather than
// resolve.
func TestTildeIsRefusedInAContainerWithNoDeclaredHome(t *testing.T) {
	mounted := t.TempDir()
	t.Setenv("WEBTMUX_HOME", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")

	env := describeSaveEnv("/home/nathan/Projects", mounted)
	if env.Home != "" {
		t.Fatalf("a container with no WEBTMUX_HOME has no ~: %+v", env)
	}
	_, err := resolveSavePath(env, "~/out.txt")
	if err == nil {
		t.Fatal("~ should be refused here")
	}
	// It must still point at what DOES work — the chosen directory is right there.
	if !strings.Contains(err.Error(), mounted) {
		t.Errorf("the refusal should name the directory that works: %s", err)
	}
}

// Declaring a shared directory is what unblocks it — that env var is the only
// signal webtmux has that a directory is reachable from outside the container.
func TestDeclaringASaveDirUnblocksAContainer(t *testing.T) {
	saves := filepath.Join(t.TempDir(), "saves")
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", saves)
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")

	env := describeSaveEnv("/home/nathan/Projects", "")
	if env.Blocked {
		t.Fatalf("WEBTMUX_SAVE_DIR should unblock saving: %+v", env)
	}
	got, err := resolveSavePath(env, "out.txt")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != filepath.Join(saves, "out.txt") {
		t.Fatalf("resolved = %q, want it under %q", got, saves)
	}
}

// Outside a container, webtmux and tmux share a filesystem, so the old fallback
// (the server's own home) is a real place and must survive.
func TestOutsideAContainerAnInvisiblePaneDirStillFallsBack(t *testing.T) {
	home := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	t.Setenv("WEBTMUX_IN_CONTAINER", "0")
	t.Setenv("WEBTMUX_HOME", home)

	env := describeSaveEnv("/definitely/not/here", "")
	if env.Blocked || env.BaseDir != home {
		t.Fatalf("expected a fallback to %q, got %+v", home, env)
	}
}

func TestDescribeSaveEnvFallsBackWhenThePaneDirIsInvisible(t *testing.T) {
	save := filepath.Join(t.TempDir(), "saves")
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", save)

	env := describeSaveEnv("/definitely/not/here", "")
	if env.PaneVisible {
		t.Fatal("a nonexistent pane dir must not be reported as visible")
	}
	if env.BaseDir != save {
		t.Fatalf("BaseDir = %q, want the configured save dir %q", env.BaseDir, save)
	}
	// WEBTMUX_SAVE_DIR is an instruction, so it is created rather than ignored.
	if st, err := os.Stat(save); err != nil || !st.IsDir() {
		t.Fatalf("WEBTMUX_SAVE_DIR was not created: %v", err)
	}
}

func TestDescribeSaveEnvReportsAMappedPaneDir(t *testing.T) {
	server := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "/home/nathan/Projects="+server)

	env := describeSaveEnv("/home/nathan/Projects", "")
	if !env.PaneVisible || !env.Mapped || env.BaseDir != server {
		t.Fatalf("mapping should make the pane dir visible: %+v", env)
	}
}

// The override has to stay LIVE (re-read, not baked into a sync.Once) — it now
// decides whether saving is refused, not just how a sentence reads, and the
// tests above depend on being able to flip it either way.
func TestContainerDetectionCanBeForcedEitherWay(t *testing.T) {
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")
	if !inContainer() {
		t.Fatal("WEBTMUX_IN_CONTAINER=1 should force true")
	}
	t.Setenv("WEBTMUX_IN_CONTAINER", "0")
	if inContainer() {
		t.Fatal("WEBTMUX_IN_CONTAINER=0 should force false")
	}
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")
	if !inContainer() {
		t.Fatal("the override must be re-read, not cached from the first call")
	}
}

// ---- containment ---------------------------------------------------------------
//
// Resolution says where a save lands; containment says whether that destination
// was ever on offer. The tests above assert what the resolver DOES; these assert
// what it must refuse — which is the half that was missing, and the half that
// turned "save this pane's buffer" into a write-anywhere primitive.

// saveEnvIn is the boring, fully-permitted environment: webtmux and tmux share a
// filesystem and the pane's own directory is the base.
func saveEnvIn(t *testing.T, dir string) SaveEnv {
	t.Helper()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	t.Setenv("WEBTMUX_IN_CONTAINER", "1") // no implicit $HOME/cwd roots — only `dir`
	t.Setenv("WEBTMUX_HOME", "")
	return SaveEnv{BaseDir: dir, PaneVisible: true, Container: true, Writable: true}
}

func TestTraversalOutOfTheBaseDirectoryIsRefused(t *testing.T) {
	base := t.TempDir()
	outside := t.TempDir()
	env := saveEnvIn(t, base)

	// `../` climbs out of the one directory that was shared. The parent EXISTS —
	// that is exactly why a dir-exists check alone never caught this.
	rel, err := filepath.Rel(base, filepath.Join(outside, "stolen.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := resolveSavePath(env, rel); err == nil {
		t.Fatalf("%q escaped the base directory", rel)
	} else if !strings.Contains(err.Error(), base) {
		t.Errorf("the refusal should name the directory that IS allowed: %v", err)
	}
}

func TestAbsolutePathsLoseTheirBypass(t *testing.T) {
	base := t.TempDir()
	env := saveEnvIn(t, base)

	// The old rule honored an absolute path "as typed". /etc exists and, for a
	// webtmux running as root (a container default), is writable.
	for _, path := range []string{"/etc/webtmux-owned.conf", "/tmp/anywhere.txt"} {
		if _, err := resolveSavePath(env, path); err == nil {
			t.Errorf("%q was accepted; an absolute path is not an authorization", path)
		}
	}
	// …and the same path INSIDE the allowed directory still works, so the rule is
	// containment and not a ban on absolute paths.
	got, err := resolveSavePath(env, filepath.Join(base, "fine.txt"))
	if err != nil {
		t.Fatalf("an absolute path inside the allowed directory must work: %v", err)
	}
	if got != filepath.Join(base, "fine.txt") {
		t.Errorf("resolved = %q", got)
	}
}

func TestTildeIsSubjectToContainment(t *testing.T) {
	base, home := t.TempDir(), t.TempDir()
	env := saveEnvIn(t, base)

	// A declared WEBTMUX_HOME is itself a root — someone named it.
	env.Home = home
	if _, err := resolveSavePath(env, "~/notes.txt"); err != nil {
		t.Fatalf("a declared home is a save destination: %v", err)
	}
	// But `~/../elsewhere` still leaves it.
	if _, err := resolveSavePath(env, "~/../elsewhere.txt"); err == nil {
		t.Error("~ must not be a way out of the allowlist either")
	}
}

// A symlink inside an allowed directory pointing out of it satisfies every
// string-prefix test ever written, which is why the check resolves it.
func TestASymlinkedParentCannotEscape(t *testing.T) {
	base, outside := t.TempDir(), t.TempDir()
	env := saveEnvIn(t, base)

	link := filepath.Join(base, "door")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := resolveSavePath(env, "door/out.txt"); err == nil {
		t.Error("a symlinked directory walked straight out of the allowlist")
	}
}

// …and the same for a symlink at the FILE, which os.WriteFile follows.
func TestASymlinkedTargetCannotEscape(t *testing.T) {
	base, outside := t.TempDir(), t.TempDir()
	env := saveEnvIn(t, base)

	target := filepath.Join(outside, "victim.txt")
	if err := os.WriteFile(target, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "out.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := resolveSavePath(env, "out.txt"); err == nil {
		t.Error("a symlinked target let the write land outside the allowlist")
	}
}

// Containment must not break the deployments the allowlist is built from.
func TestEveryDeclaredDirectoryIsAllowed(t *testing.T) {
	pane, configured, chosen := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", configured)
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")
	t.Setenv("WEBTMUX_HOME", "")

	env := SaveEnv{BaseDir: pane, Chosen: chosen, PaneVisible: true, Container: true}
	for _, dir := range []string{pane, configured, chosen} {
		if _, err := resolveSavePath(env, filepath.Join(dir, "out.txt")); err != nil {
			t.Errorf("a declared directory (%s) was refused: %v", dir, err)
		}
	}
}

// The container-with-nothing-shared case: there is no root at all, so the
// refusal is the "name a directory" message rather than a list of none.
func TestABlockedEnvRefusesAbsolutePathsToo(t *testing.T) {
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")

	env := describeSaveEnv("/home/nathan/Projects", "")
	if !env.Blocked {
		t.Fatalf("expected a blocked env: %+v", env)
	}
	// An absolute path used to be waved through here on the theory that the typer
	// knew about a mount webtmux couldn't infer. The dropdown is how they say so
	// now, and it is checked.
	if _, err := resolveSavePath(env, filepath.Join(t.TempDir(), "out.txt")); err == nil {
		t.Error("an absolute path bypassed a blocked environment")
	}
}

// ---- overwrite -----------------------------------------------------------------

func TestExistingTargetsAreDetected(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "there.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !targetExists(file) {
		t.Error("an existing file was not seen")
	}
	if targetExists(filepath.Join(dir, "absent.txt")) {
		t.Error("a name that is free was reported as taken")
	}
	// A dangling symlink is still a name that is taken, and the write follows it.
	link := filepath.Join(dir, "dangling.txt")
	if err := os.Symlink(filepath.Join(dir, "nothing"), link); err == nil {
		if !targetExists(link) {
			t.Error("a dangling symlink is still an occupied name")
		}
	}
	if !strings.Contains(existsMessage(file), "Overwrite") {
		t.Errorf("the exists message should ask, not just report: %s", existsMessage(file))
	}
}
