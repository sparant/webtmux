# Plan: webtmux build/run split — the fork builds the artifact, the infra repo runs it

`plan-webtmux-build-run-split.md` — created 2026-07-26. Spans **two repos**:
`/workspace/webtmux` (`local-main`) and `/workspace/scripts` (`master`).

**STATUS: COMPLETE** — executed, merged, and verified on the host 2026-07-26
(`local-main` af969d2 + bcdbdd5, `scripts` master e2a95f9 + 10c8d09). All worktrees
removed. The `plan-webtmux-portable-vendor.md` Stage 1 gate passes.

**Host run 2 (2026-07-26T18:24Z) PASSED** — the split is proven end to end on the host:

| Claim | Evidence |
|---|---|
| The artifact was built by that run | mtime 1785087873 >= build start 1785087868 |
| **The image copied it, did not rebuild it** | image sha == disk sha, `6dda1ae2…` |
| The deploy build pulls no toolchain | only `tmux-build` + `stage-1` ran, both debian; zero `golang`/`nodejs` references in the image-build log |
| The tmux protocol pin still works | built tmux **3.4**, matching the probed host tmux |
| It actually serves | HTTP **200** |
| The uid trap is fixed | `OK  builds/ is writable by nathan` |

The run reported one `FAIL` — "the deploy Dockerfile still references a toolchain" — which
was a **bug in the verification script, not a finding**: `grep -c` prints its count *and*
exits 1 when nothing matches, so `|| echo 0` appended a second line and the comparison saw
`"0\n0"`. The tell is in the output itself (`count: 0` followed by a bare `0`). The
underlying assertion is true and was confirmed two independent ways — a direct grep of the
deploy Dockerfile returns nothing, and the image-build log shows only the two debian
stages. Fixed to `|| true`.

**Host run 1 (2026-07-26T17:32Z) failed and was worth doing** — it caught two things no
in-container check could:

1. **A real deployment defect.** `make docker-artifact` died at the export step with
   `lstat builds/webtmux-linux-amd64: permission denied`. BuildKit's local exporter
   creates its output directory `0700`; on this bind-mounted `/workspace` the agent
   container's uid is remapped on the host, so an in-container build (ironically, the
   final sanity check at the end of the first session) left a `builds/` the host user
   could not traverse — and the `0700` also collapsed the POSIX ACL mask to `---`,
   voiding the `user:1001:rwx` entry that every sibling directory has. Fixed in two
   places: the fork's Makefile now creates the directory itself (`mkdir -p`) so it is
   never born `0700`, and `launch.sh` preflights it — relaxing what it can, removing an
   artifact owned by another uid so the export can replace it, and otherwise aborting
   with the owner, our uid, and the fix, instead of an exporter error. Merged
   `local-main` bcdbdd5 / `scripts` master 10c8d09.
2. **Two defects in the verification script itself.** Its HTTP check read credentials
   from `webtmux.env` and got a 401, because `launch.sh` hard-codes `WEBTMUX_PASSWORD`
   and exports `WEBTMUX_AUTH` over the file's (possibly stale, generate-once) value — it
   now reads the live container's `--credential` argument, the only ground truth for
   what the server accepts. And its "no toolchain layer" check grepped `docker history`,
   which **never shows multi-stage builder layers**: verified worthless by running it
   against the *old* three-stage image, where it also comes back empty. Replaced with a
   check that the deploy Dockerfile references no Go/Node base at all.

**The failure-loud design (task 3.3) worked exactly as intended:** the artifact build
failed, `launch.sh` aborted before touching the container, and the before/after binary
shas are identical with the old container still `Up 2 hours`. No broken build was ever
served. Step 4's "MISMATCH — the run image is still building its own binary" was a
cascade of the abort (nothing on disk to compare), *not* an independent finding.

## Goal

Today `scripts/webtmux-docker/Dockerfile` does everything: builds tmux from source,
installs Go **and Node**, runs `make build`, and assembles the runtime image. Meanwhile
`webtmux/Dockerfile` is dead upstream gotty cruft (one commit, `e307712`, never adapted) —
it calls a Makefile target that doesn't exist and copies a binary named `gotty`.

Move the seam to where it belongs:

- **`webtmux/Dockerfile`** — how the **artifact** is built. Owned by the fork, versioned
  with the source, works for anyone who clones it.
- **`scripts/webtmux-docker/Dockerfile`** — how the artifact is **deployed** here: host
  tmux protocol pin, socket mount, uid/gid match, `attach-web.sh`.

## Approach

The Go binary is `CGO_ENABLED=0` static with `go:embed` assets, so the artifact is exactly
one file with no ABI coupling to the runtime image. That is what makes this split safe:
builder and runtime never have to agree on a Debian release.

```
ARTIFACT (webtmux repo)          make docker-artifact
  webtmux/Dockerfile      →      builds/webtmux-linux-amd64

DEPLOY  (scripts repo)           launch.sh
  scripts/webtmux-docker/  →     stage 1: tmux from source @ host version
    Dockerfile                   stage 2: slim runtime
                                   COPY --from=artifacts webtmux-linux-amd64
                                   COPY --from=overlay   attach-web.sh
```

## Key design decisions

**`launch.sh` always runs the artifact build — never conditionally.** The obvious risk of
a two-step build is shipping a stale binary. BuildKit's layer cache makes a no-op artifact
build take seconds, so running it unconditionally costs nothing and makes staleness
*structurally impossible* rather than merely detectable. No mtime heuristics, no
`--rebuild`-only path.

**A Dockerfile, not `docker run --rm golang:1.23 make build`.** The Dockerfile pins the
toolchain in-repo, carries the `nodejs` dependency that `make check-js` needs, and lets
BuildKit cache module downloads across builds. A bare `docker run` re-fetches modules
unless you hand-mount a module cache.

**`--target artifact` + `--output type=local`, not an image.** The build product is a file,
so emit a file. `FROM scratch AS artifact` exports into `builds/` with no image to tag,
push, or garbage-collect. The same file feeds `make cross-compile` later.

**Stoplight scripts stay where they are** *(revised from the initial sketch — see
Correction below)*. `scripts/webtmux-container/` runs on the **host** (the bridge) and in
**other** containers (the hooks); `webtmux/install_stoplight_hooks_bash.sh` is a host shell
rc. None of it belongs in the webtmux image. `attach-web.sh` remains the only overlay. The
confusion here is documentation, not packaging — so this plan documents the boundary and
moves no files.

### Correction to the initial proposal

The first sketch of this design said "consolidate the stoplight artifacts into one overlay
directory." That is wrong on two counts, both found by reading the code and the in-flight
plans:

1. The stoplight pieces are host-side and cross-container by design (see
   `scripts/webtmux-container/README.md` — the spool-file transport exists *because*
   `/workspace` is mounted at every nesting depth). Baking them into the run image would
   package them for the one process that never uses them.
2. `plan-webtmux-harden-prep.md` Phase 1 is about to genericize
   `install_stoplight_hooks_bash.sh` **in place** in the fork. Moving it would collide.

## Coordination with in-flight plans

This plan **must land before** portable Stages 1 and 2. Neither has started (no
`webtmux-portable-*` worktree exists).

**`plan-webtmux-portable-vendor.md` (Stage 1) hard-gates on this plan** — the gate was
added to that subplan on 2026-07-26, ahead of its worktree creation, so it cannot be
started by accident. It is a content check, not a commit-message grep:

```bash
grep -q 'FROM scratch AS artifact' /workspace/webtmux/Dockerfile 2>/dev/null \
  && test -f /workspace/webtmux/.dockerignore \
  && grep -q 'docker-artifact' /workspace/webtmux/Makefile \
  || { echo "GATE: plan-webtmux-build-run-split.md not merged to local-main — stop"; exit 1; }
```

Those three conditions are produced by tasks 1.1, 1.3, and 1.2 respectively, so the gate
opens only when the whole artifact half has landed — a partial merge fails it.

| Plan | Conflict | Resolution | Status |
|---|---|---|---|
| `plan-webtmux-portable-vendor.md` — gate | Would delete a now-live build file | Hard gate added before its worktree step | **done** |
| `plan-webtmux-portable-vendor.md` 1.2 | Deletes root `Dockerfile` as broken | Amended: removed from the delete list. Its `js-build` stage still dies with `js/`. | **done** |
| `plan-webtmux-portable-vendor.md` 1.3 | Fixes a stale gotty comment in the run Dockerfile | Amended to a verification — Phase 3.1 deletes that block | **done** |
| `plan-webtmux-portable.md` | Declared "No gate"; stage table + history stale | Updated: gate recorded on the Stage 1 row and in Revision history | **done** |
| `plan-webtmux-portable-release.md` 2.2 | Untracks `builds/` | This plan writes artifacts there, so it must untrack first; downgrade 2.2 to a verification | task 2.1 |
| `plan-webtmux-portable-release.md` 2.4 | Adds `.dockerignore` | The artifact build is what does `COPY . /src`; downgrade 2.4 to a verification | task 2.1 |
| `plan-webtmux-harden-prep.md` §2 | `pr/upstream` strips the Dockerfile `js-build` stage | No change needed — the stage is gone from `local-main`, so the strip is a no-op | n/a |

The Stage 1 amendments were made in `/workspace/webtmux` rather than in a worktree because
a gate that only exists on an unmerged branch gates nothing. Plan files are the sanctioned
exception to worktree discipline (see the master plan's Worktree Reference).

## Trade-offs

- **Two Dockerfiles in two repos instead of one.** Accepted: they have genuinely different
  owners and lifecycles, and the static binary means no hidden coupling between them.
- **`builds/` gets untracked earlier than Stage 2 planned.** This is required — the
  artifact build writes there, and a tracked output directory means every build dirties the
  tree. It also retires master-plan Risk 4 (`make clean` producing six tracked deletions)
  ahead of schedule.
- **Live verification needs the host.** `launch.sh` hard-refuses to run under the secure
  daemon, so the final deploy check is a user-executed host script. The artifact build and
  a full run-image build *are* verifiable in-container (docker 27.5.1 + buildx present).
- **Not addressed here:** whether the Docker deployment survives at all once a native
  binary exists (`plan-webtmux-portable-release.md` Next steps raises this). If it is
  retired later, the artifact half of this split is exactly what remains useful.

## What this enables

- The run image stops needing Go or Node — rebuilding after an `attach-web.sh` change is
  seconds and pulls no toolchain.
- One verified binary can be deployed to the container, a Mac, or a bare host, instead of
  every deployment being its own from-source build.
- `make docker-artifact` gives anyone cloning the fork a reproducible build with no local
  Go toolchain — the fork stops depending on our infra repo to be buildable.
- Directly feeds `plan-webtmux-portable-launcher.md` (payload = an artifact) and
  `plan-webtmux-portable-release.md` (release assets = artifacts).

---

## Worktree

**Two worktrees, two repos.** Merge the webtmux side first — the scripts side consumes it.

| # | Repo | Branch | Worktree |
|---|---|---|---|
| 1 | `/workspace/webtmux` | `feat/artifact-build-split` | `/workspace/webtmux-build-split` |
| 2 | `/workspace/scripts` | `feat/webtmux-run-only-image` | `/workspace/scripts-webtmux-run-split` |

### Worktree Reference — read before every execution session

```bash
# Create (Phase 0)
git -C /workspace/webtmux worktree add /workspace/webtmux-build-split \
    -b feat/artifact-build-split local-main
cp /workspace/webtmux/plan-webtmux-build-run-split.md /workspace/webtmux-build-split/

git -C /workspace/scripts worktree add /workspace/scripts-webtmux-run-split \
    -b feat/webtmux-run-only-image master
cp /workspace/webtmux/plan-webtmux-build-run-split.md /workspace/scripts-webtmux-run-split/

# Merge + clean up (Phase 5) — run tests FIRST, webtmux side FIRST
/workspace/scripts/git-merge-worktree.sh /workspace/webtmux-build-split \
    --target local-main --no-ff --remove
/workspace/scripts/git-merge-worktree.sh /workspace/scripts-webtmux-run-split \
    --target master --no-ff --remove
```

**`--no-ff` is mandatory, never `--ff-only`.** `local-main` is churned by concurrent agents
(five live worktrees share its object store). Never run raw `git merge` or
`git worktree remove` — concurrent instances race on `packed-refs`.

**All edits happen inside a worktree.** If you are about to edit
`/workspace/webtmux/<file>` or `/workspace/scripts/<file>`, stop — wrong directory. The
exception is the plan-file amendments in Phase 2, which by design edit *other* plans in the
webtmux worktree copy.

**A branch alone does not deploy.** The host container builds from `local-main` +
`scripts` `master`; nothing is live until both merges **and** a host
`launch.sh --rebuild`.

**Never push `master` to origin** (root `CLAUDE.md`) — the scripts repo stays local.

---

## Phases

*Subagent guidance: Phases 1 and 3 are self-contained file edits well suited to a sonnet
subagent each, run sequentially (3 depends on 1). Phase 2 is a careful cross-plan edit —
keep it in the main context. Phase 5 needs host handoff and must not be delegated.*

### Phase 0 — Preflight and worktrees

- [x] **P0** 0.1 Confirm no `webtmux-portable-*` worktree exists (this plan must land
      first) and both repos are clean. Create both worktrees per the Worktree Reference.
      *(15 min)*

      ```bash
      git -C /workspace/webtmux worktree list | grep portable && echo "STOP: portable stage in flight"
      git -C /workspace/webtmux status --short
      git -C /workspace/scripts status --short
      ```

- [x] **P0** 0.2 Record the baseline so the split can be proven equivalent: build the
      current run image and capture the binary's sha256 and size from inside it.
      *(20 min)*

      ```bash
      docker build -t webtmux:baseline -f /workspace/scripts/webtmux-docker/Dockerfile \
        --build-context overlay=/workspace/scripts/webtmux-docker /workspace/webtmux
      docker run --rm --entrypoint sha256sum webtmux:baseline /usr/local/bin/webtmux
      ```

      **Baseline recorded:** sha256 `0ea012de7223ac638b556261315b867678aae11b88c7c6d4197016d18fc3d66f`,
      size **11731096**, `--version` → `webtmux version local`.

### Phase 1 — Artifact build in the fork · worktree `/workspace/webtmux-build-split`

- [x] **P0** 1.1 **Replace `webtmux/Dockerfile`** with a two-target artifact builder.
      `--platform=$BUILDPLATFORM` + `TARGETOS`/`TARGETARCH` so it also serves
      cross-compilation later (launcher payloads, release assets). *(35 min)*

      ```dockerfile
      # webtmux/Dockerfile — how the webtmux ARTIFACT is built. Owned by THIS repo.
      # Deployment concerns (host tmux version pin, tmux socket, uid/gid, stoplight
      # wiring) live in the consuming infra repo — see scripts/webtmux-docker/.
      #
      #   make docker-artifact          -> builds/webtmux-linux-amd64
      #
      FROM --platform=$BUILDPLATFORM golang:1.23-bookworm AS build
      # node is required by `make check-js`, which parse-guards the embedded JS so a
      # stray backtick in a css`` template cannot ship and blank the page.
      RUN apt-get update && apt-get install -y --no-install-recommends nodejs \
       && rm -rf /var/lib/apt/lists/*
      WORKDIR /src
      ARG VERSION=dev
      ARG GIT_COMMIT=unknown
      ARG TARGETOS=linux
      ARG TARGETARCH=amd64
      COPY . /src
      # .git is excluded by .dockerignore, so VERSION/GIT_COMMIT MUST arrive as build
      # args — command-line make vars override the Makefile's git-describe defaults.
      RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
            make build VERSION="$VERSION" GIT_COMMIT="$GIT_COMMIT" \
       && mv webtmux "webtmux-$TARGETOS-$TARGETARCH"

      # Export-only stage: the build product is a file, so emit a file, not an image.
      FROM scratch AS artifact
      COPY --from=build /src/webtmux-* /
      ```

- [x] **P0** 1.2 Add the `docker-artifact` Makefile target + `.PHONY` entry, and document
      it in `make help`. *(20 min)*

      ```make
      DOCKER_PLATFORM ?= linux/amd64

      # Build the release artifact in a pinned container — no local Go toolchain needed.
      # Emits builds/webtmux-<os>-<arch>. Cheap to re-run: BuildKit caches everything.
      docker-artifact:
      	docker build --target artifact --platform $(DOCKER_PLATFORM) \
      	  --output type=local,dest=$(OUTPUT_DIR)/ \
      	  --build-arg VERSION=$(VERSION) --build-arg GIT_COMMIT=$(GIT_COMMIT) .
      ```

- [x] **P0** 1.3 Add `.dockerignore` (none exists; the artifact build is what does
      `COPY . /src`). Use the exact list `plan-webtmux-portable-release.md` 2.4 specifies,
      so that task degrades to a verification. *(15 min)*

      ```
      .git
      builds/
      *.gif
      *.ai
      plan-*.md
      cmd/webtmux-launch/payload/*.gz
      ```

      The `js/` tree is intentionally absent — `plan-webtmux-portable-vendor.md` 1.2
      deletes it outright.

- [x] **P0** 1.4 **Untrack `builds/`** — required, since the artifact build writes there
      and a tracked output dir dirties the tree on every build. Use the gitignore comment
      from release 2.2 verbatim so the two plans agree. *(20 min)*

      ```bash
      git rm -r --cached builds/
      ```

      Replace the `.gitignore` line "Don't ignore builds/ - we want prebuilt binaries in
      repo" with:

      ```gitignore
      # builds/ is NOT committed — it holds build artifacts (make docker-artifact,
      # make cross-compile) and, from v0.1.0, GitHub Release assets. History still
      # carries pre-v0.1.0 blobs — sunk cost; no rewrite (it would break live worktrees).
      /builds/
      ```

- [x] **P0** 1.5 Verify the artifact build in-container and prove equivalence against the
      Phase 0.2 baseline. *(30 min)*

      ```bash
      cd /workspace/webtmux-build-split
      make docker-artifact
      file builds/webtmux-linux-amd64          # ELF, statically linked
      sha256sum builds/webtmux-linux-amd64     # compare vs 0.2 (differs only by ldflags)
      make test                                # go test + go vet + node store tests
      ```

      A byte-identical match is not expected (`VERSION`/`GIT_COMMIT` differ); assert
      instead that size is within a few KB and the binary runs: `builds/webtmux-linux-amd64
      --version`.

      **Result:** sha256 `066b35e375ae0c908cd59bec3e92b468fe50baf55b7de4308407f1286cf02e18`,
      size **11731096** — byte-for-byte the *same size* as the 0.2 baseline (differing
      content is the ldflag stamp alone: `dev`/`unknown` vs `local`). ELF, statically
      linked; `--version` → `webtmux version dev`. Risk 6 discharged: appending an
      unterminated template literal to `resources/js/stoplight.js` made
      `make docker-artifact` exit 1 in the `make build` layer, so the Node parse-guard
      survived the move out of the deploy path. `make test` runs its JS half locally
      (119 pass) but has no local Go toolchain — `go test ./... && go vet ./...` were run
      in `golang:1.23-bookworm` instead: all green.

- [x] **P2** 1.6 Fix the dead ldflag: `-X main.GitCommit=…` targets a symbol that does not
      exist (`main` has only `Version`, in `version.go`) and is silently ignored. The live
      one is `-X webtmux/server.BuildCommit`. Either drop the dead flag or add
      `var GitCommit` to `version.go` — prefer dropping. *(15 min)*

      Dropped, as preferred. Confirmed `version.go` declares only `Version`.

- [x] **P0** 1.7 Commit: `build: make the root Dockerfile the artifact builder`. *(10 min)*

### Phase 2 — Amend the in-flight plans

*The Stage 1 gate and its amendments were done up front, in `/workspace/webtmux` — see
Coordination above for why. The remaining task edits plan files in
`/workspace/webtmux-build-split/`; those copies merge back with the rest of the change.*

- [x] **P0** 2.0 **Done at plan-authoring time (2026-07-26).**
      `plan-webtmux-portable-vendor.md`: hard gate added before the worktree step; 1.2 no
      longer deletes the root `Dockerfile`; 1.3 downgraded to a verification.
      `plan-webtmux-portable.md`: "No gate" claim corrected, Stage 1 table row marked
      gated, Revision history entry added.

- [x] **P0** 2.1 `plan-webtmux-portable-release.md`: downgrade 2.2 (untrack `builds/`) and
      2.4 (`.dockerignore`) to verifications, each citing the task here that did it. Update
      master-plan Risk 4 (`make clean` tracked-deletion footgun) to resolved. *(20 min)*

      Deferred to the worktree deliberately, unlike the Stage 1 edits: Stage 2 runs
      **last** in the 0 → 3 → 1 → 2 order, so there is no risk of it starting before this
      plan merges. Only Stage 1 needed the up-front gate.

### Phase 3 — Run-only image · worktree `/workspace/scripts-webtmux-run-split`

- [x] **P0** 3.1 Strip the Go stage from `scripts/webtmux-docker/Dockerfile`: delete the
      whole `go-build` stage (including the `nodejs` install and the
      `WEBTMUX_VERSION`/`WEBTMUX_COMMIT` args) and rewrite the header comment to describe
      two stages, not three. Keep `tmux-build` untouched — the protocol pin is a runtime
      concern. *(35 min)*

      ```dockerfile
      COPY --from=tmux-build /usr/local/bin/tmux         /usr/local/bin/tmux
      COPY --from=artifacts  webtmux-linux-amd64         /usr/local/bin/webtmux
      COPY --from=overlay    attach-web.sh               /usr/local/bin/attach-web.sh
      RUN chmod +x /usr/local/bin/webtmux /usr/local/bin/attach-web.sh
      ```

      The header must state where the artifact comes from and that this file never builds
      it — that pointer is the whole point of the split.

- [x] **P0** 3.2 Rewrite the build step in `launch.sh`: run `make docker-artifact`
      **unconditionally** (before the image-exists check), passing the host-computed
      `GIT_COMMIT`; then pass `--build-context artifacts=$SOURCE_DIR/builds` alongside the
      existing `overlay` context. Drop `--build-arg WEBTMUX_COMMIT` from the image build.
      *(35 min)*

      Keep the existing `safe.directory` + `git rev-parse --short HEAD` block — it now
      feeds the artifact build instead of the image build. Update the `--help` header
      (lines 2–17) to describe the two-step build.

- [x] **P1** 3.3 Make the artifact build failure-loud: if `make docker-artifact` exits
      non-zero, `launch.sh` must abort before touching the running container, so a broken
      build can never be masked by an old image still serving. *(20 min)*

- [x] **P0** 3.4 Build the run image in-container against the Phase 1 artifact and confirm
      it no longer pulls a Go or Node layer. *(30 min)*

      ```bash
      docker build -t webtmux:split -f scripts/webtmux-docker/Dockerfile \
        --build-context overlay=/workspace/scripts-webtmux-run-split/webtmux-docker \
        --build-context artifacts=/workspace/webtmux-build-split/builds \
        --build-arg TMUX_VERSION=3.5a /workspace/webtmux-build-split
      docker run --rm --entrypoint sha256sum webtmux:split /usr/local/bin/webtmux
      docker run --rm --entrypoint tmux      webtmux:split -V
      ```

      The sha must equal Phase 1.5's — same file, copied not rebuilt. Note the image
      cannot be *booted* here: it needs the host tmux socket.

      **Result:** image sha256 `066b35e3…` == the on-disk artifact's, so the image copied
      the binary rather than building one. `tmux -V` → `tmux 3.5a`. `docker history`
      confirms the image is debian-slim + libevent/ncurses + tmux + the two copied files —
      no golang or nodejs layer anywhere.

- [x] **P0** 3.5 Commit: `build: webtmux image consumes the fork's artifact instead of
      building it`. *(10 min)*

### Phase 4 — Documentation of the boundary

- [x] **P0** 4.1 `scripts/CLAUDE.md` webtmux section: replace "builds `webtmux:local` from
      the local working clone" with the two-step description, and state the ownership rule
      in one sentence (fork owns the artifact; this repo owns the deployment). Correct the
      **tmux protocol pin** bullet — it stays, but say explicitly that it is a runtime
      concern and is why the tmux stage did *not* move. *(30 min)*

- [x] **P1** 4.2 `scripts/webtmux-container/README.md`: add a short "Where these files
      live and why" section naming the three homes (host bridge here; container hooks here;
      `install_stoplight_hooks_bash.sh` in the fork as a host shell rc; `attach-web.sh` in
      the image overlay) and stating that none of the stoplight pieces belong *in* the
      webtmux image. This is the finding that replaced the "consolidate the overlay" idea.
      *(25 min)*

- [x] **P1** 4.3 `webtmux/README.md`: add a "Building" note for `make docker-artifact` as
      the no-toolchain path. Keep it short — Stage 2 rewrites the install section anyway.
      *(20 min)*

      Left alone as out of scope: the "Prebuilt binaries are available in the `builds/`
      directory" table just above. It was already wrong for this fork (it points at
      upstream `chrismccord/webtmux`), and `plan-webtmux-portable-release.md` Phase 2B
      owns rewriting that whole install section.

### Phase 5 — Host verification, merge, cleanup

- [x] **P0** 5.1 Run tests on both sides, then merge **webtmux first**, scripts second, via
      the lock wrapper (see Worktree Reference). Do not merge on a red test. *(25 min)*

      Green both sides: webtmux 119 JS store tests + `go test ./...`/`go vet ./...` (run in
      `golang:1.23-bookworm` — this container has no Go toolchain, which is the very gap
      `make docker-artifact` closes); scripts 3 + 14 move-pass tests, plus `bash -n` over
      every changed shell script. Merged `local-main` af969d2, then `scripts` master
      e2a95f9. Stage 1's gate now passes against `local-main`.

- [x] **P0** 5.2 Write `/workspace/claude_run_me_4417.sh` for the user to run **on the
      host** — the only place `launch.sh` will run (it hard-refuses under the secure
      daemon). The script must: *(35 min)*

      1. print the currently-running container's build id, for a before/after comparison;
      2. run `bash /workspace/scripts/webtmux-docker/launch.sh --rebuild`;
      3. assert `builds/webtmux-linux-amd64` was produced and is newer than the run;
      4. `docker run --rm --entrypoint sha256sum webtmux:local /usr/local/bin/webtmux` and
         compare it to the artifact's sha on disk — this is the proof that the image
         *copied* the artifact rather than rebuilding it;
      5. `curl -u` the served page and confirm HTTP 200 plus a non-`dev` build stamp;
      6. write everything to `/workspace/claude_run_me_4417.results.txt`.

      Each step gets a comment saying **why**, per root `CLAUDE.md`.

      Written and syntax-checked. Two checks added beyond the six: a BuildKit
      precondition (Risk 1 — a host `DOCKER_BUILDKIT=0` would fail `--build-context`
      confusingly, so it is named up front rather than diagnosed after), and a
      `docker history` grep proving no Go/Node layer survives in the image. The
      artifact-freshness test is an mtime-vs-build-start comparison, which is what
      actually distinguishes "the unconditional build fired" from "a stale file was
      already there".

- [x] **P0** 5.3 Read the results file. If the two shas
      differ, the run image is still building its own binary — stop and fix before marking
      the plan complete. *(20 min)*

      This is the one task that cannot be done from the agent container: `launch.sh`
      hard-refuses to run under the secure daemon (the host tmux socket must never enter
      the sandbox), so the deploy check must be user-executed. Everything it verifies has
      an in-container analogue that already passed — 1.5 (artifact builds, statically
      linked, right size), 3.4 (image sha == artifact sha, no toolchain layer) — so what
      5.3 adds is specifically the *host* claims: host BuildKit, host tmux protocol pin,
      and the service actually serving. Hand `/workspace/claude_run_me_4417.sh` to the
      user and read back `/workspace/claude_run_me_4417.results.txt`.

- [x] **P0** 5.4 Mark the plan complete, commit it on both `local-main` and scripts
      `master`, and confirm both worktrees were removed by the wrapper. *(15 min)*

      Both worktrees removed by the wrapper (`git worktree list` is clean in both repos;
      neither directory remains) — as were the two follow-up fix worktrees. Plan complete:
      5.3 passed on host run 2.

---

## Risks

1. **`--build-context` needs BuildKit.** Already relied on for `overlay`, and buildx
   v0.34.1 is present in-container — but a host docker with `DOCKER_BUILDKIT=0` would fail
   confusingly. 5.2 surfaces this on the host before it matters.
2. **`builds/` untracking races the release plan.** If someone starts
   `plan-webtmux-portable-release.md` concurrently, both try `git rm --cached builds/`. The
   second is a harmless no-op, but Phase 2.2's amendment is what prevents the confusion —
   do it in the same commit series, not later.
3. **Cross-repo merge order.** Merging scripts first leaves `launch.sh` calling a
   `docker-artifact` target that does not exist on `local-main`. 5.1 fixes the order; if a
   merge fails, stop rather than merging the other side alone.
4. **`local-main` churn.** Five live worktrees. Always `--no-ff`; if the wrapper reports
   non-fast-forward, rebase and retry — never force.
5. **The run image cannot be booted in-container** (no host tmux socket), so "it builds"
   and "it works" are separate claims. Only 5.2 establishes the second.
6. **Deleting the go-build stage loses the Node parse-guard from the deploy path.**
   `make check-js` still runs — but now in the artifact build. Confirm in 1.5 that a
   deliberately broken JS file still fails `make docker-artifact`.

## Next steps

1. Execute Phase 0 → 4 in-container (all verifiable here).
2. Hand `/workspace/claude_run_me_4417.sh` to the user for the host deploy check.
3. Then the portable stages proceed in their planned order (0 → 3 → 1 → 2) against the
   amended tasks.

**File:** `plan-webtmux-build-run-split.md` (this).
