# Plan: multi-machine Stage L — multi-target launcher and "Connect to…"

Subplan L of `plan-webtmux-multimachine.md`. Turn the one-target launcher into the hub's
connection manager and give the sidebar's `+ Connect machine` button something real to do.

**Last stage by design.** Every earlier stage works with statically configured machines, so the
one item with genuinely unbounded risk — interactive ssh auth in a process with no tty — cannot
block the other six.

## Worktree

- Branch: `feat/mm-launcher`
- Path: `/workspace/webtmux-mm-launcher`
- Setup: gate → `git -C /workspace/webtmux worktree add /workspace/webtmux-mm-launcher -b feat/mm-launcher local-main` (fork **after** Stages H and U merged), copy plan files in.
- Finish: tests green → `/workspace/scripts/git-merge-worktree.sh /workspace/webtmux-mm-launcher --target local-main --no-ff --remove`

## Prerequisite check

`plan-webtmux-portable-launcher.md` is 36/38. Both remainders are verification-only — 3.15e
(fetch-path tests, deferred until a published `v0.1.0`) and 3.21 (real-world Mac check, needs the
user). **Before starting:** either retire that plan under CLEANUP mode or record an explicit
waiver here, so two plans aren't editing `webtmux-launch/` with different intents.

```bash
grep -c '^\s*- \[ \]' /workspace/webtmux/plan-webtmux-portable-launcher.md   # expect 0, or waive below
```

Waiver (fill in if proceeding with 2 open): _________________________

## Design decisions (settled)

1. **Extract, don't rewrite.** `webtmux-launch/` is `package main` with target-scoped structs
   (`sshRunner`, `probe`, `deployment`, `supervisor`, `targetConfig`) that are already the right
   shape — they just each assume one target. Extract them to an importable package
   (`webtmux-launch/internal/target` or `pkg/launch`) and keep `main.go` as a thin CLI over it.
   The hub imports the same package. One implementation, two front-ends.
2. **One `sshRunner` per target, N in one process.** Each already owns its own hashed
   `ControlPath` (`ssh.go:37-47`), so multiplexing per target is already isolated. The mux-master
   keepalive subtlety (`ssh.go:56-77`) applies unchanged per target.
3. **Port allocation moves to the hub.** `targetConfig` persists a stable local port per target
   (`config.go`); the hub must own allocation across targets so two connections can't be handed
   the same port. Keep the per-target stability property — the URL-stability rationale in
   `config.go:3-9` still holds.
4. **Auth policy is explicit, not hopeful.** The hub attempts `BatchMode=yes` first (Stage S task
   3.1 established whether that suffices for the user's real hosts). If a target needs a password
   or 2FA, the hub **must not** silently hang: it reports `needs-auth` with the prompt text and
   the UI either surfaces it or tells the user to run `webtmux-launch <target>` by hand once to
   prime the mux master — which is a legitimate, honest fallback and cheap to build.
5. **Teardown asymmetry is preserved.** Launch mode's webtmux dies with the connection
   (`tieToConnection`, `main.go:347`); adopt mode's must outlive it (`adopt`, `main.go:398` passes
   a nil `remoteCmd`). A hub managing N connections must keep that distinction per machine or it
   will kill someone's long-lived instance.
6. **Disconnect ≠ remove.** Disconnecting drops the tunnel and marks the machine `gone`;
   removing purges its state (Stage T task 3.3). Two separate actions, two separate words.
7. **Connections are an address book on the hub** — `~/.config/webtmux/connections.json`,
   served over the hub API. Not tmux state (it must survive every machine being down, and a hub
   need not have a tmux at all — same argument as Stage T decision 1) and not browser storage
   (any browser reaching the hub must see the same list). The friendly name in an entry **is**
   the machine label; Stage T task 2.5's per-machine `label` reads from here when an entry
   exists and only holds an override when it doesn't.
8. **Two files, two responsibilities — do not merge them.** The address book holds what the
   *user typed* (name, username, host, port, optional identity file). The existing
   `targetConfig` (`config.go`, `~/.config/webtmux-launch/<sanitised-target>.json`) keeps
   holding what the *launcher derived* (local/remote ports, secret path, basic-auth password).
   The derived file is keyed by ssh target and is load-bearing for URL stability
   (`config.go:3-9`); an address-book entry references it by target, never absorbs it.
9. **No secrets in the address book.** No ssh passwords, no key material — an optional
   `identityFile` *path* only. Note for the UI copy: `targetConfig.Password` is webtmux's
   basic-auth password, not an ssh password. Two different things; never label them alike.
10. **Structured or raw, both accepted.** An entry is either structured (`username`, `host`,
    `port`) or a raw ssh target — an `~/.ssh/config` alias, `user@host`, a ProxyJump form —
    which `main.go:67` deliberately supports and which no structured form can replace.
    **Gap to close:** the launcher has *no ssh port handling today*. `r.target` is appended
    verbatim at `ssh.go:89,101,128,130,146,156`, `baseArgs()` carries no `-p`, and
    `ssh user@host:port` is not valid ssh syntax. Structured entries with a non-22 port do not
    work until task 2.9 lands.

## Phases

### Phase 1 — extraction (P0)

- [ ] **P0** 1.1 Create worktree; confirm gate and the prerequisite above. ~15m, Sonnet.
- [ ] **P0** 1.2 Extract `sshRunner`, `probe`, `deployment`, `supervisor`, `targetConfig`,
  `attachScript` and `resolveSource` into an importable package with exported surface; `main.go`
  becomes a CLI over it. **Behaviour-preserving only** — the existing
  `webtmux-launch/*_test.go` suite must pass untouched. ~45m, Opus.
- [ ] **P0** 1.3 Introduce a `Connection` type owning one target's runner + config + supervisor +
  lifecycle, with `Connect(ctx)`, `State()`, `Disconnect()`. This is the unit the hub holds N
  of. Table-tested with a fake runner. ~45m, Opus.
- [ ] **P0** 1.4 Hub-side port allocator (decision 3): stable per target, collision-free across
  targets, persisted. ~45m, Opus.
- [ ] **P1** 1.5 Confirm the extraction changed no CLI behaviour: run the existing
  `webtmux-launch/test/e2e.sh` against the Stage S rig. ~30m, Sonnet.

### Phase 2 — the hub's connection manager (P0)

- [ ] **P0** 2.1 `ConnectionManager` in the hub: N `Connection`s, feeding the Stage H registry.
  A connection reaching `ready` registers its machine; leaving `ready` marks it `degraded`. ~45m, Opus.
- [ ] **P0** 2.2 `POST <path>machines` — body `{connectionId}` **or** `{target, session?}` —
  starts a connection and returns immediately with a machine id and initial state;
  `DELETE <path>machines/<id>` disconnects (decision 6). Auth-wrapped. ~45m, Opus.
- [ ] **P0** 2.3 Progress reporting: probe → deploy → session → tunnel → ready, streamed or
  polled, so a 12 MB first-time deploy shows progress rather than looking hung. The launcher
  already prints these milestones; route them structurally instead of to stdout. ~45m, Opus.
- [ ] **P0** 2.4 `needs-auth` state per decision 4, carrying ssh's own stderr (which
  `ssh.go:88-97` deliberately preserves — *"its messages are better than anything we would
  invent"*). ~45m, Opus.
- [ ] **P0** 2.5 Reuse `adopt` for a target already running webtmux (`probe` already finds
  instances and `chooseInstance` picks one), preserving decision 5's teardown asymmetry. ~45m, Opus.
- [ ] **P1** 2.6 Hub shutdown tears down every connection it owns, and only those (`Shutdown` vs
  `ClearStaleMaster`, `ssh.go:145-164` — the distinction matters more with N targets). ~45m, Opus.
- [ ] **P0** 2.7 New `server/connections.go`: the address book store (decision 7). Entry =
  `{id, name, username, host, port, identityFile, rawTarget, order}`; atomic load/save (temp +
  rename, the `deploy.go:100` pattern); validation — a name is required and unique, and exactly
  one of `host` / `rawTarget` is set. `sshTarget()` composes an entry into the argv the runner
  takes. Pure, table-tested, no network. ~45m, Opus.
- [ ] **P0** 2.8 CRUD API: `GET/POST <path>connections`, `PUT/DELETE <path>connections/<id>`,
  and a reorder. Auth-wrapped like the rest of `siteMux`. Deleting an entry whose machine is
  currently connected must be refused with a reason (disconnect first) — decision 6's
  distinction, enforced. ~45m, Opus.
- [ ] **P0** 2.9 **Close the ssh port gap** (decision 10): add `Port` to the extracted runner
  and emit `-p <port>` in `baseArgs()` when set. Assert with a golden-argv test that an unset
  port produces today's argv **byte-for-byte** across all six call sites — this function is on
  every ssh invocation and a stray flag breaks mux reuse. Add `identityFile` → `-i` the same
  way. ~45m, Opus.
- [ ] **P1** 2.10 Reconcile the friendly name with Stage T (decision 7): machine `label`
  resolves address-book name → user override → machine id. One resolution function, tested,
  so the sidebar and the connect dialog can never disagree. ~30m, Opus.

### Phase 3 — the connect dialog and its address book (P0)

The dialog is a **saved-connections manager**, not a text box: a list of named machines
(`mac-mini`, `gpu-box`) each showing `username@host:port`, with Connect on each row and
add / edit / delete / reorder around it.

- [ ] **P0** 3.1 Wire Stage U's inert `+ Connect machine` to a dialog listing the address book
  from 2.8: friendly name (primary), `username@host:port` (secondary), current machine state
  (Stage H task 3.1) and a Connect action per row. Empty state invites the first entry. ~45m, Opus.
- [ ] **P0** 3.2 Add / edit form: **name**, **username**, **host or IP**, **port** (default 22,
  shown greyed), optional identity file, and a raw-target escape hatch for `~/.ssh/config`
  aliases and ProxyJump forms (decision 10). Inline validation from 2.7's rules — a duplicate
  name or a both-fields-set entry is caught before submit, not on connect. ~45m, Opus.
- [ ] **P0** 3.3 Delete with a confirm that names the entry and says what is *not* deleted (the
  machine's tmux sessions keep running; this only forgets how to reach it). Refuse deleting a
  connected entry with the 2.8 reason. ~45m, Opus.
- [ ] **P1** 3.4 Drag-to-reorder the list, persisted via 2.8's reorder. The list is the user's
  own ordering, not alphabetical — it is a dock, not a directory. ~30m, Sonnet.
- [ ] **P0** 3.5 Connect progress inline on the row being connected (probe → deploy → session →
  tunnel → ready, from 2.3), so a 12 MB first-time deploy reads as progress rather than a hang.
  The dialog stays usable — connecting one machine must not block adding another. ~45m, Opus.
- [ ] **P0** 3.6 Failure presentation on the row: ssh's stderr shown as-is (`ssh.go:88-97`
  preserves it deliberately), plus the `needs-auth` fallback copy — "run `webtmux-launch
  <target>` once in a terminal to authenticate, then retry". ~45m, Opus.
- [ ] **P0** 3.7 Per-machine row actions in the sidebar's outer tier: disconnect, reconnect,
  rename (writes the address-book name via 2.10, not a separate label), and remove. Removal
  confirms and names what is forgotten (Stage T task 3.3). ~45m, Opus.
- [ ] **P0** 3.8 **Never auto-connect.** The saved list supersedes any "remember what worked"
  heuristic; reconnect is always one deliberate click. An auto-connect that prompts for a
  password at page load is hostile, and with N saved entries it is N prompts. ~30m, Opus.
- [ ] **P2** 3.9 Surface each machine's build id (Stage H task 1.4 made it per-machine) so a skew
  problem is visible rather than mysterious. ~30m, Sonnet.
- [ ] **P2** 3.10 Offer `~/.ssh/config` `Host` aliases as *suggestions* when adding an entry
  (read-only, hub-side). Convenience only — never import silently, and never copy key material.
  ~45m, Sonnet.

### Phase 4 — verify and merge (P0)

- [ ] **P0** 4.1 Go suite in the golang:1.23 container; JS suite + `make check-js` +
  `make sync-assets`. ~30m, Sonnet.
- [ ] **P0** 4.2 Rig check: save target-a and target-b as named entries, connect both **from the
  UI**, cold (no prior deploy), and confirm progress reporting is honest end to end. ~45m, Sonnet.
- [ ] **P0** 4.2b Address-book round-trip: add / edit / reorder / delete, restart the hub, and
  confirm the list is intact; open a **second browser** and confirm it sees the same list
  (decision 7's whole point). ~45m, Sonnet.
- [ ] **P0** 4.2c Non-default ssh port: run one rig target on port 2222 and connect to it via a
  structured entry. This is the acceptance test for the 2.9 gap — before that task it cannot
  work at all. ~45m, Sonnet.
- [ ] **P0** 4.3 Failure-path checks: unreachable host, wrong key, target with no tmux, target
  whose port is taken, and a mid-session network drop. Each must produce a distinguishable,
  actionable message. ~45m, Opus.
- [ ] **P0** 4.4 Adopt-path check: a target already running webtmux is adopted, and hub shutdown
  leaves it running (decision 5). Getting this backwards destroys the persistence the user set
  up — test it explicitly. ~45m, Opus.
- [ ] **P0** 4.5 **Real-world check (needs the user):** connect to the user's actual hosts from a
  real hub, including any that need a password. Record the outcome against Stage S task 3.1's
  prediction. ~45m, Opus.
- [ ] **P0** 4.6 Mark complete, commit, merge via `git-merge-worktree.sh --no-ff --remove`. Then
  update the master plan's status table and consider CLEANUP mode for the whole set. ~30m, Sonnet.

## Risks

- **Interactive auth is the one unbounded item in the plan set.** Decision 4's fallback ("prime
  the mux master by hand once") is the escape hatch that keeps this stage finite. Take it early
  rather than building a prompt-forwarding channel unless Stage S task 3.1 says it's required.
- **N supervisors, one process.** Backoff, reconnect and the liveness-pipe trick
  (`supervise.go:56-74`) are per-connection today by accident of there being one. Confirm no
  shared mutable state after extraction — especially the single `livePipe` per supervisor.
- **Killing someone's long-lived webtmux.** Decision 5, tested by 4.4. This is the most damaging
  possible bug in this stage.
- **`webtmux-launch/` may still be in flight** — see the prerequisite check.
- **`baseArgs()` is on every single ssh invocation** (`ssh.go:68-77`), including the mux master
  whose keepalives every later call inherits. Task 2.9 edits it; the golden-argv test is not
  ceremony — a stray flag when no port is set would change the master's identity and silently
  break connection reuse for every existing target.
- **The address book is a list of the user's machines.** It is not sensitive like a key, but it
  is a map of their infrastructure. It is served behind the hub's auth like everything else;
  don't add an unauthenticated read path for convenience.
