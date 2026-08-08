# webtmux v0.2.0

The second tagged release of this fork, and the first whose binaries can be
re-derived from the tag they were built from.

Most of what is here came from asking what a feature already *promises* and then
finding the place it quietly does not keep that promise: a save button that could
only produce the smaller of a pane's two buffers, a scrollback limit you can raise
with no effect on the window in front of you, a copy that silently destroys the
last one, a highlight that outlives the text it named.

## Copy buffers — copy several things, paste them one at a time

A system clipboard holds exactly one thing, so gathering three snippets out of a
scrollback meant three round trips, and every intermediate copy destroyed the last
one silently.

- A list of copy buffers with one FOCUSED entry, and one rule tying it to the
  machine's single clipboard: **the focused buffer is the clipboard.** Focusing a
  row writes it there, so this is not a second clipboard fighting the real one —
  it is a way to choose what the real one holds. Cmd/Ctrl+V keeps working
  everywhere, including in other applications.
- Whether a copy ADDS a buffer or REUSES one is decided by a single question: has
  the focused buffer been pasted yet? Copy before pasting and both are kept; copy
  after pasting and the spent slot is reused. So gathering grows the list and
  ordinary copy-paste never does — the panel stays one row for anyone who does not
  want the feature.
- Copying while the panel is shut floats it in for a couple of seconds so you can
  see where the copy landed: always floating (no terminal is resized), never taking
  the keyboard, and dismissed early by anything else you do. A panel you opened
  yourself is left alone — never auto-collapsed, because it was never auto-shown.
- Ctrl+Alt+= (tmux's own `Prefix+=`, choose-buffer), or the toolbar's NORMAL/COPY
  pill, which now opens the panel and carries a count. The copy/normal mode toggle
  moved inside it; Ctrl+Alt+[ still flips the mode directly.
- Buffers are per browser tab and survive a reload. They are deliberately not
  shared through the tmux server: text you copied is not UI arrangement.

## Scrollback: see it, resize it, and get all of it out

- **The ⤓ save now defaults to the ENTIRE buffer.** Both destinations — the browser
  download and the file written on the machine tmux runs on — were built on the
  capture store that feeds the Exposé thumbnails, which holds only the VISIBLE
  SCREEN. The one thing a terminal is kept for, the output that has already
  scrolled past, was the part you could not get out, and nothing said so.
- **Toolbar ⛁ answers the three things a fixed-capacity ring hides:** how many lines
  a window can hold, how many it is holding (with a gauge that turns amber once
  tmux is already dropping the oldest), and the fact that changing `history-limit`
  does nothing to a pane that already exists.
- **"Resize this window" is a rebuild**, because tmux has no resize — a pane's
  buffer capacity is fixed when the pane is created. The window's panes are rebuilt
  in place at the new size, same name, index and shape, **and the existing
  scrollback is carried across**, colours included. It travels in a tmux buffer
  rather than a temp file, so it works when webtmux is a container that cannot see
  that filesystem.
- A pane tmux itself launched with a command (`#{pane_start_command}`) offers to
  start it again, naming the exact command. A program you started by typing at a
  prompt is one tmux never saw, so the confirmation stops offering rather than
  guessing.
- **New windows** sets `history-limit` for everything created from then on, and
  **Also save it for future tmux servers** writes the line into the tmux config
  file tmux actually loaded, naming the file it wrote.

## Selection

- **Shift-click moves the END of the selection you already have**, keeping the
  anchor you dragged from — so an overshoot is one click to fix rather than a whole
  drag repeated, which matters in a pane that is still printing. It works over a
  mouse-grabbing program too, where xterm's own incremental-click path is disabled
  and therefore unusable.
- **A highlight now ends when the window under it does.** A selection names text,
  but xterm holds it as buffer coordinates and tmux repaints the viewport rather
  than scrolling it, so switching windows left a rectangle sitting over unrelated
  text. The decision comes from the layout, so switches this browser did not make
  are caught too — tmux's own `prefix n`, another client, a reconnect.

## Reconnect and alerts

- **A reload restores the connection; it does not answer your alerts.** Opening a
  laptop to several tabs flashing, refreshing to get the connection back, and
  finding every flash gone was the page's death being indistinguishable from a full
  acknowledgement. The registry is now carried across the gap in per-tab storage,
  which has exactly the right lifetime.
- **A reconnect puts the primary region back in the session it was in**, instead of
  landing on whatever window the shared base session happened to be showing — a
  window nobody had opened, and which the recents strip correctly did not explain.

## Reproducible builds

**This is the first release whose assets can be checked against their source by
anyone.** Four independent inputs used to leak into the binary, each invisible in
normal use and each fatal to an audit: a `date`-derived build stamp, no `-trimpath`
(`-s -w` does not strip file paths), a floating Go toolchain, and a docker context
that was the working tree rather than the commit.

```sh
make release-from-commit REF=v0.2.0   # the release build — no local Go needed
make verify-repro REF=v0.2.0          # proves it: same commit, two directories, same bytes
```

`verify-repro` deliberately varies the build *directory*, because building twice in
one place proves nothing about the leak that actually occurred.

v0.1.0's published assets were replaced with a reproducible rebuild after the fact,
but its tag does not name the commit they were built from. v0.2.0's do.

## Install

Binaries are release assets, one per platform, named `webtmux-<os>-<arch>`. The
repository is public, so no token and no `gh` is needed:

```bash
curl -fsSL -o webtmux \
  https://github.com/sparant/webtmux/releases/download/v0.2.0/webtmux-linux-amd64
chmod +x webtmux
./webtmux -a 127.0.0.1 -w tmux new-session -A -s main
```

Bind loopback as above unless you mean otherwise: the default address is `0.0.0.0`,
and authentication is HTTP basic auth over plain HTTP.

`SHA256SUMS` covers every binary in this release:

```bash
curl -fsSL -O https://github.com/sparant/webtmux/releases/download/v0.2.0/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```

See the README's Installation section for a full fresh-machine walkthrough
(tmux prerequisite, `~/.local/bin`, macOS quarantine xattr).

## Upgrading from v0.1.0

- **The toolbar's NORMAL/COPY pill no longer toggles copy mode** — it opens the copy
  buffer panel, and the button that flips the mode is the first control inside it.
  Ctrl+Alt+[ is unchanged if you want the mode without the panel.
- **The ⤓ save defaults to the whole scrollback**, where it previously produced the
  visible screen. Pick "visible screen" in the dropdown for the old behaviour.
- If you pinned v0.1.0 with `webtmux-launch --webtmux-version v0.1.0` and hit a
  `sha256 mismatch`, that is the pinned-version cache holding the sums from before
  v0.1.0's assets were rebuilt: `rm -rf ~/.cache/webtmux-launch/v0.1.0`. That check
  is the tamper detection, so it is not being loosened.

## Notes

- **Asset names are an interface.** `webtmux-launch` builds its download URLs from
  them, so they will not be renamed. Adding platforms is safe.
- Read-only (`-w` absent) is a browser-facing authority boundary, not a sandbox —
  see v0.1.0's notes for what it does and does not cover. Bind loopback and tunnel
  over SSH.
- The browser UI still loads xterm.js and Tailwind from a CDN at runtime; removing
  that dependency is planned, not done.
- Built with `CGO_ENABLED=0` by a pinned Go 1.23.12; the binaries are static and
  embed their assets.
