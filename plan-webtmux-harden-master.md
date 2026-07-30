# Plan: webtmux harden — close the design-level holes the full-fork review found

`plan-webtmux-harden-master.md` — created 2026-07-26. **Master plan** for `/workspace/webtmux`
(branch `local-main`). Source: the six-audit review of the whole fork delta (`6852248..HEAD`)
whose quick fixes landed as merge `1639423`. This plan set takes on everything that was
deliberately deferred because it needed a design decision, not a drive-by patch.

**Gate:** none for subplans A–C (the review fixes are merged; nothing else is in flight on
their surface). Subplan D (PR prep) is **hard-gated** on A–C being merged, and has
conditional tasks that drop out if `plan-webtmux-portable-vendor.md` / `-release.md` land
first (they subsume the CDN and `builds/` items). The portable plan set touches asset
loading/build/launcher only — no overlap with A–C's surface (state-store, controller,
webtty guards).

## Worktree

The master plan itself needs no worktree — it only sequences subplans and tracks status.
Each subplan declares its own worktree off `/workspace/` and merges through
`scripts/git-merge-worktree.sh <worktree> --target local-main --no-ff --remove`
(never raw merge; local-main is churned by concurrent agents). Plan files are committed to
`local-main` before execution starts and copied into each worktree at setup.

## Subplans (execute in this order; A and C may run in parallel if desired — disjoint files)

| # | Subplan | Scope | Status |
|---|---------|-------|--------|
| A | `plan-webtmux-harden-state.md` | Frontend @wt_state sync protocol: cold-cache clobber, recents signature poisoning, rev divergence, flush loss, per-server cache, recency pruning | [x] merged `2341dd7` |
| B | `plan-webtmux-harden-guards.md` | Backend write authority: permitWrite gating matrix, savepath confinement, cross-session mutation fallbacks, capture fan-out cap | [x] merged `5a83b7c` |
| C | `plan-webtmux-harden-parse.md` | Backend robustness: controller identity-field races, comma/pipe field parsing, exact `-t` targeting, ws read limits | [x] merged `477310b` |
| D | `plan-webtmux-harden-prep.md` | Upstream-PR branch: strip plan files/builds/dead gotty bundle, genericize stoplight installer, scrub personal-environment strings | [x] merged `a33f4fd` |

## Ordering rationale

- **A first (or parallel with C):** the cold-cache clobber is the only active data-loss
  path a normal user can hit today; it is pure frontend (state-store.js, split-manager.js,
  pip-overlay.js, recents-strip.js) and its test suite is the fast `node --test test/`.
- **B before D:** permitWrite gating and savepath confinement change protocol behavior an
  upstream reviewer will ask about; land and soak them locally first.
- **C independent:** pkg/tmux + server files only; the mutex work must not interleave with
  another backend subplan's edits to `controller.go`, so B and C are serialized (B → C or
  C → B, either order, one merged before the other starts).
- **D last:** it constructs a `pr/upstream` branch from a settled local-main; running it
  early would just mean redoing it.

## Verification bar (applies to every subplan)

- JS: `node --test test/` green + `make check-js` + bindata re-synced (`make sync-assets`).
- Go: `docker run --rm -v <worktree>:/src -w /src -e GOFLAGS=-mod=mod golang:1.23 sh -c
  "go vet ./... && go test -race -count=1 ./..."` — the container has no Go toolchain.
- New behavior gets a test in the same style the repo already uses (pure-module `.mjs`
  tests; Go table tests with the fake-runner seam).
- Live browser verification where UI behavior changed: throwaway container per
  memory `webtmux-verify-in-throwaway-container` / playwright image; host prod untouched.

## Subagent guidance

Each subplan phase is sized for one subagent run (Sonnet for mechanical/parse/test tasks,
Opus for the protocol-design-sensitive tasks in A and B). Keep the main context to
sequencing + review; hand file-level implementation to subagents with the plan section
pasted into the prompt.

## Explicitly out of scope (tracked, not planned here)

Work-alert flash persistence across reload, the orphaned `renderer.webgl` setting,
hover-preview Esc from toolbar hovers, Ctrl+P print shadowing, state ingestion from
non-primary units — smaller UX items from the review's low tier; revisit after A–D.

## Completion

- [x] A merged to local-main, plan marked complete
- [x] B merged to local-main, plan marked complete
- [x] C merged to local-main, plan marked complete
- [x] D executed; `pr/upstream` branch exists and builds clean — `ddb02c6`, regenerated
      from the merged local-main by `scripts/make-upstream-pr.sh`
- [x] Memory note `webtmux-review-deferred-findings` updated to point here / pruned
- [x] CLEANUP mode: retire this plan set — this commit marks the set complete; the
      deletion follows immediately after, and these merge commits are the record
      (`2341dd7` A, `477310b` C, `5a83b7c` B, `a33f4fd` D)

## Outcome

All four subplans merged to `local-main` on 2026-07-30. Each was verified before merge:
JS suite 203 → 253 tests, `go vet` + `go test -race` green, `make check-js` /
`sync-assets` / `test-hooks`, and a real-browser Playwright driver per subplan
(`screenshots/harness/verify-state-sync.js`, `verify-parse.js`, `verify-guards.js`).
Subplan A's driver was also run against the pre-fix commit and failed exactly the three
checks describing the bug, so the harness is not vacuous.

Deviations that changed the design, all decided during execution and documented in the
subplan files before deletion:

- **C:** tmux's `=name` exact-match is not universal — target-pane commands need `=name:`
  and `set-option -t` accepts neither (targets `#{session_id}` instead). Following the
  plan literally would have broken copy mode, scroll and the session-identity read.
- **C:** the plan's "`enumSep` NUL approach already in the codebase" did not exist;
  session-id indirection is the workable form of that intent.
- **B:** there was no "existing toolbar error toast" to surface refusals on — a transient
  toolbar notice was added, and only deliberate refusals (`tmux.ErrRefused`) reach the
  client, so ordinary tmux races stay logged-and-silent.
- **D:** the delegate patterns went to a repo site file (`scripts/stoplight-delegates.env.sh`,
  sourced only when `WT_STOPLIGHT_DELEGATES` is unset) rather than to a host bashrc line,
  so the live host keeps working without a manual edit. The Dockerfile `js-build` stage
  the plan meant to strip no longer exists.

Still open, deliberately: the review's low-tier UX items listed under "Explicitly out of
scope" above.
