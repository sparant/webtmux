# webtmux v0.1.0

First tagged release of this fork. Until now every binary reported its version as
`dev`, because the repository carried no tags for `git describe` to find — so this
release exists as much to make a binary able to say *what it is* as to publish one.

`0.1.0` rather than `1.0.0` deliberately: this is a personal fork and makes no
compatibility promise yet. `1.x` would also collide with gotty's lineage.

## What this fork adds over upstream

A browser UI built around watching many tmux windows at once, rather than
attaching to one:

- **Stoplights and work alerts** — every window reports green (working) / amber
  (prompting you) / red (waiting for work) via the tmux option `@wt_working`, and
  anything showing that window flashes when it changes while you are looking
  elsewhere. Built for keeping an eye on a fleet of coding agents.
- **Four ways to monitor and reach a window** — Exposé mosaic, picture-in-picture
  and preview bar, sidebar window tree, and a most-recently-used tab strip.
- **Hover previews** — pointing at any window paints it full-size in a real
  terminal region, and puts back what you were looking at when you move away.
- **Split view** — side-by-side live regions, each an independent tmux view backed
  by its own grouped session.
- **State persistence** — the UI's visual state survives a reload, stored in tmux
  itself.
- **`webtmux-launch`** — run webtmux against a remote machine from your laptop.
  It installs webtmux on the target over SSH and supervises the tunnel; the target
  needs only `ssh` and `tmux`.

## Authority and hardening

Most of the features above were built assuming a trusted browser on a loopback
port. This release closes the gaps that assumption left, because the launcher now
makes remote use ordinary:

- **`-w` (read-only) means watch again.** It gated exactly one thing — keystrokes
  reaching the pty — while everything the browser learned to ask for afterwards
  (select/kill/rename a window, switch or kill a session, rewrite the shared UI
  state, write a file on the machine tmux runs on) arrived with no authority check.
  A read-only server handed any authenticated client the whole tmux server plus a
  filesystem write primitive. Every client→server message is now classified once
  and enforced before dispatch; view-only is the set that changes nothing another
  client can observe.
- **Saving a pane buffer is confined to declared directories.** An absolute path
  was honored as typed and a relative one could climb out with `../`. A resolved
  path must now land inside a directory somebody actually named as a destination,
  with symlinks resolved on both sides. A save also never replaces an existing file
  without asking.
- **tmux commands no longer guess.** Every mutation targets an exact window or
  session, listings put machine-readable fields first so an arbitrary window name
  cannot break parsing, identity reads are keyed by format rather than position,
  and websocket reads and capture fan-out are bounded.
- **The UI state protocol converges.** Concurrent browsers adopt the server's copy
  per section instead of overwriting each other.

Read-only is still not a sandbox — it is a browser-facing authority boundary. Bind
loopback and tunnel over SSH, as the install steps below do.

## Install

Binaries are release assets, one per platform, named `webtmux-<os>-<arch>`. The
repository is public, so no token and no `gh` is needed:

```bash
curl -fsSL -o webtmux \
  https://github.com/sparant/webtmux/releases/download/v0.1.0/webtmux-linux-amd64
chmod +x webtmux
./webtmux -a 127.0.0.1 -w tmux new-session -A -s main
```

Bind loopback as above unless you mean otherwise: the default address is `0.0.0.0`,
and authentication is HTTP basic auth over plain HTTP.

`SHA256SUMS` covers every binary in this release:

```bash
curl -fsSL -O https://github.com/sparant/webtmux/releases/download/v0.1.0/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```

See the README's Installation section for a full fresh-machine walkthrough
(tmux prerequisite, `~/.local/bin`, macOS quarantine xattr).

## Notes

- **Asset names are an interface.** `webtmux-launch` builds its download URLs from
  them, so they will not be renamed. Adding platforms is safe.
- The browser UI still loads xterm.js and Tailwind from a CDN at runtime; removing
  that dependency is planned, not done.
- Built with `CGO_ENABLED=0`; the binaries are static and embed their assets.
