# Plan: webtmux portable — offline UI, real releases, and a one-command SSH launcher

`plan-webtmux-portable.md` — created 2026-07-25. A **master plan** for the webtmux fork
(`/workspace/webtmux`, branch `local-main`), the browser front-end also shipped by
`scripts/webtmux-docker/`.

**No gate.** The two pre-existing plans in this repo — `plan-webtmux-split.md` (19/19) and
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

Four stages, executed in the order **0 → 3 → 1 → 2** *(revised 2026-07-26 — see Revision
history)*, each its own subplan and worktree:

| Order | Stage | Subplan | Role |
|---|---|---|---|
| 1st | 0 | `plan-webtmux-portable-fork.md` | **User-executed.** Migrate to your own GitHub fork — the canonical origin everything else references. |
| 2nd | 3 | `plan-webtmux-portable-launcher.md` | **The actual deliverable.** Gates only on Stage 0. Its staleness mechanism is the embedded payload's **content sha**, not a version tag, so it does not need Stage 2 first; payloads are dev-stamped until Stage 2 lands. |
| 3rd | 1 | `plan-webtmux-portable-vendor.md` | Offline UI: the page pulls Tailwind/lit/xterm from CDNs at runtime — no internet means a blank screen. Also drops ~2.6 MB of dead embedded assets. Lands behind the launcher; a payload rebuild picks it up automatically (new sha ⇒ redeploy). |
| 4th | 2 | `plan-webtmux-portable-release.md` | Semver tags + **GitHub Releases** publishing. Binaries leave git. Formalizes distribution of webtmux *and* launcher binaries. |
| — | D | `plan-webtmux-portable-deps.md` | **Optional, gates nothing.** Dependency audit: 16 modules → 4, dropping three unmaintained packages that have one call site each. |

Each stage merges to `local-main` before the next begins.

**Why the launcher no longer waits for Stages 1–2:** the mechanism actually built for
payload staleness is the content-addressed sha, not the semver tag — and the Mac browser
in the target workflow has internet, so vendoring isn't on the launcher's critical path.

**Why binaries leave git:** launcher binaries embed *gzipped* payloads, which neither
delta- nor re-compress — committed-binary growth would be roughly **30 MB packed per
release**, not the 4–6 MB originally estimated from plain Go binaries. GitHub Releases
(available once Stage 0 lands) removes the growth entirely and gives a one-line curl
install.

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

- **GitHub Releases, not binaries in git** *(revised 2026-07-26)*. The original
  binaries-in-git choice predated the Stage 0 GitHub migration and its growth estimate
  didn't survive the launcher: embedded gzip payloads don't delta-compress, so real growth
  is ~30 MB packed per release. Releases cost a `gh release create` step per release
  (user-executed — the agent has no GitHub access) and require target machines to reach
  github.com at install time; in exchange the repo stays clone-sized and install is one
  curl. Existing committed binaries get untracked in Stage 2 — history keeps the old blobs
  (sunk cost, no rewrite: it would break the seven live worktrees).
- **`--no-auth` + a 32-char secret path** for launcher sessions, instead of basic auth.
  Chrome dropped `http://user:pass@host` URLs, so keeping basic auth means typing a
  password every launch, which defeats the purpose. Both ends bind `127.0.0.1`, so reaching
  the server needs either the SSH-authenticated tunnel or a local account. Stated plainly:
  **a local user on either machine who learns the secret path gets a shell.** A `--auth`
  flag is provided for shared boxes.
- **Vendored assets are committed, not fetched at build time.** `scripts/vendor-assets.sh`
  is the only networked step and is deliberately *not* wired into `make build` — otherwise
  the offline build would require internet, the exact opposite of the goal.
- **Nothing binary is committed.** Payload `.gz` files are gitignored (derived, rebuilt by
  `make launcher`); webtmux and launcher binaries ship as Release assets once Stage 2
  lands, and are plain local builds before that.

## What this enables

- Run webtmux on any Linux box from a Mac with one command and no SSH knowledge.
- A UI that boots on an air-gapped network.
- Binaries that can say what they are (`webtmux --version` → `v0.1.0`), verifiable against
  the release's `SHA256SUMS` asset.
- ~2.6 MB smaller binaries, and a repo that stops growing with every release.

---

## Worktree

Each subplan declares its own worktree and branch. This master plan creates none.

| Stage | Branch | Worktree |
|---|---|---|
| 0 | *(none — remote reconfiguration, user-executed)* | — |
| 1 | `feat/portable-vendor` | `/workspace/webtmux-portable-vendor` |
| 2 | `chore/portable-release` | `/workspace/webtmux-portable-release` |
| 3 | `feat/portable-launcher` | `/workspace/webtmux-portable-launcher` |

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

> **Execution order: Phase 0 → Phase 3 → Phase 1 → Phase 2.** The sections below stay in
> numeric order so task IDs and cross-references remain stable — do NOT execute them top
> to bottom.

### Phase 0 — GitHub fork migration · `plan-webtmux-portable-fork.md` *(user-executed)*

- [ ] **P0** 0.1 Create an **empty** GitHub repo (no README/licence init)
- [ ] **P0** 0.2 Push `local-main` **first**, then `main` and tags
- [ ] **P0** 0.3 Keep the branch name `local-main`; set it as GitHub's default
- [ ] **P0** 0.4 Repoint `origin`; `git remote set-url --push upstream DISABLED`
- [ ] **P1** 0.5 Keep or retire the Dropbox/SSH bare repo
- [ ] **P0** 0.6 Decide public vs private (only changes whether the Release-asset curl needs a token) → feeds Stage 2
- [ ] **P1** 0.7 Preserve `LICENSE`; add a one-line attribution to README
- [ ] **P0** 0.8 Verify the gate passes

### Phase 1 — Offline UI · `plan-webtmux-portable-vendor.md`

- [ ] **P0** 1.1 Create worktree `feat/portable-vendor`
- [ ] **P0** 1.2 Delete ~2.6 MB of dead embedded assets + the legacy `js/` webpack tree
- [ ] **P0** 1.3 Write `scripts/vendor-assets.sh` (bundles lit, fetches @xterm, guards)
- [ ] **P0** 1.4 Repoint `index.html` — importmap, xterm CSS, drop Tailwind
- [ ] **P0** 1.5 Add the four CSS rules Tailwind's preflight was silently providing
- [ ] **P0** 1.6 Repoint the two **shadow-root** xterm CSS links (easy to miss)
- [ ] **P1** 1.7 Fix the `sync-assets` / `assets` Makefile footguns
- [ ] **P0** 1.8 Verify offline (static greps, `--network none` boot, binary grep)
- [ ] **P0** 1.9 Merge + cleanup

### Phase 2 — Real releases · `plan-webtmux-portable-release.md`

- [ ] **P0** 2.1 Create worktree `chore/portable-release`
- [ ] **P0** 2.2 Untrack `builds/` (gitignore + `git rm --cached`) — binaries become Release assets
- [ ] **P1** 2.3 `checksums` + `release-binaries` targets; add `.dockerignore`
- [ ] **P0** 2.4 Rewrite the README install path (curl from `releases/download/…`; currently points at **upstream**)
- [ ] **P0** 2.5 Cut `v0.1.0` — tag, build from the tag, `gh release create` *(user-executed)*
- [ ] **P0** 2.6 Merge + cleanup

### Phase 3 — The launcher · `plan-webtmux-portable-launcher.md`

- [ ] **P0** 3.1 Create worktree `feat/portable-launcher`
- [ ] **P0** 3.2 Scaffold `cmd/webtmux-launch/` + embedded payload + Makefile targets
- [ ] **P0** 3.3 SSH layer: one option set on **every** invocation (`ControlMaster=auto` + keepalives, so whichever call becomes master carries them); one-round-trip probe
- [ ] **P0** 3.4 **Adopt** an already-running webtmux when present (skips deploy/create/launch)
- [ ] **P0** 3.5 Content-addressed deploy (sidesteps `ETXTBSY`) + attach script + **detached** base session
- [ ] **P0** 3.6 Port allocation + secret path, **persisted per-target** (`~/.config/webtmux-launch/`) so the URL survives launcher restarts; the supervised `ssh -L` command
- [ ] **P0** 3.7 Readiness poll + browser launch (once, never on reconnect)
- [ ] **P0** 3.8 Supervisor: backoff, restart, clean teardown — **setup stays out of the restart loop**
- [ ] **P1** 3.9 Flags, error messages, `--version`
- [ ] **P0** 3.10 End-to-end tests: attach-vs-create, durability, split-view, reconnect cost
- [ ] **P1** 3.11 README section; formal launcher publishing lands with Stage 2's first Release
- [ ] **P0** 3.12 Merge + cleanup

---

## Risks

**Browser-only failure modes** — no headless browser exists in this container, so the CSS
cascade cannot be executed here. Ranked:

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

4. `make clean` deletes `builds/` — six *tracked* deletions until Stage 2 untracks the
   directory (which resolves this permanently). Until then, check `git status` after any
   `make clean`/`cross-compile` on a tree with committed binaries.
5. `check-js` does not glob `vendor/`, so a corrupt vendored file ships silently.
   Mitigated by the guard in `vendor-assets.sh` and a size assertion on `lit.js`.
6. `local-main` churn — always `--no-ff`, always re-verify after merge.

**Launcher risks:**

7. Remote port collision on a busy shared box (mitigated by `ExitOnForwardFailure` + retry).
8. `gzip` assumed present on the remote — detect in the probe, fail clearly.
9. Payload staleness: `make launcher` must always rebuild the payload or you ship a
   launcher embedding an old webtmux. Content-addressed install paths make this visible.

---

## Next steps

1. User executes Stage 0 (`plan-webtmux-portable-fork.md`) and reports the public/private
   decision from 0.6.
2. Execute Stage 3 (`plan-webtmux-portable-launcher.md`) — the deliverable.
3. Then Stage 1 (vendor; finish with the 20-second browser check), then Stage 2 (first
   published Release, including launcher binaries).

**Files:** `plan-webtmux-portable.md` (this) plus the `-fork`, `-launcher`, `-vendor`,
`-release`, and `-deps` subplans.

## Revision history

- **2026-07-25** — initial plan set: order 0→1→2→3, binaries committed in `builds/`.
- **2026-07-26** — review pass. Distribution → **GitHub Releases** (committed-binary
  growth was underestimated ~6× once launcher payloads exist — embedded gzip doesn't
  delta-compress); execution order → **0→3→1→2** (the sha, not the tag, is the launcher's
  staleness mechanism); `--pass-headers` downgraded from required to verify-first (the
  production compose command omits it and split-view works); SSH keepalives moved onto
  whichever invocation becomes the mux master; adopt-mode gains container detection and
  honest credential-recovery limits; per-target URL persistence added.
