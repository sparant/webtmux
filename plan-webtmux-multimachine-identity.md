# Plan: multi-machine Stage I — identity migration (pure modules + SplitManager)

Subplan I of `plan-webtmux-multimachine.md`. Widen every frontend key from
`(session, window)` to `(machine, session, window)`. This is the single largest cost in the
plan set, and it is **the same migration this codebase already completed once** when windows
became placements — `window-tree.js:17-20` states the rule: *"keyed by (session, window), never
by window id alone — the same rule the recents strip and Exposé already follow."*

Scope here is the **pure modules + `SplitManager`**. Rendering (sidebar, toolbar, Exposé, PiP)
is Stage U.

## Worktree

- Branch: `feat/mm-identity`
- Path: `/workspace/webtmux-mm-identity`
- Setup: gate → `git -C /workspace/webtmux worktree add /workspace/webtmux-mm-identity -b feat/mm-identity local-main`, copy plan files in.
- Finish: tests green → `/workspace/scripts/git-merge-worktree.sh /workspace/webtmux-mm-identity --target local-main --no-ff --remove`

## Design decisions (settled)

1. **One key function**, in a new `resources/js/place.js`:
   `placeKey(machine, session, windowId)` → `"<machine> <session> <windowId>"`. Machine ids are
   `[A-Za-z0-9._-]` (hub decision 4) and tmux window ids are `@N`, so a space join stays
   unambiguous — the same argument `rowKey` already makes.
2. **`rowKey` is replaced, not wrapped.** A 2-arg compatibility shim would let un-migrated call
   sites compile and silently conflate machines. Delete it and let the type-free breakage be
   loud; the test suite is the safety net.
3. **`machine` is never optional in a key.** Absent/empty normalises to `'local'` at the single
   ingest point (below), not at each call site.
4. **One ingest point.** `TerminalUnit` knows its own machine (from its `endpoint`/registry
   entry) and stamps `machine` onto every layout it hands to `SplitManager` — including
   `layout.windows[]`, `layout.allWindows[]`, `layout.sessions[]` and the `allWorking` map's
   keys. Downstream code therefore never has to ask "which machine did this come from".
5. **`occupiedWindowIds()` becomes machine-qualified.** The invariant "a window is VISIBLE in at
   most one pane" (`split-manager.js:12-14`) is per-machine; unqualified it would disable
   `gpu-box`'s `@1` because the laptop is showing *its* `@1`. This is the highest-value single
   fix in the stage and the most likely to be missed.

## Phases

### Phase 1 — the primitive (P0)

- [ ] **P0** 1.1 Create worktree; confirm gate. ~15m, Sonnet.
- [ ] **P0** 1.2 New `resources/js/place.js`: `placeKey`, `parsePlaceKey`, `samePlace`,
  `LOCAL = 'local'`, and `normMachine(m)`. Pure, no DOM. New `test/place.test.mjs` covering the
  join, the round-trip, and machine normalisation. ~45m, Sonnet.
- [ ] **P0** 1.3 Stamp machine at ingest (decision 4) in `terminal-unit.js`: a `machine` field on
  the unit, applied to the parsed layout before `onLayout` fires. Test that a layout with no
  machine info normalises to `local`. ~45m, Opus.
- [ ] **P0** 1.4 Delete `rowKey` from `window-tree.js` and re-point `buildTree` at `placeKey`,
  keeping its existing behaviour for a single machine. Update `test/window-tree.test.mjs`. ~45m, Sonnet.

### Phase 2 — pure modules (P0)

Each of these is independently testable and can be a separate subagent run.

- [ ] **P0** 2.1 `capture-cache.js`: cache and recency keyed by `placeKey`. The store dedupes by
  window id today ("a window has one screen regardless of how many sessions") — that is still
  true *per machine* and false across machines. ~45m, Opus.
- [ ] **P0** 2.2 `work-alerts.js`: the alert registry and `hiddenAlerts`/`alertOf` become
  machine-qualified. A window id colliding across machines currently means one box's green
  latch silences another's red. ~45m, Opus.
- [ ] **P0** 2.3 `mru-order.js`: `buildMruOrder` entries carry `machine`; ordering is global
  (master decision 6 — one recents bar), not per-machine. ~30m, Sonnet.
- [ ] **P0** 2.4 `restore-view.js`: `resolveRestoreView` must tolerate a saved placement whose
  **machine is not connected yet** — return "pending" rather than falling through to an
  arbitrary window on another machine. Add tests for the not-yet-connected case explicitly. ~45m, Opus.
- [ ] **P0** 2.5 `split-state.js`: region records gain `machine` (`{machine, windowId,
  session}`); `readSplitState` normalises legacy 2-field records to `local`. ~30m, Sonnet.
- [ ] **P0** 2.6 `recents-strip.js`: `sanitizeRecents` accepts and preserves `machine`; entries
  without one normalise to `local`. Note `MAX_RECENTS = 5` / `RECENTS_MAX = 20` — with three
  machines, 5 is thin; leave the default alone here and let Stage U surface the pref. ~30m, Sonnet.
- [ ] **P1** 2.7 `stoplight.js` / `alert-flash.js`: no keying of their own, but confirm — a
  module that *looks* stateless and isn't is exactly how a machine's dots end up on another
  machine's rows. ~30m, Sonnet.

### Phase 3 — SplitManager (P0)

`split-manager.js` carries ~216 identity references. Work top-down through its documented
navigation model (`:6-26`), which is the spec for what must stay true.

- [ ] **P0** 3.1 `occupiedWindowIds(exclude)` → machine-qualified set (decision 5), plus
  `_shownWindowId`/`_unitShowing`. Add a regression test: two machines, same window id, both
  regions must be independently selectable. ~45m, Opus.
- [ ] **P0** 3.2 `_viewOf` / `_persistSplitState` / `_restoreSplitState` / `_applyRestoreTarget`
  carry `machine`; restore tolerates a pending machine (2.4). ~45m, Opus.
- [ ] **P0** 3.3 `goToWindow` / `goToWindowIn` gain a machine argument; a navigation whose
  machine differs from the focused unit's must **re-point that region's machine**, not silently
  target the wrong server. Decide and document: does navigating to another machine move the
  focused region, or focus a region already on that machine? (Recommendation: prefer an existing
  region on that machine, else re-point the focused one.) ~45m, Opus.
- [ ] **P0** 3.4 `noteAccess` / `_metaFor` / `_pruneDeletedRecents` / `_persistRecents` /
  `_restoreRecents` machine-qualified; recents stay one global list. ~45m, Opus.
- [ ] **P0** 3.5 `_markWorkAlerts` / `_refreshOverflowAlerts` / `revealOverflowAlert` /
  `_placements`: the alert universe becomes the **union across connected machines**. A machine
  that is `degraded` contributes no alerts but must not clear the ones it last reported —
  decide and document which. (Recommendation: keep, marked stale.) ~45m, Opus.
- [ ] **P0** 3.6 `navigateRecents` / `navigateWindows` / `navigateMru` / `_endMruCycle`:
  `⇧N`/`⇧P` walk the focused region's machine's window list; recents/MRU walk globally across
  machines. Document the asymmetry in the navigation-model comment block — it is deliberate. ~45m, Opus.
- [ ] **P0** 3.7 `logicalSession` / `_windowPlacements` / `_refreshPanes` / `_pushLayout` and the
  save helpers (`savePaneBuffer`, `requestSaveInfo`, `saveDir`, `onSaveInfo`, `onSaveResult`)
  machine-qualified. Save resolves on the machine tmux runs on — Stage X owns the labelling, this
  task only stops it targeting the wrong machine. ~45m, Opus.
- [ ] **P1** 3.8 `hover-preview.js`: preview reads a capture for a placement; ensure the
  capture-vs-geometry match (memory `webtmux-capture-refresh-model`) is per machine. ~45m, Opus.

### Phase 4 — verify and merge (P0)

- [ ] **P0** 4.1 Grep gate: no remaining call site keys on a bare window id. Add
  `test/place-coverage.test.mjs` or a `make check-js` rule that fails on `rowKey(` and on
  `accessed[`-style unqualified indexing. A mechanical guard is worth more than a review pass
  here. ~45m, Opus.
- [ ] **P0** 4.2 Full JS suite + `make check-js` + `make sync-assets`. ~30m, Sonnet.
- [ ] **P0** 4.3 **Single-machine no-regression check** in a throwaway container: with one
  machine, every behaviour (recents, alerts, Exposé, split restore, MRU) is unchanged. This is
  master decision 7 and the acceptance test for the whole stage. ~45m, Sonnet.
- [ ] **P0** 4.4 Two-machine check on the Stage S rig: the 1.4 collision screenshots must now
  render as two distinct, independently navigable placements. ~45m, Sonnet.
- [ ] **P0** 4.5 Mark complete, commit, merge via `git-merge-worktree.sh --no-ff --remove`. ~30m, Sonnet.

## Risks

- **Silent conflation is the failure mode**, not crashes. Everything here still "works" with a
  bare window id — it just acts on the wrong machine. Hence 4.1's mechanical guard and 2.4's
  explicit not-connected tests.
- **`plan-webtmux-harden-state.md` must already be merged** (master plan gate). Its decisions 1–7
  rewrite `state-store.js`, `split-manager.js` persistence, `recents-strip.js` and
  `capture-cache.js` — the same files as Phases 2–3.
- **Don't start Stage U in this worktree.** Sidebar/Exposé/toolbar edits here will collide with
  Stage U's branch on the largest files in the repo.
