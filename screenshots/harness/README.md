# Screenshot & gif harness

Regenerates every screenshot and animated gif in `screenshots/` by launching
the real webtmux binary against a staged tmux server and driving the UI with
Playwright in a throwaway container. No host setup beyond Docker.

```sh
# 1. Build the binary with the build-id stamped (chip shows the commit)
docker run --rm -v "$PWD":/src -w /src -e CGO_ENABLED=0 -e HOME=/tmp golang:1.23 \
  bash -c 'git config --global --add safe.directory "*" >/dev/null; \
    C=$(git rev-parse --short HEAD); T=$(date -u "+%Y-%m-%d_%H:%M:%S"); \
    go build -buildvcs=false -ldflags "-s -w -X main.Version=dev \
      -X webtmux/server.BuildCommit=$C -X webtmux/server.BuildTime=$T" \
      -o webtmux-test .'

# 2. Stills (installs tmux/htop/pygments + playwright npm pkg on first run)
docker run --rm -v "$PWD":/src mcr.microsoft.com/playwright:v1.48.0-jammy \
  bash /src/screenshots/harness/run.sh

# 3. Animated gifs (also needs ffmpeg, installed on first run)
docker run --rm -v "$PWD":/src mcr.microsoft.com/playwright:v1.48.0-jammy \
  bash /src/screenshots/harness/run-gifs.sh

# ...or just the scenes you changed. Re-encoding all nine for a one-feature
# change rewrites binaries nobody looked at and makes the diff unreviewable.
docker run --rm -v "$PWD":/src -e SCENES=copy-buffers \
  mcr.microsoft.com/playwright:v1.48.0-jammy bash /src/screenshots/harness/run-gifs.sh
```

Check what a re-recorded gif actually shows before committing it — pull frames out
with `ffmpeg -i screenshots/<name>.gif -vf "select=not(mod(n\,12))" -vsync 0 f%02d.png`
and look at them. Two takes of the copy-buffers scene were wrong in ways no
assertion would have caught: a row's hover hint covered the very list the frame
existed to show, and every Ctrl+V was a silent no-op because the recording context
had no clipboard permission (the paste path only `console.warn`s).

Pieces:

- `boot-tmux.sh` — stages 3 tmux sessions / 9 windows of realistic content
  (pygmentized source, a rolling build, request logs, htop, a pane grid, …) on a
  private socket.
- `attach.sh` — the command webtmux spawns per connection.
- `driver.js` — Playwright script that poses each feature (split, sidebar,
  Exposé, previews, stoplights, copy mode, save dropdown, …) and writes one jpg
  per README feature section into `screenshots/`.
- `run.sh` — container entry: deps → tmux → webtmux on :8090 → driver. `DRIVER=<file>.js`
  runs an ASSERTION driver instead of the screenshot one; those print PASS/FAIL lines and
  exit non-zero on a failure: `verify-ux5.js` (recents cap, pin, arrow nav, lost-socket
  spinner), `verify-mousemode.js` (who gets a click/drag over a mouse-grabbing program),
  `verify-ux6.js` (MRU chord with an empty capture cache, Exposé's status filter, the
  mouse-capture dropdown, the paired sidebar toggles, paste-trim on rename),
  `verify-shift-extend.js` (shift-click adjusts the end of an existing selection from
  its original anchor — in a plain shell and over a mouse-grabbing program, where it
  must reach neither the program nor the copy-mode exit),
  `verify-window-selection.js` (a highlight ends when the window under it does —
  on the UI's own switch and on one it never made, with nothing left painted, while
  an unrelated layout push still leaves a selection alone),
  `verify-state-sync.js` (TWO browser contexts against one tmux server: a cold-cache
  client must not erase the other's split/preview, must converge on it, and a killed
  window must not be resurrected by the next push),
  `verify-copybuffers.js` (the copy-buffer panel: ⌃⌥= opens it at one empty buffer, a
  real ⌘C over a real xterm selection fills it AND the system clipboard, copying again
  before pasting keeps both while copying after a paste reuses the slot, clicking a row
  decides what ⌘V types into the pane, "+"/×/Clear, the toolbar pill opening the panel
  with its count, both right-edge panels open without overlapping, and the buffers
  surviving a reload — needs `permissions: ['clipboard-read','clipboard-write']`),
  `verify-copypeek.js` (the auto-peek: a copy floats the panel in without taking focus
  or resizing the terminal even when the pref says mount, it closes itself and is not
  persisted as open, an already-open panel is left alone, typing/Escape/click/scroll
  elsewhere dismisses it early WITHOUT swallowing the keystroke, reaching for it
  promotes it, and a second copy re-arms rather than stacking),
  `verify-scrollback-save.js` (the ⤓ dropdown saves the WHOLE buffer, asserted against
  the downloaded file),
  `verify-scrollback-buffer.js` (the ⛁ dropdown: reported sizes match `tmux display -p`,
  setting the default leaves existing windows alone, a confirmed resize rebuilds a
  3-pane window in place at the new size, keeps its shape AND carries the scrollback
  across (oldest line + colours), a window tmux launched with a command offers to
  start it again and does, saving for next time writes the tmux config and a SEPARATE
  tmux server started afterwards comes up at that size, clear empties every pane —
  and with `WT_PERMIT_WRITE=0` the sizes are still shown but nothing can change them).
- `driver-gifs.js` — records one video per animated feature, each scene
  replaying its README section's bullets in order (split → drag divider →
  close; hover → preview → restore; lights change → tabs flash until viewed;
  reload → state restores; …). A fake cursor div is injected because Playwright
  videos don't render the pointer, and janitor navigation runs in separate
  unrecorded contexts so it never bloats a recording.
- `run-gifs.sh` — records via `driver-gifs.js`, then ffmpeg (two-pass palette)
  converts each webm to `screenshots/<scene>.gif`, plus `toolbar-alerts.gif`
  cropped from the stoplights take.

The driver navigates via Exposé's type-to-filter, so it observes real UI state
(the filter persists across close/reopen by design — see `exposeState()`).
