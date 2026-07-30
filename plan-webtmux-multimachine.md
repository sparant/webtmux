# Plan: webtmux multi-machine — one view, many computers

`plan-webtmux-multimachine.md` — created 2026-07-29. **Master plan** for `/workspace/webtmux`
(branch `local-main`). Sequences seven subplans; owns no worktree of its own.

## Goal

One browser tab shows windows from **several machines** at once: a split region on the
laptop beside a region on `gpu-box`, one global recents bar, one sidebar whose tree is
**machine → session → window**. Adding the second machine is a UI action, not a second
browser tab.

## Approach — hub + unchanged per-machine webtmux

The decisive finding from the feasibility read: **the per-machine half already exists and
must not be rewritten.** `webtmux-launch` already probes a target, content-addressed-deploys
the binary + attach script, starts it tied to connection liveness, forwards a stable port,
supervises with backoff, and can adopt a running instance. And `server/server.go:298-323`
already splits the binary's two jobs across two muxes: `siteMux` (UI assets, served once)
and `wsMux` `pathPrefix+"ws"` (one duplex channel per region).

So:

```
browser ──► hub webtmux (laptop, --hub)
              ├─ machine "local"   → local tmux                (existing path, untouched)
              ├─ machine "gpu-box" → ssh tunnel → webtmux → its tmux   (unmodified webtmux)
              └─ machine "linuxbox" → ssh tunnel → webtmux → its tmux
```

**One binary, two roles, selected by a flag.** The "helper" is today's webtmux in today's
mode. The hub↔helper protocol is the existing webtty protocol. Nothing new is invented on
the wire, and the existing test rig keeps applying.

**Rejected: driving tmux over SSH per command.** `RefreshLayout` costs 6 + N_windows tmux
forks per region per 500ms (`controller.go:324-464`, incl. `list-panes -t` *per window* at
`:402`), plus one `capture-pane` per window for Exposé. Two regions × ten windows ≈ 64 tmux
invocations/second. Over an ssh-per-command transport that needs `pkg/tmux` (1,128 lines +
tests) rewritten onto `tmux -C` control mode. Most expensive path available; declined.

Keeping the pty on the machine that owns the tmux also preserves `SetClient(tty, pid)`
(`handlers.go:237-244`) — the basis of follow / `switch-client` / `selfHeal`. Any design that
forwards a pty across the wire breaks that silently.

## Design decisions (settled — execution must not re-litigate)

1. **Hub is a near-dumb relay.** `Input`, `Output`, `ResizeTerminal`, `Ping`/`Pong` and every
   tmux control message pass through byte-for-byte. It parses and intervenes on exactly four
   things: the init frame (per-machine credential swap), `TmuxSetState` ('P'), the `state`
   field inside `TmuxLayoutUpdate` ('7'), and serving `config.js` / `auth_token.js`.
2. **Id qualification lives in the frontend**, not the hub. That is what keeps the Go
   addition to a few days.
3. **Per-machine credentials never reach the browser.** `resources/index.html:124` loads
   `./auth_token.js` from the serving origin, so a browser-dials-each-tunnel design would
   need every machine's credential in the page. The hub holds them instead — this is the
   deciding argument for the proxy over direct-origin, security before elegance.
4. **`local` is a registry entry, not a special case.** The hub's own tmux is machine
   `local`; a hub with no local tmux simply has no such entry.
5. **Machine id** = the launcher's already-sanitised ssh target (`config.go:39`), charset
   `[A-Za-z0-9._-]`, with `local` reserved.
6. **Global recents bar** (user decision). Tabs carry a machine marker — `3: claude` is
   ambiguous across boxes.
7. **No machine tier in the UI while only one machine is connected** (user decision). The
   single-machine case must render byte-identically to today.
8. **Session order is per-machine; recents / pip / expose prefs stay global** (user decision).
9. **Cross-machine tmux ops are refused, visibly.** `link-window`, `swap-window` and
   `move-window` cannot cross tmux servers.
10. **Static machine config first, dynamic "Connect to…" last.** Interactive ssh auth is the
    least-bounded risk; it is probed in Stage S and only built in Stage L.

## Dependency gate — HARD, on `plan-webtmux-harden-state.md`

Subplan A of `plan-webtmux-harden-master.md` rewrites the same `@wt_state` sync protocol this
plan extends (its decisions 1–7 touch `state-store.js`, `split-manager.js`, `pip-overlay.js`,
`recents-strip.js`, `capture-cache.js`) and delivers the per-server identity primitive Stage
T generalises. Executing both concurrently guarantees conflicts on those files.

**Run before creating the first worktree of any subplan:**

```bash
git -C /workspace/webtmux show local-main:resources/js/state-store.js | grep -q 'loadedOnce' \
  || { echo "GATE FAILED: plan-webtmux-harden-state.md must merge to local-main first"; exit 1; }
```

**Soft notes (no gate).** `plan-webtmux-harden-guards.md` (permitWrite gating matrix,
savepath confinement, capture fan-out cap) and `-parse.md` (controller identity races, ws read
limits) overlap this plan's surface only at the edges; Stage H carries explicit tasks to honour
whichever of them has landed. `plan-webtmux-portable-{vendor,release,fork}.md` touch asset
loading / build / remotes only — no overlap. `plan-webtmux-portable-launcher.md` is 36/38 with
both remainders verification-only (3.15e deferred, 3.21 user-executed); Stage L extends
`webtmux-launch/` and should be sequenced after those two are retired or explicitly waived.

## Subplans — execute in this order

| # | Subplan | Scope | Est | Status |
|---|---------|-------|-----|--------|
| S | `plan-webtmux-multimachine-spike.md` | Two-machine rig; per-unit endpoint proof; ssh-auth probe; go/no-go | 1–2 d | [ ] |
| H | `plan-webtmux-multimachine-hub.md` | `--hub` mode, machine registry, WS relay, the 4 intervene points, health | 3–5 d | [ ] |
| I | `plan-webtmux-multimachine-identity.md` | `placeKey(machine,session,window)` across the pure modules + SplitManager | 1–1.5 wk | [ ] |
| U | `plan-webtmux-multimachine-ui.md` | Sidebar machine tier, toolbar, Exposé, PiP; hide-tier-when-one rule | 1–1.5 wk | [ ] |
| T | `plan-webtmux-multimachine-state.md` | Hub-owned state blob, schema v2 + migration, per-machine sessionOrder | 3–5 d | [ ] |
| X | `plan-webtmux-multimachine-semantics.md` | Cross-machine refusals, stoplight unknown≠stopped, alert union, save labels | 1–2 wk | [ ] |
| L | `plan-webtmux-multimachine-launcher.md` | Multi-target launcher, "Connect to…" flow, ssh auth surfacing | 4–7 d | [ ] |

**Total: 5–8 weeks.** S alone (1–2 days) produces a demonstrable two-machine view and is the
decision point for everything after it.

Order rationale: S proves the architecture and builds the rig everything else verifies
against. H before I because the frontend migration needs a real machine-tagged feed to develop
against. I before U because U consumes the keying primitive I defines. T after I because the
schema encodes I's key format. X after U because the refusals attach to U's drag surfaces. L
last: static config carries every earlier stage, and L is the only stage with an unbounded risk.

## Worktree

**The master plan owns no worktree** — it only sequences subplans and tracks status. Each
subplan declares its own off `/workspace/`:

| Stage | Branch | Worktree |
|---|---|---|
| S | `feat/mm-spike` | `/workspace/webtmux-mm-spike` |
| H | `feat/mm-hub` | `/workspace/webtmux-mm-hub` |
| I | `feat/mm-identity` | `/workspace/webtmux-mm-identity` |
| U | `feat/mm-ui` | `/workspace/webtmux-mm-ui` |
| T | `feat/mm-state` | `/workspace/webtmux-mm-state` |
| X | `feat/mm-semantics` | `/workspace/webtmux-mm-semantics` |
| L | `feat/mm-launcher` | `/workspace/webtmux-mm-launcher` |

### Worktree Reference — read before every execution session

```bash
# 0. Gate (above) must pass first.
# 1. Create
git -C /workspace/webtmux worktree add /workspace/webtmux-mm-<stage> -b feat/mm-<stage> local-main
cp /workspace/webtmux/plan-webtmux-multimachine*.md /workspace/webtmux-mm-<stage>/

# 2. Finish — run tests FIRST, then the serialized wrapper
/workspace/scripts/git-merge-worktree.sh /workspace/webtmux-mm-<stage> \
    --target local-main --no-ff --remove
```

**`--no-ff` is mandatory, never `--ff-only`.** `local-main` is churned by concurrent agents.
Never run raw `git merge` / `git worktree remove` — all `/workspace/webtmux-*` worktrees share
one `.git` object store and ref namespace and concurrent instances race on `packed-refs`.

**All edits happen inside the worktree.** About to edit a file in `/workspace/webtmux/`? Stop —
wrong directory. The only exception is these plan files at creation time; update the worktree
copies during execution and commit both at cleanup.

**A branch alone does not deploy.** The host container rebuilds from `local-main`; nothing is
live until merge **and** `bash /workspace/scripts/webtmux-docker/launch.sh --rebuild`.

## Verification bar (every subplan)

Inherited verbatim from `plan-webtmux-harden-master.md`:

- **JS:** `node --test test/` green + `make check-js` + `make sync-assets` (bindata re-synced).
- **Go:** `docker run --rm -v <worktree>:/src -w /src -e GOFLAGS=-mod=mod golang:1.23 sh -c
  "go vet ./... && go test -race -count=1 ./..."` — this container has no Go toolchain.
- New behaviour gets a test in the repo's existing style (pure-module `.mjs`; Go table tests
  through the fake-runner seam).
- **Two-machine live check** in throwaway containers for any stage that changes UI behaviour
  (rig built in Stage S). Host prod webtmux is never touched.

## Subagent guidance

Each phase is sized for one subagent run. **Sonnet** for mechanical renames, parsing, test
authoring, and rig plumbing; **Opus** for the protocol-design-sensitive work (H's intervene
points, T's schema migration, X's refusal semantics). Keep the main context to sequencing and
review — paste the relevant plan section into each subagent prompt.

## Trade-offs made

- **Proxy relay over browser-dials-each-tunnel.** Costs a Go relay and one extra hop on the
  pty path. Buys: credentials stay server-side (decision 3), one origin, one auth surface, and
  a "connect machine" flow that has somewhere to live.
- **Frontend-side id qualification over hub-side rewriting.** Costs the large Stage I/U
  migration. Buys a hub small enough to reason about, and a helper that stays *literally
  unmodified* — no version-skew matrix between hub and helper beyond what exists.
- **Hub-owned state file over the hub's tmux `@wt_state`.** Costs a new persistence path.
  Buys state that survives any machine being down, including a hub with no tmux at all.
- **Static config before dynamic connect.** Delays the headline "Connect to" button to the
  last stage. Buys six stages that are testable without solving interactive ssh auth.

## What this enables

- A laptop region beside a gpu-box region in one tab, one keyboard, one clipboard.
- Cross-machine window search, Exposé, MRU and attention alerts — "which box is that agent
  waiting on?" answered in one place.
- Every existing single-machine behaviour unchanged, by construction (decision 7).
- A hub that is also the natural home for anything else needing a machine registry later.

## Next steps

1. Commit this plan set to `local-main` (concurrent agents churn the tree; uncommitted plans
   are at risk).
2. Confirm the hard gate: has `plan-webtmux-harden-state.md` merged? If not, run subplan A
   first — it is 12 tasks and is a prerequisite, not a detour.
3. Execute Stage S. It is 1–2 days and ends in an explicit go/no-go with a working demo.
