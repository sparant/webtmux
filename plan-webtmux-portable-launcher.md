# Plan: webtmux portable — Stage 3, the SSH launcher

`plan-webtmux-portable-launcher.md` — subplan of `plan-webtmux-portable.md`, created
2026-07-25.

## Goal

One command on a Mac that: works out which webtmux the target machine needs, fetches it
from GitHub, installs it over SSH, starts it, tunnels the port back, keeps both alive, and
opens the browser.

```bash
webtmux-launch linuxbox          # that's it
```

Replaces: SSH in → install webtmux → start it → keep it alive → set up a port forward →
keep *that* alive → paste a URL.

**The launcher and webtmux are built and released independently.** *(Revised 2026-07-26:
an earlier design embedded gzipped webtmux binaries in the launcher via `//go:embed`.)*
The launcher carries no webtmux at all — it resolves the target's platform over SSH and
downloads the matching release asset.

That removes a combinatorial coupling: with embedding, every webtmux change forced a
rebuild *and republish* of every launcher binary, and each launcher carried the sum of all
target payloads (~15 MB). Now a webtmux fix reaches every launcher already in the field
with **no launcher release at all**, and the launcher stays ~5 MB.

The Mac does the downloading and pushes over the SSH connection it already has open, so
**target machines need no internet, no `curl`/`wget`, and no pre-installed webtmux.**

## Gate

**Do not execute until Stage 0 (`plan-webtmux-portable-fork.md`) is done** — origin must
be the user's public GitHub fork, which is where release assets are fetched from.

```bash
git -C /workspace/webtmux remote get-url origin | grep -q 'github.com' \
  || { echo "GATE: Stage 0 not done — origin is $(git -C /workspace/webtmux remote get-url origin)"; exit 1; }
```

**Stage 2 should also have published `v0.1.0`** before end-to-end testing — the launcher
fetches a release, so there must be one. That is why the execution order is D → 0 → 2 → 3.
Development can proceed without it via `--webtmux-binary <path>` (task 3.7a); only the
fetch-path tests (3.15e) genuinely require a published release.

---

## Worktree

- **Branch:** `feat/portable-launcher`
- **Worktree:** `/workspace/webtmux-portable-launcher`

```bash
git -C /workspace/webtmux worktree add /workspace/webtmux-portable-launcher \
    -b feat/portable-launcher local-main
cp /workspace/webtmux/plan-webtmux-portable*.md /workspace/webtmux-portable-launcher/
```

Merge with `--no-ff`. See the Worktree Reference in the master plan.

---

## Design

### The insight that makes "keep it alive" simple

**webtmux is disposable — the tmux server holds all the state and outlives it.** So we do
not supervise a remote daemon, write PID files, or reap orphans. One SSH invocation
carries both the forward and the remote process:

```
ssh -L <local>:127.0.0.1:<remote> host 'exec webtmux … tmux new-session -A -s main'
```

Connection dies → webtmux dies with it. The launcher restarts the whole thing and the tmux
panes are exactly where they were. Two hard problems ("keep the binary alive", "keep the
tunnel alive") collapse into **one supervised subprocess**.

### Reconnect cost — keep the cold path out of the warm path

The disposable design is only cheap if a reconnect does **not** re-run setup. The steps
split cleanly, and the implementation must preserve this split:

| Step | Cold start | Reconnect |
|---|---|---|
| Probe (arch, tmux, session list) | yes | **no** — cached in memory for the process lifetime |
| Fetch from GitHub + deploy + attach script | yes, if the sha is missing | **no** — content-addressed `test -x` already satisfied |
| Create base session (`new-session -d`) | yes | **no** — the session is durable; it outlived the drop |
| Readiness poll + open browser | yes | **no** — first success only |
| `ssh -L … exec webtmux … attach` | yes | **yes — this is the entire reconnect** |

So a reconnect is one SSH handshake plus a Go binary starting an HTTP server and
attaching a tmux client. **The handshake dominates completely** — roughly 100-300 ms on a
LAN, up to ~1 s over WAN. webtmux's own startup is negligible against that (the only
non-trivial work is `ReservePtys` at `main.go:113-124`, ~256 `open()` calls, tunable via
`WEBTMUX_PTS_FLOOR`).

**How flaky is SSH really?** A stable link holds for days. The real killers are laptop
sleep (guaranteed), WiFi roaming, and **NAT/firewall idle timeouts** — the most common
cause of perceived flakiness. `ServerAliveInterval=15` does double duty: it detects death,
*and* it prevents the idle-timeout class of drop outright by keeping traffic flowing.

**Why not keep webtmux running persistently and only re-tunnel?** The websocket dies with
the tunnel regardless, so the browser reconnects either way. Persistence would buy a few
hundred milliseconds and cost orphan processes, PID files, staleness checks, port-reuse
detection, and an upgrade path that has to kill the old process — exactly the complexity
the disposable design removes. Not worth it.

**What the user actually sees:** the tab stays open, the terminal freezes briefly, then
resumes with full scrollback. Ports and the secret path are generated **once** and reused
across restarts (task 3.8), so the URL never changes; `--reconnect` makes the websocket
retry on its own; tmux holds all state.

**The one case where this genuinely hurts:** if SSH auth requires interaction — YubiKey
touch, TOTP — then *every* reconnect prompts. `ControlPersist` does not help, because
network death kills the master connection too. See risk 12 for mitigations.

### Why shell out to `ssh`

It inherits `~/.ssh/config`, `ProxyJump` bastions, ssh-agent, 1Password/YubiKey,
`known_hosts`, and 2FA for free. Reimplementing that with `x/crypto/ssh` is exactly the
"complicated for people" surface being removed.

### Direction

`ssh -L`, always initiated **from the Mac**. This is a *local forward*, not a reverse
tunnel. `ssh -R` (Linux box initiates) would only be needed if the target were unreachable
from the Mac — out of scope, but keep tunnel setup behind a small interface so it could be
added without restructuring.

### Auth model

**`--no-auth` + a 32-char secret path**, both ends bound to `127.0.0.1`.

Chrome dropped `http://user:pass@host` URLs, so a credential cannot be handed to the
browser in a link — keeping basic auth means typing a password every launch, defeating the
purpose. With loopback-only binding, reaching the server needs either the
SSH-authenticated tunnel or a local account on one of the two machines; the secret path is
what stops a local account finding it by port-scanning `127.0.0.1`.

**Stated plainly: any local user on either machine who learns the secret path gets a
shell.** For shared multi-user boxes, `--auth` keeps basic auth on and prints the
password. When a credential *is* passed, it goes via the `GOTTY_CREDENTIAL` env var
prefixed to the remote command — **never** `-c user:pass`, which is visible in `ps` to
every user on that machine.

Use webtmux's existing `--path /<secret>/` flag rather than its `--random-url`: `--path`
lets the *launcher* choose the secret, so it knows the URL without scraping stdout.

### Session handling — attach if present, create durably if not

Attach is not just supported, it is the **default path**. `attach-web.sh` mode 2 is
`tmux new-session -A -s "$BASE"` — `-A` is atomic attach-or-create, which is strictly
better than check-then-create (no TOCTOU race between the probe and the launch).

**The launcher must ship an attach script; it cannot just run `tmux` directly.** This is
the load-bearing finding. Split-view depends on a wrapper:

- `server/handlers.go:148-163` injects a `Webtmux-Session` header per connection, which
  `localcommand` turns into `HTTP_WEBTMUX_SESSION` in the pty's environment.
- `attach-web.sh` mode 1 reads that and joins a **grouped** session
  (`new-session -t <base> -s <name>` + `set-option destroy-unattached on`) — shares the
  base's window *list* but keeps an independent current-window and size.

If the remote command were a bare `tmux new-session -A -s main`, every browser region
would attach the **same** session and all splits would mirror each other. The split-view
feature would be silently broken. So the payload ships an attach script alongside the
binary, adapted from `scripts/webtmux-docker/attach-web.sh` with the container-specific
socket defaults dropped.

**Durability is already the established pattern**, and it is `ensure_base()`:

```bash
tmux -S "$SOCK" has-session -t "=$BASE" 2>/dev/null \
  || tmux -S "$SOCK" new-session -d -s "$BASE"
```

`new-session -d` creates the session **detached**, so it belongs to the tmux server
daemon from the moment it exists — not to any client, not to webtmux, not to the SSH
process tree. tmux double-forks and reparents to init, so it survives SSH disconnect by
design. Note the asymmetry that makes this correct: **grouped regions get
`destroy-unattached on` (disposable), the base session does not (durable).**

The launcher does creation as its own one-shot SSH command during setup, *before*
starting webtmux — so the base session is durable independent of anything the supervised
process does. webtmux's child then only ever *attaches*, and its death is always just a
client detach.

### Adopt an already-running webtmux — the default when one exists

**Never start a second webtmux when the box already has one.** This is the common case,
not the exception: webtmux is normally already running on these machines. Adopting it is
strictly cheaper and avoids imposing configuration on the user.

Adopt mode skips **deploy, session creation, and launch entirely** — the launcher's whole
job becomes the tunnel plus the browser. Cold start collapses to roughly the cost of a
reconnect.

**Detection**, in the same round-trip as the rest of the probe:

```bash
pgrep -x webtmux -u "$(id -u)" | while read -r pid; do
  tr '\0' ' ' < /proc/$pid/cmdline; echo
done
```

Parse `-p/--port`, `-a/--address`, `-m/--path`, and `-c/--credential` straight out of
`/proc/<pid>/cmdline`. This beats `ss`/`lsof` — no extra dependency, no privileges needed
for your own processes. Read `/proc/<pid>/environ` for `GOTTY_CREDENTIAL` and
`WEBTMUX_SESSION` too (same-user readable).

**Is it the same build?** `sha256sum /proc/<pid>/exe` and compare against the expected sha
for the resolved version — which comes from the release's `SHA256SUMS` asset (task 3.7).
On mismatch, adopt anyway but warn: an older build may predate a feature you rely on.
`--fresh` overrides. Note this comparison is **free of a binary download** — only the tiny
`SHA256SUMS` asset is fetched, so adopt mode never pulls 12 MB.

**Credential recovery has hard limits — be precise about them.** Recovery works in
exactly two cases: `-c user:pass` on the command line (readable from
`/proc/<pid>/cmdline`) or a user-set `GOTTY_CREDENTIAL` (readable from
`/proc/<pid>/environ`). The default auto-generated password is created **in-process**
(`main.go:86`) and printed to stdout at startup — it is *never* in the environment and is
**not recoverable** by the launcher. When recovered, print it for the user to paste
(browsers won't take `user:pass@host` URLs). When not, say so plainly rather than opening
a URL that just 401s.

**The instance may be inside a container — and on this user's own Linux box, it is.** The
production webtmux runs in Docker under the same uid, so `pgrep` finds it, but everything
read from `/proc` is container-relative: `-a 0.0.0.0` is the *in-container* bind (actually
published only to host loopback — a false "exposed!" warning), `-p` matches the host port
only by coincidence of the port mapping, and `/proc/<pid>/exe` is the container's binary
(guaranteed sha mismatch). Detect containerization by comparing
`/proc/<pid>/ns/pid` (or `/proc/<pid>/cgroup`) against the probe shell's own, then
soften the reporting: name the container, skip the bind warning, and probe the *published*
port for reachability instead of trusting cmdline.

**Report what was adopted** — port, bind address, tmux session, uptime, and whether the
build matches. Two things warrant an explicit warning: a **`0.0.0.0` bind** (that instance
is exposed on the box's network, not just loopback), and `--no-auth` **without** a secret
path.

**Teardown must not kill an adopted process.** In launch mode webtmux dies with the SSH
connection, which is the point. In adopt mode it is the user's long-lived process — the
launcher tears down only its own tunnel. Getting this backwards would destroy the very
persistence they set up.

### Mode selection — two independent checks, do not conflate them

**Launching its own webtmux is the primary path.** The launcher works out of the box on a
machine that has never seen it: no config, no pre-deployed binary, no systemd unit. It
never refuses to launch.

Adoption is triggered by **"an instance is already running"** — *not* by detecting a
durability problem. It fires on a perfectly healthy box, purely to avoid starting a
duplicate.

| Running webtmux found? | Action |
|---|---|
| **Yes** | Adopt — tunnel only. Skip deploy, session creation, and launch. |
| **No** | Launch our own — deploy if needed, create the session detached, supervise. |

**Durability detection is orthogonal and never changes the action taken.** It only changes
what is *reported*. If the launcher started its own instance **and**
`KillUserProcesses=yes` means the session won't survive logout, it prints the options from
risk 10 — then carries on and opens the browser. Advisory, never blocking.

The two connect in one direction only: if the user acts on that advice and stands up a
persistent webtmux, the **next** run detects it and takes the adopt path automatically. No
flag, no reconfiguration. That is what makes the advice worth printing rather than being a
dead end.

**Overrides:** `--fresh` ignores a running instance and starts a new one on a different
port; `--adopt-only` fails rather than starting one.

**Two env vars are mandatory when the command is a wrapper.**
`server.detectTmuxSession()` (`server/server.go:151`) parses `-s`/`-t` out of argv only
when the command *is* tmux; a wrapper script hides those args, so it falls back to `"0"`
and the sidebar controller targets a session that doesn't exist. `WEBTMUX_SESSION` wins
over detection and must be set. `WEBTMUX_SOCKET` can be left **unset** for a native
install — empty means tmux's default socket, handled correctly at
`pkg/tmux/capture.go:100` and in `Controller.runTmux`.

---

## Phase 3A — Scaffold

- [ ] **P0** 3.1 Create the worktree per the block above, after the gate check. *(5 min)*

- [ ] **P0** 3.2 Scaffold `cmd/webtmux-launch/`. The repo root stays `package main`
      (`main.go`, `version.go`), so `go build .` still builds webtmux and
      `go build ./cmd/webtmux-launch` builds the launcher — no restructuring needed.
      *(30 min)*

- [ ] **P0** 3.3 **Release-fetch configuration — no embedded payload.** *(35 min)*
      *(Revised 2026-07-26: this task previously embedded gzipped webtmux binaries via
      `//go:embed payload`. See "Independent builds" above for why that is gone.)*

      Bake three values at build time with ldflags, so the launcher is self-describing and
      needs no config file to work:

      ```
      -X main.RepoOwner=<you> -X main.RepoName=webtmux -X main.DefaultWebtmuxVersion=v0.1.0
      ```

      A **pinned default** rather than always-latest: reproducible, no surprise upgrade
      mid-session, and the happy path needs no version-resolution request at all.
      `--webtmux-version vX.Y.Z|latest` overrides.

      **No GitHub API, no auth, no JSON parsing** — both forms are plain HTTPS GETs that
      work on a public repo, with `latest` handled by GitHub's own redirect:

      ```
      https://github.com/<owner>/<repo>/releases/download/<tag>/webtmux-<platform>
      https://github.com/<owner>/<repo>/releases/latest/download/webtmux-<platform>
      ```

      Use `net/http` from the standard library — this adds **zero** dependencies, which
      matters given Stage D runs first specifically to shrink that surface.

- [ ] **P0** 3.4 Makefile target — just one now. *(15 min)*

      ```make
      launcher:    # build launcher for darwin/arm64, darwin/amd64, linux/amd64
      ```

      No `launcher-payload`, no cross-compiling webtmux as a prerequisite: the launcher
      builds from its own source alone. Consequently `make launcher` is fast and cannot
      ship a stale webtmux — the old "payload staleness" risk disappears with the payload.

      **Also drop the now-dead `.dockerignore` line** `cmd/webtmux-launch/payload/*.gz`
      (it was added anticipating this design). Stage 2 task 2.4 tracks the same cleanup;
      whichever runs first should do it.

---

## Phase 3B — Connection flow

- [ ] **P0** 3.5 **Multiplexed control connection** — one password/2FA prompt covers the
      probe, the copy, and the tunnel instead of three. *(45 min)*

      **The mux gotcha that matters:** keepalive options set on a mux *client* are
      ignored — only the connection that becomes **master** owns the TCP link and its
      `ServerAlive*` behaviour. So do not configure keepalives on "the supervised
      command" and mux options on "the probe" as separate concerns. Instead, pass ONE
      identical option set on **every** ssh invocation:

      ```
      -o ControlMaster=auto -o ControlPath=~/.ssh/cm-webtmux-%C -o ControlPersist=60s \
      -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10
      ```

      With `auto`, whichever call runs first becomes master and *it* carries the
      keepalives; everything later rides it. After a network drop the master dies (that's
      the keepalives working) and can leave a **stale control socket** — the supervisor
      must handle it between retries (`ssh -O check`, and remove the socket if dead)
      or the reconnect hangs on a dead mux instead of establishing a fresh connection.

- [ ] **P0** 3.6 **One-round-trip probe** — a small shell snippet returning `uname -s`,
      `uname -m`, `command -v tmux`, `$HOME`, whether the content-addressed binary already
      exists, and **the existing tmux session list**
      (`tmux list-sessions -F '#{session_name}' 2>/dev/null`). Fail with actionable
      errors: no tmux → name the install command for the detected distro; unsupported
      platform → say which platforms the release publishes. *(45 min)*

      `uname -s`/`-m` now feed the **release asset name** (`linux-amd64`, `linux-arm64`,
      `darwin-arm64`, …), so normalize them carefully: `x86_64`→`amd64`, `aarch64`→`arm64`,
      `armv7l`→`arm`. A wrong mapping produces a 404 on download rather than a bad binary,
      but the error must name the asset it looked for. `gzip` is no longer probed — the
      launcher controls the transfer and does not need it remotely.

      The session list is for **reporting and `--session` validation only** — the actual
      attach uses `-A` (atomic attach-or-create), so there is no check-then-create race.
      Print what was found: `attaching to existing session 'main'` vs
      `creating session 'main'`. With no `--session` and exactly one existing session,
      default to it rather than to the literal name `main`.

- [ ] **P0** 3.6a **Detect an already-running webtmux** in the same round-trip, and make
      adopt the default when one is found. Parse `/proc/<pid>/cmdline` for port, bind
      address, `--path`, and `-c`; read `/proc/<pid>/environ` for `GOTTY_CREDENTIAL` and
      `WEBTMUX_SESSION`; `sha256sum /proc/<pid>/exe` to compare against the expected sha
      from the release's `SHA256SUMS`. *(45 min)*

      Adopt mode **skips tasks 3.7 (fetch + deploy), 3.8a (attach script), 3.8b (session create),
      and the remote-command half of 3.9** — the launcher only builds the tunnel and opens
      the browser. Report port, bind, session, uptime, and build match. Warn on a
      `0.0.0.0` bind or `--no-auth` with no secret path — but check the pid namespace
      first: a **containerized** instance (the production deploy!) reports
      container-relative cmdline values, so suppress the bind warning and verify the
      *published* port instead (see the container paragraph in the design section).

      Handle multiple instances: if more than one is found, list them and require
      `--remote-port` to disambiguate rather than guessing.

- [ ] **P0** 3.7 **Fetch from GitHub, then deploy content-addressed** to
      `~/.cache/webtmux/webtmux-<sha256[:12]>` on the target. *(75 min)*
      *(Revised 2026-07-26: the source is a GitHub Release rather than an embedded blob.
      The content-addressing and the atomic install are unchanged.)*

      **Order matters — check before you download.** The `SHA256SUMS` asset is a few
      hundred bytes; the binary is ~12 MB. So:

      1. GET `SHA256SUMS` for the resolved version (cache it on the Mac).
      2. Look up the expected sha for the target's platform → gives the install path.
      3. `test -x ~/.cache/webtmux/webtmux-<sha12>` on the target.
      4. **Already there → stop.** No download, no transfer. This is the common case on a
         repeat launch, and it costs one tiny HTTP GET plus one `test`.
      5. Otherwise fetch the binary to the Mac cache, **verify its sha**, then push.

      **Mac-side cache:** `~/.cache/webtmux-launch/<version>/webtmux-<platform>`, so a
      second target on the same platform needs no second download, and a warm cache works
      offline entirely.

      **Verify before transfer, never after.** A corrupted or truncated download must fail
      on the Mac — never push an unverified binary and discover the problem remotely.

      **Transfer** streams over the existing SSH connection to a temp path, then
      `chmod +x` and atomic `mv`. Content-addressed naming means the destination never
      collides with a *running* binary, so **`ETXTBSY` remains structurally impossible**.
      Gzip the stream in-process if worth it — but the remote no longer needs `gzip`
      installed, which removes a probe check and a failure mode.

      Three properties still come free from content-addressing:
      - "Is a copy needed?" is a plain `test -x` — no version parsing, no ambiguity.
      - `ETXTBSY` is structurally impossible.
      - Multiple versions coexist. Prune older entries on success.

- [ ] **P1** 3.7a **`--webtmux-binary <path>` escape hatch.** Skips fetching entirely and
      pushes a local file. Three reasons it earns its keep: the launcher is testable
      **before any release exists** (which matters because Stage 2 must otherwise land
      first), a developer can deploy an unreleased build, and a fully-offline Mac can still
      deploy. Compute the sha locally so the install path stays content-addressed. *(20 min)*

- [ ] **P0** 3.8 **Allocate ports and secret once per target — and persist them.** Local:
      bind `127.0.0.1:0`, read the port, close. Remote: pick a random high port, retry on
      "address already in use" (webtmux has no `--port 0`). *(40 min)*

      Store `{local port, remote port, secret}` per target in
      `~/.config/webtmux-launch/<target>.json` (0600) and reuse on subsequent runs. This
      extends URL stability across **launcher restarts**, not just reconnects within one
      run — quit the launcher, relaunch tomorrow, and the already-open browser tab
      revives via its own `--reconnect` loop because the URL never changed. Fall back to
      fresh allocation if a stored port has since been taken.

- [ ] **P0** 3.8a **Ship the attach script** next to the binary, as
      `~/.cache/webtmux/attach-<sha>.sh`. Adapt `scripts/webtmux-docker/attach-web.sh`,
      dropping the container-specific socket default (`/host-tmux/default` → unset, i.e.
      tmux's default socket) and the legacy `WEBTMUX_GROUPED` mode. Keep modes 1 and 2
      verbatim — mode 1 *is* split-view. *(35 min)*

      **Keep the `tmux -u` flag and the `LANG`/`LC_ALL=C.UTF-8` exports.** tmux decides
      per client at attach time whether the terminal is UTF-8 capable; SSH does not
      forward `LANG` unless the server sets `AcceptEnv`, so a remote login in the POSIX
      locale makes tmux flag the client `utf8=0` and **downgrade every wide/box-drawing
      glyph** it sends to the browser. That is a server→client downgrade — no font or
      renderer change on the client can fix it.

- [ ] **P0** 3.8b **Create the base session durably**, as its own one-shot SSH command
      during setup, *before* webtmux starts: *(20 min)*

      ```bash
      tmux has-session -t "=<session>" 2>/dev/null || tmux new-session -d -s "<session>"
      ```

      `-d` creates it detached, so it belongs to the tmux server daemon from the moment it
      exists — not to webtmux, not to the SSH process tree. Doing this as a separate step
      (rather than relying on `-A` inside the supervised child) means the session's
      durability never depends on anything the supervised process does.

- [ ] **P0** 3.9 **The supervised command.** Note it runs the **attach script**, not tmux
      directly, and exports `WEBTMUX_SESSION` — without which `detectTmuxSession()` falls
      back to `"0"` and the sidebar controller targets a nonexistent session. *(35 min)*

      ```
      ssh <shared option set from 3.5> -o ExitOnForwardFailure=yes \
          -L 127.0.0.1:<local>:127.0.0.1:<remote> <target> \
          'WEBTMUX_SESSION=<session> exec ~/.cache/webtmux/webtmux-<sha> \
                -w -a 127.0.0.1 -p <remote> --path /<secret>/ --no-auth --reconnect \
                ~/.cache/webtmux/attach-<sha>.sh'
      ```

      **`--pass-headers`: verify whether it is needed — do not assume.** *(Revised
      2026-07-26: an earlier draft called it required, but the production compose command
      runs WITHOUT it and split-view works daily.)* The server *injects* the
      `Webtmux-Session` header itself (`server/handlers.go:161`); the `--pass-headers`
      flag most likely gates only client-supplied request headers. During implementation,
      test split-view without the flag; add it only if grouped regions fail to separate.
      Either way 3.15c catches a regression.

      **`ServerAlive*` is not optional.** A Mac that sleeps or changes wifi leaves SSH
      **hung, not exited** — without these the supervisor never learns it should restart.
      `ExitOnForwardFailure` turns a port collision into a clean failure instead of a
      tunnel-less session that looks fine until the browser can't connect.

---

## Phase 3C — Supervision and UX

- [ ] **P0** 3.10 **Readiness poll, then open the browser once.** Poll
      `http://127.0.0.1:<local>/<secret>/` until 200 (with timeout), then `open` (macOS) /
      `xdg-open` (Linux) / `rundll32` (Windows). Only on **first** success — never on
      reconnect, or every network blip spawns a tab. *(30 min)*

- [ ] **P0** 3.11 **Supervisor loop.** Restart with exponential backoff starting at **1s**
      (so a transient blip recovers almost instantly) capped at 30s, resetting after any
      connection that survived >60s. Surface ssh's own stderr rather than swallowing it —
      SSH's messages are better than anything we'd invent. Ctrl-C tears down the child and
      removes the ControlPath socket. *(45 min)*

      **The reconnect path must skip setup.** Cache the probe result, the resolved binary
      path, the allocated ports, and the secret for the process lifetime; the restart loop
      re-runs *only* the `ssh -L … exec …` command from 3.9. Add
      `-o ConnectTimeout=10` so a dead network fails fast instead of hanging on the
      default TCP timeout — without it a reconnect attempt can appear frozen for minutes.

- [ ] **P1** 3.11a **Reconnect status line.** On drop, print a single updating line
      (`reconnecting… attempt 3, next in 4s`) rather than a scrolling log. The user's
      browser is already showing a frozen terminal; the launcher's job is to say whether
      it is working on it. *(20 min)*

- [ ] **P1** 3.12 **Flags and errors.** *(35 min)*

      `--local-port`, `--remote-port`, `--session` (tmux session name), `--no-browser`,
      `--auth`, `--force-copy`, `--arch` (override probe), `--verbose` (echo ssh command
      lines), `--version`; the adopt controls `--fresh` (ignore a running instance) and
      `--adopt-only` (fail rather than start one); and the fetch controls
      `--webtmux-version vX.Y.Z|latest` and `--webtmux-binary <path>`.

      Positional: `webtmux-launch [flags] <ssh-target> [-- tmux args…]`, with
      `<ssh-target>` passed **verbatim** to `ssh` so config aliases and bastions work.

---

## Phase 3D — Verify

The launcher can be exercised **fully without a Mac**, inside this container.

- [ ] **P0** 3.13 Stand up a throwaway target: a container running `sshd` + `tmux`, with a
      key-based login. *(35 min)*

- [ ] **P0** 3.14 End-to-end run with `--no-browser`, then curl the forwarded local port
      and assert 200 on `/<secret>/`. Covers probe → deploy → tunnel → readiness. *(30 min)*

- [ ] **P0** 3.15 **Idempotence:** run twice; the second run must skip the copy
      (content-addressed `test -x` hit) **and skip the binary download** — only the tiny
      `SHA256SUMS` GET should occur. Verify with `--verbose`. *(15 min)*

- [ ] **P0** 3.15e **Fetch-path tests.** *(40 min)*
      - **Cold cache** → downloads, verifies sha, pushes, installs.
      - **Warm Mac cache, empty target** → no download, pushes from cache.
      - **`--webtmux-version latest`** → resolves via the `releases/latest/download`
        redirect with no API call.
      - **Bad version** (`v9.9.9`) → fails with the URL it tried, installs nothing.
      - **Corrupted download** (truncate the cached file, force re-verify) → fails on the
        Mac, pushes nothing.
      - **`--webtmux-binary <path>`** → deploys a local file with no network at all.

- [ ] **P0** 3.14a **Adopt mode.** Start webtmux by hand on the test container, then run
      the launcher. Confirm it: reports the adoption with port/session/build-match, does
      **not** deploy a binary, does **not** create a session, does **not** start a second
      webtmux, and reaches the UI through the tunnel. *(30 min)*

- [ ] **P0** 3.14b **Adopt teardown safety — the one that would hurt.** Exit the launcher
      (SIGINT **and** SIGKILL) and confirm the adopted webtmux is **still running**. In
      launch mode, confirm the opposite: webtmux exits with the SSH connection and leaves
      no orphan. *(25 min)*

- [ ] **P1** 3.14c **Adopt edge cases.** Build mismatch → adopts with a warning. Two
      running instances → lists them and demands `--remote-port`. `--fresh` → ignores the
      running one and starts its own on a different port. Unrecoverable credentials → says
      so instead of opening a URL that 401s. *(30 min)*

- [ ] **P0** 3.15a **Attach vs create.** Run against a box with **no** sessions → confirm
      it reports `creating session` and one appears. Run again → confirm it reports
      `attaching to existing` and no second session is created. Then pre-create a session
      by hand with a non-default name, run with `--session <name>`, and confirm it
      attaches to that one. *(25 min)*

- [ ] **P0** 3.15b **Durability — the explicit ask.** With a session created by the
      launcher and something running in a pane: *(25 min)*
      1. Kill webtmux on the remote → session survives, pane output intact.
      2. Kill the launcher locally (SIGINT and SIGKILL) → session survives.
      3. Drop the SSH connection entirely → session survives.
      4. Re-run the launcher → attaches to the same session with the pane still running.

      If any of these lose the session, the cause is almost certainly systemd-logind
      `KillUserProcesses=yes` (see risk 10) — not the tmux invocation. **Honesty note:**
      the throwaway test container has no systemd, so this suite *cannot* exercise the
      logind risk — that only surfaces on a real host (covered by 3.21).

- [ ] **P0** 3.15c **Split-view still works** — the regression this design exists to
      prevent. Open two regions in the browser and confirm they show **different** tmux
      windows independently. If they mirror each other, `--pass-headers` or the attach
      script's mode 1 is not wired. Also confirm the sidebar populates at all (that is
      `WEBTMUX_SESSION` being set correctly). *(20 min)*

- [ ] **P1** 3.15d **UTF-8 glyphs.** Run something with box-drawing/wide glyphs in a pane
      and confirm the browser renders them, not tofu — proves `tmux -u` + the locale
      exports survived into the remote attach. *(10 min)*

- [ ] **P0** 3.16 **Resilience:** kill the remote sshd mid-session, confirm backoff and
      restart, and confirm **tmux panes survive** the reconnect (the whole point of the
      disposable-webtmux design). *(30 min)*

- [ ] **P0** 3.16a **Measure the reconnect, don't assume it.** With `--verbose`, drop the
      connection and confirm: exactly **one** `ssh` invocation per reconnect (no re-probe,
      no re-deploy, no session re-create), and time from drop to a 200 on
      `/<secret>/`. Expect well under a second on a LAN. If it is seconds, setup has leaked
      into the restart loop — risk 13. *(25 min)*

- [ ] **P1** 3.16b **Idle survival.** Leave a session connected and idle for longer than a
      typical NAT timeout (~10-30 min) and confirm it does **not** drop — that is
      `ServerAliveInterval` doing its preventive job, not just its detective one. *(35 min,
      mostly waiting)*

- [ ] **P1** 3.17 **`ETXTBSY` non-regression:** deploy, leave it running, deploy a
      *different* build, confirm no error — the new sha gets a new path. *(15 min)*

- [ ] **P0** 3.18 `make test`, `go vet ./...`, commit. *(15 min)*

- [ ] **P1** 3.19 Add the README section for the launcher, leading with it as the primary
      cross-machine story (manual install is the fallback). Publish launcher binaries as
      assets on the **next** release — Stage 2 already established the mechanism, and
      because the two are now independent, the launcher can be released on its own cadence
      whenever it is ready. *(20 min)*

      Document `--webtmux-version` and note the pinned default, so a user can tell which
      webtmux a given launcher will install without reading source.

- [ ] **P0** 3.20 Merge + cleanup, then push. *(15 min)*

      ```bash
      /workspace/scripts/git-merge-worktree.sh /workspace/webtmux-portable-launcher \
          --target local-main --no-ff --remove
      git -C /workspace/webtmux push origin local-main   # origin = GitHub fork after Stage 0
      ```

- [ ] **P0** 3.21 **Real-world check (needs the user + a Mac):** run
      `webtmux-launch <linuxbox>` from an actual Mac against an actual Linux box. Confirm
      one auth prompt, browser opens automatically, terminal works, and closing the laptop
      lid then reopening it reconnects without losing panes. *(10 min)*

---

## Risks

1. **Remote port collision** on a busy shared box. Mitigated by `ExitOnForwardFailure` +
   retry, but may need several attempts.
2. **Bootstrapping: no release, no fetch.** The launcher cannot work end-to-end until
   Stage 2 publishes `v0.1.0` — which is exactly why Stage 2 now runs before Stage 3.
   `--webtmux-binary` (3.7a) unblocks development before then.
3. **Network required on the Mac at first deploy** for a given platform+version; cached
   afterwards, and a warm cache is fully offline. Errors must distinguish "no network"
   from "404 — that version or asset does not exist"; they need different fixes, and both
   should name the URL attempted.
4. **Platform-mapping mistakes** (`x86_64`→`amd64`, `aarch64`→`arm64`, `armv7l`→`arm`)
   surface as a 404 rather than a wrong binary — the safe failure mode, *provided* the
   message names the asset it looked for.
4a. **Never push an unverified binary.** Sha-check on the Mac before transfer (3.7); a
   truncated download discovered remotely is far harder to diagnose.
5. **Browser spawning on every reconnect** if the "first success only" guard in 3.10 is
   missed — a network blip would open dozens of tabs.
6. **ControlPath length limit.** Unix socket paths cap around 104 chars on macOS; `%C`
   (a hash) keeps it short, but do not switch to `%h/%p/%r` which can overflow.
7. **Secret path in process args on BOTH machines.** It is passed as `--path` in the
   remote command, so it is visible in `ps` on the target — and the same argv appears in
   the launcher's `ssh` process on the **Mac**, so any local Mac process can read it too.
   Acceptable for a personal tool (a local user could equally read
   `~/.config/webtmux-launch/`), but say so in the README; if it ever matters, the fix is
   a 0600 remote file the attach command reads instead of an argv flag.
8. **Split-view silently degrading** if the attach script's mode 1 is dropped or the
   header→env channel turns out to be gated (see 3.9's `--pass-headers` verification). It
   fails *quietly* — regions mirror each other instead of erroring — which is why 3.15c
   is a P0 check rather than a nice-to-have.
9. **Sidebar dead on arrival** if `WEBTMUX_SESSION` isn't exported.
   `detectTmuxSession()` falls back to the literal `"0"` when the command is a wrapper
   script, so the controller targets a session that doesn't exist.
10. **systemd-logind `KillUserProcesses=yes`** will reap the tmux server on logout,
    defeating durability entirely. Most distros default to `no`, but not all. Detect it in
    the probe (`loginctl show-user "$USER" -p Linger` / check `logind.conf`). This is the
    single most likely cause of "my session vanished".

    **Do not lead with `loginctl enable-linger`** — it needs sudo on many systems and
    imposes a machine-wide config change to use one tool. Present the options in order of
    least imposition:
    1. **Already covered if a webtmux is running** — adopt mode uses the user's own
       persistent instance and the question doesn't arise.
    2. **Run webtmux yourself persistently** (systemd user unit, or `nohup`) and re-run
       the launcher, which will adopt it. Zero privileged config.
    3. **`sudo loginctl enable-linger $USER`** — the blunt fix, offered last.
    4. **Accept it** — sessions die at logout, which for a laptop-driven workflow may be
       perfectly fine.
11. **UTF-8 downgrade in the browser only.** SSH does not forward `LANG` unless the server
    sets `AcceptEnv`, so the remote attach can land in the POSIX locale and tmux will flag
    the client `utf8=0`, mangling wide and box-drawing glyphs. Guarded by `tmux -u` plus
    the locale exports in the attach script; covered by 3.15d.
12. **Interactive auth makes reconnects painful.** With a touch-required hardware key or
    TOTP, *every* reconnect prompts — and `ControlPersist` cannot help, since network death
    kills the master too. Mitigations, in order of preference: use a non-touch key for this
    host; add a `Match host <target>` block in `~/.ssh/config` pinning `IdentityFile` to an
    agent-cached key; or accept it and raise the backoff floor so a flapping link doesn't
    prompt repeatedly. **Detect this at cold start** — if authentication took more than a
    couple of seconds or ssh wrote a prompt to the tty, warn once that reconnects will
    require interaction. Silently prompting on every blip is the worst outcome.
13. **Reconnect accidentally re-running setup.** The single biggest performance risk: if
    the restart loop re-probes or re-checks the deploy, every blip costs several extra
    round trips instead of one handshake. 3.11 pins the split; a `--verbose` run during
    3.16 should show exactly one `ssh` invocation per reconnect.

## Next steps

After 3.21 passes, retire the two completed legacy plans (`plan-webtmux-split.md`,
`plan-webtmux-capture-expose.md`) under CLEANUP mode, and consider whether the host-side
Docker deployment is still worth keeping now that a native binary needs no tmux
version-pinning, no socket mount, and no uid/gid matching.
