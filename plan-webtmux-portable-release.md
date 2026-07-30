# Plan: webtmux portable — Stage 2, real releases via GitHub Releases

`plan-webtmux-portable-release.md` — subplan of `plan-webtmux-portable.md`, created
2026-07-25. **Revised 2026-07-26:** distribution moved from committed-in-git binaries to
**GitHub Releases**. **Revised again 2026-07-26 (second pass):** this stage moved from
last to **third** (execution order D → 0 → **2** → 3 → 1) because it now *unblocks* the
launcher — Stage 3 fetches the assets published here.

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

- [ ] **P0** 2.1 Create the worktree per the block above, after both gate checks. *(5 min)*

- [ ] **P0** 2.2 **VERIFY ONLY — `builds/` is already untracked.**
      The build/run split (`af969d2`) did this on `local-main`: the artifact
      build writes into `builds/`, so it could not leave a tracked output directory
      behind. Confirm, do not redo: *(5 min)*

      ```bash
      test -z "$(git ls-files builds/)" && grep -q '^/builds/$' .gitignore \
        || echo "UNEXPECTED: builds/ still tracked — the build/run split did not land"
      ```

      The landed `.gitignore` comment differs in wording (it cites `make docker-artifact`
      as a writer, which did not exist when this subplan was written) but is the same
      decision. Do not rewrite it.

      That change also **dissolved the old `clean` footgun**: with `builds/` untracked,
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

- [ ] **P1** 2.4 **`.dockerignore` — verify, then delete one dead line.**
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

- [ ] **P0** 2.5 Rewrite the Installation section around Release assets. *(30 min)*

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

- [ ] **P0** 2.6 Fresh-box section: tmux prereq, `chmod +x`, `~/.local/bin` + PATH,
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

- [ ] **P0** 2.9 **Publish — user-executed.** *(15 min)*

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

- [ ] **P1** 2.10 Verify the documented install path end-to-end from a throwaway
      container: curl the release asset URL **unauthenticated**, `chmod +x`, run
      `--version`, and check the binary against the `SHA256SUMS` asset. *(20 min)*

- [ ] **P0** 2.11 **Verify the launcher's contract before Stage 3 depends on it.** These
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

---

## Policy

- **Tag + publish only at release time; never commit binaries.** The repo's size is now
  independent of release cadence.
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
