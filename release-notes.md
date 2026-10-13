# webtmux v0.3.0

The first release that ships **`webtmux-launch`** as a download, the one where
the preview became a place you arrange rather than a shape the window count
decides, and the one where the shortcuts became tmux's own keys.

Most of what is here came from watching a wall of agent windows in real use: a
light that turned red for an agent that was only waiting on its own build, a strip
of tabs that would not empty however many you closed, a copy a program offered that
never reached the clipboard, and no way to tell how long any window had been the
colour it was.

## The launcher is a release asset

`webtmux-launch` runs on your laptop, installs webtmux on any machine you can
already SSH to, and tunnels it back — the target needs only `ssh` and `tmux`. It has
been in the repository since v0.1.0, and the README has told people to download it
from the release page since then, but no release actually carried it. From v0.3.0
every release does, built from the same tag as webtmux itself:

```bash
curl -fsSL -o webtmux-launch \
  https://github.com/sparant/webtmux/releases/download/v0.3.0/webtmux-launch-darwin-arm64
chmod +x webtmux-launch
./webtmux-launch linuxbox
```

Builds for `darwin-arm64`, `darwin-amd64` and `linux-amd64`. It installs webtmux
v0.3.0 on the target by default (`--webtmux-version` to pick another). The
launcher's checksums are in their own file, `SHA256SUMS.launcher`; `SHA256SUMS`
stays exactly the webtmux binaries, because it is the file the launcher reads to
decide whether a target already has the right binary.

The target is anything `ssh` accepts — a host, `user@host`, a `~/.ssh/config`
alias, or `ssh://user@host:2222` for SSH on another port (`user@host:port` does
not work: `ssh` reads it as a host name). `webtmux-launch --help` and the README
list the forms.

Changes to the launcher itself in this release:

- **The tunnel has its own SSH connection.** It used to ride the connection the
  setup steps share, and when the launcher attached to an already-running webtmux
  that made it print "reconnecting…" forever while the page worked — and left the
  forward depending on a connection that closes itself after 60 idle seconds. Setup
  still shares one connection (one password prompt); the tunnel is a separate one,
  so the process the launcher watches is the tunnel. With a password or 2FA login
  that is one extra prompt when the tunnel starts.
- **A dead tunnel is noticed in ~15–20 seconds, not ~45**, and reconnected without
  you: keepalives every 5s, plus a check through the forward every 5s that bounces
  the tunnel after three misses. That covers a laptop switching networks, where
  `ssh` keeps running on a dead connection.
- **Plainer output.** Lines that need no action say they are informational; the
  login is printed as the user and password to type at the browser's prompt.

## Stoplights: how long, and a green that is not a turn

- **A duration beside every dot**, on recents tabs, sidebar rows and preview tiles, so a wall of
  windows answers "how long has it been like this" without hovering each one. By
  default it is the time since the window last printed anything (tmux's own
  `window_activity`, no hook needed). A hook that also sets `@wt_working_since` makes
  it the time in the current state instead; when both exist, click the badge to
  switch, and hover it to see which reading is on screen.
- **`@wt_working 3` — green ring.** An agent that starts a build or a background
  task and then falls quiet is waiting on itself and will resume unprompted. It used
  to paint red, and a strip of false reds is how the windows that really ran out of
  work stop being noticed. A 1 → 3 change raises no alert; dropping out of either
  green still does. Exposé's **Show** filter has its own button for it, since it is
  the window you can interrupt for free.
- **One dot, everywhere.** Preview tiles and Exposé used to draw their own dots and
  showed the background-work state as "not reporting"; every surface now shares one
  stylesheet and one set of states.

## Preview: placement is per window, and the bar is yours to arrange

The preview used to derive its shape from its size: one window **was** a floating
corner box, two or more **were** a docked bar.

- **Every previewed window has its own slot** — the bar (any number) or one of the
  four corners (one each) — and both surfaces are on screen at once.
  **Ctrl+Alt+I** adds to the bar; **Ctrl+Alt+Shift+I** pins the focused window to a
  free corner, or back to the bar.
- Every tile, bar or corner, has the same hover controls: the corners that are
  actually free, back to the bar, close.
- **Drag a bar tile to reorder** the bar; dropping a corner box on the bar docks it
  where you point.
- **Drag the bar's inner edge to resize it** (double-click resets). Each axis keeps
  its own size, per webtmux instance.
- **Tiles show the content, not the blank screen.** A TUI that draws a dozen rows of
  a fifty-row window is cropped to what it drew, so a sparse panel is readable in a
  thumbnail. Applies to corner boxes, bar tiles, Exposé and the hover preview, and
  never touches the real window.
- Tiles hint like recents tabs: the full `session — window N: name`, labels shaped
  by the same **Recent ▾** toggles, the stoplight key on the dot, and — with the
  view split — the region picker.
- **Escape and Enter answer any hover preview** — from a recents tab, a bar tile or
  a region chip, not only the sidebar: Escape puts the region back, Enter switches.
- Glancing at a thumbnail no longer leaves a selection highlight behind in your own
  region, which used to let ⌘C copy text out of a window you were only looking at.

## Recents strip

- **A window pushed off the strip waits in line instead of being forgotten.** The
  strip shows the first N; close a tab, raise the count, or move a window into the
  preview and the next one slides back in. Only × (or the window dying) removes an
  entry, and a reload keeps the queue.
- **Clear the whole strip** — the ✕ beside the **Recent** label, or the menu. It
  says how many windows it is about to forget, including those queued or held by the
  preview, and closes nothing: windows keep running and split regions keep their
  views.
- **Fitted to the toolbar, never scrolled.** The tab count is the smaller of your
  setting and what fits; the surplus queues and comes back when the window widens.
  Your setting is not changed by a narrow screen.
- A window in the preview gives up its tab while it is there; it comes back where it
  was when the preview lets go.
- **Send a window to a particular split region**: hover a tab for a chip per region,
  or drag the tab onto a region. Sending a window the other region shows swaps the
  two.
- Closing a tab under a still pointer now previews the window that slid into its
  place.

## Sidebar: several kinds of new window per session

A session can offer **one "+" per kind of window**, each captioned with what it
starts — e.g. `+ shell`, `+ secure`, `+ claude`. The command is **typed into a
normal shell**, so Ctrl-C leaves you at a prompt, up-arrow runs it again, and the
window outlives it. Double-click a "+" to edit it, × removes it, `+…` adds one. The
menu is stored on the tmux session (`@wt_newcmds`, JSON), so every browser shares it
and scripts can set it. A session made with "+" inherits the menu and an indexed
name (`editors` → `editors (1)`).

Also: a row being killed shows a progress bar instead of looking like the × did
nothing, and a session tab at the wrap edge no longer flickers on hover.

## Files between the two machines

The ⤓ menu now **uploads and downloads whole files and folders** between the
browser's machine and the machine tmux runs on — a folder downloads as a zip, and a
folder upload arrives as a folder. It rides the authenticated connection the page
already uses, so a session reached through tunnels and jump hosts needs no extra
setup. Paths obey the same rules and allowed directories as saving a buffer, and
transfers — downloads included — need `-w`.

**The filesystem root is no longer an implicit allowed directory**, for saves or
transfers. The pane's directory, the server's home and its working directory used to
count as given, so any of them being `/` — a systemd service's default working
directory, a pane sitting at `/` — put the whole filesystem on offer. They now skip
`/`; `WEBTMUX_SAVE_DIR=/`, or choosing `/` in the dropdown, still counts, because
those are choices.

## The link menu: the tmux settings that touch other clients

The spinner on the far left now **opens**: the connection's state in longhand, and
the tmux **server** settings webtmux manages, each saying who else it affects.

- **tmux status line** — see *Upgrading* below.
- **Copy from a program to this browser.** A program's "press c to copy" (OSC 52)
  now reaches the clipboard of the machine you are sitting at. tmux's shipped
  `set-clipboard external` silently discards those, so webtmux sets it `on` when it
  attaches. Also fixed: an OSC 52 sequence split across websocket frames was lost —
  routine for a long login URL — and the copy panel's "on the clipboard" dot now
  reports whether the browser accepted the write instead of assuming it.
- **Run a command when a window is renamed.** Shows any `after-rename-window` hook
  verbatim, with a save-and-restore switch, and the windows that opted in to it.
  webtmux never writes the command itself.

## Connection health

The spinner reports what it knows: **green** nothing outstanding, **amber** asked
and not yet answered, **red** closed or stalled. Coming back to a sleeping laptop
colours a dead link in about a second instead of ten; typing into a wedged link
turns it amber within ~2s; and a link that recovers heals itself without a reload.
Idle probing is less frequent, and a hidden tab probes nothing.

## Shortcuts are tmux's keys

**Ctrl+Alt now takes the key tmux uses after its prefix**, wherever tmux has one, so
tmux muscle memory carries straight over:

| Ctrl+Alt + | Does | tmux |
|---|---|---|
| `0`–`9` | go to window N of this session | `0`–`9` |
| `%`, `"` (and `⏎`) | add a split region | `%` / `"` |
| `o` / `;` | next region / the region you were in before | `o` / `;` |
| `&` | kill the window (asks first) | `&` |
| `]` | paste the focused copy buffer | `]` |
| `f` | Exposé — **was `e`** | `f` (find-window) |
| `?` | the shortcuts list (as well as `/`) | `?` |

**Exposé opens at 3×3**, and the key and the trackpad gesture now only open and
close it; a **Grid** toggle in its header switches between 3×3 and 2×2 and is
remembered.

## Smaller things

- Reaching for the copy panel while it is peeking after a copy (⌃⌥= or the pill)
  now keeps it open, from the keyboard as from the mouse.
- The permanent white scrollbar track down the terminal's side is gone.
- The Docker build fetches Go modules in their own cached layer, so a JS-only change
  builds without reaching the module proxy. Nothing about what is compiled changes.

## Install

Binaries are release assets, named `webtmux-<os>-<arch>` and
`webtmux-launch-<os>-<arch>`. The repository is public, so no token and no `gh` is
needed. To run webtmux directly on the tmux machine:

```bash
curl -fsSL -o webtmux \
  https://github.com/sparant/webtmux/releases/download/v0.3.0/webtmux-linux-amd64
chmod +x webtmux
./webtmux -a 127.0.0.1 -w tmux new-session -A -s main
```

Bind loopback as above unless you mean otherwise: the default address is `0.0.0.0`,
and authentication is HTTP basic auth over plain HTTP. For the launcher, see the
top of these notes.

Checksums:

```bash
curl -fsSL -O https://github.com/sparant/webtmux/releases/download/v0.3.0/SHA256SUMS
curl -fsSL -O https://github.com/sparant/webtmux/releases/download/v0.3.0/SHA256SUMS.launcher
sha256sum --check --ignore-missing SHA256SUMS SHA256SUMS.launcher
```

Reproducible from the tag, as since v0.2.0: `make release-from-commit REF=v0.3.0`,
and `make verify-repro REF=v0.3.0` to prove it.
The build id the binaries carry (the toolbar's hidden build chip, Ctrl+Alt+B) is
now the tagged **commit**; v0.2.0's carried the id of its annotated tag object
instead, which appears in no commit log.

## Upgrading from v0.2.0

- **webtmux hides tmux's status line on attach**, server-wide — tmux has no
  per-client status option, so a terminal attached to the same server loses it too.
  This is a default, not a policy: the link menu turns it back on, and once you
  choose either way webtmux stops applying the default. A multi-row status line
  comes back at its original height.
- **webtmux sets `set-clipboard on` on attach**, also server-wide and also a default
  you can switch off in the link menu, which restores the value tmux had (`external`
  and `off` kept apart).
- **One previewed window is now a bar tile, not a corner box.** Ctrl+Alt+I always
  adds to the bar; use Ctrl+Alt+Shift+I for a corner. A preview saved by v0.2.0
  comes back as you left it.
- **Exposé moved from Ctrl+Alt+E to Ctrl+Alt+F** (tmux's find-window key), and
  pressing it again closes rather than stepping 2×2 → 3×3. Pick the grid size in
  Exposé's header.
- **`/` is no longer an allowed save/transfer directory unless you choose it.** If
  webtmux runs with its working directory or home at `/`, set `WEBTMUX_SAVE_DIR` or
  pick a directory in the ⤓ dropdown.
- **Closing a recents tab lets the next queued window in.** To empty the strip, use
  the new clear.
- Hooks can start sending `@wt_working 3`; older builds treat it as unknown.
- A session's single `@wt_newcmd` from development builds is still read when no
  `@wt_newcmds` menu is set; writing a menu retires it.

## Notes

- **Asset names are an interface.** `webtmux-launch` builds its download URLs from
  `webtmux-<os>-<arch>`, and the README links `webtmux-launch-<os>-<arch>` under
  `releases/latest`; neither will be renamed. Adding platforms is safe.
- Read-only (`-w` absent) is a browser-facing authority boundary, not a sandbox.
  Bind loopback and tunnel over SSH.
- The browser UI still loads xterm.js and Tailwind from a CDN at runtime.
- Built with `CGO_ENABLED=0` by a pinned Go 1.23.12; the binaries are static and
  embed their assets.
