# Plan: webtmux harden — controller races & parsing (subplan C of plan-webtmux-harden-master.md)

The per-connection controller's identity/session fields are written from two goroutines
with no lock; the legacy per-session layout parse still splits on `,` with
`#{window_name}` mid-format (a window named `build, test` shifts every field); destructive
tmux targets use prefix matching (killing a stale "dev" can kill "dev-2"); and the ws
wrapper buffers unbounded input pre-check. Mechanical, well-testable hardening.

## Worktree

- Branch: `harden-parse`
- Path: `/workspace/webtmux-harden-parse`
- Setup: `git -C /workspace/webtmux worktree add /workspace/webtmux-harden-parse -b harden-parse local-main`,
  copy this plan in; all edits there.
- Finish: tests green → `scripts/git-merge-worktree.sh /workspace/webtmux-harden-parse --target local-main --no-ff --remove`.
- **Serialization:** not concurrent with subplan B (same files). May run parallel to
  subplan A (disjoint: A is JS + one Go format field; coordinate the layout-format edit
  if simultaneous — trivial rebase otherwise).

## Design decisions

1. **One identity mutex.** A single `identMu sync.Mutex` on `Controller` guards
   `sessionName`, `baseSession`, `groupBase`, `clientTTY`, `clientPID`, `follow`.
   Accessors (`ident()` snapshot / `setIdent()`) rather than sprinkled locks; no lock held
   across a tmux fork (copy-out, act, copy-in — same discipline `layoutMu` already
   follows). `regroupOnto` becomes single-flight (`regrouping` flag under the mutex):
   poll-tick self-heal and a user switch can't interleave two `new-session`+`switch-client`
   pairs.
2. **Delimiter-safe formats everywhere.** Migrate the legacy per-session
   `list-windows`/`list-panes` formats in `controller.go` (lines ~358–435) to the pattern
   the fork already proved in `allWindowsFormat`: `|` separator, user-controlled text
   (window_name, pane_title, pane_current_command) **last**, parsed with
   `strings.SplitN(line, "|", n)`. Same for `sessionEmptiness` and any format where a
   session name is non-final. Session names may contain `|`? tmux forbids `:` and `.`
   only — so for session-name-bearing rows keep the name last too, or use the `enumSep`
   NUL approach already in the codebase where both a name and a title appear.
3. **Exact targets for destructive ops.** Every `-t <session>` on a kill/rename/link/move
   becomes `-t =<name>` (tmux exact-match syntax, already used by `Start()`); names
   starting with `-` are protected by `--` where tmux accepts it, else refused with an
   error (rename already fails loudly today — make the message honest). `RenameSession`'s
   space-splitting payload parse becomes first-token = target only if payload is
   structured (`old\0new` NUL-delimited, matching the NUL conventions elsewhere) — client
   updated in the same commit.
4. **Bounded reads.** `ws_wrapper.Read` stops buffering the whole message before the size
   check: `conn.SetReadLimit(bufferSize)` on the gorilla conn (kills oversize frames at
   the transport, complementing the fixed error path) + `io.LimitReader(reader,
   bufferSize+1)` for the copy. The pre-auth `conn.ReadMessage` in `server/handlers.go`
   gets the same `SetReadLimit` before the auth handshake read.

## Phases

### Phase 1 — races (P0)

- [ ] P0 `identMu` + snapshot accessors + call-site sweep (`SwitchSession`,
      `regroupOnto`, `discoverClient`, `SetClient`, `session()`, `selfHeal`); single-flight
      regroup. ~45m, Opus.
- [ ] P0 A `-race` test that actually exercises it: fake-runner controller with a
      RefreshLayout loop racing SwitchSession/SetClient (the review noted `-race` passes
      only because no test crosses goroutines). ~40m, Opus.

### Phase 2 — parsing (P0)

- [ ] P0 Migrate per-session window rows (decision 2) + tests with `,`/`|` in names. ~40m, Sonnet.
- [ ] P0 Migrate pane rows (`pane_current_command`/`pane_title` last) + tests. ~35m, Sonnet.
- [ ] P1 `sessionEmptiness` + `parseAllWindows` session-name hardening + tests
      (the `|`-in-session-name caveat the code comment already admits). ~35m, Sonnet.

### Phase 3 — targeting & transport (P1)

- [ ] P1 Exact `-t =name` sweep over destructive ops + leading-`-` policy + tests
      (fake-runner asserts the literal argv). ~40m, Sonnet.
- [ ] P1 `RenameSession` NUL-delimited payload (server + client + both test suites). ~35m, Sonnet.
- [ ] P1 Bounded reads (decision 4) in `server/ws_wrapper.go` + `server/handlers.go`. ~30m, Sonnet.

### Phase 4 — verify & land (P0)

- [ ] P0 Full Go suite `-race` in golang:1.23 docker + JS suite + bindata sync;
      live smoke: window named `a, b | c` renders and navigates correctly everywhere
      (sidebar, recents, Exposé, stoplights). ~40m, Sonnet.
- [ ] P0 Mark complete, merge via the lock wrapper, tick subplan C in the master plan. ~15m.
