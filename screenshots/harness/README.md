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
  `verify-tmux-chords.js` (the tmux-shaped chords, each asked of tmux over its socket:
  ⌃⌥0–9 selects window N, ⌃⌥% and ⌃⌥" add a region, ⌃⌥O / ⌃⌥; move focus between
  regions, ⌃⌥& asks and then kills, ⌃⌥] types the focused copy buffer into the pane — and
  Exposé: ⌃⌥F opens at 3×3 and closes on the next press, ⌃⌥E does nothing, the header's
  Grid toggle re-lays-out the tiles and is remembered, a trackpad spread only opens and
  a pinch only closes. Forges a Mac platform for the gesture, as Chromium answers
  `userAgentData.platform` from the real OS),
  `verify-recents-preview.js` (a window in the preview gives up its recents tab and
  gets it back — in its old slot — when the preview hides it or lets it go, the cap
  counting drawn tabs rather than held entries, ⌃⌥N/P skipping what has no tab while
  ⌃⌥L still walks to it, and the "Recent ▾" menu surviving an all-previewed strip),
  `verify-recents-queue.js` (a window pushed past the last tab is queued, not closed:
  the head of that queue takes the next slot × frees, a dismissed window never returns,
  visiting a queued one gives it a tab back, the tab-count control is reversible, and
  the queue survives a reload),
  `verify-hover-retarget.js` (a recents tab is a slot, not a window: with the pointer
  held still, × on the hovered tab, and a removal that shifts the strip sideways, both
  re-point the preview at whatever window landed under the pointer — and a strip that
  shrinks past the pointer drops the preview instead of leaving it up),
  `verify-recents-fit.js` (the strip is fitted to the toolbar rather than scrolled:
  nothing overflows at any viewport width, narrowing the window queues the tabs that
  no longer fit and widening brings them back in order, the user's cap is never
  rewritten by the width, and the terminal's dead scrollbar reserves no space),
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
  and with `WT_PERMIT_WRITE=0` the sizes are still shown but nothing can change them),
  `verify-content-zoom.js` (the content crop: a window drawing a dozen rows into a
  54-row grid is zoomed ~3.4× in its PiP tile and its Exposé thumbnail while a window
  that fills its grid keeps the plain letterbox scale it always had, the crop never
  clips a cell of ink — re-measured in the page against the crop that was applied —
  it doesn't move on most captures of a rolling log, and a hover preview into a
  half-width region shows the window at native size instead of at 0.49×. Stages its
  own full-screen fixture, because nothing `boot-tmux.sh` starts actually fills its
  grid. `SHOTS=1` also writes a before/after pair of the preview bar to
  `/src/.zoomshots` — worth looking at, since "the numbers say it zoomed" and "you
  can read it now" are different claims),
  `verify-stoplight-bg.js` (the background green, `@wt_working 3`: a value the server
  had never heard of before reaches the strip as a dot with a rule behind it — asserted
  from `getComputedStyle`, since a class nobody styled looks fine in the DOM — the ring
  is the SAME green as a working window but hollow, an agent parking on its own work
  (1 → 3) raises no attention flash while 3 → 0 still does (with a 1 → 0 control first,
  so "no flash" can't be a driver that never sees one), and Exposé's Background button
  selects exactly those windows without Working swallowing them. Writes the strip to
  `screenshots/verify/` — whether a 2px ring is distinguishable at 8px is not something
  an assertion can tell you),
  `verify-preview-selection.js` (a preview does not leave a highlight on the region it
  borrowed: the highlight ends when the previewed screen is blitted in — so ⌘C can't
  copy the previewed window's text out from under it — nothing is left painted when
  the region comes back, a hover with NOTHING selected paints nothing (the ghost
  rectangle a resize used to repaint from a selection long gone), a resize with no
  selection paints nothing either, and pointing at the window the region already shows
  leaves its highlight alone. `diag-resize-ghost.js` is the same claim stripped to the
  xterm behaviour underneath it, with no preview involved),
  `verify-link-health.js` (the connection spinner's three states: a healthy link is
  never coloured by typing or by coming back to the tab, an INTERACTION with a mute
  link goes amber in ~2s and red at the stall deadline, amber is a state it climbs back
  out of, a red link heals itself when the server answers again — no reload — a hidden
  tab is not probed on spec, and returning to a tab whose link died while you were away
  is coloured in ~1s rather than the ~11s the old heartbeat took. Writes live/slow/lost
  spinner crops for `check-link-ink.sh`, which asserts the three are told apart ON THE
  PIXELS — a third state is worth nothing if it renders like one of the other two),
  `verify-preview-slots.js` (WHERE a previewed window is drawn, now that it is a
  per-window choice rather than a function of the set's size: ⌃⌥I puts a lone window in
  the docked BAR — which the count-derived preview could not do — its own hover controls
  pin it to a corner and hand the reserved edge back, a second window sits in the bar
  while the first stays pinned, two windows hold two different corners at once, a corner
  another window is in is not offered at all while the tile's own is drawn active, ⌃⌥⇧I
  pins and unpins from the keyboard, a box of the window you are looking at is the mini
  hint and one of a window you are not is full size, a corner box clears the space the
  bar reserved, and every placement survives a reload. The one-code-path claim is
  asserted by moving ONE window between the two surfaces and diffing the control cluster
  it renders on each — they must differ by exactly the "back to the bar" button.
  `SHOTS=1` writes the two clusters and both surfaces to `screenshots/verify/`, because
  whether six buttons are legible on a 300px tile is not a DOM assertion),
  `verify-preview-reorder.js` (the preview bar's ORDER is the user's: a tile dropped in
  an earlier gap lands in it and one dragged FORWARDS lands in the gap the insertion line
  promised rather than one past it, the line marks that gap before the drop, a tile
  dropped where it already is rewrites nothing, a LEFT-docked bar reorders on the vertical
  axis, a corner box dropped on the bar docks at the position it was dropped in, the
  windows that stayed pinned stay pinned, and the arrangement survives a reload. Its
  private MIME type is asserted both ways: it is what the bar reads, and a terminal region
  does NOT light up for it the way it does for a recents tab.
  Most of the drags are dispatched as DragEvents with a hand-made DataTransfer, but the
  FIRST one is real: `page.dragAndDrop` does drive a native HTML5 drag here (contrary to
  what verify-recents-target.js's comment assumes), and it is the only way to test the one
  thing a synthetic driver cannot see — whether the browser makes a tile a drag source at
  all. It runs first on purpose: a native drag is the flakiest thing in this harness, and
  the same call later in the run, over a page also holding a floating corner box, timed
  out once and crashed the renderer outright the next time.
  `SHOTS=1` writes the bar mid-drag and a column-docked bar to `screenshots/verify/`,
  since whether a 3px line inside a tile's edge reads as "it lands HERE" is not a DOM
  assertion),
  `verify-recents-target.js` (WHICH pane a recents tab goes to: a hovered tab grows a
  region picker only when the view is split, hovering a chip previews the window in
  THAT pane, clicking one lands it there, and asking for a window the other pane is
  already showing trades the two views rather than following it — twice over, since the
  gesture is its own inverse. Also drives the drag: the panes light up as targets for
  the length of it, the payload rides a private MIME type, and a drop moves the window
  exactly as its chip does).,
  `verify-pip-label-format.js` (a Preview tile's label strip follows the Recent ▾
  "Labels" toggles: every combination of show-session and trim-name, flipped through
  the real menu, labels each tile exactly as the toolbar's own formatter labels its
  tab, and a tmux rename reaches the tile still formatted),
  `verify-pip-tile-tip.js` (what a Preview tile says when you point at it — the recents
  tab's answer, at the recents tab's speed: no native `title` anywhere in the preview,
  the tile's hint leads with the full "session — window N: name" and does not explain
  the stoplight, the dot in the label strip is what does, and with the view split the
  tile grows the same region picker a recents tab does — flush on its inward side,
  previewing and sending the window to the pane you pick),
  `verify-link-menu.js` (the dropdown the spinner opens: attaching hides tmux's own
  status line and remembers what it hid WITHOUT recording it as the user's choice, the
  menu's connection row agrees with the spinner's state, the settings row is drawn from
  what tmux actually reports rather than from a default, clicking it puts the bar back
  and takes a row off the tmux window, and clicking again restores the SAVED value.
  Every claim about tmux is asked of tmux over its socket, never of the UI's opinion of
  it — and note that `xterm.rows` is NOT the assertion to make: the browser's row count
  is set by the viewport and does not move, so it passes identically in both states).
  `verify-osc52.js` (a program's "(c to copy)" reaching the BROWSER's clipboard:
  attaching turns tmux's `set-clipboard` on and remembers what it found, an application's
  OSC 52 lands in both the copy ring and `navigator.clipboard`, a sequence deliberately
  torn across websocket frames still copies exactly once and leaves nothing painted in
  the terminal, and the link menu's row switches the forwarding off for real — after
  which reconnecting does NOT switch it back on. Emits the escape from a staged script
  rather than an inline `printf`, because `send-keys` types the command onto the pane and
  a base64 body echoed there would defeat the "was it painted?" assertion).
  `verify-hover-keys.js` (Escape and Enter answer a hover preview from a recents tab and
  from a preview-bar tile — Escape leaves tmux where it was, Enter switches it — still do
  with focus left on a toolbar button, and with no preview up Enter reaches the shell),
  `verify-recents-clear.js` (emptying the strip: the ✕ beside the "Recent" label holds
  its space while invisible and comes out on hover, it asks before acting and No changes
  nothing, and Clear empties the tabs, the off-strip QUEUE and the entries the preview is
  holding — nothing slides into the freed slots, releasing the preview does not bring a
  cleared window back, and a reload does not resurrect the list from `@wt_state`. Also
  that the windows all keep running and no split region is torn down, that the label
  survives an empty strip so the menu is still reachable, and that the menu's own clear
  row does the same thing. The queue is what the feature is about: × on a tab frees a
  slot and the next window in line takes it, which is why clicking × down the strip never
  emptied it).
- `diag-osc52.js` — a DIAGNOSTIC rather than a gate, for when a copy from a pane does
  not arrive. It emits all three channels a real program uses (raw OSC 52, the
  `ESC Ptmux;` DCS passthrough, and `tmux load-buffer -w -`) under several `set-clipboard`
  / `allow-passthrough` combinations and prints which arrive, plus whether each reached
  the system clipboard. This is what established that stock tmux drops the raw sequence
  (`set-clipboard external`) and that tmux ≥3.3 drops the DCS one too
  (`allow-passthrough off`), leaving nothing for the browser to hear.
- `annotate.js` — the magenta ring / arrow / label call-outs that point at the toolbar
  control a README screenshot is about (`annotate`, `clearAnnotations`, `rectOf`).
- `driver-features.js` — stills for the sections added after the first tour (the
  sidebar's all-windows view and new-window menu, stoplight durations, the split region
  picker, file transfer, the ⛁ and link menus). Run it with `DRIVER=driver-features.js`.
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
