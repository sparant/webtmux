# Plan: webtmux portable — offline UI, real releases, and a one-command SSH launcher

`plan-webtmux-portable.md` — created 2026-07-25. A **master plan** for the webtmux fork
(`/workspace/webtmux`, branch `local-main`), the browser front-end also shipped by
`scripts/webtmux-docker/`.

**One gate, on Stage 1 only** *(added 2026-07-26; satisfied same day)*: the build/run split must
merge to `local-main` before `plan-webtmux-portable-vendor.md` starts — that plan revives
the root `Dockerfile` as the artifact builder, which Stage 1 task 1.2 was going to delete.
The gate command lives in the vendor subplan. Stages 0, 2, and 3 are unaffected.

The two pre-existing plans in this repo — `plan-webtmux-split.md` (19/19) and
`plan-webtmux-capture-expose.md` (22/22) — are both fully complete and merged. This plan
touches none of their surface (it changes asset loading, the build, and adds a new
binary; it does not touch `SplitManager`, `TerminalUnit`, or the capture store). Both are
retirement candidates under CLEANUP mode.

---

## Goal

Make webtmux genuinely usable **across machines**: one command on a Mac that ships
webtmux to a Linux box, runs it, tunnels the port back, keeps both alive, and opens the
browser — with a UI that works even when nothing has internet.

Today that workflow is: SSH in, start webtmux, keep it alive, set up a port forward, keep
*that* alive, paste a URL. Too many steps for anyone not already fluent in SSH
forwarding.

## Approach

Five stages, executed in the order **D → 0 → 2 → 3 → 1** *(revised 2026-07-26, second
pass — see Revision history)*, each its own subplan and worktree:

| Order | Stage | Subplan | Role |
|---|---|---|---|
| 1st | D | `plan-webtmux-portable-deps.md` | **Minimize dependencies first**, so every later stage is working against a smaller surface. 16 modules → 4; three unmaintained packages with one call site each. Cheapest here: D2.2 (urfave/cli v2→v3) costs far less *before* the launcher is written against v2's API. |
| 2nd | 0 | `plan-webtmux-portable-fork.md` | **User-executed.** Fork `chrismccord/webtmux` on GitHub — the public home and the host the launcher downloads from. It is *not* the working repo's `origin`; that stays the Mac bare (chain topology). |
| 3rd | 2 | `plan-webtmux-portable-release.md` | Semver tags + **GitHub Releases** publishing — the distribution channel for people who aren't you. *(No longer blocks Stage 3; see the local-source note below.)* |
| 4th | 3 | `plan-webtmux-portable-launcher.md` | **The actual deliverable.** Gets the right webtmux for the target platform — from a GitHub Release, or from a local build directory — and installs it over SSH. |
| 5th | 1 | `plan-webtmux-portable-vendor.md` | **Optional.** Removes the runtime CDN dependency and drops ~2.6 MB of dead assets. No longer required — air-gap support is a nice-to-have, not a goal. **Gated on the build/run split — satisfied `af969d2`.** |

Each stage merges to `local-main` before the next begins.

**Independent builds — the change that shapes everything else.** The launcher does **not**
embed webtmux. It resolves the target's platform over SSH, obtains the matching binary on
the Mac, and pushes it over the connection it already has open.

That kills a combinatorial coupling: with embedding, every webtmux change forced a rebuild
*and republish* of every launcher binary, and each launcher carried the sum of all target
payloads (~15 MB). Now the two ship on **independent cadences** — a webtmux fix reaches
every existing launcher with no launcher release at all — and the launcher stays ~5 MB.

**Two binary sources, one interface** *(added 2026-07-27)*. "Obtains" means a GitHub
Release asset **or** a local build directory (`WEBTMUX_LAUNCH_SOURCE=./builds`), selected
by config and differing only in how the bytes and their sha are read. `make cross-compile`
already writes the *same* filenames the release publishes, so a checkout is a drop-in
substitute for a release.

**Consequence for ordering: Stage 3 no longer gates on Stage 0 or Stage 2.** The launcher
can be built and tested end-to-end today, against local builds, with no fork and no
published release. D → 0 → 2 → 3 remains the recommended order — it is the shortest path
to something a stranger can use — but it is now a preference. Only the fetch-path tests
and launcher-asset publishing are deferred until the GitHub migration lands.

**Why targets never need internet:** the Mac fetches and pushes over SSH, so the target
needs neither github.com reachability nor `curl`/`wget`. The Mac is the user's laptop; it
has internet by definition in this workflow.

**Why binaries stay out of git:** `builds/` was untracked by the build/run split
(`af969d2`) because the artifact build writes there. Releases keep that intact and cost
one `gh release create` per release.

## Key design decisions

**Local forward, not a reverse tunnel.** What's wanted is `ssh -L 8080:127.0.0.1:8080
host`, initiated *from* the Mac. `-L` is the easy direction and lets the whole launcher
live in one process on the client. `ssh -R` would only be needed if the Linux box were
unreachable from the Mac — explicitly out of scope.

**Launching its own webtmux is the primary path** — the launcher works on a machine that
has never seen it, with no config and nothing pre-deployed. **Adopt before you launch** is
an optimisation on top: if an instance is already running (the normal case on these
machines), connect to *that* rather than starting a duplicate. It skips deploy, session
creation, and launch entirely, and the launcher tears down only its tunnel, leaving an
adopted process running.

The two checks are independent: adoption is triggered by "an instance is running", **not**
by detecting a durability problem. Durability detection (systemd `KillUserProcesses`)
never changes what the launcher does — it only changes what it reports afterward. They
connect in one direction: if the user acts on that advice and stands up a persistent
webtmux, the next run adopts it automatically.

**webtmux is disposable; tmux holds the state.** In *launch* mode, this is what makes
"keep it alive" tractable. One SSH invocation carries both the forward and the remote
process:

```
ssh -L <local>:127.0.0.1:<remote> host 'exec webtmux … tmux new-session -A -s main'
```

Connection dies → webtmux dies with it. No PID files, no orphan reaping, no remote
supervision. The launcher restarts the whole thing and the tmux panes are exactly where
they were. Two hard problems collapse into one supervised subprocess.

**Shell out to the system `ssh`.** It inherits `~/.ssh/config`, `ProxyJump` bastions,
ssh-agent, 1Password/YubiKey, `known_hosts`, and 2FA for free. Reimplementing that with
`x/crypto/ssh` is exactly the "complicated for people" surface we're trying to remove.

**Assets land under `resources/js/vendor/`, including the CSS.** `sync-assets` already
copies `resources/js/*` recursively and `server/server.go:301` already routes `js/` to the
embedded FS — so this requires **zero Makefile and zero Go changes**. A top-level
`resources/vendor/` would 404 against the explicit allow-list at `server.go:299-308`.

## Trade-offs

- **GitHub Releases, not binaries in git** *(revised 2026-07-26)*. Keeping artifacts
  committed — as upstream did — was reconsidered and declined: the build/run split already
  untracked `builds/` because the artifact build writes there, and re-tracking it would
  dirty the tree on every build. Releases cost one `gh release create` per release
  (user-executed — the agent has no GitHub access). Target machines are unaffected either
  way, since the Mac does the downloading. History keeps the old pre-split blobs (sunk
  cost, no rewrite: it would invalidate every clone and force the Mac bare to be
  rebuilt).
- **The launcher fetches instead of embedding** *(added 2026-07-26, second pass; revised
  2026-07-27)*. Costs a network round-trip on first deploy to a given platform (cached
  thereafter). Buys decoupled release cadences, a launcher that stays ~5 MB, and no
  rebuild-everything-on-every-webtmux-change. The bootstrapping constraint this originally
  carried — "a release must exist before the launcher works" — is **gone**: a local build
  directory is a first-class source, not just an escape hatch.
- **`--no-auth` + a 32-char secret path** for launcher sessions, instead of basic auth.
  Chrome dropped `http://user:pass@host` URLs, so keeping basic auth means typing a
  password every launch, which defeats the purpose. Both ends bind `127.0.0.1`, so reaching
  the server needs either the SSH-authenticated tunnel or a local account. Stated plainly:
  **a local user on either machine who learns the secret path gets a shell.** A `--auth`
  flag is provided for shared boxes.
- **Vendored assets are committed, not fetched at build time.** `scripts/vendor-assets.sh`
  is the only networked step and is deliberately *not* wired into `make build` — otherwise
  the offline build would require internet, the exact opposite of the goal.
- **Nothing binary is committed.** webtmux and launcher binaries ship as Release assets;
  `builds/` holds local artifacts and stays gitignored.

## What this enables

- Run webtmux on any Linux box from a Mac with one command and no SSH knowledge.
- Ship a webtmux fix to every existing launcher **without releasing a new launcher**.
- Target machines that need no internet, no `curl`, and no pre-installed webtmux.
- Binaries that can say what they are (`webtmux --version` → `v0.1.0`), verifiable against
  the release's `SHA256SUMS` asset.
- A smaller dependency surface (16 modules → 4) before any of the above is built on it.
- *(Optional, via Stage 1)* a UI with no runtime CDN dependency — resilient to jsdelivr
  being slow or down, and usable air-gapped.

---

## Worktree

Each subplan declares its own worktree and branch. This master plan creates none.

| Stage | Branch | Worktree |
|---|---|---|
| D | `chore/portable-deps` | `/workspace/webtmux-portable-deps` |
| 0 | *(none — remote reconfiguration, user-executed)* | — |
| 2 | `chore/portable-release` | `/workspace/webtmux-portable-release` |
| 3 | `feat/portable-launcher` | `/workspace/webtmux-portable-launcher` |
| 1 | `feat/portable-vendor` | `/workspace/webtmux-portable-vendor` |

### Worktree Reference — read before every execution session

```bash
# Create (first step of each subplan)
git -C /workspace/webtmux worktree add /workspace/webtmux-portable-<stage> \
    -b <branch> local-main
cp /workspace/webtmux/plan-webtmux-portable*.md /workspace/webtmux-portable-<stage>/

# Merge + clean up (last step of each subplan) — run tests FIRST
/workspace/scripts/git-merge-worktree.sh /workspace/webtmux-portable-<stage> \
    --target local-main --no-ff --remove
```

**`--no-ff` is mandatory, never `--ff-only`.** `local-main` is churned by concurrent
agents (it moved from `7a5c5ef` to `f34c949` during this plan's authoring alone), so a
fast-forward will fail. Never run raw `git merge` or `git worktree remove` — all
`/workspace/webtmux-*` worktrees share one `.git` object store and ref namespace, and
concurrent instances race on `packed-refs`.

**All edits happen inside the worktree.** If you are about to edit a file in
`/workspace/webtmux/`, stop — you are in the wrong directory. The one exception is the
plan files themselves at creation time; update the worktree copies during execution and
commit both at cleanup.

**A branch alone does not deploy.** The host container rebuilds from `local-main`, so
nothing is live until merge **and** `bash /workspace/scripts/webtmux-docker/launch.sh
--rebuild`.

---

## Phases

Detail lives in the subplans. This is the roll-up.

> **Execution order: Phase D → Phase 0 → Phase 2 → Phase 3 → Phase 1.** The sections
> below stay in numeric order so task IDs and cross-references remain stable — do NOT
> execute them top to bottom.

### Phase D — Dependency minimization · `plan-webtmux-portable-deps.md` ✅ **COMPLETE 2026-07-27**

**16 modules → 3, zero indirect dependencies** (one better than the target of 4 —
`creack/pty` v1.1.24 had already dropped `golang.org/x/sys`). Merged to `local-main`.

- [x] **P0** D1.2 Drop `yudai/hcl` (2015, unmaintained; 1 call site) — takes 3 modules with it
- [x] **P0** D1.3 Drop `NYTimes/gziphandler` (archived; 1 call site) — ~60 lines of middleware
- [x] **P1** D1.4 Drop `fatih/structs` (stale since 2018; 5 call sites, `reflect` already imported)
- [x] **P1** D1.5 Bump `gorilla/websocket` → v1.5.3, `creack/pty` → v1.1.24
- [x] **P2** D2.1 Drop `pkg/errors` (archived; 58 call sites, mechanical)
- [x] **P2** D2.2 Migrate `urfave/cli` v2 → v3 (sheds 3 more modules; **do before the launcher**)
- [x] **P0** D3.1 Make `@xterm/addon-webgl` a dynamic import (104 KB never fetched; it is default-off)
- [x] **P1** D3.2 Reconcile the dead `EnableWebGL` server option

> **For Stage 3.** The launcher is a second `main`: write it against **urfave/cli v3**
> (`cli.Command`, not `cli.App`). v3 parses flags anywhere on the line unless
> `StopOnNthArg` is set — that difference silently broke `webtmux … tmux new-session -A`
> and was caught only by booting the binary. The "launcher adds zero dependencies"
> claim now starts from **3** modules, not 16.

### Phase 0 — GitHub fork · `plan-webtmux-portable-fork.md` *(user-executed)*

*(Rewritten 2026-07-27 for the **chain** topology — `container --sync-all-repos--> Mac bare
--> GitHub`. The GitHub fork is a publishing mirror hanging off the Mac bare, **not** the
working repo's `origin`. Renumbered to 0.1–0.10; see the subplan's "Topology" section.)*

- [ ] **P0** 0.1 **Fork `chrismccord/webtmux`** on GitHub (the Fork button)
- [x] **P0** 0.2 ~~Complete the Mac backup first~~ — **discharged 2026-07-28**, the 11
      unbacked branches were merged into `local-main` and deleted
- [ ] **P0** 0.3 Give the **Mac** GitHub credentials — leg 2 originates there, not on the host
- [ ] **P0** 0.4 Add the `github` remote **on the Mac bare** and push `local-main`; set it
      as GitHub's default branch
- [ ] **P0** 0.5 Delete any tags inherited from upstream (they poison `git describe --tags`)
- [ ] **P0** 0.6 Leave the working repo's `origin` on the Mac and add **no** GitHub remote
      (a remote named `github` sorts ahead of `origin` and silently redirects the backup);
      `git remote set-url --push upstream DISABLED`
- [ ] **P1** 0.7 Optionally automate leg 2 with a `post-receive` hook on the bare
- [ ] **P0** 0.8 Confirm the fork is **public** (unauthenticated Release downloads)
- [ ] **P1** 0.9 Preserve `LICENSE`; the fork badge supplies attribution
- [ ] **P0** 0.10 Verify the chain end to end (both legs; the gate is now the *inverse* of
      the pre-2026-07-27 one — `origin` must be the **Mac**)

### Phase 1 — Remove the runtime CDN dependency · `plan-webtmux-portable-vendor.md` *(OPTIONAL, last)*

- [ ] **P0** 1.1 Create worktree `feat/portable-vendor`
- [ ] **P0** 1.2 Delete ~2.6 MB of dead embedded assets + the legacy `js/` webpack tree
- [ ] **P0** 1.3 Write `scripts/vendor-assets.sh` (bundles lit, fetches @xterm, guards)
- [ ] **P0** 1.4 Repoint `index.html` — importmap, xterm CSS, drop Tailwind
- [ ] **P0** 1.5 Add the four CSS rules Tailwind's preflight was silently providing
- [ ] **P0** 1.6 Repoint the two **shadow-root** xterm CSS links (easy to miss)
- [ ] **P1** 1.7 Fix the `sync-assets` / `assets` Makefile footguns
- [ ] **P0** 1.8 Verify offline (static greps, `--network none` boot, binary grep)
- [ ] **P0** 1.9 Merge + cleanup

### Phase 2 — Real releases · `plan-webtmux-portable-release.md` ✅ **COMPLETE 2026-08-02**

**v0.1.0 is published:** https://github.com/sparant/webtmux/releases/tag/v0.1.0 — seven
assets, public, no token needed. Verified unauthenticated end to end (all six binaries
re-downloaded and checked against the published `SHA256SUMS`; README install flow run
verbatim against the live URLs).

- [x] **P0** 2.1 Create worktree `chore/portable-release`
- [x] **P0** 2.2 **Verify only** — `builds/` already untracked by the build/run split
- [x] **P1** 2.3 `checksums` + `release-binaries` targets; the dead payload line was already gone (Stage 3 dropped it)
- [x] **P0** 2.4 Rewrite the README install path (curl from `releases/download/…`; the upstream URLs were already fixed by `66d07e0` — what was stale was `builds/`)
- [x] **P0** 2.5 Cut `v0.1.0` — tagged, built from the tag, published, verified. Needed three runs and produced two script fixes plus a new Mac-side `create-webtmux-release.sh`
- [x] **P0** 2.6 Merge + cleanup

### Phase 3 — The launcher · `plan-webtmux-portable-launcher.md`

- [ ] **P0** 3.1 Create worktree `feat/portable-launcher`
- [ ] **P0** 3.2 Scaffold `cmd/webtmux-launch/` + Makefile target (**no embedded payload**)
- [ ] **P0** 3.3 SSH layer: one option set on **every** invocation (`ControlMaster=auto` + keepalives, so whichever call becomes master carries them); one-round-trip probe
- [ ] **P0** 3.4 **Adopt** an already-running webtmux when present (skips fetch/deploy/create/launch)
- [ ] **P0** 3.5 **Resolve from the configured source** (GitHub Release **or** local build dir via `WEBTMUX_LAUNCH_SOURCE`) for the target's platform → push over SSH; content-addressed install (sidesteps `ETXTBSY`) + attach script + **detached** base session
- [ ] **P0** 3.6 Port allocation + secret path, **persisted per-target** (`~/.config/webtmux-launch/`) so the URL survives launcher restarts; the supervised `ssh -L` command
- [ ] **P0** 3.7 Readiness poll + browser launch (once, never on reconnect)
- [ ] **P0** 3.8 Supervisor: backoff, restart, clean teardown — **setup stays out of the restart loop**
- [ ] **P1** 3.9 Flags, error messages, `--version`
- [ ] **P0** 3.10 End-to-end tests: attach-vs-create, durability, split-view, reconnect cost — all runnable against a local source, no release needed
- [ ] **P1** 3.11 README section (incl. a **Developing** note on `WEBTMUX_LAUNCH_SOURCE`); launcher binaries publish alongside webtmux on the next Release *(publishing deferred to post-Stage 0)*
- [ ] **P0** 3.12 Merge + cleanup

---

## Risks

**Browser-only failure modes** *(Stage 1 only — now optional)* — no headless browser
exists in this container, so the CSS cascade cannot be executed here. Ranked:

1. **`box-sizing` regression (highest).** Tailwind preflight silently supplied
   `*{box-sizing:border-box}`. Without it, `.xterm { height:100%; padding:8px }` overflows
   its region by 16px and clips the bottom row of every terminal. It will present as an
   unrelated layout bug.
2. **The mobile bar covering every desktop session.** `mobile-controls.js:11-23` sets
   `:host { position:fixed; bottom:0; z-index:1000 }` with **no** media query — `lg:hidden`
   was the only thing hiding it.
3. **One bad importmap entry blanks the page.** The UI is a single ES-module graph; if
   `lit` fails to resolve, nothing executes and you get a black screen with no error
   outside devtools.

**Process risks:**

4. ~~`make clean` deletes `builds/` — six *tracked* deletions~~ — **resolved**, earlier
   than planned. The build/run split (`af969d2`) untracked `builds/` ahead of Stage
   2 because the artifact build writes there; a tracked output directory would have
   dirtied the tree on every build. Stage 2's task 2.2 is now a verification.
5. `check-js` does not glob `vendor/`, so a corrupt vendored file ships silently.
   Mitigated by the guard in `vendor-assets.sh` and a size assertion on `lit.js`.
6. `local-main` churn — always `--no-ff`, always re-verify after merge.

**Launcher risks:**

7. Remote port collision on a busy shared box (mitigated by `ExitOnForwardFailure` + retry).
8. **Bootstrapping — resolved** *(2026-07-27)*. Local sources mean the launcher works
   end-to-end with no release at all. What remains is that the **release path ships
   untested** until Stage 2 lands: mitigate by keeping the two backends behind one
   interface so only `Digest`/`Open` differ, never a branch through the launcher.
9. **Network required on the Mac at first deploy** to a given platform+version, on the
   release path only. Cached afterwards. A launcher with a warm cache works offline; a
   cold one does not. A local source needs no network ever.
9a. **A misconfigured local source silently falling back to a download** — looks like
   success while testing nothing you meant to test. Configured-but-invalid must be a hard
   error, and every run prints which source it used.
10. **Version resolution / sha mismatch** — a deleted release, a renamed asset, or a
    corrupted download must fail loudly with the URL it tried, never install a partial
    binary. Verify the sha before pushing anything over SSH.

---

## Next steps

1. Execute Stage D (`plan-webtmux-portable-deps.md`) — first, so everything downstream is
   built against a smaller surface.
2. User executes Stage 0 (`plan-webtmux-portable-fork.md`): fork, push **from the Mac bare**, confirm public.
3. Execute Stage 2 (`plan-webtmux-portable-release.md`) — publishes `v0.1.0`, which is
   what the launcher will fetch.
4. Execute Stage 3 (`plan-webtmux-portable-launcher.md`) — the deliverable.

   **Stage 3 may be pulled forward** ahead of 0 and 2 and run against local builds; only
   its fetch-path tests and asset publishing then wait for them. Do that if the launcher
   is the thing you actually want working, rather than blocking on a migration you have to
   run by hand.
5. Optionally Stage 1 (vendor; finish with the 20-second browser check).

**Files:** `plan-webtmux-portable.md` (this) plus the `-fork`, `-launcher`, `-vendor`,
`-release`, and `-deps` subplans.

## Revision history

- **2026-07-25** — initial plan set: order 0→1→2→3, binaries committed in `builds/`.
- **2026-07-26** — the **build/run split** (plan since retired; landed `af969d2`, host
  verified, follow-up fix `bcdbdd5`) was created and inserted **ahead of
  Stage 1**, which now hard-gates on it. That plan makes the fork's root `Dockerfile` the
  artifact builder and reduces `scripts/webtmux-docker/Dockerfile` to a run-only image; it
  also lands the `.dockerignore` and the `builds/` untracking that Stage 2 tasks 2.4 and
  2.2 had claimed (both downgraded to verifications there). Stage 1 tasks 1.2 and 1.3 are
  amended in place.
- **2026-07-26** — review pass. Distribution → **GitHub Releases** (committed-binary
  growth was underestimated ~6× once launcher payloads exist — embedded gzip doesn't
  delta-compress); execution order → **0→3→1→2** (the sha, not the tag, is the launcher's
  staleness mechanism); `--pass-headers` downgraded from required to verify-first (the
  production compose command omits it and split-view works); SSH keepalives moved onto
  whichever invocation becomes the mux master; adopt-mode gains container detection and
  honest credential-recovery limits; per-target URL persistence added.
- **2026-07-26 (second pass)** — four directional changes:
  1. **Independent builds.** The launcher no longer embeds webtmux; it fetches the target's
     platform binary from GitHub Releases to the Mac and pushes it over SSH. Deletes
     `cmd/webtmux-launch/payload/`, the `go:embed` directory trick, and the
     `launcher-payload` target. Decouples release cadences and kills the
     rebuild-everything-on-every-change coupling. *(The ~30 MB/release argument from the
     previous pass died with the payloads — Releases is retained on its own merits, chiefly
     that `builds/` is already untracked.)*
  2. **Stage 0 forks the original repo** via GitHub's Fork button, reversing the earlier
     standalone-repo recommendation.
  3. **Air-gap is no longer a requirement** — Stage 1 (vendor) drops to optional and last.
  4. **Stage D goes first** — minimize dependencies before building on them.
  Execution order → **D→0→2→3→1**; Stage 2 moves ahead of Stage 3 because the launcher
  cannot fetch a release that does not exist.
- **2026-07-27** — **local development source; Stage 3's GitHub gate removed.** The
  launcher gains a `Source` interface with two backends — a GitHub Release asset, and a
  local build directory selected by `WEBTMUX_LAUNCH_SOURCE` / `--webtmux-source` / a
  `make launcher-dev` ldflag default. They differ only in how bytes and shas are read;
  platform resolution, content-addressed install, adopt-mode build comparison, and the
  digest-before-transfer ordering are shared. This works because `make cross-compile`
  already writes the release asset names into `builds/`, making a checkout a drop-in
  substitute for a release.

  Consequently **Stage 3 no longer gates on Stage 0 or Stage 2** — it is built and tested
  now, with only the fetch-path tests (3.15e), launcher-asset publishing (3.19), and the
  `git push` in 3.20 deferred until the migration lands. Execution order **D→0→2→3→1**
  stands as a recommendation, not a constraint. New risks: a stale local build deployed
  confidently, target-cache growth per rebuild, and the release backend rotting untested —
  all addressed in the subplan's risk list.
