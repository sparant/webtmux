# Plan: webtmux portable — Stage 2, real releases via GitHub Releases

`plan-webtmux-portable-release.md` — subplan of `plan-webtmux-portable.md`, created
2026-07-25. **Revised 2026-07-26:** distribution moved from committed-in-git binaries to
**GitHub Releases**, and this stage now runs **last** (execution order 0 → 3 → 1 → 2).

## Goal

Make a webtmux binary able to say **what it is**, and give it a real distribution channel.
There are no git tags in this repo, so `VERSION ?= $(shell git describe --tags …)` has
always fallen back to `dev` — every binary ever shipped is stamped identically. This stage
adds semver tags, moves binaries out of git and onto GitHub Releases, and publishes
`v0.1.0` including the Stage 3 launcher binaries.

**Why not binaries in git** (the original choice): launcher binaries embed gzipped
payloads, which neither delta- nor re-compress — real growth would be ~30 MB packed per
release, ~6× the estimate the original decision rested on. Releases add one user-executed
`gh` step per release and require github.com reachability at install time; in exchange the
repo stops growing and install becomes one curl.

## Gates (two)

**Gate A — Stage 0 done.** Origin must be the user's GitHub fork, and the user needs an
authenticated `gh` CLI (or a token) on whatever machine performs the publish — **the agent
has no GitHub access, so every push/publish step here is user-executed** (directly or via
a `/workspace/claude_run_me_*.sh` host script).

```bash
git -C /workspace/webtmux remote get-url origin | grep -q 'github.com' \
  || { echo "GATE A: Stage 0 not done — origin is $(git -C /workspace/webtmux remote get-url origin)"; exit 1; }
```

**Gate B — Stage 1 (vendor) merged.** Published binaries should ship the offline UI and
not 2.6 MB of dead assets.

```bash
git -C /workspace/webtmux log local-main --oneline | grep -q 'vendor browser assets' \
  || { echo "GATE B: Stage 1 not merged — stop"; exit 1; }
```

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

- [ ] **P0** 2.1 Create the worktree per the block above, after both gate checks. *(5 min)*

- [ ] **P0** 2.2 **Untrack `builds/`.** *(20 min)*

      ```bash
      git rm -r --cached builds/
      ```

      Replace the `.gitignore` comment ("Don't ignore builds/ - we want prebuilt binaries
      in repo") with:

      ```gitignore
      # builds/ is NOT committed. Binaries ship as GitHub Release assets (see
      # release-binaries). History still carries pre-v0.1.0 blobs — sunk cost;
      # no history rewrite (it would break the seven live worktrees).
      /builds/
      ```

      This also **dissolves the old `clean` footgun**: with `builds/` untracked,
      `clean`/`cross-compile` deleting it is harmless again, and no Makefile surgery for
      tracked-deletion safety is needed. Keep `cross-compile`'s
      `@rm -f $(OUTPUT_DIR)/$(BINARY_NAME)-*` line (catches a dropped platform).

- [ ] **P1** 2.3 Add `checksums` and `release-binaries` targets. `SHA256SUMS` is a
      release *asset* now, not a committed file. `release-binaries` deliberately does not
      tag or publish — the user reviews, then runs the printed commands. *(20 min)*

      ```make
      checksums:
      	@cd $(OUTPUT_DIR) && sha256sum $(BINARY_NAME)-* > SHA256SUMS

      #   make release-binaries VERSION=v0.1.0   (run AFTER tagging — see Phase 2C order)
      release-binaries: cross-compile launcher checksums
      	@echo "Built $(VERSION). Publish (user-executed):"
      	@echo "  gh release create $(VERSION) builds/webtmux-* builds/webtmux-launch-* builds/SHA256SUMS \\"
      	@echo "     --title 'webtmux $(VERSION)' --notes-file release-notes.md"

      # Re-fetch the vendored browser deps (the ONLY step that needs network).
      # Deliberately NOT a prerequisite of build.
      vendor:
      	bash scripts/vendor-assets.sh
      ```

      Add all new targets to `.PHONY`.

- [ ] **P1** 2.4 Add a `.dockerignore` (none exists). Still worthwhile with `builds/`
      untracked — local builds land there and `scripts/webtmux-docker/Dockerfile` does
      `COPY . /src`. Safe because `VERSION`/`GIT_COMMIT` arrive as build args, so `.git`
      isn't needed either: *(15 min)*

      ```
      .git
      builds/
      *.gif
      *.ai
      plan-*.md
      cmd/webtmux-launch/payload/*.gz
      ```

      (No `js/` entry — the legacy webpack tree was deleted in Stage 1.)
      **Verify with `bash /workspace/scripts/webtmux-docker/launch.sh --rebuild` before
      merging** — this touches the deploy path.

---

## Phase 2B — README install path

The current instructions are **broken for this fork**: `README.md:10`, `:48`, and `:61`
point at `github.com/chrismccord/webtmux` — upstream, which contains none of this fork's
work — and describe fetching binaries from `builds/`, which is no longer committed.

- [ ] **P0** 2.5 Rewrite the Installation section around Release assets. *(30 min)*

      ```bash
      # Public repo:
      curl -fsSL -o webtmux \
        https://github.com/<you>/webtmux/releases/download/v0.1.0/webtmux-linux-amd64
      chmod +x webtmux

      # Private repo (needs an authenticated gh):
      gh release download v0.1.0 -R <you>/webtmux -p webtmux-linux-amd64
      ```

      Which form leads depends on the Stage 0 step 0.6 answer (public vs private). Drop
      the `git archive --remote` and shallow-clone instructions entirely — building from
      source (`git clone && make build`) remains the documented alternative.

- [ ] **P0** 2.6 Fresh-box section: tmux prereq, `chmod +x`, `~/.local/bin` + PATH,
      `webtmux --version`, verify against the release's `SHA256SUMS` asset, and a
      first-run command that **binds loopback** (`-a 127.0.0.1`) — basic auth over plain
      HTTP must not face a LAN, and the default is `0.0.0.0`. Lead with the launcher
      (`webtmux-launch <host>`) as the primary cross-machine story; manual install is the
      fallback. *(25 min)*

      Two notes worth stating explicitly:
      - **The tmux protocol-version pinning in the Docker deploy does not apply here** —
        it exists only because the container attaches to the *host's* tmux across a
        bind-mounted socket. A native binary talks to its own local tmux.
      - **macOS:** Go's linker ad-hoc-signs `darwin/arm64` even when cross-compiled from
        Linux, so the binaries run on Apple Silicon. `curl`-downloaded binaries carry the
        quarantine xattr — `xattr -d com.apple.quarantine webtmux` if Gatekeeper objects
        (`gh release download` avoids this).

---

## Phase 2C — Cut v0.1.0

### Why v0.1.0

`v1.0.0` implies a compat promise not wanted for a personal fork, and reusing `1.x` would
collide with upstream gotty's lineage. `v0.1.0` leaves all of 0.x for iteration.

### Ordering — tag first, then build

With binaries out of git, the old tag/commit chicken-and-egg **evaporates**: nothing about
a release needs committing after the build. Tag the release commit, build *from the tag*
(so `git describe` stamps `v0.1.0` with no `VERSION=` override needed), and upload.

- [ ] **P0** 2.7 Merge this stage's changes to `local-main` first (via the wrapper, tests
      passing), so the tag lands on the integration branch: *(15 min)*

      ```bash
      make test
      /workspace/scripts/git-merge-worktree.sh /workspace/webtmux-portable-release \
          --target local-main --no-ff --remove
      ```

- [ ] **P0** 2.8 Tag, build, sanity-check *(15 min)*:

      ```bash
      git -C /workspace/webtmux tag -a v0.1.0 -m "webtmux v0.1.0"
      cd /workspace/webtmux && make release-binaries    # VERSION=v0.1.0 via git describe
      ./builds/webtmux-linux-amd64 --version            # must say v0.1.0, not dev
      ```

- [ ] **P0** 2.9 **Publish — user-executed.** Push `local-main` + the tag to origin and
      run the `gh release create` command printed by `release-binaries` (write a
      `/workspace/claude_run_me_*.sh` script if the publish must happen from the host).
      *(15 min)*

- [ ] **P1** 2.10 Verify the documented install path end-to-end from a throwaway
      container: curl the release asset URL, `chmod +x`, run `--version`, and check the
      binary against the `SHA256SUMS` asset. If the repo is private, verify the
      `gh release download` form instead — and make the README lead with whichever form
      actually works. *(20 min)*

---

## Policy

- **Tag + publish only at release time; never commit binaries.** The repo's size is now
  independent of release cadence.
- History already carries ~48 MB of packed pre-v0.1.0 binary blobs. **Sunk cost — leave
  it.** A history rewrite would break the seven live worktrees and every clone.

---

## Risks

1. **Publishing requires the user** — `gh` auth lives outside the agent. Every push and
   `gh release create` is a handoff; the plan marks them explicitly.
2. **`.dockerignore` touches the deploy path** — 2.4 requires a `launch.sh --rebuild`
   verification before merge.
3. **Tag on the wrong commit** — 2.7 merges *before* 2.8 tags, so the tag always lands on
   `local-main`.
4. **Install docs vs repo visibility mismatch** — 2.10 tests the actual documented path
   against the actual repo visibility before the README ships.

## Next steps

This is the final stage. After 2.10, the whole portable plan is complete: retire the two
legacy plans (`plan-webtmux-split.md`, `plan-webtmux-capture-expose.md`) under CLEANUP
mode, and consider whether the host-side Docker deployment is still worth keeping now
that a native binary needs no tmux version-pinning, socket mount, or uid/gid matching.
