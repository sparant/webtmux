# Plan: multi-machine Stage S — spike, rig, go/no-go

Subplan S of `plan-webtmux-multimachine.md`. Prove the architecture end-to-end with throwaway
code, build the two-machine rig every later stage verifies against, and probe the one unbounded
risk (interactive ssh auth) before committing weeks to the design.

**This stage's code is disposable.** Nothing here is expected to survive into Stage H except
the rig and the findings. Say so in the commit messages.

## Worktree

- Branch: `feat/mm-spike`
- Path: `/workspace/webtmux-mm-spike`
- Gate first (see master plan), then:
  `git -C /workspace/webtmux worktree add /workspace/webtmux-mm-spike -b feat/mm-spike local-main`
  and copy `plan-webtmux-multimachine*.md` into it. All edits happen there.
- Finish: tests green → `/workspace/scripts/git-merge-worktree.sh /workspace/webtmux-mm-spike --target local-main --no-ff --remove`

## Exit criteria (the go/no-go)

1. One browser tab shows two regions whose windows live on **two different tmux servers**.
2. Typing, resize, layout push, window switch and copy mode all work in the remote region with
   **no change to the remote webtmux binary**.
3. A measured answer to: does the remote region's 500ms layout poll over the tunnel cost
   anything noticeable? (Record ms and bytes/s, don't guess.)
4. A written answer to the ssh-auth question (task 0.6) — this decides Stage L's shape.

## Phases

### Phase 0 — rig (P0)

The rig is two containers in the agent's own rootless docker (memories
`webtmux-verify-in-throwaway-container`, `webtmux-test-container-in-rootless-daemon`). Reuse
`webtmux-launch/test/Dockerfile.target` + `e2e.sh`, which already stand up one ssh-able tmux
target.

- [ ] **P0** 0.1 Create the worktree per the reference above; confirm the hard gate passed.
  Record the `local-main` sha the branch forked from. ~15m, Sonnet.
- [ ] **P0** 0.2 Extend `webtmux-launch/test/` into a **two**-target rig: `Dockerfile.target`
  parameterised, `rig.sh` bringing up `target-a` and `target-b` each with tmux + 2 sessions +
  3 named windows, plus authorized_keys for a generated throwaway keypair. Assert both are
  ssh-reachable and `tmux list-sessions` differs between them. ~45m, Sonnet.
- [ ] **P0** 0.3 Add `rig.sh --launch` : run the existing `webtmux-launch` against each target
  from inside the rig, using `-webtmux-source ./builds` (the local-source seam, no GitHub).
  Assert two distinct local ports serve a webtmux index page. This proves the launcher already
  delivers the helper half with zero changes. ~45m, Sonnet.
- [ ] **P1** 0.4 Document the rig in `webtmux-launch/test/README.md`: how to bring it up, the
  two ports, how to tear down, and the rootless-daemon playwright caveat (memory
  `webtmux-sidebar-tree-view`: the scratchpad cannot be mounted for playwright drivers — stage
  drivers inside the image instead). ~30m, Sonnet.

### Phase 1 — per-unit endpoint (P0, throwaway)

- [ ] **P0** 1.1 `terminal-unit.js:1176-1179` currently derives the ws URL from
  `window.location`. Add an optional `endpoint` to the `TerminalUnit` constructor: absent ⇒
  today's behaviour exactly; present ⇒ `{proto}//{endpoint}{path}ws`. No other change. Add a
  pure test asserting the absent case is byte-identical to the old string. ~30m, Sonnet.
- [ ] **P0** 1.2 Thread `endpoint` through `SplitManager.addUnit()` and expose a console-only
  hook (`window.splitManager.addUnit({endpoint: '127.0.0.1:8081'})`). No UI. ~30m, Sonnet.
- [ ] **P0** 1.3 Hand-run the rig: hub = target-a's webtmux, add a region pointed at
  target-b's port. Drive it manually. Record which of {typing, resize, layout, window switch,
  copy mode, capture/Exposé thumbnails, save-to-file} work, break, or misbehave. **This list is
  the real input to Stages I/U/X.** ~45m, Opus (judgement, not typing).
- [ ] **P0** 1.4 Confirm the predicted collisions concretely: two windows both `@1`, two
  sessions both named `main`, two `%0` panes. Capture screenshots of the resulting confusion —
  they justify Stage I to anyone who later asks why it cost a week. ~30m, Sonnet.

### Phase 2 — measurements (P0)

- [ ] **P0** 2.1 Measure the remote region's steady-state cost over the tunnel: bytes/s and
  layout-push latency at idle and while a window streams output. Compare against the local
  region as the control. Record in the plan. ~45m, Sonnet.
- [ ] **P1** 2.2 Measure an Exposé "all windows" capture burst per machine (one `capture-pane`
  per window, `capture.go:283`) across the tunnel. This is the largest single payload the
  design creates; if it is bad, Stage X needs a per-machine capture budget. ~30m, Sonnet.
- [ ] **P2** 2.3 Sanity-check version skew: point the hub at a *deliberately older* webtmux
  build for target-b and note what breaks. Unknown message types are already tolerated
  (`webtty/tmux.go:321`); layout JSON is not. Record the failure mode. ~30m, Sonnet.

### Phase 3 — the ssh-auth question (P0)

- [ ] **P0** 3.1 Determine empirically whether a headless hub can open the user's real
  connections: for each target the user cares about, does
  `ssh -o BatchMode=yes -o ControlMaster=auto <target> true` succeed? Agent-only / key-only
  targets ⇒ Stage L is small. Password or 2FA targets ⇒ Stage L must surface a prompt in the UI,
  which is a materially bigger build. **Ask the user to run this against their real hosts** —
  the rig cannot answer it. ~30m, Opus.
- [ ] **P0** 3.2 Write the finding into the master plan's Stage L row as a scoped note, and
  adjust L's estimate accordingly. ~15m, Opus.

### Phase 4 — decide and close (P0)

- [ ] **P0** 4.1 Write a **Findings** section into this file: the exit-criteria answers, the
  1.3 behaviour matrix, the 2.x numbers, the 3.1 verdict. Explicit go/no-go, and if no-go, why
  and what would change it. ~45m, Opus.
- [ ] **P0** 4.2 Decide whether the throwaway `endpoint` plumbing (1.1/1.2) is kept as the
  seam Stage H builds on, or reverted. Recommendation: **keep 1.1, revert 1.2's console hook** —
  the constructor option is the honest seam, the global hook is a debugging artifact. ~15m, Opus.
- [ ] **P0** 4.3 Full verification bar (JS suite, `make check-js`, `make sync-assets`, Go suite
  in the golang:1.23 container). Mark this subplan complete, commit, merge via
  `git-merge-worktree.sh --no-ff --remove`. ~30m, Sonnet.

## Risks specific to this stage

- **The rig's two containers share the agent's rootless daemon**, which has no GPU and cannot
  mount the scratchpad. Stage drivers/assets inside images.
- **Do not point the rig at the host's prod webtmux** (127.0.0.1:8090). Every memory about this
  repo says host prod stays untouched.
- **A green spike is not a green design.** Task 1.3's job is to find what breaks, so a spike
  that reports "everything worked" has probably not exercised copy mode, Exposé and
  save-to-file. Push on those three specifically.
