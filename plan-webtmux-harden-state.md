# Plan: webtmux harden — state-sync protocol (subplan A of plan-webtmux-harden-master.md)

Fix the @wt_state synchronization holes: a cold-cache browser can erase everyone's saved
split layout, a persist during remote-apply silently poisons the recents signature, equal
rev numbers diverge two clients forever, and a flush over a dead websocket is lost. The
persistence *coverage* is complete (review verdict); this subplan is only about making the
sync protocol converge.

## Worktree

- Branch: `harden-state`
- Path: `/workspace/webtmux-harden-state`
- Setup: `git -C /workspace/webtmux worktree add /workspace/webtmux-harden-state -b harden-state local-main`,
  then copy this plan file into the worktree; all edits happen there.
- Finish: tests green → `scripts/git-merge-worktree.sh /workspace/webtmux-harden-state --target local-main --no-ff --remove`.

## Design decisions (made now, so execution doesn't re-litigate)

1. **First-load gate.** `StateStore` grows `loadedOnce` (true after the first `load()` of a
   server blob) and `onFirstLoad(cb)` (fires immediately if already loaded). *No section may
   flush to the server before `loadedOnce`* — boot-time writes from cached state are the
   clobber vector. The localStorage cache keeps making the UI instant; it just can't win a
   race against the authoritative blob anymore.
2. **Adopt, don't restore-once.** `split` and `pip` move to the recents `adopt()` pattern:
   restore eagerly from cache at boot (unchanged UX), then re-apply from the first remote
   blob if it differs and the user hasn't interacted with that section yet
   (`_userTouched` flag per section). After first-load, remote emits apply as today.
3. **Write-success contract.** `patch()`/`patchSection()` return `false` when swallowed
   (`_applying` guard) and `true` when accepted. `RecentsPersistence.persist()` updates
   `_sig` only on `true`; the split-manager remote-adopt subscriber defers its
   `_refreshToolbar()` out of `_emit` via `queueMicrotask` so pruning can write.
4. **Rev tie-break by content.** `load()` accepts an incoming blob when
   `rev > appliedRev` **or** (`rev === appliedRev` and content hash ≠ what we applied) —
   equal-rev different-content means a collision happened; last-writer-wins with
   *visibility* instead of silent permanent divergence. Un-flushed local patches are
   replayed on top after adopt (keep the debounced patch queue until acked).
5. **Flush must not vanish.** `_flush` treats a send over a non-OPEN ws as still-pending
   (keep `_dirty`, don't bump `lastWrittenRev`), and TerminalUnit signals the store on
   reconnect (`stateStore.resync()`), which re-reads the server blob (next layout push)
   and re-flushes pending state on top.
6. **Cache keyed per tmux server.** The layout push gains a server identity (tmux
   `start_time` of the server, added to `Layout` in Go — one format field); the
   localStorage cache key includes it. A different server ⇒ different cache ⇒ no rev
   poisoning after a socket swap. Absent identity (old server) falls back to today's key.
7. **`recent` section pruning.** CaptureCache drops recency entries whose window id is
   absent from `layout.allWindows` for > 7 days (timestamped tombstone on first miss, so a
   briefly-unlisted window isn't forgotten); cap the section at 200 entries, LRU.

## Phases

### Phase 1 — harness first (P0)

- [ ] P0 Extend `test/state-store.test.mjs` with failing tests for decisions 1, 3, 4, 5
      (fake ws send fn; simulate two stores sharing a fake tmux blob). ~40m, Sonnet.
- [ ] P0 New `test/state-adopt.test.mjs`: cold-cache scenario — store B with empty cache
      must adopt A's split/pip blob, and B's first navigation must not write `regions: []`.
      Drive via extracted pure logic (see Phase 2 extraction). ~40m, Opus.

### Phase 2 — StateStore core (P0)

- [ ] P0 Implement `loadedOnce`/`onFirstLoad`, first-load flush gate, write-success return
      values, pending-patch replay after adopt, non-OPEN-ws flush hold + `resync()`.
      Keep the file's design-doc comment truthful — update it. ~45m, Opus.
- [ ] P0 Rev tie-break by content hash (decision 4); store the applied-content hash beside
      `appliedRev`. ~30m, Opus.
- [ ] P1 Server identity in the cache key (decision 6): Go `Layout.ServerStart` from
      `display-message -p '#{start_time}'` (or the existing layout format), JS cache-key
      suffix, fallback path. Go test + JS test. ~40m, Sonnet.

### Phase 3 — consumers (P0)

- [ ] P0 `split`: gate `_persistSplitState` and the boot-time eager persist on
      `loadedOnce`; add remote adopt (re-run `_restoreSplitState` from the first remote
      blob when un-touched); mark `_userTouched` on any real navigation/region change. ~45m, Opus.
- [ ] P0 `pip`: same treatment for `restoreState`/`_persist`; drop the unconditional
      boot `_persist()` ("so its rev is current" — that rationale is the bug). ~30m, Sonnet.
- [ ] P0 `recents`: persist-only-on-accepted-write (`_sig` on success), microtask-deferred
      refresh in the remote-adopt subscriber; regression test: prune-during-adopt converges
      in one round trip (kills the dead-tab-resurrection loop). ~40m, Sonnet.
- [ ] P1 `recent` recency pruning + cap (decision 7) in capture-cache.js + test. ~30m, Sonnet.

### Phase 4 — verify & land (P0)

- [ ] P0 Full JS suite + `make check-js` + `make sync-assets`; Go suite for the layout
      field. ~20m, Sonnet.
- [ ] P0 Two-browser live check in a throwaway container (playwright memory pattern):
      arrange split+recents in A, cold-load B, confirm B converges and A's layout
      survives B's first navigation; kill a window, confirm no resurrection. ~45m, Opus.
- [ ] P0 Mark plan complete, commit in worktree, merge via
      `scripts/git-merge-worktree.sh /workspace/webtmux-harden-state --target local-main --no-ff --remove`;
      tick subplan A in the master plan on local-main. ~15m.
