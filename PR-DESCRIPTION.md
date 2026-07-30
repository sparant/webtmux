# webtmux: a tmux-native UI on top of gotty

Draft body for a pull request from the `pr/upstream` branch. Kept on `local-main`
and pasted in by hand — it is not part of the branch it describes (see the last
section for why).

Regenerate the branch with `scripts/make-upstream-pr.sh`.

---

## What this is

gotty gives a terminal in a browser. This turns that terminal into a **tmux
client**: the browser knows what windows exist, which of them are working, and
lets you move between them without typing a prefix key. The pane you see is still
a real tmux client on a real pty — nothing is emulated, and everything stays true
if you attach from a terminal at the same time.

The change that motivates all the rest is the one in the last section of the
README: when you run several long jobs (builds, deploys, coding agents) in
several tmux windows, the expensive thing is not switching windows, it is *not
knowing which window wants you*. So a window reports its own state into a tmux
option and every surface that shows that window paints it.

Roughly 285 commits on top of `6852248`. The diff is large but it is almost
entirely additive: `resources/js/` (the UI, an ES-module graph), `pkg/tmux/` (the
controller and capture store), and `webtty/`'s tmux message handling.

## What it adds

**Seeing your windows**

- **Sidebar** (Ctrl+Alt+W) — a UI for prefix+w: a tree of every session and
  window, type-ahead filter, drag to reorder or to link a window into another
  session, inline rename, `+` to create, hover `×` to kill (or just unlink, when
  the window lives in several sessions). Hovering or arrowing **previews** the
  window live in the real terminal; Esc puts everything back, Enter commits.
- **Exposé** (Ctrl+Alt+E) — a 2×2 / 3×3 mosaic of every window across every
  session, from live capture buffers. Type to filter by name (optionally by
  captured content too); a Show filter narrows to one work state, which turns it
  into a triage board when a dozen jobs are running.
- **Recents strip** — up to five MRU window tabs in the toolbar, plus an
  attention arrow that counts windows that need you but are visible nowhere.
- **Preview / picture-in-picture** (Ctrl+Alt+I) — keep chosen windows on screen
  while you work elsewhere: one floats as a corner PiP, two or more dock as an
  edge bar that reserves space instead of covering the terminal.
- **Hover previews** — pointing at any of the above paints that window full-size
  in the real terminal region, marked temporary; Esc or moving away restores what
  you were doing.

**Knowing which window wants you**

- A window self-reports through one tmux option, `@wt_working`
  (`1` working / `2` prompting / `0` idle / unset "not reporting"), and every
  surface showing that window renders the dot. That is the entire contract — any
  script, shell hook, or agent lifecycle hook can write it.
- A window dropping out of green while you are looking elsewhere **flashes**
  everywhere it appears until you actually view it — including windows with no
  tab, via the attention arrow, and across every window on the server.
- `install_stoplight_hooks_bash.sh` wires an ordinary bash shell up to it
  (`DEBUG` trap green, `PROMPT_COMMAND` red, red on exit). Every write is
  addressed to `$TMUX_PANE`: a bare `tmux set -w` resolves to the window you are
  *looking at*, which is correct exactly until you switch away — i.e. until it
  matters. `test/stoplight-hooks.sh` drives that case against a real tmux server.

**Working in it**

- **Split regions** (Ctrl+Alt+Enter) — side-by-side live tmux views of the same
  server, each its own grouped session, with a draggable divider and one shared
  sidebar bound to the focused region.
- **Copy, scroll and clipboard** — scrolling up enters copy mode but ordinary
  typing still drops back to the prompt; Cmd/Ctrl+C copies and stays in copy mode;
  drag-to-edge auto-scrolls. Click-and-drag selects text **even over a program
  holding the mouse** (vim, htop, a TUI agent), via a four-step
  `click+drag:` / `copymode on scroll:` pair of dropdowns.
- **Save a pane's buffer** — download it, or write it on the machine webtmux runs
  on, container-aware and explained up front rather than guessed
  (`WEBTMUX_SAVE_DIR` / `WEBTMUX_PATH_MAP` / `WEBTMUX_HOME` /
  `WEBTMUX_IN_CONTAINER`).
- **Keyboard** — global Ctrl+Alt chords mirroring tmux letters, an alt-tab-style
  MRU cycle with deferred commit, and a shortcuts overlay (Ctrl+Alt+/) that
  labels modifiers for your OS.

**Underneath**

- **Capture store** — one deduplicated capture buffer per tmux window, shared
  across connections, freshness-coalesced so overlapping UI polls never storm
  tmux; clients mirror it in a cache that powers every thumbnail and preview.
- **State in tmux** — shared UI state lives in the tmux server itself (global
  option `@wt_state`), so it survives reloads, reconnects and webtmux restarts and
  is shared by every browser. Per-tab state (focus, split widths) stays in the tab
  so two browsers do not fight.
- **Per-connection tmux controller** — each browser region follows its own pane's
  real tmux client by tty+pid rather than by name, which is what makes two regions
  (and two browsers) independent.
- **Rendering** — tmux clients attach UTF-8-clean and the DOM renderer is the
  default (WebGL opt-in), so box-drawing and pane borders render correctly.

## Things worth knowing before reviewing

- **Every mutation is gated by write authority.** `webtty/authority.go` maps each
  tmux message type to read/write; without `-w`, read-only means *watch* — you can
  browse, preview, Exposé and switch your own view, but nothing mutates the server.
  New message types have to declare an authority, so the default is not "open".
- **Saves are confined** to declared directories and ask before replacing a file.
- **The UI is dependency-free ES modules**, parse-checked by `make check-js`
  before every build, then copied into `bindata/static/` for `go:embed`. The whole
  UI loads as one module graph, so a single syntax error blanks the page — hence
  the check being a build gate rather than a lint.
- **`@wt_state` and the capture protocol are the two places with real
  concurrency.** Both have test suites (`test/*.test.mjs` for the client half,
  `pkg/tmux/*_test.go` and `webtty/*_test.go` for the server half) and a
  two-browser Playwright driver (`verify-state-sync.js`).

## Known warts, deliberately left alone

Minimal diff beats tidiness in a PR of this size, so a handful of pre-existing or
inherited oddities are untouched and flagged instead:

- `TmuxSendCommand` ('A', client→server) is listed in `isTmuxMessage` and has an
  authority entry, but `handleTmuxMessage` has no case for it — accepted and
  ignored. It is *classified as a write* on purpose: its name means "run an
  arbitrary tmux command", which is the last thing that should default open if
  anyone ever implements it. Removing it is an easy follow-up; guessing at an
  implementation is not.
- Dead constants in `webtty/message_types.go`: `TmuxPaneOutput` ('8', never
  emitted), `UnknownInput` / `UnknownOutput` ('0', inherited from gotty).
- `// @TODO hashing?` above `handleAuthToken` in `server/handlers.go` — gotty's,
  still true, still not this PR's problem.
- The **Extended WebSocket Protocol** table in the README lists only the original
  handful of message types and has drifted from `webtty/message_types.go`, which
  is now the source of truth. Happy to regenerate it if you would rather the
  README carried the full list.

## Dependencies

The UI loads **Tailwind, xterm.js and Lit from CDNs** (`resources/index.html`),
the same way the pre-fork page did. Nothing is vendored and there is no npm build
step in this branch — `make build` is Go plus a file copy. That is a deliberate
carry-over, not an oversight: vendoring those three is its own change with its own
licensing and size trade-offs, and it is being done separately. Say the word if
you would rather it landed together and it can be folded in.

The Go side adds no dependencies beyond what gotty already had
(`gorilla/websocket`, `creack/pty`, `urfave/cli`).

## How to test

```sh
make test          # go test + go vet, node --test test/, bash test/stoplight-hooks.sh
make check-js      # parse every UI module as ESM (also a prerequisite of `make build`)
make build         # sync assets into bindata/ and build ./webtmux
```

`make test-js` needs node and `make test-hooks` needs tmux; both skip with a note
rather than failing where the tool is absent.

Then the real thing, in a browser, with no host setup beyond Docker:

```sh
# build the binary the harness drives
docker run --rm -v "$PWD":/src -w /src -e CGO_ENABLED=0 -e HOME=/tmp golang:1.23 \
  go build -buildvcs=false -o webtmux-test .

# assertion drivers: PASS/FAIL lines, non-zero exit on failure
docker run --rm -v "$PWD":/src mcr.microsoft.com/playwright:v1.48.0-jammy \
  bash /src/screenshots/harness/run.sh          # DRIVER=verify-guards.js, verify-state-sync.js, …
```

`screenshots/harness/README.md` lists the drivers and what each one asserts. The
harness stages nine windows of realistic content on a private tmux socket, boots
the binary on :8090, and drives the actual UI — including the two-browser and
read-only-mode cases.

## About this branch

`pr/upstream` is generated, not developed. It is the fork's `local-main` with the
paths that only mean something in the fork removed in a single commit: execution
plans, fork tooling, and the pre-fork `js/` webpack project together with the
`bindata/static/js/gotty*` bundle it produced — `index.html` stopped loading that
bundle when the UI became an ES-module graph, so it is 2.5 MB of dead weight, and
the artifact and the project that regenerates it only go together.

It is rebuilt from scratch by `scripts/make-upstream-pr.sh` whenever the fork
moves, so it can be force-updated without losing anything, and it is never merged
back. It sits on the original fork point rather than current `main`; say if you
would like it rebased.
