# Plan: multi-machine Stage U — the machine tier in the UI

Subplan U of `plan-webtmux-multimachine.md`. Render the machine dimension Stage I created:
sidebar tree gains an outer tier, the session-tabs row gets a machine selector, recents tabs get
a machine marker, Exposé/PiP gain machine grouping. **Hard rule for this stage: with one machine
connected, every surface renders byte-identically to today** (master decision 7).

## Worktree

- Branch: `feat/mm-ui`
- Path: `/workspace/webtmux-mm-ui`
- Setup: gate → `git -C /workspace/webtmux worktree add /workspace/webtmux-mm-ui -b feat/mm-ui local-main` (fork **after** Stage I merged), copy plan files in.
- Finish: tests green → `/workspace/scripts/git-merge-worktree.sh /workspace/webtmux-mm-ui --target local-main --no-ff --remove`

## Design decisions (settled)

1. **`machineCount <= 1` ⇒ no tier, anywhere.** Implemented once, as a single derived predicate
   (`manager.multiMachine`), read by every component. Not re-derived per component — that is how
   four surfaces end up disagreeing.
2. **Tree view takes the machine tier natively.** `sidebar.js:842` already switches between
   `renderTree()` and `renderSessionView()`; the tree becomes machine → session → window, three
   levels. The per-session `+ New session` (`:929`) gains a sibling `+ Connect machine` at the
   outer tier (wired inert here; Stage L makes it work).
3. **The session-tabs row does NOT grow machine-prefixed tabs.** It is a horizontal row
   (`sidebar.js:868`); N machines × M sessions will not fit. Instead: a **machine selector above
   the row**, showing the focused region's machine, switching which machine's sessions the row
   lists. Chosen over prefixed tabs because it keeps the row's existing drag-reorder and
   drag-to-link semantics scoped to one machine, which Stage X needs anyway.
4. **Recents tabs carry a compact machine marker** — a short label, not a colour alone
   (accessibility, and colour is already carrying stoplight meaning). Hidden when
   `!multiMachine`.
5. **Machine label ≠ machine id.** The id is the sanitised ssh target; the label is what the user
   sees and can rename. Renames are hub state (Stage T), not tmux state.

## Phases

### Phase 1 — the predicate and the label (P0)

- [ ] **P0** 1.1 Create worktree (fork after Stage I merged); confirm gate. ~15m, Sonnet.
- [ ] **P0** 1.2 `manager.multiMachine` derived from the registry in `config.js`
  (`webtmux_machines`, Stage H task 1.4) plus live machine state; a change event so components
  re-render on the second machine connecting. Pure test for the predicate. ~45m, Opus.
- [ ] **P0** 1.3 New `resources/js/machine-label.js`: id → display label, short-form for tabs,
  and a stable per-machine accent colour derived from the id (deterministic, so it survives
  reload without persistence). Pure + tested. ~45m, Sonnet.
- [ ] **P1** 1.4 Machine chip component (`resources/js/components/…` or a shared template
  helper) used identically by sidebar rows, recents tabs, Exposé tiles and the region header —
  one implementation so the marker never drifts between surfaces. ~45m, Sonnet.

### Phase 2 — sidebar (P0, the bulk)

`sidebar.js` is 2,104 lines with ~339 identity references. Work it in slices, each its own
subagent run.

- [ ] **P0** 2.1 `renderTree()` → three tiers, machine nodes collapsible and persisted
  (`sidebar.tree` already persists the view toggle; add per-machine fold state). Reuse
  `window-tree.js`'s `buildTree` with the machine tier from Stage I task 1.4. ~45m, Opus.
- [ ] **P0** 2.2 Tree row keys → `placeKey`; type-ahead haystack (`rowText`) gains the machine
  label so "gpu" narrows to that box. ~45m, Opus.
- [ ] **P0** 2.3 Machine selector above the session-tabs row (decision 3), reflecting the focused
  region's machine, hidden when `!multiMachine`. ~45m, Opus.
- [ ] **P0** 2.4 `renderSessionView()` scoped to the selected machine; session order read from
  that machine's list (per-machine `sessionOrder` — schema lands in Stage T; consume a
  machine-keyed accessor here and let Stage T back it). ~45m, Opus.
- [ ] **P0** 2.5 Stoplight dots in both views resolve per machine (memory
  `webtmux-window-list-nav-and-sidebar-stoplights`: shared `stoplight.js`, dots in list **and**
  Exposé tiles). A machine with no hooks installed must not render as a wall of red — Stage X
  owns the unknown-vs-stopped semantics; here, just don't hard-code the mapping. ~45m, Opus.
- [ ] **P0** 2.6 `+ Connect machine` at the outer tier, inert (opens a placeholder). Wired in
  Stage L. ~30m, Sonnet.
- [ ] **P1** 2.7 Drag affordances: disable/annotate drags whose source and target machines differ
  rather than letting them start. Full refusal semantics are Stage X; this is the affordance so a
  user never begins an impossible drag. ~45m, Opus.

### Phase 3 — toolbar, Exposé, PiP (P0)

- [ ] **P0** 3.1 Recents strip tabs: machine marker per decision 4; surface the existing
  `toolbar.recentMax` pref (up to `RECENTS_MAX = 20`) in the UI, since 5 slots across three
  machines is thin. ~45m, Opus.
- [ ] **P0** 3.2 Overflow arrow + global alert flashes span machines (Stage I task 3.5 supplied
  the union); the arrow's target label must name the machine. ~45m, Opus.
- [ ] **P0** 3.3 Exposé: machine as a grouping tier and a third sort option alongside
  `session`/`recent` (`expose-overlay.js:316`); tile cursor keyed by `placeKey`; search matches
  the machine label. ~45m, Opus.
- [ ] **P0** 3.4 PiP / preview bar: tiles labelled with machine; the set is machine-qualified so
  two same-id windows can both be pinned. ~45m, Opus.
- [ ] **P1** 3.5 Region header/label shows its machine when `multiMachine` — the answer to "which
  box am I typing into", which is the single most dangerous ambiguity this feature introduces.
  Treat as P0-in-spirit. ~45m, Opus.
- [ ] **P2** 3.6 `shortcuts-overlay.js` + `mobile-controls.js`: document/expose machine
  navigation; mobile is lower priority but must not break. ~30m, Sonnet.

### Phase 4 — verify and merge (P0)

- [ ] **P0** 4.1 JS suite + `make check-js` + `make sync-assets`. ~30m, Sonnet.
- [ ] **P0** 4.2 **Single-machine pixel check** (master decision 7): playwright screenshots of
  sidebar (both views), toolbar, Exposé and PiP with one machine, diffed against the same shots
  from `local-main`. Any diff is a bug in this stage, not a new design. ~45m, Opus.
- [ ] **P0** 4.3 Two-machine live check on the Stage S rig: tree shows both boxes, selector
  switches, recents mixes machines with correct markers, Exposé groups by machine, region header
  names the machine. Capture screenshots into `screenshots/`. ~45m, Sonnet.
- [ ] **P0** 4.4 Second-machine *arrival* check: connect target-b while the tab is open and
  confirm the tier appears without a reload; disconnect it and confirm the tier disappears
  cleanly rather than leaving an empty node. ~45m, Opus.
- [ ] **P0** 4.5 Mark complete, commit, merge via `git-merge-worktree.sh --no-ff --remove`. ~30m, Sonnet.

## Risks

- **Two components disagreeing about `multiMachine`.** Hence decision 1's single predicate.
- **The session-tabs row is a genuine design fork.** If the machine selector proves worse in
  use than prefixed tabs, that is a legitimate finding — record it in this file rather than
  quietly implementing both.
- **`sidebar.js` is the most-churned file in the repo** (memory
  `webtmux-local-main-concurrent-commits`). Fork this worktree late, merge it promptly, and
  expect to re-merge `local-main` in before the wrapper call.
- **Playwright in the rootless daemon can't mount the scratchpad** (memory
  `webtmux-sidebar-tree-view`) — stage drivers inside the image.
