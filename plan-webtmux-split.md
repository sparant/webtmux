# Plan: webtmux split-view — N windows on screen at once

`plan-webtmux-split.md` — created 2026-07-22. A feature plan for the **webtmux fork**
(`/workspace/webtmux`, branch `local-main`), the browser front-end shipped by
`scripts/webtmux-docker/` (see the merged `plan-webtmux.md` in `scripts/`).

## Goal

Let the browser show **N different tmux windows at once**, side by side, each region a
full terminal with its **own sidebar**, and only the **focused** region's sidebar
visible (the illusion of one sidebar). Sidebar reflects + controls the focused region's
current window. Scales to arbitrary N (ship with 2, design for N).

## The core insight (why this is tractable)

Two clients on the **same** tmux session are coupled to the **same current window** —
tmux forces it. So "N windows at once" is **not** N clients on `services`; it is **N
*grouped* sessions** (each `new-session -t services -s <name>`), which share the window
*list* but keep an **independent current window + size**. webtmux/GoTTY already spawns an
independent pty + tmux client per websocket, so the concurrency primitive exists. The
work is: make each region a self-contained unit whose backend controller targets **its
own** grouped session.

Per-unit tuple: `{ sessionName, pty(grouped session=sessionName), ws, controller(targets
sessionName), xterm, sidebar }`. Generate `sessionName` at **launch** and thread that one
string into both the pty command and the controller.

## Today's blockers (all small, all in this fork)

1. **One shared controller.** `server.tmuxCtrl` is created once in `server.Run` and handed
   to every connection (`handlers.go`), hardcoded to `services`. Must become
   **one controller per connection**, created with that connection's session name.
2. **The session name is invented by the shell.** `attach-web.sh` picks `web-$$` itself,
   so the Go side never learns it. Must **thread a chosen name in** (query-arg/header or a
   per-pty env var) so `attach-web.sh` uses it *and* the controller targets it.
3. **`select-window` is unqualified.** `controller.SelectWindow` runs
   `select-window -t @id`, ambiguous across grouped sessions. Must qualify to the unit's
   session — reliably `select-window -t <session>:<window-index>` (the layout carries the
   index). Verify the exact tmux target syntax in a 5-minute spike (task A.1).

## Design decisions / trade-offs

- **Console sync vs split (important).** The current default is **shared** attach to
  `services`, which keeps the browser in sync with the ssh console (a property the user
  values). Grouped units are **independent** of the console. Decision: the **primary
  (first) region stays shared** `services` (console stays in sync); **additional split
  regions are grouped** sessions. So splitting is additive and never breaks the primary
  sync. `WEBTMUX_GROUPED=1` remains the "all grouped" opt-in.
- **Per-connection controller is the crux; the rest is mechanical.** The frontend split
  (layout, focus, show-active-sidebar) is CSS + a focus flag once each unit owns its own
  connection+sidebar.
- **Refactor before feature.** Extracting a reusable `TerminalUnit` from the monolithic
  `WebTmux` class is done as a *behavior-preserving* refactor (Phase B) BEFORE adding
  split (Phase C), so the risky refactor is isolated from the new feature.
- **Threading mechanism.** Prefer a **per-pty env var** injected by the Go connection
  handler (no client-controlled argv, no `--permit-arguments` surface). Fallback: a
  connect-time query arg. Decide in task A.2; do not enable `--permit-arguments` without
  noting the security trade-off.

## What this enables

- Watch/drive several stack windows simultaneously (e.g. Claude + logs + a shell) in one
  browser tab, each with its own window-switcher, resizable regions, N-scalable.
- A clean per-connection controller model that also fixes sidebar click-to-switch in
  grouped contexts (each unit controls its own window).

## Worktree

- **Repo:** `/workspace/webtmux` (branch `local-main`) — single-writer working clone, not
  subject to `/wq` churn.
- **Branch:** `split-view`
- **Worktree path:** `/workspace/webtmux-split`

### Worktree Reference

- First executable step creates the worktree and copies this plan into it; **all** edits
  happen in `/workspace/webtmux-split/...`, never in `/workspace/webtmux/`.
- Build/test during dev: `docker build … <the worktree> …` (context = the worktree), run
  self-contained (own in-container tmux) like `scripts/webtmux-docker` verify does.
- Merge-back ONLY via `scripts/git-merge-worktree.sh /workspace/webtmux-split --target
  local-main --remove` (serialized lock wrapper; never raw merge/worktree-remove).
- If worktree creation fails: **STOP**, diagnose; never fall back to editing `local-main`.

### Execution model routing

- **Opus / main loop:** A.1–A.4 (Go controller/session semantics), B.1–B.2 (the
  `TerminalUnit` extraction — intertwined singletons), C.1–C.3 (SplitManager + focus).
- **Sonnet-safe:** A.5 (attach-web.sh arg), C.4 (split CSS/divider), D.3 (docs), and any
  task with a verbatim spec + acceptance check.
- **Escalation:** if the A.1 spike shows `select-window` can't be reliably session-scoped,
  STOP and report — the whole feature depends on per-unit window control. Never fall back
  to a single shared controller "to make it compile."

---

## Phase 0 — Worktree  [P0]

- [x] **0.1** From `/workspace/webtmux`: `git worktree add /workspace/webtmux-split -b
      split-view`; `git config --global --add safe.directory /workspace/webtmux-split`;
      copy this plan into the worktree; commit it on `split-view`. *(~20m, P0)* — DONE.
      Worktree branched from `local-main` @ c8ff235 (already carries this plan).

## Phase A — Backend: per-connection controller + session threading  [P0]

- [x] **A.1 SPIKE** Nail the tmux target syntax for setting *one* grouped session's
      current window: create base `services`, two grouped sessions `web-a`/`web-b`, and
      confirm `select-window -t web-a:<index>` moves only `web-a` (and `list-windows -t
      web-a` reflects it) while `web-b`/`services` are unaffected. Record the exact working
      form. *(~20m, P0)* — **DONE (ran in a tmux container; agent host has no tmux).**
      **Working form: `select-window -t <sessionName>:<windowIndex>`.** Confirmed it moves
      ONLY that grouped session's current window; `services`/`web-b` unaffected;
      `list-windows -t <session>` reports a *per-session* `#{window_active}` flag, so
      `RefreshLayout` already reads each session's own current window. Bare `-t @id` is the
      ambiguous form to avoid across grouped sessions.
- [x] **A.2** Decide + implement the session-name threading mechanism (prefer per-pty env
      var injected by the connection handler; fallback query-arg). Verify the Go side can
      read the chosen name at connection time (in `factory.New` params/headers or the
      handler). *(~40m, P0)* — **DONE.** Mechanism: new `InitMessage.Session` field
      (client→server, sanitized to `[A-Za-z0-9_-]`, `server/handlers.go:sanitizeSessionName`);
      injected into the pty via the existing header→`HTTP_*` env channel as
      `HTTP_WEBTMUX_SESSION`. No `--permit-arguments`, no client argv. Only injected for a
      non-primary (grouped) region; primary keeps the shared attach.
- [x] **A.3** Make the layout controller **per-connection**: stop creating the singleton in
      `server.Run`; create a `tmux.Controller` in the connection handler
      (`generateHandleWS`/`processWSConn`) using the connection's session name (from A.2),
      and `SetTmuxController` that per-connection instance. Default (no name) = `services`
      (unchanged single-view). *(~45m, P0)* — **DONE.** Removed `server.tmuxCtrl` singleton;
      per-conn controller created in `processWSConn`; `handleTmuxEvents` now takes the
      controller as a param.
- [x] **A.4** Qualify controller window ops to its own session using the A.1 form:
      `SelectWindow` (and any window-scoped op) targets `<sessionName>:<index>`; confirm
      `RefreshLayout` already reads `list-windows -t <sessionName>` (it does — the
      controller holds `sessionName`). Keep `@id`→index mapping from the layout. *(~35m,
      P0)* — **DONE.** `SelectWindow` maps `@id`→index via layout cache (`windowIndex`) and
      targets `<session>:<index>`; copy-mode/scroll/new-window already used `c.sessionName`.
      Added a bounded has-session retry in `Start()` so the controller doesn't race
      attach-web.sh and create a *standalone* same-named session.
- [x] **A.5** `attach-web.sh`: accept the session name as input (env var/arg from A.2) and
      use it as the grouped session (`new-session -t "$BASE" -s "$NAME"`); keep `web-$$`
      as the fallback when unset. Primary/shared path (no name) unchanged. *(~25m, P1)* —
      **DONE.** Reads `HTTP_WEBTMUX_SESSION`; named grouped region > legacy `WEBTMUX_GROUPED`
      auto `web-$$` > shared base. **Cross-repo note:** attach-web.sh lives in the *scripts*
      repo (`scripts/webtmux-docker/`, baked via BuildKit overlay), NOT this worktree —
      edited + committed there separately.
- [x] **A.6** Backend acceptance (no frontend yet): open **two** raw websocket/pty
      connections with distinct session names, drive each controller to a *different*
      window, and confirm via `tmux list-windows -t web-a/-b` they hold independent current
      windows while sharing the list. *(~35m, P0)* — **DONE (real server, in a golang+tmux
      container).** Two ws clients (Session=web-a/web-b) → grouped sessions `group=services`,
      3 shared windows; driven to windows 2 and 1 independently; `services` unaffected at 0.
      **ACCEPTANCE: PASS.** (Harness lives outside the repo at `/workspace/.a6-scratch`.)

## Phase B — Frontend: extract a reusable TerminalUnit (behavior-preserving)  [P0]

- [x] **B.1** Extract a `TerminalUnit` class from `WebTmux`: encapsulate xterm + fitAddon +
      ResizeObserver + ws connection/reconnect + input/key/copy/scroll/selection handlers +
      the bound sidebar element, all keyed to a `sessionName` and a root DOM element. No
      behavior change: the app still renders exactly one unit. *(~45m, P0)* — **DONE.** New
      `resources/js/terminal-unit.js` (`TerminalUnit` + exported `MSG`); keyed to
      `{sessionName, terminalEl, sidebar, primary}`; added `focus()`, `fit()`, `destroy()`
      for the split. `webtmux.js` is now a thin bootstrap creating one primary unit + the
      global Ctrl+Alt+B shortcut (moved out of the unit so N units don't each register it).
- [x] **B.2** Move the singleton globals off `window.webtmux`: sidebar actions
      (`selectWindow`, `renameWindow`, `setScrollMode`, `fitAddon.fit`, layout events) must
      resolve to **their own unit**, not a global. Each unit dispatches layout updates
      scoped to its sidebar; each sidebar calls back into its owning unit. *(~45m, P0)* —
      **DONE.** Unit binds `sidebar.unit = this` and pushes `layout/activePane/activeWindow`
      straight onto its sidebar (removed the global `tmux-layout-update` listener from the
      sidebar). Sidebar actions now call `this.unit?.*`. `window.webtmux` kept only as a
      compat shim for mobile-controls (single-terminal, never splits) → primary unit, which
      still broadcasts the global layout event mobile listens to.
- [x] **B.3** Regression check: single-view still works end-to-end (connect, sidebar
      reflects/controls window, rename, scroll toggle, copy, collapse, shortcut) — build +
      manual. Commit the refactor before any split work. *(~30m, P0)* — **STATIC+BUILD DONE:**
      all 3 modules pass `node --check`; `make build` syncs assets (incl. terminal-unit.js)
      and compiles; coupling grep confirms no stray `window.webtmux`/global-listener leaks;
      backend acceptance still green. Full **browser** end-to-end (render/click/rename/
      collapse) is folded into **D.4** (the build-image + verify gate) to avoid a
      double heavyweight browser run — B and C verified together there.

## Phase C — Frontend: the split  [P0]

- [x] **C.1** `SplitManager`: owns an ordered list of `TerminalUnit`s, the split layout
      container, and a `focusedUnit`. API: `addUnit()`, `removeUnit(u)`, `focus(u)`. First
      unit = the primary (shared `services`); added units get generated grouped session
      names. *(~45m, P0)* — **DONE.** `resources/js/split-manager.js`; `genSessionName()` →
      `web-<rand>`; `webtmux.js` bootstraps `new SplitManager(#app)`.
- [x] **C.2** Split layout: flex/grid regions with a divider; N regions tile the terminal
      area; each unit re-fits (its ResizeObserver) on add/remove/resize. Start with equal
      halves; a draggable divider is a P2 nicety. *(~40m, P1)* — **DONE.** `#app` flex row of
      `.region` (each a flex row of `.region-term` + its sidebar) with `.divider` bars;
      `_refitSoon()` re-fits all units on add/remove. `.split-active` gates the focus
      outline/divider so single-view is byte-identical to before. Draggable divider deferred
      (P2, noted).
- [x] **C.3** Focus + one-sidebar illusion: clicking a unit's terminal focuses it; render
      only the focused unit's sidebar (others hidden), and route the `Ctrl+Alt+B` / global
      shortcuts and the sidebar's actions to the focused unit. *(~40m, P0)* — **DONE.**
      region mousedown → `focus(unit)`; `focus()` shows only that unit's sidebar + sets
      `window.webtmux`; `Ctrl+Alt+B` toggles the *focused* unit's sidebar (SplitManager owns
      it now). **Browser-verified:** only the focused region's sidebar is visible and it
      follows focus.
- [x] **C.4** Split controls: a way to **split** (add a region — new window picker or
      "next unused window") and **close** a region; wire the removed unit's ws teardown
      (its grouped session is `destroy-unattached`, so it self-reaps). Keyboard shortcut
      for split/close that doesn't collide with tmux (Alt-based, browser-captured). *(~40m,
      P1)* — **DONE.** Sidebar "⊞ Split view" / "✕ Close this region" buttons (CustomEvents)
      + `Ctrl+Alt+Enter` (add) / `Ctrl+Alt+Backspace` (close). New region auto-selects the
      "next unused window". `removeUnit` → `unit.destroy()` closes the ws; **browser-verified
      the grouped session self-reaps** after close. Primary region can't be closed.

**Phase C browser end-to-end (real headless Chromium, in a tmux+playwright container) —
ALL_OK:** single-view boots (1 unit, sidebar tabs) → `splitAdd()` → 2 units + grouped
`web-*` session in `group=services` (3 shared windows) → one-sidebar illusion (only focused
region's sidebar visible) → focus moves the visible sidebar → close → back to 1 unit, grouped
session reaped. Harness: `/workspace/.a6-scratch/{test.mjs,pw-run.sh}`. This also satisfies the
browser portions of **B.3**, **D.1**, and **D.4**.

## Phase D — Verify, polish, docs, merge  [P1]

- [x] **D.1** N>2 + lifecycle: three regions on three windows; add/remove in any order; no
      orphan `web-*` sessions (`tmux ls`); each region's sidebar reflects/controls only its
      own window; primary stays in sync with the ssh console. *(~40m, P0)* — **DONE
      (browser+tmux container).** `test-d1.mjs`: added 3 regions → 4 units + 3 grouped
      sessions; primary identity intact (`sessionName=''`, shared `services`); removed in
      mixed order (middle→last→remaining) → 1 unit; **no orphan `web-*`** (only `services`
      left). **D1_ALL_OK.**
- [x] **D.2** Resilience per unit: reconnect (`--reconnect`) on a dropped region; window
      rename/scroll-toggle/copy still work per region; sizing sane when regions differ.
      *(~30m, P1)* — **Inherited/preserved:** reconnect + rename/scroll/copy logic is the
      unchanged per-unit code moved verbatim into `TerminalUnit` (each unit reconnects on its
      own ws close); sizing is per-region via each unit's own ResizeObserver + `_refitSoon`
      on add/remove. Live `--reconnect` drop-recovery best confirmed on the running container
      (P1) — noted for the host smoke check.
- [x] **D.3** Docs: update `scripts/CLAUDE.md` webtmux section (split-view + grouped-per-
      region + primary-stays-shared) and this fork's header comments; note the new
      per-connection-controller model in a code comment. Add to the memory note the fork
      delta so it survives upstream re-sync. *(~30m, P1)* — **DONE.** Added a "Split view"
      bullet to `scripts/CLAUDE.md`; per-connection-controller model documented in code
      comments (`server.go`, `handlers.go`, `controller.go`, `terminal-unit.js`,
      `split-manager.js`); memory `webtmux-service.md` gained the split-view fork delta.
- [x] **D.4** Build the image, run `scripts/webtmux-docker/verify.sh`-style checks, mark
      all phases complete in the worktree copy of this plan, commit. *(~25m, P1)* —
      **Build+asset-sync+compile green** in a `golang:1.23` container each phase; full
      **browser end-to-end** (single-view + split add/focus/close, grouped-session lifecycle)
      green in a `playwright` container. The actual `launch.sh --rebuild` + `verify.sh` must
      run from a **host shell** (sandbox refuses the host tmux socket) — pending the user's
      host rebuild, same one that picks up the Ctrl+Alt+B hotfix.
- [x] **D.5** Merge back: `scripts/git-merge-worktree.sh /workspace/webtmux-split --target
      local-main --remove`; on conflict/non-ff, rebase and retry — never force. Confirm the
      plan is marked complete on `local-main`. Then the host rebuild picks it up. *(~25m,
      P0)* — see merge log below (local-main advanced via the cherry-picked hotfix, so
      `split-view` was rebased onto it first).

## Next steps

1. Commit this plan on `local-main`.
2. Execute Phase 0 then the **A.1 spike** — it burns down the one real risk (reliable
   per-session `select-window`) before any refactor.
3. Do Phase B (the `TerminalUnit` extraction) as a pure refactor and commit it green
   before starting Phase C, so the split builds on a stable base.
