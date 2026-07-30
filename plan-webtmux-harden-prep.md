# Plan: webtmux harden — upstream PR prep (subplan D of plan-webtmux-harden-master.md)

Construct a clean branch (`pr/upstream`) suitable for a PR against
`github.com/chrismccord/webtmux`, without removing anything from `local-main` that we
still want locally (plan files, builds, environment-specific hook plumbing all stay on
local-main). The PR branch is a *derived artifact*, rebuilt by a script so it can be
regenerated after local-main moves.

**HARD GATE:** do not create the worktree until subplans A, B, C are merged to local-main
(check the master plan's table). Conditional tasks below drop out if the portable plan set
has landed first.

## Worktree

- Branch: `harden-prep` (tooling + doc edits that DO belong on local-main)
- Path: `/workspace/webtmux-harden-prep`
- Setup: `git -C /workspace/webtmux worktree add /workspace/webtmux-harden-prep -b harden-prep local-main`,
  copy this plan in.
- The generated `pr/upstream` branch is created BY the script inside the worktree repo,
  from local-main, and is never merged back — only `harden-prep` (the script + generic
  installer + doc scrubs) merges to local-main via
  `scripts/git-merge-worktree.sh /workspace/webtmux-harden-prep --target local-main --no-ff --remove`.

## Design decisions

1. **Derived PR branch, not a divergent fork.** `scripts/make-upstream-pr.sh` (new, lives
   in the webtmux repo) recreates `pr/upstream` from local-main head each run:
   delete-paths commit (plans, builds, dead bundle, env-specific scripts), then the
   scrub commits. Idempotent; history on that branch is disposable.
2. **What gets stripped on `pr/upstream` only:** all root `plan-*.md`; `builds/` (68 MB —
   *skip if `plan-webtmux-portable-release.md` already moved releases off-tree*);
   `bindata/static/js/gotty.js*` + root `js/` webpack project + the Dockerfile `js-build`
   stage that pretends to build it (they go together); `claude-costs`-style local files if
   any leak in.
3. **What gets *genericized* on local-main (both branches benefit):**
   - `install_stoplight_hooks_bash.sh`: parameterize the delegation list via
     `WT_STOPLIGHT_DELEGATES` (colon-separated patterns; default empty upstream — our
     claude/pi/secure-daemon patterns move to an env line in our own bashrc), path in the
     header comment becomes `/path/to/webtmux`.
   - Personal-environment strings in comments/UI: "claude Dominion-wq | review"
     (controller.go, toolbar.js), "claude-editors" (types.go, controller.go,
     split-manager.js), `placeholder="/workspace"` → neutral examples.
4. **Known upstream warts left untouched** (minimal diff beats tidiness in a PR):
   `TmuxSendCommand` accepted-but-unhandled, dead `TmuxPaneOutput`/`TmuxError`/`Unknown*`
   consts, `@TODO hashing?` — mention in the PR description instead.
5. **CDN dependencies:** *only if the portable-vendor plan has NOT landed*, note in the PR
   description that the UI loads tailwind/xterm from CDN (upstream already does); do not
   vendor here — that is `plan-webtmux-portable-vendor.md`'s job.

## Phases

### Phase 1 — genericize on local-main (P0)

- [x] P0 Stoplight installer parameterization (`WT_STOPLIGHT_DELEGATES`) + move our
      patterns to the environment side (`scripts/webtmux-container/` or bashrc snippet —
      verify the live host setup keeps working); README hook section updated to match. ~45m, Opus.
      *Done. Deviation from "an env line in our own bashrc": the agent cannot edit the host,
      and an empty upstream default would have silently stopped delegation there. So the
      patterns ship as `scripts/stoplight-delegates.env.sh`, which the installer sources ONLY
      when `WT_STOPLIGHT_DELEGATES` is unset (environment still wins) and which
      `make-upstream-pr.sh` strips — upstream keeps the empty default, the live host keeps
      working with no bashrc edit at all. Loudness per the brief: `wt_stoplight_status` names
      the resolved list and its origin, `WT_STOPLIGHT_VERBOSE=1` prints it at shell start, and
      `test/stoplight-hooks.sh` now asserts all three configurations (env-set, site-file,
      explicitly-empty) against the same command.*
- [ ] P1 Personal-string scrub sweep (decision 3 second bullet) — comments/placeholders
      only, no behavior; JS + Go grep sweep with `grep -a`. ~30m, Sonnet.

### Phase 2 — the PR-branch builder (P0)

- [ ] P0 `scripts/make-upstream-pr.sh`: recreate `pr/upstream` from local-main; strip
      paths per decision 2 (with the portable-release conditional); verify by building:
      `make check-js` + Go build in golang:1.23 docker on the stripped tree (catches a
      stripped file something still references). ~45m, Opus.
- [ ] P1 Draft `PR-DESCRIPTION.md` (kept on local-main, consumed manually): feature
      summary reusing the README's "What this fork adds" groups, the warts note
      (decision 4), CDN note (decision 5), test instructions. ~35m, Sonnet.

### Phase 3 — verify & land (P0)

- [ ] P0 Run the builder; on `pr/upstream`: full Go suite + JS suite + `make build`;
      boot the binary in a throwaway container and click through core flows (split,
      sidebar, Exposé, stoplights, save). ~40m, Opus.
- [ ] P0 Mark complete; merge `harden-prep` via the lock wrapper; tick subplan D and the
      master plan completion list. ~15m.

## Non-goals

Actually opening the PR (needs the user's say-so and their GitHub account), rebasing onto
current upstream `main` (fork point is 6852248; upstream may have moved — the builder
script leaves `pr/upstream` on our base, and a rebase is a separate decision), and any
release/versioning work (portable plan set owns that).
