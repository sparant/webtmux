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

### Phase 1 — races (P0) — COMPLETE

- [x] P0 `identMu` + snapshot accessors + call-site sweep (`SwitchSession`,
      `regroupOnto`, `discoverClient`, `SetClient`, `session()`, `selfHeal`); single-flight
      regroup. ~45m, Opus.
      Landed as `identState` (the six fields plus the `regrouping` latch) behind
      `Controller.identMu`, reached only through `ident()`/`setIdent()`. A refused
      regroup returns `errRegroupInFlight` (webtty logs a failed tmux command
      without tearing the connection down).
- [x] P0 A `-race` test that actually exercises it: fake-runner controller with a
      RefreshLayout loop racing SwitchSession/SetClient (the review noted `-race` passes
      only because no test crosses goroutines). ~40m, Opus.
      `pkg/tmux/controller_race_test.go`, on a new fake-tmux seam
      (`newControllerWithRunner` + `pkg/tmux/faketmux_test.go`, which RENDERS the
      `-F` format the code asks for rather than hard-coding a line, so a field
      reorder is exercised instead of re-baselined). Verified the test really
      witnesses the bug: with the mutex removed it reports `WARNING: DATA RACE`
      on `regroupOnto` vs `selfHeal`.

### Phase 2 — parsing (P0) — COMPLETE

- [x] P0 Migrate per-session window rows (decision 2) + tests with `,`/`|` in names. ~40m, Sonnet.
      `windowsFormat` (`window_id|window_index|window_active|@wt_working|window_name`)
      + `parseWindowRows`. Also swept the pane's OWN identity read, which was
      `display-message -p "#{session_id},#{session_name}"` parsed with a plain
      `Split` — a session called `a, b` reported itself as `a`; now
      `sessionIdentFormat` + `parseSessionIdent`.
- [x] P0 Migrate pane rows (`pane_current_command`/`pane_title` last) + tests. ~35m, Sonnet.
      `panesFormat` + `parsePaneRows`. Note on decision 2: a pane row has TWO
      user-controlled fields and neither has an id form (they ARE the data), so
      the residual is stated rather than removed — `pane_title` (which really does
      carry `|`, from shell prompt titles) takes the last slot, and a `|` in a
      process comm name can still bleed into the title but never into the geometry.
- [x] P1 `sessionEmptiness` + `parseAllWindows` session-name hardening + tests
      (the `|`-in-session-name caveat the code comment already admits). ~35m, Sonnet.
      Both rows now carry `#{session_id}` and resolve the name from the same
      refresh's `list-sessions`, which removes the caveat instead of restating it.
      Deviation from decision 2's wording: it offers "the `enumSep` NUL approach
      already in the codebase" as the fallback for a row with two names — there is
      no such approach (`enumSep` is `|`; the comment beside it explains that tmux
      sanitizes control bytes in `-F` output, so NUL is impossible). The id
      indirection is the workable form of the same intent.
      Scope note: decision 2 says "any format where a session name is non-final",
      so `capture.go`'s `EnumerateWindows` — session_name in field 1 of 7, i.e. the
      worst instance in the tree — was migrated too, at the cost of one extra
      `list-sessions` fork per enumeration. `windowLinkCounts` is deliberately left
      on `session_name`: it is already final-slot safe, and dropping an unnameable
      id there would UNDERCOUNT links, turning the sidebar's × from unlink to kill.

### Phase 3 — targeting & transport (P1) — COMPLETE

- [x] P1 Exact `-t =name` sweep over destructive ops + leading-`-` policy + tests
      (fake-runner asserts the literal argv). ~40m, Sonnet.
      **Decision 3 needed correcting against a live tmux (3.2a) — `=` is NOT
      universal, and the plan's "already used by `Start()`" generalisation does not
      hold.** Measured (probe scripts, since retired):
      * session targets (`has-session`, `kill-session`, `rename-session`,
        `switch-client`, `new-session -t`, `new-window -t`, `link-window -t`,
        `unlink-window -t`, `select-window`, `swap-window`, `list-windows -t`,
        `list-clients -t`) take `=name` / `=name:index`. Verified exact:
        `switch-client -c tty -t dev-` moves the client to `dev-2` and exits 0,
        `-t =dev-` refuses.
      * target-PANE commands (`split-window`, `copy-mode`, `send-keys`, `if-shell`,
        `display-message`) REJECT `=name` — "can't find pane: =name" — and
        `display-message` fails silently, expanding its whole format to "" with
        exit 0. They take `=name:` (session resolved exactly, then its current
        window's active pane). Hence the second helper, `exactPaneOf`.
      * `set-option -t` accepts NEITHER form ("no such session: =name"). Its one
        caller (regroupOnto) now targets `#{session_id}`, taken from a `-P -F` on
        the `new-session` that just created the session.
      Leading-`-` policy: `--` where tmux takes the name as a positional argument
      (`rename-session`, `rename-window` — both verified), and a refusal with an
      honest message for `new-session -s`, where the name is an OPTION ARGUMENT
      and tmux swallows a `--` as the name itself.
      Tests: `pkg/tmux/controller_targets_test.go` asserts the literal argv per
      command plus a sweep that no recorded `-t` names a session in bare form.
- [x] P1 `RenameSession` NUL-delimited payload (server + client + both test suites). ~35m, Sonnet.
      New import-free `resources/js/tmux-payloads.js` holds the encoder (the rest
      of `terminal-unit.js` can't load under node), `webtty/tmux.go` decodes, a
      payload without a NUL is dropped rather than guessed at. `make sync-assets`
      run so `bindata/static/js/` carries both files.
- [x] P1 Bounded reads (decision 4) in `server/ws_wrapper.go` + `server/handlers.go`. ~30m, Sonnet.
      `webtty.DefaultBufferSize` exported so the transport ceiling and the buffer
      size cannot drift; `newWSWrapper` arms `SetReadLimit`, `Read` copies through
      an `io.LimitReader(reader, len(p)+1)`, and the pre-auth `conn.ReadMessage`
      gets the limit before the handshake read. `server/ws_wrapper_test.go` drives
      a real gorilla connection for all four cases.

### Phase 4 — verify & land (P0)

- [x] P0 Full Go suite `-race` in golang:1.23 docker + JS suite + bindata sync;
      live smoke: window named `a, b | c` renders and navigates correctly everywhere
      (sidebar, recents, Exposé, stoplights). ~40m, Sonnet.
      * `go vet ./... && go test -race -count=1 ./...` — every package ok.
      * `node --test test/` — 208 pass, 0 fail (baseline 203; +5 from
        `test/tmux-payloads.test.mjs`).
      * `make check-js` clean, `make sync-assets` run.
      * Live: `screenshots/harness/verify-parse.js` (new committed driver, run with
        `DRIVER=verify-parse.js`) — a window named `a, b | c` inside a session named
        `ops | staging`, driven in a real chromium against a real tmux. 17/17
        checks: window row (name/index/active/@wt_working), pane geometry, the
        server-wide directory, the session list + emptiness, the pane's own
        identity after a switch, the sidebar row + its stoplight + click-to-select
        (with tmux agreeing), the recents strip, Exposé tiles and placements, an
        end-to-end session rename over the NUL payload, and `killSession("proj")`
        leaving `proj-2` alone.
      One finding, not a defect: the recents strip LABEL shows `b | c`, because the
      `recentTrimName` pref (on by default) drops everything before the first
      space — the same rule that renders "claude Dominion" as "Dominion". The name
      in the strip's data is whole; the driver checks both for what they are.
- [ ] P0 Mark complete, merge via the lock wrapper, tick subplan C in the master plan. ~15m.
      Plan marked complete here; the MERGE and the master-plan tick are the parent
      session's (subplan B is gated on it).
      **Merge preflight (done, read-only — `git merge-tree` against the local-main
      that now carries subplan A):** exactly ONE conflicting file,
      `pkg/tmux/controller.go`, and exactly one hunk in it — A's
      `serverStartFormat`/`serverIdentity` block and this branch's
      `sessionNamesByID` were inserted at the same point. Resolution is keep both.
      Everything else auto-merges, `resources/js/terminal-unit.js` included. The
      resolved tree was built and run: `go vet` + `go test -race ./...` all green
      and `node --test test/` 237/0. A's `#{start_time}` read is a TARGETLESS
      `display-message`, so it is unaffected by the `=name:` rule; the only
      adjustment that needed making on this side was selecting the identity read
      by its format instead of by position, which is committed here.
