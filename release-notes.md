# webtmux v0.4.0 — first public release

This is webtmux's first public release. webtmux puts your tmux sessions in a
browser: every window visible at a glance, stoplights that show which windows
are working, which are waiting on you and which are idle, and tmux's own keys
with Ctrl+Alt in place of the prefix. It was built for running many AI coding
agents at once. `webtmux-launch` gets it onto any machine you can SSH to in one
command, and the target needs only `ssh` and `tmux`.

Earlier tags (v0.1.0 to v0.3.0) were working releases. If you never ran them,
start at [Install](#install). What is new since v0.3.0: split views are now a
real layout, left|right and top/bottom in any arrangement with a header per
view. The launcher now also runs on this machine without SSH, on Windows
(natively and into WSL), and on a laptop that changes networks under it.

## Split views: a layout, not a row

A split view divides the **browser**, and each view shows a whole tmux window.
That is different from a tmux pane, which divides a window and travels with it.
Views are independent of each other.

- **Split either way.** The focused view splits left | right (Ctrl+Alt+% or
  Ctrl+Alt+Enter) or top / bottom (Ctrl+Alt+"), from the keys or the toolbar's
  split menu. Once split, the menu can also add a view across the **whole**
  screen: full height on the right, or full width along the bottom. Both kinds of
  divider drag. The shape is shared; sizes stay per browser.
- **Every view has a header** naming its window, with its stoplight and time in
  state. Near the top of a view, move arrows and a close button fade in. An arrow
  moves the view's whole branch past its neighbour, and every view keeps its size.
- **The focused view always navigates.** It wears a cyan frame, and every
  switcher (recents, sidebar, previews, Exposé, keys) changes it. Picking a
  window another view already shows swaps the two views' windows instead of
  pulling you across. The region picker is gone. The sidebar marks windows shown
  elsewhere, and hovering a window another view holds pulses that view's frame.
- **Closing a window never closes a view.** The view moves on to the next recents
  tab, even when the window's whole session went with it. Only a view's own close
  button, or Ctrl+Alt+X for the focused view, removes the view.
- **Ctrl+Alt+L counts views.** Walking back through recent windows stops at
  windows other views show and lands by focusing that view.

## The launcher

- **This machine, without SSH.** With no target, or `localhost` or one of this
  machine's own addresses, the launcher installs and runs webtmux here directly,
  with no tunnel. It stops webtmux when it exits, and tmux keeps running. Another
  user (`other@localhost`) or another port still goes over SSH, and `--ssh`
  forces it.
- **Windows.** The release now carries `webtmux-launch-windows-amd64.exe` and
  `webtmux-launch-windows-arm64.exe`. webtmux itself still needs a Unix machine.
  From Windows, point the launcher at a box you SSH to, or at WSL:
  `webtmux-launch wsl` (or `wsl:<distro>`) runs webtmux in the distro, and
  the Windows browser opens it directly.
- **Changing networks.** The launcher listens for the OS's network changes and
  reconnects as soon as the SSH server is reachable on the new network, instead
  of finishing its backoff. The browser tab retries at once too, instead of every
  10 seconds. A Wi-Fi join that reports its addresses one at a time no longer
  restarts a tunnel that is still coming up. A reconnect also clears away the
  webtmux left behind on the old connection, which used to hold its port.
- **It says which build is running.** When it attaches to a webtmux that is not
  the build it would install, it connects anyway and names both, by tag or commit,
  with dates. A matching build says nothing.
- **It says when a newer release is out.** It asks GitHub at most every 12 hours,
  waits no more than 3 seconds, and only recommends; `--no-update-check` or
  `WEBTMUX_LAUNCH_NO_UPDATE_CHECK=1` turns it off.
- **Google Chrome opens when installed**; `--default-browser` opens the system
  default instead.
- **Missing `ssh` or `tmux`** gets the install command for your system before
  anything is attempted.
- **macOS targets:** the attach script no longer dies under macOS's bash 3.2
  ("SOCKARGS[@]: unbound variable").

## Smaller things

- `webtmux --version` adds two lines after the first: `commit <hash>` and
  `built <time>`.
- The auto+ scroll mode's tooltip says that copy mode is entered automatically,
  not never.
- The README's Quick Start is shorter. The setup detail moved further down.

## Install

Binaries are release assets, named `webtmux-<os>-<arch>` and
`webtmux-launch-<os>-<arch>` (`.exe` on Windows). No token and no `gh` are
needed. From a laptop:

```bash
curl -fsSL -o webtmux-launch \
  https://github.com/sparant/webtmux/releases/download/v0.4.0/webtmux-launch-darwin-arm64
chmod +x webtmux-launch
./webtmux-launch linuxbox
```

Or run webtmux directly on the tmux machine:

```bash
curl -fsSL -o webtmux \
  https://github.com/sparant/webtmux/releases/download/v0.4.0/webtmux-linux-amd64
chmod +x webtmux
./webtmux -a 127.0.0.1 -w tmux new-session -A -s main
```

Bind loopback as above unless you mean otherwise: the default address is
`0.0.0.0`, and authentication is HTTP basic auth over plain HTTP.

Checksums:

```bash
curl -fsSL -O https://github.com/sparant/webtmux/releases/download/v0.4.0/SHA256SUMS
curl -fsSL -O https://github.com/sparant/webtmux/releases/download/v0.4.0/SHA256SUMS.launcher
sha256sum --check --ignore-missing SHA256SUMS SHA256SUMS.launcher
```

Reproducible from the tag: `make release-from-commit REF=v0.4.0`, and
`make verify-repro REF=v0.4.0` to prove it.

## Upgrading from v0.3.0

Only for anyone who ran an earlier working release:


- **Navigation always changes the focused view.** A window no longer pulls you
  back to the view it was last in, and the recents/preview region picker is
  removed.
- **The sidebar's "Close this view" button is gone.** Use the ✕ in the view's
  header, or Ctrl+Alt+X.
- **The launcher no longer uses SSH for this machine.** If you relied on
  `webtmux-launch localhost` going through sshd, pass `--ssh`.
- **The launcher opens Google Chrome when it is installed.** Pass
  `--default-browser` for the old behaviour.
- **`webtmux --version` prints three lines.** The first is unchanged, so
  scripts that read only the first line keep working.
