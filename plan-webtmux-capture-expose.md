# Plan: webtmux capture-buffers — Exposé overlay + optimistic-paint switching

`plan-webtmux-capture-expose.md` — created 2026-07-22. A feature plan for the **webtmux
fork** (`/workspace/webtmux`, branch `local-main`), the browser front-end shipped by
`scripts/webtmux-docker/`.

> **GATE — do not execute until `plan-webtmux-split.md` is complete and merged to
> `local-main`.** This plan is deliberately built on top of the split work: it assumes the
> **per-connection controller** (split Phase A) and the **`TerminalUnit` / `SplitManager`
> with a `focusedUnit`** (split Phase B–C) already exist. Building the capture store and
> the Exposé/optimistic-paint UI against the *pre-split* singleton (`server.tmuxCtrl`,
> `window.webtmux`) would be thrown away by the split refactor. Phase 0 verifies the gate
> before any other work.

## Goal

Maintain, for **every window we know about**, a single cached **capture buffer** (a
color-preserving snapshot of the window's active pane), and use it for two things:

1. **Exposé overlay** — a full-screen mosaic of *all windows across all sessions*, each
   tile a faithful colored thumbnail, **click-to-switch** (switches the focused region to
   that window), dismiss on Esc/click-out.
2. **Optimistic paint** — when switching windows (sidebar click, ↑/↓ arrow-nav, or Exposé
   click), immediately blit the target window's cached buffer into the focused unit's
   xterm so the switch *looks* instant; the live `select-window` repaint then overwrites
   it a beat later.

## The core architecture insight

**Exactly one capture per window, keyed by tmux `window_id` (`@N`), server-global.**

tmux `window_id` is unique per *server*, and the split feature's grouped sessions
(`new-session -t services -s web-x`) **share the same window list** — the same `@N`
objects appear in every grouped session. So a window's content is identical no matter how
many sessions "contain" it. Therefore:

- The capture store is a **server-level singleton** (constructed in `server.Run` with the
  tmux socket), **not** per-connection and **not** per-controller. All `TerminalUnit`
  connections read from and refresh the *same* store.
- Enumerate windows with `tmux list-windows -a` (all sessions on the server) and
  **dedup by `window_id`** — so a window shared by `services` + `web-a` + `web-b` is
  captured **once**, satisfying "one capture-group per window regardless of how many split
  sessions we've made".
- Capturing is **read-only** (`capture-pane` never moves the active pane or disturbs any
  client), so it is always safe to run against any window at any time.

**Refresh is a separate concern from storage/consumption.** The store just holds
`{windowId → {ansi, cols, rows, capturedAt}}`. *When* to refresh is driven by the UI and
coalesced by the store:

- **Exposé** refreshes on open, then (optional) polls every **1–2 s while the overlay is
  visible**.
- **Opening the sidebar** refreshes once after **2 s**, then every **5 s while open**;
  stops on collapse.
- The server **coalesces**: a capture request for a window captured < *freshness-TTL* ago
  (e.g. 500 ms) returns the cached entry instead of re-forking tmux, so multiple units /
  overlapping triggers don't stampede the socket.

## Capture mechanics (verified assumptions — pin in the A-phase spike)

- **Colors:** `tmux capture-pane -e -p -t <target>` — `-e` emits SGR escape sequences
  (fg/bg/bold/underline); `-p` prints to stdout. The output, joined by `\r\n`, writes
  straight into an xterm and renders pixel-identical.
- **Target:** capture the window's **active pane** using the `pane_id` (`%N`) the layout
  parser already extracts (`controller.go:168–182`), not `@id`, for determinism.
- **Snapshot, not stream:** captures the current visible screen (incl. altscreen apps like
  vim/claude-TUI) — no cursor, no live updates. Correct for thumbnails/optimistic paint.
- **MVP = active pane only.** A multi-pane window is previewed by its active pane; per-pane
  compositing via the parsed layout geometry is a **P2** follow-up, not MVP.
- **Sizing caveat:** a window not current in any client keeps its last size; other-session
  windows may capture at odd dims. Tiles scale via CSS `transform`, so this is cosmetic.

## Design decisions / trade-offs

- **Server-global store, not controller method.** Add a separate `CaptureStore` in the
  `tmux`/`server` layer and a `CaptureProvider` reference on `WebTTY` (set alongside
  `SetTmuxController`). Keeping it off the per-connection `TmuxController` interface is what
  makes "one capture per window across all connections/sessions" fall out for free.
- **Client drives cadence, server coalesces correctness.** Refresh *policy* (2 s / 5 s /
  1–2 s numbers) lives in the JS components where it's trivial to tune; *dedup + freshness
  coalescing* lives in the store where it guarantees correctness under multiple units.
- **Capture-on-demand, not background polling.** No global timer captures when nobody's
  looking. Triggers come only from an open Exposé or an open sidebar. (Change-driven "on
  refresh" would need tmux **control mode** — explicitly out of scope; noted as the future
  upgrade path for always-live thumbnails.)
- **Exposé switches the *focused* unit.** A tile click calls `focusedUnit.selectWindow(id)`,
  which (post-split) qualifies to that unit's own session (`<session>:<index>`). Exposé is a
  browser/window navigator, not a new tmux client.
- **Tile renderer = small xterm per tile** (exact color), lazily created on open, disposed
  on close, capped at N_MAX live tiles (fallback: ANSI→HTML `<pre>` for overflow). N is
  small in practice; revisit only if window counts get large.
- **Optimistic paint is a byproduct, not its own subsystem.** It's one helper that writes
  `\x1b[H\x1b[2J` + the cached ansi into the focused xterm right before/at switch; the
  server repaint is authoritative. Guarded behind "buffer exists & fresh enough".

## Protocol additions (`webtty/message_types.go`, mirror in `webtmux.js` `MSG`)

- **Input** `TmuxCaptureRequest = 'G'` (client→server). Payload JSON:
  `{ "windows": ["@3","@5"] | "all", "force": false }`. `"all"` = every deduped window.
- **Output** `TmuxCaptureData = 'A'` (server→client). Payload JSON:
  `{ "captures": [ { "windowId":"@3", "sessionName":"services", "index":2, "name":"logs",
  "cols":203, "rows":50, "capturedAt":<unix>, "data":"<base64 ansi>" }, ... ] }`.
  Routed through `masterWrite` (the atomic writer used by `SendTmuxLayout`, `tmux.go:51`).
  Register `TmuxCaptureRequest` in `isTmuxMessage` and `handleTmuxMessage`
  (`tmux.go:69,163`).

## What this enables

- Browse and jump between every window across every (grouped) session from one colored
  overview, without cycling through them.
- Perceived-instant window switching in the sidebar / arrow-nav / split regions.
- A single reusable capture buffer that both features (and future per-pane split previews)
  read from — one capture per window, no duplication across sessions.

## Worktree

- **Repo:** `/workspace/webtmux` (branch `local-main`) — single-writer working clone, not
  subject to `/wq` churn. Branch from `local-main` **after** the split feature has merged
  into it (see GATE).
- **Branch:** `capture-expose`
- **Worktree path:** `/workspace/webtmux-capture`

### Worktree Reference

- First executable step creates the worktree and copies this plan into it; **all** edits
  happen in `/workspace/webtmux-capture/...`, never in `/workspace/webtmux/`.
- Build/test during dev: `docker build … <the worktree> …` (context = the worktree), run
  self-contained (own in-container tmux) as `scripts/webtmux-docker/verify.sh` does.
- Merge-back ONLY via `scripts/git-merge-worktree.sh /workspace/webtmux-capture --target
  local-main --remove` (serialized lock wrapper; never raw merge/worktree-remove).
- If worktree creation fails: **STOP**, diagnose; never fall back to editing `local-main`.

### Execution model routing

- **Opus / main loop:** A.2–A.4 (CaptureStore, enumeration/dedup, coalescing), B.1–B.3
  (message plumbing + `WebTTY` wiring), C.1–C.3 (Exposé overlay + tile renderer), D.1–D.2
  (optimistic paint + arrow/sidebar integration — touches split's `TerminalUnit`/
  `SplitManager`).
- **Sonnet-safe:** A.1 (capture spike, verbatim commands), C.4 (overlay CSS), E.3 (docs),
  and any task with a verbatim spec + acceptance check.
- **Escalation:** if the A.1 spike shows `capture-pane -e` output can't be round-tripped
  into xterm faithfully, or `list-windows -a` dedup can't reliably identify one capture per
  shared window, **STOP and report** — both features depend on it. Never ship uncolored or
  per-session-duplicated captures "to make it work".

---

## Phase 0 — Gate + Worktree  [P0]

- [x] **0.1** Confirm the GATE: `plan-webtmux-split.md` is marked complete and merged on
      `local-main` (per-connection controller + `TerminalUnit`/`SplitManager` present). If
      not, **STOP** — do not start this plan. *(~10m, P0)*
- [x] **0.2** From `/workspace/webtmux`: `git worktree add /workspace/webtmux-capture -b
      capture-expose`; `git config --global --add safe.directory /workspace/webtmux-capture`;
      copy this plan into the worktree; commit it on `capture-expose`. *(~20m, P0)*

## Phase A — Backend: the server-global CaptureStore  [P0]

- [x] **A.1 SPIKE** In a scratch tmux on the mounted socket, verify: (a) `capture-pane -e
      -p -t %<paneid>` emits SGR color; (b) writing that (lines joined `\r\n`) into an xterm
      renders identically; (c) `list-windows -a -F '#{window_id} #{session_name}
      #{window_index} #{window_name} #{window_active} #{pane_active}'` lists a window shared
      by two grouped sessions under **one `window_id`** (dedup key). Record exact commands.
      *(~30m, P0)*
- [x] **A.2** Add `CaptureStore` (new file in `pkg/tmux/`): holds the socket + a
      mutex-guarded `map[windowID]CaptureEntry{ansi []byte, cols, rows int, capturedAt
      time.Time, sessionName, index int, name string}`. Method `Capture(windowIDs []string,
      force bool)` runs `capture-pane -e -p` per **active pane** (resolve `@id`→active
      `%paneid` via `list-panes`/layout), stores the entry. Read-only; never touches the
      active pane. *(~45m, P0)*
- [x] **A.3** Add `EnumerateWindows()` to `CaptureStore`: run `list-windows -a -F …`, build
      the deduped set keyed by `window_id` (first occurrence wins for label/index; keep a
      note of which sessions saw it). This is the "all windows across all sessions, one
      entry each" source of truth. *(~35m, P0)*
- [x] **A.4** Add freshness **coalescing**: `Capture(..., force=false)` skips (returns
      cached) any window whose `capturedAt` is < `CaptureFreshnessTTL` (default 500ms) old;
      `force=true` bypasses. `Snapshot(windowIDs|all)` returns entries for the response.
      Unit-test dedup + coalescing with a fake tmux runner. *(~40m, P0)*

## Phase B — Backend: message plumbing + WebTTY wiring  [P0]

- [x] **B.1** Add protocol constants `TmuxCaptureRequest='G'` (input) and
      `TmuxCaptureData='A'` (output) to `webtty/message_types.go`; mirror in `webtmux.js`
      `MSG`. Register `TmuxCaptureRequest` in `isTmuxMessage` (`tmux.go:163`). *(~20m, P0)*
- [x] **B.2** Give `WebTTY` a `captureProvider` field + `SetCaptureProvider(...)` (parallel
      to `SetTmuxController`). In `server.Run`, construct the **one** `CaptureStore` with the
      socket and hand it to **every** connection's `WebTTY` (shared pointer). *(~35m, P0)*
- [x] **B.3** Handle `TmuxCaptureRequest` in `handleTmuxMessage`: parse `{windows, force}`,
      resolve `"all"` via `EnumerateWindows()`, call `Capture(...)`, marshal a
      `TmuxCaptureData` payload, and send it via `masterWrite`. Run the capture in a
      goroutine so it never blocks the output stream; the atomic writer serializes the send.
      *(~40m, P0)*
- [x] **B.4** Backend acceptance (no UI): drive a raw ws connection, send `G {"windows":
      "all"}`, confirm one `A` frame back with **one capture per window_id** (shared windows
      deduped), each carrying non-empty base64 ansi + sane cols/rows. *(~30m, P0)*

## Phase C — Frontend: the Exposé overlay  [P0]

- [x] **C.1** Client `CaptureCache` (in a new `resources/js/components/capture-cache.js` or
      on the app): map `windowId → {data, cols, rows, capturedAt}`, updated on every
      `TmuxCaptureData` frame; expose `request(windows='all', force)` that sends `G`, and a
      `subscribe` for UI refresh. *(~35m, P0)*
- [x] **C.2** Tile renderer: given a capture entry, render its ansi into a small read-only
      xterm sized to `cols×rows`, scaled to the tile via CSS `transform`. Pool/dispose xterm
      instances on overlay open/close; cap live tiles at `N_MAX` (overflow → ANSI→HTML
      `<pre>` fallback). *(~45m, P0)*
- [x] **C.3** `<webtmux-expose>` overlay component (Lit): full-screen dim backdrop + grid of
      tiles, one per **deduped window** (label `index: name`, mark the focused unit's current
      window). On open: `captureCache.request('all', force=true)`; optional **1–2 s poll
      while visible**; clear timer + dispose tiles on close. Open via `Ctrl+Alt+E` (Alt so it
      dodges the tmux prefix, mirror the `Ctrl+Alt+B` handler) and a sidebar button; close on
      Esc / backdrop click. *(~45m, P0)*
- [x] **C.4** Tile click → `SplitManager.focusedUnit.selectWindow(windowId)` (+ switch
      session if the window isn't in the focused unit's session), then dismiss the overlay.
      Keyboard: arrow-move highlight between tiles, Enter to select, Esc to cancel. CSS
      polish (hover-enlarge as a lightweight "preview"). *(~40m, P1)*

## Phase D — Frontend: optimistic paint + refresh triggers  [P0]

- [x] **D.1** `paintOptimistic(windowId)` on `TerminalUnit`: if the cache has a fresh-enough
      buffer, write `\x1b[H\x1b[2J` + the ansi into the unit's xterm immediately. Call it at
      the top of the unit's `selectWindow` path so sidebar-click, ↑/↓ arrow-nav, and Exposé
      all get instant paint; the server's `select-window` repaint then overwrites. Guard: no
      buffer → no-op (unchanged behavior). *(~45m, P0)*
- [x] **D.2** Sidebar-open refresh policy: when the sidebar expands, start a timer that
      `captureCache.request('all')` **once after 2 s**, then **every 5 s while open**; clear
      on collapse. (Hook the `collapsed` transition already in `sidebar.js:updated`.) This
      keeps buffers warm for optimistic paint without any background polling. *(~35m, P0)*
- [x] **D.3** Wire the Exposé poll (C.3) and the sidebar poll (D.2) to the **same**
      `captureCache`, relying on server-side coalescing so overlapping triggers don't
      stampede tmux. Confirm no duplicate in-flight `G` storms (debounce on the client too).
      *(~30m, P1)*

## Phase E — Verify, polish, docs, merge  [P1]

- [x] **E.1** End-to-end: multiple grouped sessions (from split) open; Exposé shows **one
      tile per window** (no per-session duplicates), colors faithful; click switches the
      focused region; optimistic paint makes sidebar/arrow switches feel instant; primary
      region still in sync with the ssh console. *(~40m, P0)*
- [x] **E.2** Load/lifecycle: many windows; open/close Exposé repeatedly (no leaked xterm
      tiles / timers); sidebar open/close starts/stops the 2 s→5 s poll; capture requests
      coalesce under the freshness TTL (log/inspect tmux fork rate). *(~35m, P1)*
- [x] **E.3** Docs: update `scripts/CLAUDE.md` webtmux section (capture buffers +
      Exposé + optimistic paint; one-capture-per-window-id model), add code comments on
      `CaptureStore` (server-global, dedup rationale) and the fork-delta memory note so it
      survives upstream re-sync. *(~30m, P1)*
- [x] **E.4** Build the image, run `scripts/webtmux-docker/verify.sh`-style checks, mark all
      phases complete in the worktree copy of this plan, commit. *(~25m, P1)*
- [x] **E.5** Merge back: `scripts/git-merge-worktree.sh /workspace/webtmux-capture --target
      local-main --remove`; on conflict/non-ff, rebase and retry — never force. Confirm the
      plan is marked complete on `local-main`; the host rebuild then picks it up. *(~25m,
      P0)*

## Out of scope (future)

- **Control mode (`tmux -CC`)** for change-driven / always-live thumbnails (`%output`
  notifications) instead of polled capture. This is the upgrade path if polled snapshots
  feel stale; it's a separate, larger rearchitecture.
- **Per-pane compositing** of multi-pane window previews using the parsed layout geometry
  (MVP previews the active pane only).
- **Scrollback thumbnails** (`capture-pane -S`); MVP captures the visible screen only.

## Next steps

1. Commit this plan on `local-main` (do **not** execute — the GATE and house rules require
   explicit separate intent to run it).
2. Finish `plan-webtmux-split.md` first (per-connection controller + `TerminalUnit`/
   `SplitManager`). Only then execute Phase 0.
3. Execute the **A.1 spike** early — it burns down the one real risk (faithful colored
   capture + reliable one-per-window dedup) before the store and UI are built on it.
