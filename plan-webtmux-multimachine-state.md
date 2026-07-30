# Plan: multi-machine Stage T — state home and schema v2

Subplan T of `plan-webtmux-multimachine.md`. Move the shared UI visual-state blob from "the one
tmux server's `@wt_state`" to the **hub**, and version the schema so per-machine and global
sections are explicit.

## Worktree

- Branch: `feat/mm-state`
- Path: `/workspace/webtmux-mm-state`
- Setup: gate → `git -C /workspace/webtmux worktree add /workspace/webtmux-mm-state -b feat/mm-state local-main` (fork **after** Stage I merged), copy plan files in.
- Finish: tests green → `/workspace/scripts/git-merge-worktree.sh /workspace/webtmux-mm-state --target local-main --no-ff --remove`

## Why the blob has to move

Today it lives in the tmux **server**-global option `@wt_state` (`webtty/tmux.go:285-309`,
`state-store.js` header), which is exactly right for one machine: it is shared by every client,
survives webtmux restarts, and dies with the tmux server — *"which is correct: the sessions it
describes are gone then too."*

That last clause is what breaks. The multi-machine blob describes placements on machines a given
tmux knows nothing about, and it must survive any single machine being down — including a hub
with no local tmux at all. So the blob becomes **hub-owned**.

**The wire protocol does not change.** `TmuxSetState` ('P') and `Layout.state` stay exactly as
they are; the hub terminates them locally instead of forwarding (Stage H task 2.4). The frontend
keeps one code path, which is why this stage is days and not weeks.

## Design decisions (settled)

1. **Storage:** a JSON file on the hub (`~/.config/webtmux/state-<hubid>.json`), written
   atomically (temp + rename in the same directory — the pattern `deploy.go:100` already uses).
   Not the hub's tmux: a hub need not have one.
2. **Schema v2**, explicit about scope:
   - **Global:** `renderer`, `expose`, `pip`, `toolbar`, `recentTabs`, `recent`, `sidebar`
     (minus session order) — user decision: recents/pip/expose prefs stay global.
   - **Per-machine:** `machines: { <id>: { sessionOrder: [...], label, fold } }` — user decision:
     session order is per-machine.
   - **Placement-carrying:** `split.regions[]` entries gain `machine`.
   - `version: 2` at the root.
3. **Migration is one-way and lossless-by-default.** A v1 blob (no `version`) is read as
   machine `local`: `sessionOrder` moves under `machines.local`, `split.regions[]` and every
   recents/recency entry gain `machine: 'local'`. Written back as v2. A v1 reader seeing a v2
   blob is not supported — note it, don't engineer for it.
4. **Reconcile with `plan-webtmux-harden-state.md`, don't fight it.** That subplan's decision 6
   adds a per-tmux-server identity (`Layout.ServerStart`) to the localStorage cache key. Under a
   hub, the *cache* key becomes the **hub** identity, while each machine's `ServerStart` is
   retained per machine so a single machine restarting invalidates only its own cached captures
   and recency. This is an extension of that decision, not a reversal — say so in the code
   comment, because it will read as a contradiction otherwise.
5. **First-load gate still applies.** harden-state's `loadedOnce` / no-flush-before-first-load
   rule (its decision 1) is the clobber protection; a hub-owned blob does not relax it. With N
   machines the boot race is *wider*, not narrower.

## Phases

### Phase 1 — hub-side store (P0)

- [ ] **P0** 1.1 Create worktree; confirm gate. ~15m, Sonnet.
- [ ] **P0** 1.2 New `server/uistate.go`: load/save/get/set of the blob with an atomic write,
  a mutex, a 64 KB cap (mirroring `webtty/tmux.go:298`) and JSON validation before write —
  reject-and-log, never error the connection (same reasoning as the existing handler). Table
  tests. ~45m, Opus.
- [ ] **P0** 1.3 Wire it to Stage H's intervene points: 'P' writes here; the '7' state field is
  served from here. Replace H's in-memory placeholder. ~45m, Opus.
- [ ] **P0** 1.4 Hub identity: a stable id for the hub (config-file path hash or an explicit
  `--hub-id`), surfaced in `config.js` for the localStorage cache key per decision 4. ~30m, Opus.
- [ ] **P1** 1.5 Retain per-machine `ServerStart` in the relayed layout so a machine restart
  invalidates only its own cached captures/recency (decision 4). Requires the field to survive
  the '7' state splice. ~45m, Opus.

### Phase 2 — schema v2 + migration (P0)

- [ ] **P0** 2.1 New `resources/js/state-schema.js`: v2 shape, `scopeOf(section)` (global vs
  per-machine), and `migrateV1toV2(blob)`. Pure + heavily tested — this function is the only
  thing standing between a user and a lost layout. ~45m, Opus.
- [ ] **P0** 2.2 `state-store.js`: `section(name)` gains a machine-scoped sibling
  `machineSection(machineId, name)`; writes route by `scopeOf`. Keep the existing debounce,
  rev and `_applying` guard semantics untouched. ~45m, Opus.
- [ ] **P0** 2.3 Migration on first load, exactly once, with the pre-migration blob retained
  under `legacyV1` for one release so a bad migration is recoverable. Test the idempotence of a
  second load. ~45m, Opus.
- [ ] **P0** 2.4 Per-machine `sessionOrder` consumers: the accessor Stage U task 2.4 consumed is
  now backed for real. Verify the sidebar's drag-reorder writes to the right machine. ~45m, Opus.
- [ ] **P1** 2.5 Tree `fold` state persisted per machine (Stage U task 2.1). Machine `label` is
  **not** owned here: Stage L decision 7 makes the connect address book's friendly name
  authoritative, and this blob holds only an override for a machine with no address-book entry.
  Store the override; resolve it through Stage L task 2.10's single resolution function. ~30m, Sonnet.

### Phase 3 — absent machines (P0)

- [ ] **P0** 3.1 A saved `split.regions[]` entry whose machine is not connected must render as a
  **pending region** naming the machine, not silently collapse or grab a window from another
  machine. Consumes Stage I task 2.4's "pending" result. ~45m, Opus.
- [ ] **P0** 3.2 Recents/recency entries for absent machines are kept, marked stale, and are not
  pruned by harden-state's decision-7 pruning (which drops entries missing from
  `layout.allWindows` for >7 days) — an absent machine's windows are missing for a reason that
  is not "the window is gone". **This is the interaction most likely to silently eat state.** ~45m, Opus.
- [ ] **P0** 3.3 Machine removal (explicit, by the user) *does* purge that machine's sections and
  placements, with a confirmation naming what will be forgotten. Distinguish removal from
  disconnection everywhere. ~45m, Opus.
- [ ] **P1** 3.4 Cap total state size across machines; log what was dropped rather than
  truncating silently. ~30m, Sonnet.

### Phase 4 — verify and merge (P0)

- [ ] **P0** 4.1 JS suite + `make check-js` + `make sync-assets`; Go suite in the golang:1.23
  container. ~30m, Sonnet.
- [ ] **P0** 4.2 **Real v1 → v2 migration test** against a blob captured from the live host
  webtmux's `@wt_state` (read-only; do not write to host prod). Assert nothing is lost. ~45m, Opus.
- [ ] **P0** 4.3 Two-browser convergence check in the rig (harden-state's own bar): two tabs,
  two machines, concurrent edits converge and neither clobbers the other. ~45m, Opus.
- [ ] **P0** 4.4 Machine-down check: kill target-b mid-session, reload the tab, confirm its
  regions render pending and its recents survive; bring it back and confirm they rebind. ~45m, Sonnet.
- [ ] **P0** 4.5 Mark complete, commit, merge via `git-merge-worktree.sh --no-ff --remove`. ~30m, Sonnet.

## Risks

- **This stage can lose user state.** Every other stage's failures are cosmetic or navigational;
  this one's are permanent. Hence 2.3's `legacyV1` retention and 4.2's real-blob test.
- **Reading as a contradiction of harden-state.** Decision 4 is an extension; if the code comment
  doesn't say so, a later reader will "fix" it back.
- **`@wt_state` still exists on every machine** and each machine's own webtmux still writes it if
  driven directly (someone pointing a browser straight at target-b's port). That is fine and out
  of scope — but confirm the two stores can't corrupt each other, and write down that they are
  independent.
