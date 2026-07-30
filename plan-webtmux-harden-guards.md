# Plan: webtmux harden — write-authority guards (subplan B of plan-webtmux-harden-master.md)

A server started **without** `-w` (read-only) currently still lets any authenticated client
kill sessions/windows, rename/move/link, rewrite shared @wt_state, and **write files on the
server** (TmuxSavePaneFile). Separately, the save path honors absolute paths and `../`
escapes with silent overwrite, two controller fallbacks mutate sessions the client doesn't
own, and `force:true` capture requests bypass all coalescing. This subplan draws the
authority lines and enforces them.

## Worktree

- Branch: `harden-guards`
- Path: `/workspace/webtmux-harden-guards`
- Setup: `git -C /workspace/webtmux worktree add /workspace/webtmux-harden-guards -b harden-guards local-main`,
  copy this plan in; all edits there.
- Finish: tests green → `scripts/git-merge-worktree.sh /workspace/webtmux-harden-guards --target local-main --no-ff --remove`.
- **Serialization:** do not run concurrently with subplan C (both edit `pkg/tmux/controller.go`
  and `webtty/`); whichever starts second waits for the other's merge.

## Design decisions

1. **permitWrite gating matrix** (enforced in `handleMasterReadEvent` before
   `handleTmuxMessage`, mirroring the existing `Input` guard; blocked messages are
   logged + dropped, not connection-fatal):
   - **Always allowed (view-only):** `TmuxCaptureRequest`, `TmuxSaveInfoRequest`,
     `TmuxRefresh`, `Ping`, resize, `SetEncoding`.
   - **Requires `-w`:** everything that mutates the tmux server or filesystem —
     select/split/close pane, select/new/kill/rename/move/link/unlink window,
     new/kill/rename/switch session, scroll/copy-mode (they drive tmux modes),
     `TmuxSavePaneFile`, `TmuxSetState`.
   - Rationale: "read-only" means *watch*: even select-window moves the shared console.
     The client learns the mode from the existing init preferences (add `permitWrite` to
     the init message) and greys out its controls, so read-only viewers aren't chasing
     silent no-ops.
2. **Savepath confinement.** After resolution (`resolveSavePath`), the final path must be
   inside an allowlist: `WEBTMUX_SAVE_DIR`, the user-chosen dir from @wt_state, or (outside
   containers) `$HOME`/cwd default — verified with `filepath.Rel` on the
   symlink-resolved (`filepath.EvalSymlinks`) parent, not string prefix. Absolute paths
   and `~` lose their bypass: they are subject to the same containment. Overwrite policy:
   refuse when the target exists unless the request carries `"overwrite":true`; the save
   dropdown gets a one-line inline confirm on the "exists" error. (TOCTOU between check
   and write is accepted — the threat model is a confused client, not a hostile local user.)
3. **Refuse, don't guess, on unknown identity.** `SwitchSession`'s legacy bare
   `switch-client -t <sess>` fallback (taken exactly when `discoverClient` failed) becomes
   an error returned to the client ("can't identify this pane's tmux client"), matching
   `switchOurClient`'s ambiguity refusal. `SelectWindow`'s double-miss fallback
   (`select-window -t @id` — mutates whichever session owns the window) becomes an error;
   the client already treats a failed select as a no-op + layout refresh.
4. **Capture fan-out cap.** Per-connection: at most one in-flight `CaptureWindows` call
   (subsequent requests coalesce onto its result via the store's existing dedup), and
   `force` is rate-limited to one bypass per window per 500ms (server-side; the TTL
   coalescing already handles the rest). Goroutines take the connection context.

## Phases

### Phase 1 — permitWrite (P0) — complete

- [x] P0 Gating matrix in `webtty/webtty.go`/`tmux.go` per decision 1 + table test
      enumerating every message type against both modes (test fails if a future message
      type is added without classifying it — use an exhaustive switch over the const
      list). ~45m, Opus.
- [x] P1 `permitWrite` in the init message; frontend disables mutating controls
      (toolbar/sidebar/Exposé actions, save-to-server option) in read-only mode. ~45m, Sonnet.

### Phase 2 — savepath (P0) — complete

- [x] P0 Containment + symlink-resolved `filepath.Rel` check + absolute/`~` policy change
      in `webtty/savepath.go`; extend the existing decision-table tests with traversal,
      absolute-escape, and symlink cases (tests currently assert what it does; add what it
      must refuse). ~45m, Opus.
- [x] P0 Overwrite refusal + `"overwrite":true` protocol field + dropdown inline confirm
      + tests both sides. ~40m, Sonnet.

### Phase 3 — refuse-don't-guess + capture cap (P1)

- [ ] P1 Decision 3: error returns for the two fallbacks in `pkg/tmux/controller.go`;
      client-side surfaced as the existing toolbar error toast; Go tests via the
      fake-runner seam. ~40m, Opus.
- [ ] P1 Decision 4: per-connection in-flight guard + force rate limit in
      `webtty/tmux.go` capture handling; goroutines on the connection ctx; test with the
      capture backend fake. ~40m, Sonnet.

### Phase 4 — verify & land (P0)

- [ ] P0 Full Go suite (`-race`) in golang:1.23 docker + JS suite + bindata sync. ~20m, Sonnet.
- [ ] P0 Live smoke in a throwaway container: boot read-only (no `-w`), confirm watch
      works and kill/save/select are refused + UI greys; boot with `-w`, confirm save
      confinement + overwrite confirm. ~40m, Opus.
- [ ] P0 Mark complete, merge via the lock wrapper, tick subplan B in the master plan. ~15m.
