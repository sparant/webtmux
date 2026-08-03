# Plan: webtmux portable — Stage 2, real releases via GitHub Releases

`plan-webtmux-portable-release.md` — subplan of `plan-webtmux-portable.md`, created
2026-07-25. **Revised 2026-07-26:** distribution moved from committed-in-git binaries to
**GitHub Releases**. **Revised again 2026-07-26 (second pass):** this stage moved from
last to **third** (execution order D → 0 → **2** → 3 → 1) because it now *unblocks* the
launcher — Stage 3 fetches the assets published here.

## ✅ COMPLETE — v0.1.0 published 2026-08-02

**https://github.com/sparant/webtmux/releases/tag/v0.1.0** — seven assets, public,
downloadable with no token and no `gh`. The stage's goal is reached: a webtmux binary can
say what it is (`webtmux version v0.1.0`, never again `dev`), and it has a real
distribution channel.

Verified after publication, unauthenticated, from a throwaway container — the way a
stranger meets it:

- All six platform binaries + `SHA256SUMS` return `200`, as does the `latest` redirect.
- **All six downloaded binaries check against the published `SHA256SUMS`**, and are
  byte-identical to what was staged locally. The published `SHA256SUMS` is byte-identical
  to the local copy.
- The release names the tagged commit: `refs/tags/v0.1.0` → tag object `d6cb344` →
  commit `bc27015`, matching this repo.
- Release metadata: not a draft, not a prerelease, 7 assets all `state=uploaded`, body
  4471 chars (the full `release-notes.md` from the tag).
- **The README's install flow was run verbatim against the live URLs**: curl → verify →
  `install -m 755` → `webtmux --version` → serves `200` authenticated and `401` without.
- Both URL forms `webtmux-launch` constructs (`download/v0.1.0/…` and `latest/download/…`)
  resolve for the platforms it targets.

*Residual gap, stated rather than glossed:* the launcher has not been run end-to-end
against the live release — its release-source code path is covered by unit tests through a
`urlBase` seam, and the URLs it builds are confirmed live above, but no real
`webtmux-launch <host>` has fetched from GitHub yet. Stage 3's e2e suite runs against a
local source. Worth doing once.

### How publishing actually went — three failures, all of them useful

It took three attempts, and each failure was a real defect that would have recurred:

1. **`gh release create` could not resolve the repo.** Fixed before publishing by adding
   `--repo $(RELEASE_REPO)`; see 2.9.
2. **`publish-webtmux-tag.sh` refused to push the tag**, because it insisted the tag point
   at HEAD — but `local-main` had moved 33 commits ahead, as it always will. Pushing a tag
   is not moving it. Fixed; see 2.9.
3. **A release asset was silently swapped out between building and shipping.** See 2.8.

The lesson common to all three: every step between "built" and "published" needs a check
that fails loudly, because each of these produced either a confusing error at the worst
moment or — in the third case — no error at all.

## Goal

Make a webtmux binary able to say **what it is**, and give it a real distribution channel.
There are no git tags in this repo, so `VERSION ?= $(shell git describe --tags …)` has
always fallen back to `dev` — every binary ever shipped is stamped identically. This stage
adds semver tags, moves binaries out of git and onto GitHub Releases, and publishes
`v0.1.0`.

**This stage completes Stage 3's distribution story.** *(Revised 2026-07-27: it used to
**block** Stage 3. It no longer does — the launcher now also accepts a local build
directory as a binary source, so it can be built and tested end-to-end before any release
exists. What still requires this stage is the launcher working for someone who is **not**
you, plus its own fetch-path tests.)* The launcher does not embed webtmux — it downloads
the release asset matching the target machine's platform. Two things follow, and they are
the reason asset naming is load-bearing:

- **Asset names are an interface, not a detail.** The launcher constructs URLs from
  `uname` output, so `webtmux-linux-amd64`, `webtmux-linux-arm64`, `webtmux-darwin-arm64`
  etc. must be exactly what `make cross-compile` already produces. Renaming an asset
  breaks every launcher in the field — **and** breaks the launcher's local-source mode,
  which reads those same names straight out of `builds/`. Upload what `cross-compile`
  emits, unrenamed.
- **`SHA256SUMS` must be published as its own asset.** The launcher fetches it *first*
  (a few hundred bytes) to decide whether a 12 MB download is needed at all.

**Why not binaries in git:** `builds/` is already untracked — the build/run split
(`af969d2`) did it because the artifact build writes there, and re-tracking would dirty
the tree on every build. Releases cost one user-executed `gh` step per release. Target
machines are unaffected either way, since the Mac does the downloading.

## Gate

**Stage 0 done.** Origin must be the user's **public** GitHub fork, and the user needs an
authenticated `gh` CLI (or a token) on whatever machine performs the publish — **the agent
has no GitHub access, so every push/publish step here is user-executed** (directly or via
a `/workspace/claude_run_me_*.sh` host script).

*(Revised 2026-07-29: **the old gate could never pass.** It required this repo's `origin`
to be a `github.com` URL — true under Stage 0's original hub-and-spoke design, but Stage 0
was rewritten to a chain in which `origin` deliberately stays the **Mac** and step 0.6
forbids a `github` remote here at all, because `sync-all-repos.sh` picks its remote with
`git remote | head -1` and a remote named `github` sorts ahead of `origin` and silently
redirects the backup. The gate now checks the thing that actually matters — that the
public fork exists and is fetchable without a token — which is also exactly what the
launcher depends on.)*

```bash
# The fork is reachable and public: an UNAUTHENTICATED request must succeed.
OWNER=sparant
curl -sfI "https://github.com/$OWNER/webtmux" >/dev/null \
  || { echo "GATE: Stage 0 not done — https://github.com/$OWNER/webtmux is not publicly reachable"; exit 1; }
# And this repo still backs up to the Mac rather than to GitHub (fork-plan 0.6).
git -C /workspace/webtmux remote get-url origin | grep -q '192\.168\.68\.67' \
  || { echo "GATE: origin is not the Mac — see fork-plan 0.6"; exit 1; }
```

*(A second gate requiring Stage 1 — vendoring — was removed 2026-07-26: air-gap support is
no longer a requirement, and Stage 1 now runs last and is optional. Releases cut before it
simply carry the CDN-loading UI, which works.)*

---

## Worktree

- **Branch:** `chore/portable-release`
- **Worktree:** `/workspace/webtmux-portable-release`

```bash
git -C /workspace/webtmux worktree add /workspace/webtmux-portable-release \
    -b chore/portable-release local-main
cp /workspace/webtmux/plan-webtmux-portable*.md /workspace/webtmux-portable-release/
```

Merge with `--no-ff`. See the Worktree Reference in the master plan.

---

## Phase 2A — Untrack binaries; Makefile and ignore files

- [x] **P0** 2.1 Create the worktree per the block above, after both gate checks. *(5 min)*
      **Done 2026-07-30.** Both gates passed: `https://github.com/sparant/webtmux` is
      reachable unauthenticated, and `origin` is still the Mac. Branched from `local-main`
      at `66d07e0` — note that `local-main` advanced during the session (a concurrent
      README commit), which is the normal state of this repo.

- [x] **P0** 2.2 **VERIFY ONLY — `builds/` is already untracked.**
      The build/run split (`af969d2`) did this on `local-main`: the artifact
      build writes into `builds/`, so it could not leave a tracked output directory
      behind. Confirm, do not redo: *(5 min)*

      ```bash
      test -z "$(git ls-files builds/)" && grep -q '^/builds/$' .gitignore \
        || echo "UNEXPECTED: builds/ still tracked — the build/run split did not land"
      ```

      **Verified 2026-07-30:** `git ls-files builds/` is empty and `.gitignore:22` carries
      `/builds/`. Nothing to change.

      The landed `.gitignore` comment differs in wording (it cites `make docker-artifact`
      as a writer, which did not exist when this subplan was written) but is the same
      decision. Do not rewrite it.

      That change also **dissolved the old `clean` footgun**: with `builds/` untracked,
      `clean`/`cross-compile` deleting it is harmless again, and no Makefile surgery for
      tracked-deletion safety is needed. Keep `cross-compile`'s
      `@rm -f $(OUTPUT_DIR)/$(BINARY_NAME)-*` line (catches a dropped platform).

- [x] **P1** 2.3 Add `checksums` and `release-binaries` targets. `SHA256SUMS` is a
      release *asset* now, not a committed file. `release-binaries` deliberately does not
      tag or publish — the user reviews, then runs the printed commands. *(20 min)*

      ```make
      checksums:
      	@cd $(OUTPUT_DIR) && sha256sum $(BINARY_NAME)-* > SHA256SUMS

      #   make release-binaries VERSION=v0.1.0   (run AFTER tagging — see Phase 2C order)
      release-binaries: cross-compile checksums
      	@echo "Built $(VERSION). Publish (user-executed):"
      	@echo "  gh release create $(VERSION) builds/webtmux-* builds/SHA256SUMS \\"
      	@echo "     --title 'webtmux $(VERSION)' --notes-file release-notes.md"

      # Re-fetch the vendored browser deps (the ONLY step that needs network).
      # Deliberately NOT a prerequisite of build. (Stage 1, optional.)
      vendor:
      	bash scripts/vendor-assets.sh
      ```

      Add all new targets to `.PHONY`.

      **`release-binaries` does NOT depend on `launcher`** *(changed 2026-07-26)*. With
      independent builds the two artifacts have no build-order relationship and can be
      released on separate cadences — a webtmux patch release needs no launcher rebuild at
      all. Once Stage 3 lands, add `builds/webtmux-launch-*` to a release's asset list
      **when the launcher itself changed**, not reflexively.

      **Do not rename the `webtmux-<os>-<arch>` outputs.** The launcher builds its download
      URLs from `uname` output mapped to these exact names; a rename breaks every launcher
      already distributed.

      **Done 2026-07-30, with two deviations:**

      - **The `vendor` target was NOT added.** `scripts/vendor-assets.sh` does not exist —
        Stage 1 is optional and unstarted, and there is no `scripts/` directory at all. A
        target whose recipe names a missing script is a footgun, not a placeholder. Stage 1
        step 1.3 writes the script; it should add the target in the same change.
      - **A `release-notes.md` was added** at the repo root, because the `gh release create`
        line this target prints passes `--notes-file release-notes.md`. Printing a command
        that references a nonexistent file would fail at exactly the moment the user is
        handed the publish step.

      One footgun found and documented in the recipe comment rather than fixed:
      `cross-compile` depends on `clean`, which `rm -rf`s `builds/`. So `make launcher &&
      make release-binaries` silently destroys the launcher binaries — launcher assets must
      be built *after* `release-binaries`, followed by a re-run of `checksums`.

- [x] **P1** 2.4 **`.dockerignore` — verify, then delete one dead line.**
      **Verified 2026-07-30 — nothing to delete.** The `cmd/webtmux-launch/payload/*.gz`
      line is already gone; Stage 3 removed it (task 3.4 predicted exactly this), and the
      file now instead excludes `webtmux-launch/` with a comment explaining that webtmux's
      image build neither compiles nor ships the launcher. Current contents are correct.
      The build/run split (`af969d2`) added the file. The `COPY . /src` it protects now
      lives in the fork's own `Dockerfile` (the artifact build), not in
      `scripts/webtmux-docker/Dockerfile` — that file stopped building the binary in the
      same change. *(10 min)*

      Current contents:

      ```
      .git
      builds/
      *.gif
      *.ai
      plan-*.md
      cmd/webtmux-launch/payload/*.gz     <-- DEAD, remove
      ```

      **Remove the payload line** *(added 2026-07-26)*: it anticipated the launcher
      embedding gzipped webtmux binaries, a design dropped when the launcher moved to
      fetching from Releases. That directory will never exist. Stage 3 task 3.4 notes the
      same cleanup — whichever stage runs first should do it; the other just verifies.

      (No `js/` entry — the legacy webpack tree is deleted in Stage 1, which is optional
      and now runs last; add one only if that stage lands and leaves something behind.)
      No `launch.sh --rebuild` is needed here — the deploy path was verified on the host
      when the split landed.

---

## Phase 2B — README install path

The current instructions are **broken for this fork**: `README.md:10`, `:48`, and `:61`
point at `github.com/chrismccord/webtmux` — upstream, which contains none of this fork's
work — and describe fetching binaries from `builds/`, which is no longer committed.

*(Revised 2026-07-30: **half of this was already fixed.** Commit `66d07e0`
("docs(readme): point clone URLs at the fork…") repointed every clone URL at
`sparant/webtmux` and removed the `git archive --remote` / shallow-clone instructions, so
no `chrismccord` reference remained in the install path. What was still broken is the part
this phase actually targets: "Prebuilt binaries are available in the `builds/` directory",
which describes a distribution channel that no longer exists.)*

- [x] **P0** 2.5 Rewrite the Installation section around Release assets. *(30 min)*
      **Done 2026-07-30.** "Prebuilt Binaries" now curls
      `releases/download/v0.1.0/webtmux-<os>-<arch>` unauthenticated, documents
      `releases/latest/download/…` as the always-current variant, and documents the
      `SHA256SUMS` asset with `sha256sum --check --ignore-missing` (the `--ignore-missing`
      is load-bearing: the file lists every platform and the user downloaded one; the local
      filename must also match the asset name for the check to find it).
      The asset-name table lost its `builds/` prefix so it now reads as the release
      interface it is. The Development section gained a **Cutting a release** block —
      tag → `make release-binaries` → `--version` check → user-run `gh release create` —
      carrying the two launcher-facing rules (publish `SHA256SUMS`; never rename an asset).

      ```bash
      curl -fsSL -o webtmux \
        https://github.com/<you>/webtmux/releases/download/v0.1.0/webtmux-linux-amd64
      chmod +x webtmux
      ```

      The fork is public (Stage 0 step 0.6), so a plain unauthenticated curl is the
      documented form — no `gh`, no token. Drop the `git archive --remote` and
      shallow-clone instructions entirely; building from source
      (`git clone && make build`) remains the documented alternative.

      Note `releases/latest/download/webtmux-linux-amd64` as the always-current variant —
      it is the same redirect the launcher uses for `--webtmux-version latest`.

- [x] **P0** 2.6 Fresh-box section: tmux prereq, `chmod +x`, `~/.local/bin` + PATH,
      `webtmux --version`, verify against the release's `SHA256SUMS` asset, and a
      first-run command that **binds loopback** (`-a 127.0.0.1`) — basic auth over plain
      HTTP must not face a LAN, and the default is `0.0.0.0`. *(25 min)*

      Once Stage 3 lands, this section should lead with `webtmux-launch <host>` as the
      primary cross-machine story and demote manual install to the fallback — **and note
      that the launcher makes manual install on the *target* unnecessary entirely**, since
      it fetches and installs webtmux itself.

      Two notes worth stating explicitly:
      - **The tmux protocol-version pinning in the Docker deploy does not apply here** —
        it exists only because the container attaches to the *host's* tmux across a
        bind-mounted socket. A native binary talks to its own local tmux.
      - **macOS:** Go's linker ad-hoc-signs `darwin/arm64` even when cross-compiled from
        Linux, so the binaries run on Apple Silicon. `curl`-downloaded binaries carry the
        quarantine xattr — `xattr -d com.apple.quarantine webtmux` if Gatekeeper objects
        (`gh release download` avoids this).

      **Done 2026-07-30** as "Installing on a fresh machine": five numbered steps (tmux
      prereq → fetch + verify → PATH → `webtmux --version` → first run with
      `-a 127.0.0.1`), both platform notes, and — as this task's second paragraph asks —
      a closing pointer that `webtmux-launch` makes the whole section unnecessary when the
      goal is reaching that machine's tmux rather than installing there permanently.
      The launcher section already sits above Installation, so it leads by position.
      `install -m 755` replaces `chmod +x` + `cp`: one command, and it cannot leave a
      half-installed binary on PATH.

---

## Phase 2C — Cut v0.1.0

### Why v0.1.0

`v1.0.0` implies a compat promise not wanted for a personal fork, and reusing `1.x` would
collide with upstream gotty's lineage. `v0.1.0` leaves all of 0.x for iteration.

### Ordering — tag first, then build

With binaries out of git, the old tag/commit chicken-and-egg **evaporates**: nothing about
a release needs committing after the build. Tag the release commit, build *from the tag*
(so `git describe` stamps `v0.1.0` with no `VERSION=` override needed), and upload.

- [x] **P0** 2.7 Merge this stage's changes to `local-main` first (via the wrapper, tests
      passing), so the tag lands on the integration branch: *(15 min)*
      **Done 2026-07-30.** `make test` green before each merge — 203 JS store tests,
      5 stoplight-hook tests, every Go package, `go vet` clean. The container has no Go
      toolchain and no tmux, so the suite runs in a throwaway `golang:1.23` + tmux + nodejs
      image against a copy of the worktree (`-v …:/src:ro`, then `cp -r /src /work`).
      Two gotchas worth keeping: `bash -lc` drops `/usr/local/go/bin` from PATH (use
      `bash -c`), and `cp -a` onto the ACL'd checkout floods "preserving permissions:
      Invalid argument" (use `cp -r`).

      **Merged twice**, because publishing turned up a defect (see 2.9). Both merges hit
      the same obstacle: `/workspace/webtmux`'s working tree had *another agent's*
      uncommitted README edit, and `git merge` refuses to touch a locally-modified file.
      Resolved by backing the diff up to the scratchpad, `git stash push -- README.md`,
      merging, then `git stash pop` — the concurrent work was preserved both times. Worth
      knowing before the next merge into this repo: **`local-main` moves under you.** It
      advanced from `c287fb8` to `66d07e0` between reading the plan and creating the
      worktree, and three other worktrees were live on the same commit.

      ```bash
      make test
      /workspace/scripts/git-merge-worktree.sh /workspace/webtmux-portable-release \
          --target local-main --no-ff --remove
      ```

- [x] **P0** 2.8 Tag, build, sanity-check *(15 min)*:

      ```bash
      git -C /workspace/webtmux tag -a v0.1.0 -m "webtmux v0.1.0"
      cd /workspace/webtmux && make release-binaries    # VERSION=v0.1.0 via git describe
      ./builds/webtmux-linux-amd64 --version            # must say v0.1.0, not dev
      ```

      **Done 2026-07-30.** `v0.1.0` is tagged on `local-main` at `9b1c258`, and
      `builds/` holds all six platform binaries plus `SHA256SUMS`, built *from* the tag
      with no `VERSION=` override — `git describe --tags` supplied it, and
      `./builds/webtmux-linux-amd64 --version` prints **`webtmux version v0.1.0`**, the
      first binary this repo has ever produced that does not say `dev`.
      `sha256sum --check SHA256SUMS` passes for all six.

      **The tag was moved once, deliberately.** The `--repo` defect found in 2.9 belonged
      *in* v0.1.0 — a release whose own Makefile prints a command that cannot run is not
      much of a release — so the fix was merged and the tag re-cut with `tag -f` before it
      had left this machine. Safe precisely because nothing had been pushed; once the tag
      reaches the Mac or GitHub, the "never move a published tag" rule applies and the
      publish script enforces it.

      Build ran in the same throwaway `golang:1.23` image as the tests, but read-write
      (`-u 1000:1000 -v /workspace/webtmux:/work`, `HOME`/`GOCACHE`/`GOPATH` in `/tmp`,
      plus `git config --global --add safe.directory '*'` so git inside the container will
      read the tag).

      **The tag was moved a second time, at the user's direction**, to include the 33
      commits of authority hardening that landed the same day (read-only actually gating
      more than keystrokes, pane-save confined to declared directories, tmux mutations
      targeting exactly, `@wt_state` convergence). A first release that omitted them would
      have handed every `--webtmux-version latest` target the weaker binary. Cost was one
      rebuild and one re-test. `release-notes.md` gained a section naming that work; the
      tag was re-cut once more so the notes live *inside* what is released.
      `v0.1.0` = `bc27015`.

      **⚠ NEVER STAGE RELEASE ASSETS IN `builds/` — this bit, for real.** The first
      transfer to the Mac failed its preflight with
      `builds/ holds 'webtmux version local', not exactly v0.1.0`. Cause:
      `scripts/webtmux-docker/launch.sh:159` runs
      `make docker-artifact VERSION=local`, so **any webtmux container rebuild overwrites
      `builds/webtmux-linux-amd64`** — here, a day after v0.1.0 was built, leaving a
      `local`-stamped `root`-owned binary that no longer matched `SHA256SUMS`. The other
      five were untouched, so the release would have shipped five good assets and one
      wrong one. `builds/` is a **shared drop box** between the fork's build and the deploy
      path, not a release staging area.

      Fix, now the standing procedure: build from the tag in a **detached worktree**
      (`git worktree add --detach <path> v0.1.0`) and stage the output in
      `/workspace/webtmux-release/<tag>/`, outside the repo, where nothing else writes.
      Two gotchas found doing it: `cp -a`/`cp -p` onto the ACL'd checkout fails with
      "preserving permissions: Invalid argument" (use plain `cp` + `chmod`), and a linked
      worktree's `.git` is a *file* holding an absolute `gitdir:` path — so a container
      build needs the main repo mounted at its **real path**
      (`-v /workspace/webtmux/.git:/workspace/webtmux/.git:ro`) or `git describe` fails
      silently and the Makefile stamps `dev`. Caught only because the recipe printed
      `Built dev`.

- [x] **P0** 2.9 **Publish — user-executed.** *(15 min)* — **DONE 2026-08-02.**
      Took three runs. Run 1 pushed `local-main` to the Mac (clearing a 30-commit backlog)
      then died on the tag; run 2 got the tag to GitHub via both legs and forwarded the
      branch, but found **`gh` is not installed on the host**; run 3 shipped the assets to
      the Mac, where `gh` does live, and the Mac created the Release.

      That produced a second script, `scripts/webtmux-docker/create-webtmux-release.sh`,
      which **runs on the Mac** and is reusable for every future release. Why a second
      script at all: `publish-webtmux-tag.sh` moves a *tag*, which is pure git riding the
      SSH key the Mac already has. A *Release* is not git — it is an API object with
      binaries attached, and **an SSH key cannot create one**; that needs a token, or `gh`,
      which stores one. Different mechanism, different credential, different machine.

      It needs nothing macOS does not ship (`curl`, `perl`, `shasum`, `git`), uses `gh`
      when present and a plain token otherwise, and is written for **bash 3.2** — still
      `/bin/bash` on macOS — verified by parsing it in a `bash:3.2` container. It validates
      before publishing (all seven assets, checksums, tag already on GitHub, and the
      binary matching the Mac's own arch reporting **exactly** the tag), reads the notes
      out of `release-notes.md` **in the tag** so they cannot drift, and re-fetches every
      asset unauthenticated afterwards.

      The Mac holds only a bare repo, so the binaries must travel:
      `claude_run_me_7731_to_mac.sh` stages them via `push_files_to_mac.sh`. Notes do not
      travel — they are read from the tag.

      *(Revised 2026-07-29: "push the tag to origin" is not sufficient under the chain.
      `origin` is the Mac, and `sync-all-repos.sh` pushes the current branch only — no
      `--tags` — so a tag needs an explicit push on **both** legs.)*

      ```bash
      # Both hops, with guards and verification at each:
      /workspace/scripts/webtmux-docker/publish-webtmux-tag.sh v0.1.0 [--dry-run]
      ```

      That script lives in the infra repo rather than here, because the Mac's address and
      bare-repo path are local operational knowledge and this fork is public. It refuses to
      move an existing tag, warns if HEAD is not on `local-main`, uses an explicit refspec
      on leg 2 (never `--mirror` — the bare carries junk `refs/remotes/*`), and confirms
      the tag landed on both the Mac and GitHub.

      Then run the `gh release create` command printed by `release-binaries`. **The agent
      has no GitHub access and no SSH key for the Mac**, so every step here is yours.

      *(2026-07-30: **the no-SSH-key claim is now measured, not assumed.**
      `git ls-remote origin` from the container returns `Permission denied
      (publickey,password,keyboard-interactive)` against `192.168.68.67`. `gh` is installed
      in the container but unauthenticated. So this task is genuinely blocked on the user,
      not merely marked that way.)*

      **Prepared 2026-07-30 — run `/workspace/claude_run_me_7731.sh` on the host**
      (`bash ~/Projects/claude_run_me_7731.sh --dry-run` first; it changes nothing and
      prints every command). Its dry run was exercised against the real repo via a
      symlinked fake `$HOME`, so the preflight is known to work. It does five things the
      bare `gh` command does not:

      1. **Preflight** — tag points at HEAD, all seven assets present, `release-notes.md`
         present, the binary reports `v0.1.0` and not `dev`, `SHA256SUMS` matches the
         binaries actually sitting in `builds/`.
      2. **Pushes `local-main` to the Mac *before* the tag.** Fork-plan 0.10 found the fork
         four commits behind, because `sync-all-repos.sh` skips a dirty repo and this one
         nearly always is. Pushing only the tag would publish a release whose commit
         GitHub has never seen on any branch.
      3. Delegates the tag to `publish-webtmux-tag.sh` (both legs, with its own verify).
      4. **Forwards `local-main` from the Mac to GitHub** — leg 2 of step 2, which nothing
         does automatically.
      5. Runs `gh release create`, then performs 2.10/2.11's unauthenticated verification
         inline, so a `404` on `SHA256SUMS` or a renamed asset surfaces immediately.

      **One defect found and fixed here, worth its own note: the printed `gh release
      create` command could not have worked.** `gh` resolves the target repo from git
      remotes, and this checkout has no GitHub remote *by design* — fork-plan 0.6 keeps
      `origin` on the Mac because `sync-all-repos.sh` picks its remote with
      `git remote | head -1`, so a remote named `github` would sort ahead of `origin` and
      silently redirect the backup. Without `--repo`, `gh` fails with "none of the git
      remotes configured for this repository point to a known GitHub host" — at exactly the
      moment the user is handed the publish step. The recipe now prints
      `--repo $(RELEASE_REPO)` (default `sparant/webtmux`, overridable). **The same trap
      waits for the launcher's release**, whenever `webtmux-launch-*` assets first ship.

      Also fixed, in the infra repo: `publish-webtmux-tag.sh`'s closing hint named
      `make cross-compile && make launcher`, which predates `release-binaries` and gets the
      order wrong in a way that destroys work (`cross-compile` depends on `clean`, so
      building the launcher first deletes it). It now names `release-binaries` and mentions
      `SHA256SUMS`.

- [x] **P1** 2.10 Verify the documented install path end-to-end from a throwaway
      container: curl the release asset URL **unauthenticated**, `chmod +x`, run
      `--version`, and check the binary against the `SHA256SUMS` asset. *(20 min)*

      **DONE 2026-08-02 against the live release**, and rehearsed 2026-07-30 against a
      stand-in before one existed. The real run: `curl` the asset from
      `releases/download/v0.1.0/`, `sha256sum --check --ignore-missing`, `install -m 755`,
      `webtmux --version` → `v0.1.0`, then a loopback-bound first run serving **200
      authenticated / 401 without**. All six binaries were downloaded and checked against
      the published `SHA256SUMS`, and are byte-identical to the staged originals.

      *Original rehearsal notes follow.* No release exists
      yet, so `builds/` was served under the release filenames and the fresh-box section's
      commands were run verbatim in a throwaway container: `curl -O` both assets →
      `sha256sum --check --ignore-missing` → `install -m 755` → `webtmux --version` prints
      `v0.1.0` → `webtmux -a 127.0.0.1 --credential …` serves **200 authenticated, 401
      without credentials**. This tests every part of the documented flow except GitHub's
      URL layout, which step 5 of the host script covers.

      Three documentation claims were checked rather than asserted:

      - **`--ignore-missing` is required, and the filename matters.** With one binary
        downloaded, exactly one of the six `SHA256SUMS` entries is checked — and a copy
        renamed to `webtmux` is silently *not* checked at all. Both are now stated in the
        README, because a verification step that quietly verifies nothing is worse than
        none.
      - **The macOS ad-hoc signature claim is true and correctly scoped.** Parsing the
        Mach-O load commands with `debug/macho`: `webtmux-darwin-arm64` carries
        `LC_CODE_SIGNATURE`, `webtmux-darwin-amd64` does not — which is exactly Go's
        behaviour (only `arm64` requires it), and why the README says `darwin/arm64`
        rather than "the macOS binaries".
      - **`-a 127.0.0.1` matters.** Unauthenticated requests get 401, but that is basic
        auth over plain HTTP; the default `0.0.0.0` bind is what the README now warns
        against.

- [x] **P0** 2.11 **Verify the launcher's contract before Stage 3 depends on it.** These
      are the exact requests the launcher will make; catching a mismatch now is far
      cheaper than debugging it inside the launcher. *(15 min)*

      ```bash
      OWNER=<you>; BASE=https://github.com/$OWNER/webtmux/releases

      # 1. SHA256SUMS is its own asset and fetchable unauthenticated
      curl -fsSL $BASE/download/v0.1.0/SHA256SUMS

      # 2. Every platform asset resolves (HEAD only — no 12MB download)
      for p in linux-amd64 linux-arm64 linux-arm darwin-amd64 darwin-arm64; do
        printf '%-16s ' "$p"
        curl -fsSLI -o /dev/null -w '%{http_code}\n' $BASE/download/v0.1.0/webtmux-$p
      done

      # 3. The `latest` redirect works without an API call
      curl -fsSLI -o /dev/null -w '%{http_code}\n' $BASE/latest/download/webtmux-linux-amd64
      ```

      All must be `200`. A `404` on `SHA256SUMS` or a renamed asset is exactly the failure
      that would break every launcher in the field.

      **DONE 2026-08-02 — all `200`.** Six platform assets, `SHA256SUMS` as its own asset,
      and the `latest` redirect; both URL forms the launcher builds
      (`download/v0.1.0/…` and `latest/download/…`) confirmed live. They are also
      wired into the host script as step 5 (all six platforms, including `freebsd-amd64`,
      which this task's loop omits but `cross-compile` emits and the release will carry).

      *What could be checked without a release, was.* The contract itself was read out of
      the launcher rather than assumed: `assetName()` is literally `"webtmux-" + platform`
      (`webtmux-launch/source.go:51`), and `releaseSource` fetches `SHA256SUMS` by that
      name from both URL forms (`:242`, `:244`) — matching what `cross-compile` emits and
      what `checksums` writes, unrenamed. `source_test.go` already exercises both URL
      shapes through a `urlBase` seam. So the remaining risk is not the naming, it is
      whether the *upload* includes every asset — which is what step 5 measures.

---

## Policy

- **Tag + publish only at release time; never commit binaries.** The repo's size is now
  independent of release cadence.
- **Release assets are staged outside the repo, in `/workspace/webtmux-release/<tag>/`,
  and built from the tag in a detached worktree.** `builds/` is a shared drop box the
  deploy path rewrites (`launch.sh` runs `make docker-artifact VERSION=local`), so an
  asset left there can be silently replaced between building and publishing — which
  happened to v0.1.0 and was caught only by a version preflight.
- **Asset names are a public interface.** The launcher constructs URLs from them. Adding
  platforms is safe; renaming or removing is a breaking change for launchers already
  distributed.
- **webtmux and the launcher release independently.** A webtmux patch needs no launcher
  rebuild — that decoupling is the whole point of the launcher fetching rather than
  embedding. Include `webtmux-launch-*` assets only when the launcher actually changed.
- History already carries ~48 MB of packed pre-split binary blobs. **Sunk cost — leave
  it.** A history rewrite would invalidate every clone and force the Mac bare to be
  rebuilt.

---

## Risks

1. **Publishing requires the user** — `gh` auth lives outside the agent. Every push and
   `gh release create` is a handoff; the plan marks them explicitly.
2. ~~**`.dockerignore` touches the deploy path**~~ — retired.
   the build/run split (`af969d2`) added `.dockerignore` and verified the deploy path
   under it on the host, so 2.4 is a verification plus one dead-line deletion.
3. **Tag on the wrong commit** — 2.7 merges *before* 2.8 tags, so the tag always lands on
   `local-main`.
4. **Forgetting to upload `SHA256SUMS` as an asset.** Easy to treat as a build byproduct,
   but the launcher fetches it first to avoid a needless 12 MB download — without it the
   launcher's cheap path is gone. Caught by 2.11.
5. **A private fork** would make every documented curl fail and force a token into the
   launcher. Confirmed public in Stage 0 step 0.6; 2.10 proves it unauthenticated.

## Next steps

Stage 3 (`plan-webtmux-portable-launcher.md`) — the launcher, which fetches the assets
published here. Then optionally Stage 1 (vendor).

After the launcher lands, consider whether the host-side Docker deployment is still worth
keeping, now that a native binary needs no tmux version-pinning, socket mount, or uid/gid
matching.
