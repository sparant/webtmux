# Plan: webtmux portable — dependency audit and reduction

`plan-webtmux-portable-deps.md` — subplan of `plan-webtmux-portable.md`, created
2026-07-26. **Revised same day: promoted from optional-and-last to FIRST in the execution
order (D → 0 → 2 → 3 → 1).**

**This stage runs first**, so every later stage works against a smaller surface. Three
reasons it earns the front position rather than the back:

1. **D2.2 (urfave/cli v2 → v3) is far cheaper before the launcher exists.** The launcher
   is a second `main` with its own flag set. Writing it against v2 and then migrating both
   binaries is strictly more work than migrating one and writing the second against v3.
2. **The launcher adds zero dependencies by design** — it uses `net/http` from the
   standard library to fetch release assets. Shrinking the module tree first means that
   claim starts from 4 modules rather than 16.
3. **It is self-contained and low-risk.** Nothing here depends on the fork, a release, or
   the launcher, so it can proceed immediately while the GitHub migration is arranged.

It still gates nothing: if a later stage becomes urgent, this one can be interrupted.

## Findings summary

16 modules resolve today. **Four are genuinely load-bearing.** Three of the seven direct
dependencies are unmaintained or archived, and two of those have **exactly one call site
each**.

| Module | Version | Status | Call sites | Verdict |
|---|---|---|---|---|
| `gorilla/websocket` | v1.4.2 (2020) | maintained | 3 files | **Keep** — core. Bump to v1.5.3. |
| `creack/pty` | v1.1.11 (2020) | maintained | 3 files | **Keep** — core. Bump to v1.1.24. |
| `urfave/cli/v2` | v2.3.0 (2021) | maintained | 2 files | **Keep v2 for now** — see the trap below. |
| `pkg/errors` | v0.9.1 | **archived 2021** | **58** | Removable, mechanical, touches 8 files. |
| `fatih/structs` | v1.1.0 | **stale since 2018** | **5** | Removable — `reflect` is already imported. |
| `NYTimes/gziphandler` | v1.1.1 | **archived** | **1** | Removable — ~60 lines or a maintained fork. |
| `yudai/hcl` | 2015 (!) | **unmaintained 11 yrs** | **1** | **Best single removal.** Drops 3 modules. |

Indirect deps and their sources (verified with `go mod why`):

- `go-md2man` → `blackfriday/v2` → `sanitized_anchor_name` — pulled by `urfave/cli/v2`
  purely to render man pages from `--help`. Three modules for a feature nobody uses.
- `errwrap`, `go-multierror` — pulled by `yudai/hcl`.
- `golang.org/x/sys` — pulled by `creack/pty`. Legitimate.

**Cumulative effect if everything below lands: 16 modules → 4.**

---

## Two things I assumed and had to correct

**1. Bumping `urfave/cli/v2` makes the tree *worse*, not better.** Tested: `v2.3.0` →
`v2.27.7` keeps `go-md2man`/`blackfriday`/`sanitized_anchor_name` **and adds
`xrash/smetrics`**. Seven indirect deps become eight. Do not bump v2 expecting a cleanup.

**2. `urfave/cli/v3` has zero transitive dependencies.** Tested: adding it pulled in
`v3.10.1` and nothing else. Migrating v2 → v3 would shed three modules — but it is a
breaking API change (`cli.App` → `cli.Command`, altered context handling) affecting
`main.go` and `utils/flags.go`, where flags are reflection-generated from struct tags. Real
work, deferred to its own task.

---

## Worktree

- **Branch:** `chore/portable-deps`
- **Worktree:** `/workspace/webtmux-portable-deps`

```bash
git -C /workspace/webtmux worktree add /workspace/webtmux-portable-deps \
    -b chore/portable-deps local-main
cp /workspace/webtmux/plan-webtmux-portable*.md /workspace/webtmux-portable-deps/
```

Merge with `--no-ff`. See the Worktree Reference in the master plan.

---

## Phase D1 — High value, low risk ✅ COMPLETE

*Outcome: three unmaintained dependencies gone and the two maintained ones current.
go.mod went from 7 direct + 6 indirect to **4 direct + 3 indirect**. `--help` is
byte-identical apart from the one intentionally removed `--config` row.*

- [x] **P0** D1.1 Create the worktree. *(5 min)*

      *Done. No Go toolchain exists in this container — every `go`/`make` command
      below runs inside a pinned `golang:1.23` container with `/workspace` mounted.*

- [x] **P0** D1.2 **Drop `yudai/hcl` — the single best removal.** One call site
      (`utils/flags.go:122`, inside `ApplyConfigFile`) backing an optional `~/.gotty`
      config file. Removing it also drops `hashicorp/errwrap` and
      `hashicorp/go-multierror`: **three modules for one function.** *(45 min)*

      The feature is **redundant**: `utils.GenerateFlags` already gives every option a
      `GOTTY_*` environment variable, and nothing in this project's deployment uses a
      config file — the container passes flags plus env, and the launcher will do the same.
      `main.go:62-66` only loads it when the file exists or a non-default `--config` is
      given, so the default path is already a no-op.

      Delete `ApplyConfigFile`, the `--config` flag, and the `main.go` block. If config-file
      support is ever wanted back, `encoding/json` over a small struct is ~20 lines with no
      dependency. **This is the only task here that removes user-visible surface** — call it
      out in the commit message and README.

      *Done. `--help` diff is exactly one line — the `--config` row — and nothing else.
      README's Common Options section now states there is no config file. **Deviation:**
      the dead `hcl:"…"` struct tags in `server/options.go` and
      `backend/localcommand/options.go` were left in place; removing them is not part of
      this task and would collide with D1.4, which rewrites the reflection that reads
      those structs.*

- [x] **P0** D1.3 **Drop `NYTimes/gziphandler`** (archived upstream). One call site,
      `server/server.go:317`. Replace with a small middleware, or with
      `klauspost/compress/gzhttp` — the successor the archive notice itself points to.
      *(35 min)*

      Prefer writing it: the handler needs to check `Accept-Encoding`, wrap
      `http.ResponseWriter`, and set `Content-Encoding` — roughly 60 lines with no new
      module. Trading one archived dependency for one maintained dependency is a smaller win
      than trading it for none.

      **Do not simply delete compression.** It matters more after vendoring: `xterm.js` is
      292 KB raw and roughly 80 KB gzipped, and SSH does not compress unless `-C` is set.

      *Done — written, not swapped for another module. `server/gzip.go` (~190 lines with
      comments) keeps gziphandler's 1400-byte minimum so behaviour is unchanged. Three
      things the naive version gets wrong and this one does not: **Content-Type must be
      sniffed from the plain bytes** (sniffing the gzip stream labels every asset
      `application/x-gzip`, which browsers refuse to execute), `Content-Length`/
      `Accept-Ranges` must be dropped, and 204/304/**206** must not be compressed. Covered
      by `server/gzip_test.go` — 8 tests, the first Go tests this package has ever had.*

- [x] **P1** D1.4 **Drop `fatih/structs`** (no release since 2018). Five call sites across
      `utils/flags.go` (4) and `utils/default.go` (1), all reflecting over the Options
      structs to read `flagName`/`default`/`hcl` tags. `utils/flags.go` **already imports
      `reflect`**, so this is rewriting five call sites against a package the file already
      uses. *(60 min)*

      Covered by existing tests plus a strong end-to-end check: every flag must still appear
      in `--help` with the same name, shorthand, and default. Diff `--help` before and after.

      *Done. **`--help` is byte-identical** across the change. The `structs` surface used
      (`Name`/`Tag`/`Kind`/`Value`/`Set`/field lookup) is reimplemented in
      `utils/structfields.go`, keeping the same method shape so the call sites did not
      change library and shape at once. **Deviation:** `ApplyFlags` now returns an `error`
      — reflect cannot write through a non-pointer, so the mistake `structs` used to
      swallow per-field is now reported once, up front; `main.go` exits on it.
      `utils/flags_test.go` adds 7 tests (the package had none) pinning tag→flag name,
      shorthand, `GOTTY_*` env var, default, and cross-struct routing.*

- [x] **P1** D1.5 **Bump `gorilla/websocket` → v1.5.3 and `creack/pty` → v1.1.24.** Both
      are 2020-era pins on actively maintained projects; `x/sys` moves with pty. No API
      changes expected in either. *(30 min)*

      *Done, no source changes needed — `pty.Start`/`Open`/`Setsize`/`Winsize` and the
      websocket API are unchanged. **Better than predicted:** `x/sys` did not move with
      pty, it left. creack/pty v1.1.24 dropped the dependency, so the bump removed an
      indirect module rather than updating one. `--help` unchanged.*

- [x] **P0** D1.6 Verify: `make test`, `go vet ./...`, `make build`, then boot and exercise
      a real session — a websocket connection and a pty are the two things D1.5 could break.
      Confirm the binary still links statically. *(30 min)*

      *Done, all green. `make test` + `go vet` + `make build` pass; `file ./webtmux` reports
      **statically linked**. A real webtmux was then booted on a real tmux session inside
      the container and driven by a purpose-written client
      (`/workspace/tmp/webtmux-verify/`): basic auth 401s an anonymous request; a websocket
      connection completes the webtty handshake and **a shell command typed through it is
      echoed back out of the pty** — gorilla v1.5.3 and creack/pty v1.1.24 exercised
      together, live. The new gzip middleware served `split-manager.js` at
      **93,366 → 30,874 bytes (67% saved)**, byte-identical to the plain response after
      decompression, with a JavaScript `Content-Type` (not `x-gzip`), and correctly left
      the 875-byte `webtmux.js` uncompressed.*

---

## Phase D2 — Larger, optional

- [ ] **P2** D2.1 **Drop `pkg/errors`** (archived 2021) in favour of stdlib. 58 call sites:
      26 `Wrapf`, 21 `Wrap`, 9 `New`, 2 `Errorf`, across 8 files. Mechanical but wide.
      *(90 min)*

      `errors.Wrap(err, "msg")` → `fmt.Errorf("msg: %w", err)`;
      `errors.Wrapf(err, "fmt", a)` → `fmt.Errorf("fmt: %w", a, err)` — **note the argument
      order changes**, which is where this goes wrong. `errors.New` maps to stdlib
      `errors.New` unchanged.

      The only real loss is `pkg/errors` stack traces, which nothing in this codebase
      prints. Do it as one commit, no behaviour changes mixed in.

- [ ] **P2** D2.2 **Migrate `urfave/cli/v2` → `v3`** to shed `go-md2man`, `blackfriday`,
      and `sanitized_anchor_name`. Breaking API change across `main.go` and
      `utils/flags.go`. Only worth doing after D1 and D2.1, when it is the last thing
      standing between the project and a four-module tree. *(2-3 hrs)*

      The alternative — dropping `urfave/cli` for stdlib `flag` — is **not** recommended:
      the reflection-driven flag generation and the `GOTTY_*` env-var mapping would both
      have to be hand-rolled.

---

## Phase D3 — Browser dependencies

One browser dependency is ~104 KB and is **not used by default**. This applies whether or
not Stage 1 (vendoring) ever runs — today the 104 KB is fetched from jsdelivr on every
page load; after vendoring it would be 24% of a ~431 KB embedded payload. Either way it
is downloaded for nothing.

- [ ] **P0** D3.1 **Make `@xterm/addon-webgl` (104 KB) a dynamic import.** It is
      *statically* imported at `resources/js/terminal-unit.js:11` but only conditionally
      constructed at `:246` — `if (stateStore.section('renderer').webgl === true)`. WebGL
      is **strictly opt-in**: the DOM renderer is the default because it does native font
      fallback and WebGL does not (that is the glyph-rendering bug documented at
      `terminal-unit.js:232-245`). `expose-overlay.js:675` also explicitly avoids it.
      *(30 min)*

      So every page load currently downloads 104 KB for a renderer almost nobody enables.
      Move it inside the branch:

      ```js
      if (stateStore.section('renderer').webgl === true) {
        try {
          const { WebglAddon } = await import('@xterm/addon-webgl');
          this.terminal.loadAddon(new WebglAddon());
        } catch (e) { console.warn('WebGL addon not supported:', e); }
      }
      ```

      Requires the enclosing method to be `async` — check callers. The importmap entry
      stays; dynamic `import()` resolves through it identically — and identically again
      after Stage 1 repoints that entry at a local file, so this change is independent of
      whether vendoring ever happens.

- [ ] **P1** D3.2 **Reconcile the dead `EnableWebGL` server option.**
      `server/options.go:35` still declares `enable-webgl` with `default:"true"`, but the
      frontend ignores it entirely and defaults to the DOM renderer. The flag lies. Either
      wire it to seed `stateStore`, or delete it and its `GOTTY_ENABLE_WEBGL` env var.
      *(25 min)*

- [ ] **P2** D3.3 Consider inlining `@xterm/addon-fit` (1.8 KB). It is roughly 30 lines of
      arithmetic over character cell size. Low value — listed only so the audit is
      complete. Probably **decline**: it is tiny, and hand-maintained copies of upstream
      code rot. *(20 min)*

**Keep without question:** `lit` (~18 KB, backs all six components and ~53.6 KB of
`css``` templates — removing it means rewriting the entire component layer),
`@xterm/xterm` (292 KB — it *is* the terminal), `@xterm/addon-unicode11` (12.5 KB —
correct wide-character widths, and this fork has a documented history of glyph-width bugs).

**Removed by Stage 1, if it runs:** Tailwind, 407 KB of in-browser JIT compiler serving
exactly two utility classes. Stage 1 is now optional and last, so this remains a live
cost until then — worth knowing when weighing whether to run that stage.

---

## Non-Go dependencies — assessed, mostly keep

| Dependency | Where | Verdict |
|---|---|---|
| `tmux` | runtime, required | **Irreducible** — it is the product. Note the container's from-source version pinning is a *containerization* artifact, not inherent. |
| `ssh` (client) | launcher | **Deliberate.** Buys `~/.ssh/config`, ProxyJump, agents, 2FA. Reimplementing is the cost being avoided. |
| `gzip` (remote) | launcher transfer | **Keep with a fallback.** Saves ~7 MB per deploy (12 MB → 5 MB). Universal on Linux; probe detects it and can stream raw if absent. |
| `node` | `make check-js` | **Keep.** Already no-ops with a note when absent; catches a class of error that blanks the page. |
| `npm` + `esbuild` | `vendor-assets.sh` | **Keep.** One-shot, never in the build path, output committed. Required because jsdelivr's `lit` bundle is a shim needing real bundling. |
| `libevent`, `ncursesw`, `tinfo` | container only | Only there to run the from-source tmux. A native binary needs none of it. |
| Docker | container deploy | Becomes **optional** once the launcher ships native binaries. |

---

## Risks

1. **D1.2 removes user-visible surface** — the `--config` flag and `~/.gotty` support. The
   only intentional feature removal here; everything else is invisible. Flag it in the
   README and commit message.
2. **D1.4 flag-generation regression.** `structs` → `reflect` touches how *every* CLI flag
   is derived. A subtle tag-parsing difference silently changes a default rather than
   erroring. Diff `--help` output before and after — that is the real test.
3. **D2.1 argument-order slip.** `Wrapf(err, "fmt", a)` → `fmt.Errorf("fmt: %w", a, err)`
   moves `err` to last. Getting it wrong produces a compiling, wrong error message. Grep
   for `%w` count == wrap count afterwards.
4. **D3.1 async propagation.** Making the WebGL load dynamic requires the enclosing method
   to be async; if a caller does not await, the addon may load after first paint. Verify
   the terminal still renders on a cold load with WebGL opted in.
5. **Do not run this concurrently with Stage 3.** *(Revised 2026-07-26: the original
   concern — the launcher embedding a binary whose dependency surface was shifting —
   disappeared with the embedded payload. What remains is simpler: D2.2 changes the CLI
   framework both binaries use, so overlapping the two would mean rewriting the launcher's
   flag handling mid-flight.)* Running D **before** Stage 3, as the current order does,
   removes the conflict entirely.
6. **D2.2 is the one item with a deadline.** Everything else here can be deferred
   indefinitely; the urfave/cli migration gets materially more expensive once a second
   binary is written against v2. If D2 is going to be skipped, decide that *before* Stage
   3 rather than after.

## Next steps

Phase D1 is the high-value block: **three unmaintained dependencies and four modules gone
for roughly three hours' work**, with D1.2 alone accounting for three of them. D3.1 is a
30-minute change that stops 104 KB being fetched on every page load for a default-off
renderer.

D2 is genuinely optional — but if it is going to happen at all, **do D2.2 now**, before
the launcher is written against urfave/cli v2 (see risk 6). Then hand off to Stage 0
(`plan-webtmux-portable-fork.md`).
