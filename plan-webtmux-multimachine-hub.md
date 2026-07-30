# Plan: multi-machine Stage H — the hub

Subplan H of `plan-webtmux-multimachine.md`. Add `--hub` mode: a machine registry, a WebSocket
relay to each machine's unmodified webtmux, and exactly four points of intervention. **No
frontend work here** beyond consuming the registry — Stage I owns the UI keying.

## Worktree

- Branch: `feat/mm-hub`
- Path: `/workspace/webtmux-mm-hub`
- Setup: gate → `git -C /workspace/webtmux worktree add /workspace/webtmux-mm-hub -b feat/mm-hub local-main`, copy plan files in. All edits there.
- Finish: tests green → `/workspace/scripts/git-merge-worktree.sh /workspace/webtmux-mm-hub --target local-main --no-ff --remove`

## Design decisions (settled)

1. **One binary, two roles.** `--hub` is a new tagged field on `server.Options`
   (`server/options.go`) — `utils.GenerateFlags` turns it into a flag for free. Hub mode with no
   machines and a local tmux behaves exactly like today.
2. **Relay, not proxy-with-opinions.** Frames pass through untouched except the four points
   below. In particular the hub does **not** parse or rewrite window/pane ids.
3. **The four intervene points:**
   - **init frame** (`handlers.go:116-131`): the browser sends one hub credential; the hub
     substitutes the target machine's own credential before forwarding. Machine credentials
     never leave the hub.
   - **`TmuxSetState` ('P')**, client→hub: terminated at the hub, never fanned out to N tmux
     servers. Stage T gives it a home; until then, hold it in memory.
   - **`state` inside `TmuxLayoutUpdate` ('7')**, machine→browser: stripped and replaced with
     the hub's blob, so a machine's own `@wt_state` never leaks into the aggregated view.
   - **`config.js` / `auth_token.js`**: hub-served (`resources/index.html:124-125` loads them
     relative to the serving origin). `config.js` gains the registry; the build id becomes
     per-machine data, not one string.
4. **Machine id** = sanitised ssh target (reuse `config.go:39`'s mapping), `local` reserved for
   the hub's own tmux. Validate on ingest; reject anything outside `[A-Za-z0-9._-]`.
5. **A machine going away must degrade its regions, not the app.** Its ws closes; the
   frontend's existing per-unit reconnect (`terminal-unit.js` `onclose`) already retries. The
   hub's job is to report machine state, not to hide the failure.
6. **Static config in this stage.** Machines come from a config file / repeated flag. Stage L
   makes it dynamic.

## Phases

### Phase 1 — registry (P0)

- [ ] **P0** 1.1 Create worktree; confirm gate. ~15m, Sonnet.
- [ ] **P0** 1.2 New `server/machines.go`: `Machine{ID, Endpoint, Credential, Path, Local bool}`
  and a `Registry` with add/get/list/remove under a mutex. Id validation per decision 4. Pure
  Go, table-tested, no I/O. ~45m, Sonnet.
- [ ] **P0** 1.3 `--hub` + `--machine <id>=<host:port><path>` (repeatable) + `--machines-file
  <path>` (JSON) on `server.Options`; parse into the Registry at `server.New`. Credentials come
  from the file or env, **never** a command line (visible in `ps` — the same reasoning as
  `webtmux-launch/main.go:310`). ~45m, Opus.
- [ ] **P0** 1.4 Registry → `handleConfig` (`handlers.go:381`): emit `webtmux_machines` as JSON
  (id, label, local flag, state) and make `webtmux_build`/`webtmux_built` per-machine. Keep the
  single-machine output byte-identical to today when the registry holds only `local`. ~45m, Opus.
- [ ] **P1** 1.5 `GET <path>machines` returning registry state as JSON, so the UI can poll
  machine health without a ws. Auth-wrapped like the rest of `siteMux`. ~30m, Sonnet.

### Phase 2 — the relay (P0)

- [ ] **P0** 2.1 New `server/relay.go`: `relayWS(ctx, browserConn, machine)` — dial
  `ws://<endpoint><path>ws` with the `webtty` subprotocol, then pump both directions with
  independent goroutines and a shared cancel. Close semantics: either side closing tears down
  both; log which side went first (that distinction is the whole diagnostic value). ~45m, Opus.
- [ ] **P0** 2.2 Init-frame interception: read the browser's first text frame, validate against
  the hub credential, substitute the machine credential, forward. A machine that rejects the
  swapped credential must produce a *distinguishable* error, not a silent hang. ~45m, Opus.
- [ ] **P0** 2.3 Route the ws handler by machine: the init frame gains a `Machine` field
  (default `""` ⇒ `local`). `local` ⇒ today's `processWSConn` unchanged; anything else ⇒
  `relayWS`. This keeps decision 4 of the master plan ("local is not a special case") true in
  the code, not just in prose. ~45m, Opus.
- [ ] **P0** 2.4 Intercept `TmuxSetState` ('P') client→machine and drop it at the hub, holding
  the latest blob in memory behind a mutex. Intercept `TmuxLayoutUpdate` ('7')
  machine→browser and replace its `state` field with the hub blob. Both need a
  minimal-allocation path — '7' is on the 500ms hot path per region. ~45m, Opus.
- [ ] **P1** 2.5 Relay tests with a fake upstream webtty server (an in-process
  `httptest.Server` speaking the protocol): frame passthrough fidelity, init swap, 'P' drop,
  '7' state replacement, both close directions. ~45m, Sonnet.

### Phase 3 — health and degradation (P0)

- [ ] **P0** 3.1 Per-machine state machine: `unknown → connecting → ready → degraded → gone`,
  driven by dial success and relay liveness. Exposed via 1.5 and `config.js`. ~45m, Opus.
- [ ] **P0** 3.2 Reuse the **existing** liveness signal rather than inventing one: memory
  `webtmux-tmux-liveness-detection` — a wedged tmux leaves the ws OPEN and layout pushes are
  change-only, so the signal is the Ping/Pong pair. Apply the same reasoning per machine. ~45m, Opus.
- [ ] **P0** 3.3 A dial failure must not kill the browser connection: report `degraded`, keep
  the tab alive, let the region's own reconnect loop retry. Test with the rig by killing
  target-b's webtmux mid-session. ~45m, Sonnet.
- [ ] **P2** 3.4 Bounded concurrency per machine so one machine's Exposé burst can't starve
  another's pty traffic. Note if `plan-webtmux-harden-guards.md`'s capture fan-out cap has
  landed — if so, extend it per machine rather than adding a second mechanism. ~30m, Opus.

### Phase 4 — honour what harden-* landed (P1)

- [ ] **P1** 4.1 `permitWrite`: check whether `plan-webtmux-harden-guards.md` has merged. If so,
  the relay must not become a write-authority bypass — the hub's own `--permit-write` must gate,
  *and* each machine's setting still applies at its end. Add a test for the deny path. ~45m, Opus.
- [ ] **P1** 4.2 ws read limits: if `plan-webtmux-harden-parse.md` has merged, apply the same
  limits on the relay's upstream reader. An unbounded upstream frame is now a hub-side risk that
  did not exist before. ~30m, Opus.

### Phase 5 — verify and merge (P0)

- [ ] **P0** 5.1 Go suite in the golang:1.23 container (`go vet ./... && go test -race
  -count=1 ./...`). ~15m, Sonnet.
- [ ] **P0** 5.2 Rig run: hub with `local` + target-a + target-b; two regions on two machines
  via the Stage S `endpoint` seam (now routed through the relay rather than direct). Confirm the
  Stage S 1.3 behaviour matrix is no worse. ~45m, Sonnet.
- [ ] **P0** 5.3 Confirm the single-machine no-regression claim: a hub with only `local` serves
  a `config.js` and behaves identically to pre-change `local-main`. Diff the served
  `config.js`. ~30m, Sonnet.
- [ ] **P0** 5.4 Mark complete, commit, merge via `git-merge-worktree.sh --no-ff --remove`. ~30m, Sonnet.

## Risks

- **The '7' interception is on the hot path.** Naive JSON round-tripping of every layout push
  per region per 500ms per machine will show up. Prefer a targeted splice over full unmarshal.
- **Credential handling is the security core of this design.** Machine credentials in
  `config.js`, in a log line, or in `ps` output defeats decision 3 of the master plan. Grep for
  them explicitly before merge.
- **Do not let the hub grow opinions about ids.** Every "the hub could just rewrite the window
  ids" shortcut moves the migration cost into Go and duplicates it against the frontend.
