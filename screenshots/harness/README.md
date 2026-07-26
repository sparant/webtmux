# Screenshot harness

Regenerates every screenshot in `screenshots/` by launching the real webtmux
binary against a staged tmux server and driving the UI with Playwright in a
throwaway container. No host setup beyond Docker.

```sh
# 1. Build the binary with the build-id stamped (chip shows the commit)
docker run --rm -v "$PWD":/src -w /src -e CGO_ENABLED=0 -e HOME=/tmp golang:1.23 \
  bash -c 'git config --global --add safe.directory "*" >/dev/null; \
    C=$(git rev-parse --short HEAD); T=$(date -u "+%Y-%m-%d_%H:%M:%S"); \
    go build -buildvcs=false -ldflags "-s -w -X main.Version=dev \
      -X webtmux/server.BuildCommit=$C -X webtmux/server.BuildTime=$T" \
      -o webtmux-test .'

# 2. Capture (installs tmux/htop/pygments + playwright npm pkg on first run)
docker run --rm -v "$PWD":/src mcr.microsoft.com/playwright:v1.48.0-jammy \
  bash /src/screenshots/harness/run.sh
```

Pieces:

- `boot-tmux.sh` — stages 3 tmux sessions / 9 windows of realistic content
  (pygmentized source, a rolling build, request logs, htop, a pane grid, …) on a
  private socket.
- `attach.sh` — the command webtmux spawns per connection.
- `driver.js` — Playwright script that poses each feature (split, sidebar,
  Exposé, previews, stoplights, copy mode, save dropdown, …) and writes one jpg
  per README feature section into `screenshots/`.
- `run.sh` — container entry: deps → tmux → webtmux on :8090 → driver.

The driver navigates via Exposé's type-to-filter, so it observes real UI state
(the filter persists across close/reopen by design — see `exposeState()`).
