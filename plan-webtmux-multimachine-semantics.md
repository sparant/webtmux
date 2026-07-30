# Plan: multi-machine Stage X — cross-machine semantics

Subplan X of `plan-webtmux-multimachine.md`. The features that currently assume "one tmux server
is the whole world" and now need an explicit answer: what can't cross a machine boundary, what
"no status" means on a fresh machine, and how attention alerts aggregate.

## Worktree

- Branch: `feat/mm-semantics`
- Path: `/workspace/webtmux-mm-semantics`
- Setup: gate → `git -C /workspace/webtmux worktree add /workspace/webtmux-mm-semantics -b feat/mm-semantics local-main` (fork **after** Stage U merged), copy plan files in.
- Finish: tests green → `/workspace/scripts/git-merge-worktree.sh /workspace/webtmux-mm-semantics --target local-main --no-ff --remove`

## Design decisions (settled)

1. **Three tmux operations cannot cross a machine and must be refused with a visible reason:**
   `link-window` (`controller.go:895`), `swap-window` (`:677`, behind `MoveWindow`) and the
   cross-session `unlink-window` path (`:923`). A silent no-op here reads as a bug in webtmux;
   an error toast reads as a fact about tmux.
2. **Refusal happens in the frontend, at the affordance**, not by letting the command reach a
   machine and fail. Stage U task 2.7 already disables the drag; this stage supplies the
   explanation and the belt-and-braces backend guard.
3. **`@wt_working` unset means UNKNOWN, not stopped.** Today `""` renders as an unfilled dot,
   which is honest for one machine because the user knows whether they installed the hooks. On a
   freshly connected machine every window is `""`, and a wall of dots reading "stopped" is
   actively misleading. Introduce an explicit *unknown* rendering and a per-machine "stoplight
   hooks not installed" hint.
4. **Alerts are a union across connected machines**, with a `degraded` machine's last-known
   alerts kept and marked stale (Stage I task 3.5's recommendation, ratified here).
5. **Save-to-file is per machine and must say so.** `SaveEnv` (`webtty/savepath.go`) already
   explains a surprising destination; it now also has to name *which machine* the file landed on.
   Memory `webtmux-save-path-two-filesystems` is the precedent: when nothing is declared, ask
   rather than guess.
6. **Copy/paste across machines needs no work** — it is browser-side (`clipboard.js`, OSC 52
   handling in `terminal-unit.js`). Verify, don't build.

## Phases

### Phase 1 — refusals (P0)

- [ ] **P0** 1.1 Create worktree; confirm gate. ~15m, Sonnet.
- [ ] **P0** 1.2 New `resources/js/cross-machine.js`: `canCross(op, from, to)` returning
  `{ok, reason}` for the ops in decision 1. Pure + tested; the reason strings are user-facing
  copy and belong in one place. ~45m, Opus.
- [ ] **P0** 1.3 Wire it into the sidebar's drag-to-link, drag-reorder and the × (unlink vs kill)
  paths; show the reason via the existing confirm/toast surface (`confirm-popup.js`), not a
  console warning. ~45m, Opus.
- [ ] **P0** 1.4 Backend guard: the hub rejects a tmux control message whose target window
  belongs to a different machine than the connection, and logs it once per occurrence. The
  frontend should make this unreachable; it must still be closed. ~45m, Opus.
- [ ] **P1** 1.5 Offer the *possible* alternative where one exists: a window cannot be linked to
  another machine, but "open a new window on that machine in the same directory" is achievable
  and is usually what was meant. Scope: decide and record; implement only if cheap. ~45m, Opus.

### Phase 2 — stoplight semantics (P0)

- [ ] **P0** 2.1 Add `unknown` to `stoplight.js`'s vocabulary (currently green working / amber
  prompting / red waiting-for-work per memory
  `webtmux-window-list-nav-and-sidebar-stoplights`), distinct from unset-but-known. Update the
  shared hover hint text. ~45m, Opus.
- [ ] **P0** 2.2 Per-machine hook detection: a machine reporting `@wt_working` for **no** window
  is almost certainly missing the hooks (`install_stoplight_hooks_bash.sh`). Detect, render
  `unknown` rather than stopped, and surface a one-click hint naming the installer. ~45m, Opus.
- [ ] **P0** 2.3 Propagate `unknown` through every dot surface — sidebar list, tree rows, Exposé
  tiles, recents tabs, PiP — via the shared `stoplight.js` so no surface invents its own
  mapping. ~45m, Opus.
- [ ] **P1** 2.4 Extend the stoplight writer path so the hub can install hooks on a connected
  machine on request (the launcher already pushes files content-addressed;
  `install_stoplight_hooks_bash.sh` is the payload). Scope-check before building — this may
  belong in Stage L. ~45m, Opus.

### Phase 3 — alerts and flashes across machines (P0)

- [ ] **P0** 3.1 Alert union with staleness (decision 4): a `degraded` machine's alerts persist,
  marked stale, and stop flashing; a `gone` machine's are dropped. Test the transitions. ~45m, Opus.
- [ ] **P0** 3.2 Flash rules across machines: memory `webtmux-stoplight-flash` (recent tabs flash
  on green→red/amber until focused) and `webtmux-global-alerts-and-overflow-arrow` (server-wide
  flashes + flashing overflow arrow) both assume one server. Extend the state machine in
  `work-alerts.js`, keeping it unit-testable. ~45m, Opus.
- [ ] **P0** 3.3 The overflow arrow's target must name its machine, and acknowledging an alert
  must be machine-scoped (memory `webtmux-ux6-shipped`: alerts are acknowledged by window id —
  now by placement). ~45m, Opus.
- [ ] **P1** 3.4 Rate-limit the aggregate: N machines × server-wide alerts can produce a visually
  noisy toolbar. Decide a cap and log what was suppressed rather than dropping silently. ~30m, Opus.

### Phase 4 — save, capture and the rest (P0)

- [ ] **P0** 4.1 Save-to-file names the machine in the dropdown, in the `TmuxSaveInfo` preview and
  in the result (decision 5). The existing "your pane's directory isn't visible to webtmux"
  explanation gains "…on `<machine>`". ~45m, Opus.
- [ ] **P0** 4.2 Per-machine capture budget if Stage S task 2.2 showed the Exposé burst is costly
  over a tunnel: stagger or cap per machine. Skip if 2.2 said it's fine — and say so here. ~45m, Opus.
- [ ] **P0** 4.3 Verify copy/paste, OSC 52, mouse-mode force-selection and search all work in a
  remote region (decision 6 — verification, not implementation). Any that don't become their own
  tasks. ~45m, Sonnet.
- [ ] **P1** 4.4 `⇧N`/`⇧P` window-list walk stays within the region's machine while recents/MRU
  span machines (Stage I task 3.6): confirm the asymmetry is discoverable — update
  `shortcuts-overlay.js` copy. ~30m, Sonnet.

### Phase 5 — verify and merge (P0)

- [ ] **P0** 5.1 JS suite + `make check-js` + `make sync-assets`; Go suite in the golang:1.23
  container. ~30m, Sonnet.
- [ ] **P0** 5.2 Rig check: attempt every refusal in decision 1 across machines and confirm each
  gives a reason; attempt each within a machine and confirm it still works. The second half
  matters as much as the first. ~45m, Opus.
- [ ] **P0** 5.3 Fresh-machine check: connect a target with **no** stoplight hooks and confirm
  `unknown` rendering plus the install hint — not a wall of red. ~45m, Sonnet.
- [ ] **P0** 5.4 Degraded-machine check: kill target-b's webtmux and confirm its alerts go stale
  rather than clearing or flashing forever. ~45m, Sonnet.
- [ ] **P0** 5.5 Mark complete, commit, merge via `git-merge-worktree.sh --no-ff --remove`. ~30m, Sonnet.

## Risks

- **Refusal copy is user-facing product text.** Centralised in `cross-machine.js` for a reason;
  resist inlining a second wording at each call site.
- **The unknown-vs-stopped change touches a single-machine behaviour.** It is the one place this
  plan set deliberately alters existing rendering, so it needs the pixel check from Stage U task
  4.2 re-run: a single-machine user *with* hooks installed must see no change.
- **`work-alerts.js` is small but load-bearing** across five surfaces. Keep every change behind
  its pure state machine and its tests.
