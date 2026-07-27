# Plan: webtmux UX batch 6 — MRU after reload, Exposé status filter, paste-trim, mouse menu, sidebar row, linked-window ack

Six user-reported UX defects/improvements, gathered 2026-07-27. They are independent of one
another; the only shared surface is `_refreshToolbar`'s alert plumbing (items 1 and 6).

## Approach

Each item lands as its own commit. The two behavioural bugs (1, 6) get their logic in
**import-free modules with `node --test` coverage**, following the house rule that
`split-manager.js` / the lit components can never load under the test runner
(`work-alerts.js`, `recents-strip.js`, `stoplight.js` are the precedents). The four
presentation items are edited in place in the components.

**Root cause already established for item 1 (read, not guessed):** `navigateMru`
(`split-manager.js:1280`) builds its walk order from `captureCache.all('recent')`, which
iterates `byPlacement` — the *live capture* map. Captures are only requested while the
sidebar is open (`sidebar.js:529`, a 2s-delayed poll), Exposé is open, or a preview/hover is
up. After a browser refresh with the sidebar collapsed, `byPlacement` is **empty**, so
`order.length < 2` and `navigateMru` returns having done nothing. The recency map itself
(`captureCache.accessed`, `@wt_state.recent`) survives fine — it is the *candidate set* that
is missing, not the ordering. The fix is to rank the **server-wide window directory**
(`layout.allWindows`, already collected every 500ms into `SplitManager._placements`) by that
persisted recency, and treat captures as a supplementary source only.

## Trade-offs

- **MRU candidates become "every window on the server", not "every captured window".** A
  never-accessed window now appears at the tail of the walk instead of being absent. That is
  the correct alt-tab semantic (tmux's own `last-window` doesn't require a capture), and it
  removes a class of "the chord does nothing" states that are indistinguishable from a bug.
- **Item 6 changes a documented invariant.** `work-alerts.js` currently acknowledges per
  `(session, id)` placement on purpose. The user wants acknowledgement per *window*: seeing
  the window anywhere clears every tab flashing for it. The old rule's rationale is inverted
  in the comment, not deleted, so the decision stays discoverable.
- **The two mouse buttons collapse into one dropdown**, costing a click to change a mode but
  buying room for prose ("click+drag:", "copymode on scroll:") that the 7-character button
  labels could never carry. `README.md` and `screenshots/harness/verify-mousemode.js` both
  reference the old "sel" button and must move with it.
- The Exposé status filter is **shared state** (`@wt_state.expose.statusFilter`), like `sort`
  and `density` beside it, not per-client — consistent with every other Exposé pref, at the
  cost of one browser's filter following you to another.

## What this enables

⌘⌥L works on the first keystroke after a reload; Exposé becomes usable as a triage board
("show me only what needs me"); renaming a window from a pasted path stops needing manual
trimming; the toolbar sheds a button and gains an explanation.

## Worktree

- **Branch:** `feat/ux6-recents-expose-mouse`
- **Worktree path:** `/workspace/webtmux-ux6` (created off `local-main` @ 66fda40)
- **Integration branch:** `local-main`

### Worktree Reference — read before every execution session

- **Every edit happens in `/workspace/webtmux-ux6`.** Never in `/workspace/webtmux` — that
  checkout is churned by concurrent agents and direct edits get committed out from under you
  (memory: `webtmux-local-main-concurrent-commits`).
- `resources/js/` is source; **`bindata/static/js/` is the embedded copy that `//go:embed`
  actually ships**. Run `make sync-assets` and commit *both* trees, or the change is invisible
  to a built binary.
- No Go toolchain in this container. Build/test Go in `golang:1.23` with `-buildvcs=false`
  (memory: `webtmux-verify-in-throwaway-container`). Browser checks run in
  `mcr.microsoft.com/playwright:v1.48.0-jammy` via `screenshots/harness/run.sh`
  (memory: `webtmux-browser-verify-playwright`).
- Merge back **only** with `scripts/git-merge-worktree.sh <path> --no-ff` (`--ff-only` loses
  the race against local-main's churn).

### Coordination with queued plans

`plan-webtmux-harden-state.md` (unexecuted, in `/workspace/webtmux`) has a task
"`recents`: persist-only-on-accepted-write" and "`recent` recency pruning + cap" touching
`recents-strip.js` / `capture-cache.js`. This plan **does not** change either file's persist
path — item 1 reads the recency map, never rewrites it — so the two do not collide. Do not
"fix" the store-write gating here; it belongs to that plan.

---

## Phases

### Phase 0 — Setup ✅

- [x] **P0** 0.1 Create worktree `/workspace/webtmux-ux6` on `feat/ux6-recents-expose-mouse`.
- [x] **P0** 0.2 Write this plan into the worktree and commit it.

### Phase 1 ✅ — ⌘⌥L / MRU walk survives a reload (P0, item 1)

- [x] **P0** 1.1 New import-free `resources/js/mru-order.js`: `buildMruOrder({placements,
      captures, recents, accessed, currentId, currentSession, occupied})` → deduped
      `[{id, session}]`, most-recently-accessed first, current window pinned at index 0,
      occupied placements dropped (except the current one), never-accessed windows tailing in
      session/index order. Placement preference for a linked window: the one whose session
      matches the current pane, else the lowest session/index.
- [x] **P0** 1.2 `test/mru-order.test.mjs`: empty-capture-cache-after-reload case (the
      reported bug), linked-window dedupe, occupied filtering, current-window pinning,
      never-accessed tail, junk input totality.
- [x] **P0** 1.3 Wire `SplitManager.navigateMru` to `buildMruOrder`, fed from `_placements`
      (server-wide directory) + `captureCache` + `recentWindows` + `captureCache.accessed`.
      Keep the snapshot-on-first-tap and deferred-recency-commit behaviour untouched.
- [x] **P1** 1.4 Guard the "nothing to cycle" case with a reason: if the walk has <2 entries
      because no layout has arrived yet, do nothing (as today) rather than half-cycling.
- [x] **P0** 1.5 Run the JS suite; commit.

### Phase 2 ✅ — A linked window is acknowledged once, everywhere (P0, item 6)

- [x] **P0** 2.1 `work-alerts.js`: `mark()` gains a pre-pass computing the set of window
      **ids** that are on screen (`active`) or back to green; clearing keys off that set so
      both tabs of a linked window stop flashing when either is viewed. Rewrite the
      "acknowledged independently" comment to record the new rule and why it changed.
- [x] **P0** 2.2 Extend `test/work-alerts.test.mjs`: two placements of one id, one active →
      both clear; neither active → both keep flashing; the re-colour and raise rules still
      hold (all 10 existing rules must still pass).
- [x] **P0** 2.3 Verify the downstream readers need no change (`alertOf` bare-id fallback,
      `hiddenAlerts` covered-by-id) — note in the plan if any did. **None did:** `alertOf`
      already falls back to the bare window id and `hiddenAlerts` already counts coverage by
      id, so deleting both keys at once is all the surfaces needed.
- [x] **P0** 2.4 Run the JS suite; commit.

### Phase 3 ✅ — Exposé status filter (P1, item 2)

- [x] **P1** 3.1 *(landed in `stoplight.js`, not a new module — the filter names ARE the
      stoplight's vocabulary and splitting them would let "idle" and "waiting for work to do"
      drift apart)* Pure helper:
      `STATUS_FILTERS` (`all` / `working` / `idle` / `attention`) + `matchesStatus(working,
      filter)`, plus a `node --test` file. `attention` = amber `'2'`; `idle` = red `'0'`;
      `working` = green `'1'`. Decide and document where "not reporting" (`''`) lands — it is
      NOT idle (idle is a claim the window made), so it shows only under `all`.
- [x] **P1** 3.2 Render a third segmented control in the Exposé header (`.sort` pattern,
      label "Show"), persisted as `@wt_state.expose.statusFilter`, adopted on remote change
      like `sort`/`density`.
- [x] **P1** 3.3 Apply it in `_visibleEntries()` (before the type-ahead terms) using the
      `_working` map the tiles already read, and make the header's "N of M" count and the
      empty-grid message tell the truth when the filter — not the query — is what's hiding
      things.
- [x] **P1** 3.4 Rebuild the grid on a filter change (membership changed → `_rebuild`, not
      an in-place refresh). Run the JS suite; commit.

### Phase 4 ✅ — Paste-trim in the rename input (P1, item 3)

- [x] **P1** 4.1 New import-free `resources/js/paste-name.js`: `trimPastedName(text)` →
      basename after the last `/`, minus a trailing extension
      (`webtmux/plan-webtmux-portable-deps.md` → `plan-webtmux-portable-deps`). Total on junk;
      leaves a plain word alone; strips only a *short* trailing extension so a dotted window
      name (`v1.2.3`) is not mangled; collapses whitespace/newlines (a paste can carry them);
      returns `''` for nothing-usable so the paste is left to the browser. **Deviation:** the
      extension rule ended up *letters-only*, not length-only — `v1.2.3` and a 1-char
      extension are the same shape, so length alone cannot separate them. Cost: `capture.mp4`
      keeps its suffix, which is the right way to be wrong.
- [x] **P1** 4.2 `test/paste-name.test.mjs` — the user's example plus trailing slash, no
      slash, no extension, dotfile, multi-line, empty.
- [x] **P1** 4.3 Wire a `@paste` handler on the sidebar's `.window-edit` input (and
      `.session-edit`, for parity): intercept, insert the trimmed text at the selection,
      leave the caret after it. Fall through to the default paste when the helper yields
      nothing.
- [x] **P1** 4.4 Run the JS suite; commit.

### Phase 5 ✅ — One "mouse" dropdown replaces the two mode buttons (P1, item 4)

- [x] **P1** 5.1 Toolbar: replace the two `.tbtn.text` buttons with a single
      `🖱 mouse ▾` button + a `.label-menu`-style dropdown (backdrop + outside-click close,
      matching the Recent ▾ / save menus).
- [x] **P1** 5.2 Two titled groups inside — **"click+drag:"** and **"copymode on scroll:"** —
      each listing all four modes as rows with a ✓ on the current one and its one-line hint
      (the text the tooltip used to have to carry alone). Reuse `SCROLL_META` / `MOUSE_META`
      so there is still one source for the names and hints.
- [x] **P1** 5.3 Keep the current pair visible on the closed button (e.g. `🖱 auto+/auto+`)
      so the toolbar still answers "what mode am I in" without a click, and keep the hover
      tooltip (both `modeTooltip`s, one hint).
- [x] **P1** 5.4 Update `README.md:51` and `README.md:129`, and
      `screenshots/harness/verify-mousemode.js` (it drives the old button) so the
      documentation and the driver match the new control.
- [x] **P1** 5.5 `make check-js`; commit.

### Phase 6 ✅ — Sidebar mode row: two toggles on one line (P1, item 5)

- [x] **P1** 6.1 Put the overlay and pin toggles side by side in `.mode-row` (a flex row that
      wraps), abbreviated to fit the collapsed panel width: `▣ mount` / `⇔ float` and
      `📌 pinned` / `📌 auto-hide`.
- [x] **P1** 6.2 Give both the shared `tooltip.js` hint (~600ms) carrying the full sentence
      the `title=` attribute has today — the sidebar already imports `TIP_CSS` for stoplight
      dots, so this is the same mechanism, and native `title` is dropped for consistency with
      how the stoplight dots were converted.
- [x] **P1** 6.3 Keep "✕ Close this region" full-width beneath (it is destructive and should
      not sit shoulder-to-shoulder with two harmless toggles). `make check-js`; commit.

### Phase 7 ✅ — Verify

- [x] **P0** 7.1 `make sync-assets`; confirm `resources/js` and `bindata/static/js` are
      identical; commit both trees.
- [x] **P0** 7.2 Full JS suite + `make check-js` in the worktree.
- [x] **P0** 7.3 `go vet ./... && go test ./... && go build` in `golang:1.23`
      (`-buildvcs=false`), and curl a served `/js/*.js` to prove the embedded copy carries the
      change (the decisive bindata check). **17/17 passed** — vet/test/build, HTTP 200 boot,
      ten served-marker checks, the old `sel` labels gone, one trigger not two, and
      `@wt_state` round-tripping the new Exposé pref. The ad-hoc script that ran it is NOT
      committed (its markers rot the moment the batch lands); the reusable half is
      `screenshots/harness/verify-ux6.js`.
- [x] **P1** 7.4 Browser assertions via `screenshots/harness/run.sh DRIVER=verify-ux6.js`:
      the Exposé filter narrows the grid; the mouse dropdown opens and switching a mode
      sticks; the sidebar row shows both toggles on one line; a paste into the rename input
      lands trimmed. **22/22 passed.** The MRU-chord check was NOT skipped: rather than
      racing a real reload against the sidebar's 2s capture poll, the driver empties
      `captureCache.byPlacement`/`byWindow` — which is the reload state's actual mechanism —
      and then drives the held ⌃⌥L chord, asserting it navigates and that a second tap
      returns.
- [x] **P1** 7.5 Re-run `verify-mousemode.js` to prove the mouse-mode behaviour survived the
      control's move. **34/34 passed** (driver updated to drive the dropdown). Also re-ran
      `verify-ux5.js` because it asserted the old sidebar label text: **22/22 passed**.

### Phase 8 — Land

- [x] **P0** 8.1 Mark every phase complete in this plan; commit in the worktree.
- [ ] **P0** 8.2 `scripts/git-merge-worktree.sh /workspace/webtmux-ux6 --no-ff` (retry on a
      moved target; never force).
- [ ] **P0** 8.3 Confirm `git merge-base --is-ancestor <sha> local-main`.
- [ ] **P1** 8.4 Report what still needs the HOST (container rebuild + live verify) — this
      change cannot be deployed from the container.

---

## Today's Plan

| Task | Status |
| ---- | ------ |
| Phase 0 setup | ✅ |
| Phase 1 MRU order | ✅ |
| Phase 2 linked-window ack | ✅ |
| Phase 3 Exposé filter | ✅ |
| Phase 4 paste-trim | ✅ |
| Phase 5 mouse dropdown | ✅ |
| Phase 6 sidebar row | ✅ |
| Phase 7 verify | ✅ |
| Phase 8 land | 🔄 |

## Next Steps

All six items implemented and verified in-container. Remaining: merge to `local-main`
(Phase 8) and then a HOST container rebuild + live verify — the real webtmux container
bind-mounts the host tmux socket, so it can only be deployed from the host.
