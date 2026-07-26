# webtmux

A web-based terminal with tmux-specific features. Access your tmux sessions from any browser with a visual pane layout, touch-friendly controls, and automatic scroll-to-copy-mode.

## Quick Start (Sprite)

Deploy webtmux as a service on [Sprite](https://sprites.app):

```bash
sudo curl -fsSL https://raw.githubusercontent.com/chrismccord/webtmux/main/builds/webtmux-linux-amd64 \
  -o /usr/local/bin/webtmux && \
  sudo chmod +x /usr/local/bin/webtmux && \
  sprite-env services create webtmux \
    --cmd /usr/local/bin/webtmux \
    --args '-w,tmux,new-session,-A,-s,main' \
    --http-port 8080
```

Replace `user:pass` with your desired credentials.

## Features

- **Visual Pane Layout**: Sidebar minimap shows your tmux pane arrangement - click to switch panes
- **Window Tabs**: Quick window switching via clickable tabs
- **Touch-Friendly**: Mobile controls for split, new window, and pane switching
- **Scroll-to-Copy-Mode**: Scroll up automatically enters tmux copy mode
- **Secure by Default**: HTTP Basic Auth with auto-generated credentials
- **Single Binary**: All assets embedded - just download and run
- **Real-time Updates**: Layout changes sync automatically

## Installation

### Prebuilt Binaries

Prebuilt binaries are available in the `builds/` directory for all major platforms:

| Platform | Binary |
|----------|--------|
| Linux (x64) | `builds/webtmux-linux-amd64` |
| Linux (ARM64) | `builds/webtmux-linux-arm64` |
| Linux (ARM) | `builds/webtmux-linux-arm` |
| macOS (Intel) | `builds/webtmux-darwin-amd64` |
| macOS (Apple Silicon) | `builds/webtmux-darwin-arm64` |
| FreeBSD (x64) | `builds/webtmux-freebsd-amd64` |

```bash
# Clone and use prebuilt binary (example for Linux x64)
git clone https://github.com/chrismccord/webtmux.git
cd webtmux
chmod +x builds/webtmux-linux-amd64
./builds/webtmux-linux-amd64 -w tmux new-session -A -s main

# Or copy to your PATH
sudo cp builds/webtmux-linux-amd64 /usr/local/bin/webtmux
```

### Build from Source

```bash
# Clone the repository
git clone https://github.com/chrismccord/webtmux.git
cd webtmux

# Build for current platform
make build

# Or cross-compile for all platforms
make cross-compile
```

## Usage

### Basic Usage

```bash
# Start with tmux (auto-generates credentials)
webtmux -w tmux new-session -A -s main

# Output:
# ========================================
#   Authentication Required (default)
#   Username: admin
#   Password: <random-32-char-password>
# ========================================
```

### Custom Credentials

```bash
webtmux -w -c user:password tmux new-session -A -s main
```

### Disable Authentication (not recommended)

```bash
webtmux -w --no-auth tmux new-session -A -s main
```

### Common Options

| Flag | Description |
|------|-------------|
| `-w, --permit-write` | Allow input to the terminal (required for interactive use) |
| `-p, --port PORT` | Port to listen on (default: 8080) |
| `-a, --address ADDR` | Address to bind to (default: 0.0.0.0) |
| `-c, --credential USER:PASS` | Set custom credentials for HTTP Basic Auth |
| `--no-auth` | Disable authentication (NOT RECOMMENDED) |
| `--ws-origin REGEX` | Regex for allowed WebSocket origins |
| `-t, --tls` | Enable TLS/SSL |
| `--tls-crt FILE` | TLS certificate file |
| `--tls-key FILE` | TLS key file |
| `-r, --random-url` | Add random string to URL path |
| `--reconnect` | Enable automatic reconnection |
| `--once` | Accept only one client, then exit |

Run `webtmux --help` for all available options.

### Saving a pane buffer to a file (and running in a container)

The toolbar's ⤓ button either downloads the focused pane's buffer to your
browser, or writes it to a file **on the machine tmux runs on** — which is the
machine running `webtmux`, and those are not always the same filesystem.

The common trap is running webtmux in a container that mounts only the tmux
control socket. tmux then reports pane directories as *host* paths
(`/home/you/Projects`) that the writing process cannot see, and a relative save
fails on a directory you can see perfectly well in your own shell. webtmux now
detects this: the save dropdown asks the server where a save would land and says
so up front (naming both directories), and a failed save explains which machine
is missing the directory rather than surfacing a raw `open` error.

When webtmux is containerized and no shared directory is known, it does not
guess: a container's own filesystem is always writable, so saving there would
report success for a file that dies with the container. Instead the dropdown
**asks** — "name a directory as webtmux sees it (e.g. `/workspace`), mounted from
outside" — checks that it exists and is writable, and remembers it (in the shared
tmux UI state, so every client on that server gets the answer). A remembered
directory that later disappears re-opens the question rather than silently
redirecting your file. "Download to browser" needs no directory at all.

An operator can answer the question up front instead, by mounting a directory
into the container and naming it in `WEBTMUX_SAVE_DIR`; that variable is how
webtmux knows a directory is shared. Mounting a whole home directory would also
work and is deliberately not the advice — it is far more of the filesystem than
saving a text file needs. Four environment variables adjust the resolution:

| Variable | Effect |
|----------|--------|
| `WEBTMUX_PATH_MAP` | `host=server[,host2=server2]` prefix rewrites, applied to the pane's directory and to absolute paths you type — e.g. `/home/you/Projects=/workspace` |
| `WEBTMUX_SAVE_DIR` | Declares a **shared** directory and enables server-side saving in a container; relative saves land here when the pane's own directory isn't visible. Created if missing. Outside a container this defaults to `$HOME`, then the process's working directory. A directory the user names in the dropdown takes precedence |
| `WEBTMUX_HOME` | What `~` expands to. Unset inside a container, `~` is refused rather than expanded to the image's own home |
| `WEBTMUX_IN_CONTAINER` | `1`/`0` to override container auto-detection, which only affects the *wording* of the explanation |

### Knowing which window needs you

A window can report what it is doing by setting a tmux option on itself:

```sh
tmux set -w @wt_working 1     # green  — working
tmux set -w @wt_working 2     # amber  — prompting: blocked until you answer
tmux set -w @wt_working 0     # red    — waiting for work to do
tmux set -w -u @wt_working    # unfilled — not reporting
```

Anything running in the window can do this — a shell prompt hook, an agent's
start/stop hooks, a script wrapping a long build. webtmux shows it as a stoplight
dot everywhere a window appears: the recent tabs, the sidebar's window list, the
preview thumbnails, Exposé.

The dot tells you the state; the **flash** tells you it *changed*. When a window
drops out of green while you are looking somewhere else, everything showing that
window starts flashing in the colour it changed to — the tab, the sidebar row, the
preview tile's border — and keeps flashing until you go and look at it. There is
no expiry: a signal that gives up after thirty seconds is the one you miss when
you step away.

Five recent tabs cannot hold every window that stops, so the strip ends in an
**attention arrow** (→) whenever a window needs you and has no tab, no preview
tile and no region of its own. It carries the count and flashes like the tabs do,
and clicking it opens the window list on the most recent of them, previewed in a
terminal region. Nothing switches until you press Enter or click the row; Escape
puts everything back. Between the flashes and the arrow, "nothing is blinking"
means "nothing needs you" — which is what makes any of it worth watching.

## Architecture

```
Browser                              Go Backend
+------------------+                +------------------+
| xterm.js         |<--WebSocket-->| webtty core      |<--PTY--> tmux
| Lit.js Sidebar   |   (extended)  | tmux controller  |
| Touch Controls   |               |                  |
+------------------+                +------------------+
```

### Extended WebSocket Protocol

WebTmux extends the gotty protocol with tmux-specific message types:

**Client -> Server:**
- `5` TmuxSelectPane - Switch to pane by ID
- `6` TmuxSelectWindow - Switch to window by ID
- `7` TmuxSplitPane - Split current pane (h/v)
- `8` TmuxClosePane - Close pane by ID
- `9` TmuxCopyMode - Enter/exit copy mode
- `B` TmuxScrollUp - Scroll up in copy mode
- `C` TmuxScrollDown - Scroll down in copy mode
- `D` TmuxNewWindow - Create new window

**Server -> Client:**
- `7` TmuxLayoutUpdate - Full layout JSON
- `9` TmuxModeUpdate - Copy mode state

## Development

### Project Structure

```
webtmux/
├── main.go                 # CLI entry point
├── server/                 # HTTP server & WebSocket handlers
├── webtty/                 # WebTTY protocol implementation
├── pkg/tmux/               # Tmux controller
├── backend/localcommand/   # PTY backend
├── bindata/static/         # Embedded web assets
│   ├── js/
│   │   ├── webtmux.js      # Main frontend
│   │   └── components/     # Lit.js web components
│   └── index.html
└── resources/              # Source assets (for development)
```

### Building

```bash
# Development build (copies fresh assets)
make dev

# Production build
make build

# Cross-compile all platforms
make cross-compile

# Create release archives
make release
```

### Tech Stack

- **Backend**: Go, gorilla/websocket
- **Frontend**: xterm.js, Lit.js, Tailwind CSS (CDN)
- **Embedded Assets**: Go 1.16+ embed directive

## Credits

WebTmux is a fork of [gotty](https://github.com/yudai/gotty) by Iwasaki Yudai.

## License

MIT License - See [LICENSE](LICENSE) file for details.
