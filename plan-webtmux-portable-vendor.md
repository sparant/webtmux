# Plan: webtmux portable — Stage 1, offline UI

`plan-webtmux-portable-vendor.md` — subplan of `plan-webtmux-portable.md`, created
2026-07-25.

## Goal

The UI must render with **no internet access**. Today `resources/index.html` pulls
Tailwind from `cdn.tailwindcss.com` and lit + xterm + three addons from `cdn.jsdelivr.net`
via an importmap, so an air-gapped machine gets a blank page. Vendor them all, and drop
~2.6 MB of dead assets that are currently embedded in every binary.

In the revised execution order (0 → 3 → 1 → 2) this runs **after** the launcher — once it
merges, a launcher-payload rebuild picks up the offline UI automatically (new content sha
⇒ redeploy on next connect).

## Gate — the build/run split must be merged first — **SATISFIED 2026-07-26**

*(added 2026-07-26; this stage previously declared "no gate")*

The **build/run split** landed on `local-main` in `af969d2` (plus the follow-up fix
`bcdbdd5`), was verified on the host, and its plan file has since been retired — the work
is in git history, not in a plan file. Read `Dockerfile`, `Makefile`, and
`scripts/webtmux-docker/Dockerfile` for the current shape.

Task **1.2** below lists the root `Dockerfile` as dead weight to delete. That is no longer
true: the split **revived it** as the artifact builder (`make docker-artifact`), and
`scripts/webtmux-docker/Dockerfile` now consumes its output instead of building the binary
itself. Running this stage against a tree without the split would delete a live build file
and break the deploy path.

The split also landed the `.dockerignore` and the `builds/` untracking that Stage 2 had
claimed, which is why 1.2/1.3 below are already annotated as amended.

**Re-run before creating the worktree** — it should pass immediately. It is kept, rather
than deleted along with the plan, because it is cheap and it is the only thing that would
catch the split being reverted or half-merged by a bad rebase.

```bash
grep -q 'FROM scratch AS artifact' /workspace/webtmux/Dockerfile 2>/dev/null \
  && test -f /workspace/webtmux/.dockerignore \
  && grep -q 'docker-artifact' /workspace/webtmux/Makefile \
  || { echo "GATE: the build/run split is not on local-main — stop"; exit 1; }
```

Content checks rather than a commit-message grep: they stay true if the split is amended
or re-landed, and they fail loudly if only part of it is present.

---

## Worktree

- **Branch:** `feat/portable-vendor`
- **Worktree:** `/workspace/webtmux-portable-vendor`

```bash
git -C /workspace/webtmux worktree add /workspace/webtmux-portable-vendor \
    -b feat/portable-vendor local-main
cp /workspace/webtmux/plan-webtmux-portable*.md /workspace/webtmux-portable-vendor/
```

All edits happen in `/workspace/webtmux-portable-vendor`. Merge with `--no-ff` (never
`--ff-only` — `local-main` is churned by concurrent agents). See the Worktree Reference in
the master plan.

**Two commits**, so a UI regression is bisectable: dead-asset deletion, then vendoring.

---

## Phase 1A — Delete dead weight (commit 1)

Worth doing before the first *published* release: every dead byte here rides in each
binary — and in the launcher's embedded payloads — so this trims ~2.6 MB from every
artifact and shrinks the SSH deploy transfer. *(The original "before it multiplies in git
forever" urgency dissolved when distribution moved to GitHub Releases.)*

- [ ] **P0** 1.1 Create the worktree per the block above. *(5 min)*

- [ ] **P0** 1.2 Delete the confirmed-unreferenced assets. Verified against every `.go`,
      `.html`, and `.js` in the repo — nothing references any of these. *(20 min)*

      bindata/static/js/gotty.js                 793 KB
      bindata/static/js/gotty.js.map            1.74 MB
      bindata/static/js/gotty.licenses.txt        34 KB
      bindata/static/js/gotty.js.LICENSE.txt
      bindata/static/css/index.css
      bindata/static/css/xterm.css
      bindata/static/css/xterm_customize.css
      resources/index.css                        (unreferenced, never synced)
      resources/xterm_customize.css              (unreferenced, never synced)
      js/                                        entire legacy webpack/React/preact tree

      **AMENDED 2026-07-26 — do NOT delete the root `Dockerfile`.** It was listed here as
      broken (it called the nonexistent target `make bindata/static/js/gotty.js.map` and
      copied a binary named `gotty`). The build/run split (`af969d2`) replaced it with
      the artifact builder, so it is now live and load-bearing. Its `js-build` stage — the
      only part that referenced the `js/` tree being deleted here — is already gone, so
      deleting `js/` remains safe.

      **Leave `server/server.go:303` (the `css/` route) alone** — removing it is a Go
      change with no benefit, and it stays correctly wired if a real `resources/css/` is
      ever added.

- [ ] **P1** 1.3 **AMENDED 2026-07-26 — now a verification, not an edit.** This task fixed
      a stale comment in `/workspace/scripts/webtmux-docker/Dockerfile` claiming the
      embedded assets include "the pre-built gotty.js bundle".
      The build/run split (`af969d2`) deleted that entire comment block along
      with the Go build stage. Just confirm it is gone: *(5 min)*

      ```bash
      grep -n 'gotty' /workspace/scripts/webtmux-docker/Dockerfile && echo "STALE COMMENT REMAINS"
      ```

- [ ] **P0** 1.4 Verify + commit: `make build && make test`, confirm the binary shrank by
      ~2.6 MB, then commit as `chore: drop 2.6MB of unreferenced embedded assets`. *(15 min)*

---

## Phase 1B — Vendor the CDN assets (commit 2)

### Layout

Everything under **`resources/js/vendor/`**, CSS included. This is load-bearing:
`sync-assets` copies only `resources/js/*` and `resources/index.html`, and
`server/server.go:301` already routes `js/` to the embedded FS — so this needs **zero
Makefile and zero Go changes**. A top-level `resources/vendor/` would 404 against the
explicit allow-list at `server.go:299-308`.

`sync-assets` handles the new subdirectory correctly as-is: `cp -r resources/js/*` is the
multi-operand form, which creates `vendor/` on first run and merges into it thereafter.
Proven by `components/`, synced the same way, which has no `components/components/`
nesting. `//go:embed static/*` picks up directories recursively.

Use **unversioned filenames** — every static response is wrapped in `noStore(...)`
(`server/server.go:296`), so cache-busting names buy nothing and cost an edit site per
upgrade.

- [ ] **P0** 1.5 Write `scripts/vendor-assets.sh` (new dir — `/workspace/webtmux/scripts/`
      does not exist yet). The **only** networked step; deliberately **not** wired into
      `make build`, or the offline build would require internet. *(45 min)*

      **`lit` must be BUNDLED, not downloaded.** jsdelivr's `lit@3/+esm` is a 522-byte
      shim whose entire body is `import"/npm/@lit/reactive-element@2.1.2/+esm"; …` —
      **root-relative** paths that would resolve against the webtmux origin, 404, and
      blank the whole page. Bundle it:
      ```
      npm install lit@3.3.3 esbuild   # in a mktemp -d; record the resolved esbuild
                                      # version in VERSIONS.txt (don't trust a guessed pin)
      echo "export * from 'lit';" > entry.js
      esbuild entry.js --bundle --format=esm --minify --legal-comments=none \
              --target=es2020 --outfile=lit.js       # → ~18 KB, self-contained
      ```

      **The four `@xterm/*` `+esm` bundles ARE self-contained** — verified, no internal
      `/npm/` refs — so `curl` them verbatim. Strip the trailing
      `//# sourceMappingURL=/sm/<hash>.map` line (root-relative; 404s whenever devtools
      has source maps on). **Keep** the jsdelivr banner comment at the top — it records
      the exact upstream file, which is free provenance.

      Pin versions as shell variables at the top: `LIT=3.3.3`, `XTERM=5.5.0`,
      `FIT=0.10.0`, `WEBGL=0.18.0`, `UNICODE11=0.8.0`. Bumping a version is a one-line
      edit + rerun.

      End with a **self-containment guard** that greps for URLs in
      `import` / `from` / `src=` / `href=` / `url()` position and for `"/npm/`, exiting
      non-zero on a hit. Do **not** grep bare `https?://` — the retained banner comments
      contain a harmless jsdelivr doc link and a naive grep would false-fail.

- [ ] **P0** 1.6 Run it and commit the output (~431 KB): `lit.js`, `xterm.js`,
      `xterm-addon-fit.js`, `xterm-addon-webgl.js`, `xterm-addon-unicode11.js`,
      `xterm.css`, plus `VERSIONS.txt` (pinned versions, source URLs, refresh date,
      sha256s). Embedding `VERSIONS.txt` means a *running* server can be asked what it
      shipped: `curl …/js/vendor/VERSIONS.txt`. *(20 min)*

- [ ] **P0** 1.7 Repoint `resources/index.html` — six edits. *(30 min)*

      | Line | Change |
      |---|---|
      | 10-11 | Delete the Tailwind `<script src="https://cdn.tailwindcss.com">` and its comment |
      | 13-14 | xterm CSS → `./js/vendor/xterm.css` (relative, so `--path` prefixes keep working) |
      | 102-113 | Importmap → relative `./js/vendor/*.js`. **Drop the `lit/decorators.js` entry** — imported by exactly zero files |
      | 116 | `<body class="bg-gray-900">` → `<body>` |
      | 122 | Drop `class="lg:hidden"` from `<webtmux-mobile-controls>` |

- [ ] **P0** 1.8 Add the four rules Tailwind was silently providing, into the existing
      inline `<style>` block (lines 16-99), each with a comment explaining *why*. Tailwind
      was used for only two classes, but dropping it also drops **preflight**. *(25 min)*

      ```css
      /* 1. Preflight's box-sizing. LOAD-BEARING: `.xterm { height:100%; padding:8px }`
            overflows its region by 16px under the default content-box, clipping the
            bottom row of every terminal. */
      *, *::before, *::after { box-sizing: border-box; }

      /* 2. Preflight's text-size-adjust — stops mobile Safari inflating text and
            desyncing xterm's char measurement from its canvas grid. */
      html { -webkit-text-size-adjust: 100%; }

      /* 3. Was class="bg-gray-900" on <body>. Note the class beat the `html, body
            { background:#1a1a2e }` rule above it, so #111827 is the real current colour. */
      body { background: #111827; }

      /* 4. Was class="lg:hidden". mobile-controls.js:11-23 sets
            :host { position:fixed; bottom:0; z-index:1000 } with NO media query, so
            without this the mobile bar pins itself over every desktop session. An
            outer-tree rule targeting the host beats the shadow root's :host rule. */
      @media (min-width: 1024px) { webtmux-mobile-controls { display: none; } }
      ```

      **Do not add `!important` to rule 4** — a normal outer-tree declaration already
      wins, and `!important` would flip the cascade unpredictably if a future `:host` rule
      ever becomes `!important`.

- [ ] **P0** 1.9 Repoint the **two shadow-root CSS links**. Global stylesheets don't cross
      a shadow boundary, so these components re-link xterm.css *inside* their shadow roots.
      Miss them and Exposé/PiP tiles render unstyled offline while the main terminal looks
      fine — a nasty partial failure. *(15 min)*

      - `resources/js/components/pip-overlay.js:31` (used at `:473`)
      - `resources/js/components/expose-overlay.js:25` (used at `:324`)

      Both become `const XTERM_CSS = './js/vendor/xterm.css';` — relative on purpose,
      since URLs inside a shadow root resolve against the *document* base URL, which keeps
      `--path` prefixes working. Verified this is a CSS-positioned box in the same
      document, **not** the `documentPictureInPicture` API, so there is no second Document
      with an `about:blank` base to break the relative path.

- [ ] **P1** 1.10 Correct the now-false claims: `resources/js/package.json:4` ("No
      dependencies — the browser resolves lit/@xterm via the importmap") and
      `README.md:219` ("Tailwind CSS (CDN)"). *(10 min)*

- [ ] **P1** 1.11 Fix two Makefile footguns while here. *(20 min)*

      - `sync-assets` uses `cp -r`, which never deletes — a renamed vendor file would
        linger in `bindata/` and ship forever. Add `@rm -rf bindata/static/js/vendor` as
        its first line. **Scope to `vendor/` only**; a blanket `rm -rf bindata/static/js`
        aims a much bigger hammer at tracked files.
      - The `assets:` target copies only `webtmux.js` and `components/*.js` — already
        incomplete (misses `state-store.js`, `split-manager.js`, …) and would now silently
        skip `vendor/`. `make dev` depends on it. Make `assets` an alias for `sync-assets`.

---

## Phase 1C — Verify

- [ ] **P0** 1.12 Static checks — all must come back clean. *(20 min)*

      ```bash
      cd /workspace/webtmux-portable-vendor

      # No remote refs in import/link/src position across embedded assets
      grep -REn 'from *"https?://|import *"https?://|src *= *"https?://|href *= *"https?://|url\(https?://|"/npm/' \
        bindata/static/index.html bindata/static/js/ ; echo "exit=$? (1 = clean)"

      # The two names that must be gone entirely
      grep -rn 'cdn.tailwindcss.com\|cdn.jsdelivr.net/npm/lit' bindata/static/ resources/

      # Tailwind classes gone from BOTH copies of index.html
      grep -n 'bg-gray-900\|lg:hidden' resources/index.html bindata/static/index.html

      # lit is really bundled, not the 522-byte shim
      wc -c resources/js/vendor/lit.js          # expect ~15-25 KB
      grep -c 'LitElement' resources/js/vendor/lit.js
      ```

      Then confirm every bare specifier actually imported has an importmap entry — extract
      both lists, assert the first is a subset of the second. Expect exactly `lit`,
      `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `@xterm/addon-unicode11`,
      with `lit/decorators.js` in **neither**.

- [ ] **P0** 1.13 Boot in a throwaway container and curl **every importmap target**,
      asserting 200 + nonzero bytes. A single unresolvable specifier blanks the whole page
      with no error visible outside devtools — this loop is the guard. Serving static
      assets needs no tmux (the command runs only on WebSocket connect), so `golang:1.23`
      suffices; auth is on by default, so pass `-u`. *(25 min)*

- [ ] **P0** 1.14 Prove no egress is needed at all. *(10 min)*

      ```bash
      docker run --rm --network none -v /workspace/webtmux-portable-vendor:/src -w /src golang:1.23 \
        bash -c './webtmux -w -p 8080 -c u:p sh & sleep 2;
                  for p in / js/webtmux.js js/vendor/lit.js js/vendor/xterm.js js/vendor/xterm.css; do
                    curl -s -u u:p -o /dev/null -w "$p %{http_code}\n" "http://127.0.0.1:8080/$p"; done'
      ```

- [ ] **P0** 1.15 **Strongest check** — grep the shipped binaries. Assets are embedded
      uncompressed, so this catches a stale `bindata/` that a rebuild forgot to sync.
      *(10 min)*

      ```bash
      make cross-compile
      for b in builds/webtmux-*; do
        grep -qa 'cdn.tailwindcss.com\|cdn.jsdelivr.net/npm/lit' "$b" \
          && echo "$b FAIL" || echo "$b clean"
      done
      ```

- [ ] **P0** 1.16 `make test` (JS store tests + `go test ./...` + `go vet ./...`), then
      commit as `feat: vendor browser assets so the UI works offline`. *(15 min)*

- [ ] **P0** 1.17 Merge + cleanup. Tests must pass **before** calling the wrapper. *(10 min)*

      ```bash
      /workspace/scripts/git-merge-worktree.sh /workspace/webtmux-portable-vendor \
          --target local-main --no-ff --remove
      ```

- [ ] **P0** 1.18 Deploy and confirm: `bash /workspace/scripts/webtmux-docker/launch.sh
      --rebuild && bash /workspace/scripts/webtmux-docker/verify.sh`. A branch alone does
      not deploy — the container builds from `local-main`. *(15 min)*

---

## The one thing needing a human (20 seconds)

There is no headless browser in this container, so the CSS cascade cannot be *executed*
here. After 1.18, in a real browser:

- [ ] **P0** 1.19 Manual check. *(5 min)*
      1. Desktop window **wider than 1024px** → **no bar at the bottom of the screen**.
         If it is there, the media query didn't take and it is covering the terminal's
         last rows.
      2. Drag the window **narrower than 1024px** → the bar **reappears**.
      3. Confirm the terminal's bottom row is **not clipped** (that's `box-sizing` doing
         its job) and the backdrop is the same near-black as before.
      4. Open an Exposé tile and a PiP — both must be **styled**, not raw text (that's
         step 1.9's shadow-root links).

---

## Risks

1. **`box-sizing` regression (highest).** Covered by task 1.8 rule 1. If skipped, the
   bottom row of every terminal clips and it looks like an unrelated layout bug.
2. **Mobile bar covering desktop sessions** if rule 4 is missed.
3. **One bad importmap entry blanks the page** — guarded by task 1.13.
4. **`check-js` does not glob `vendor/`**, so a corrupt vendored file ships silently.
   Mitigated by the guard in 1.5 and the size assertion in 1.12.
5. **Do not wire `vendor:` into `build:`** — that would make the offline build require
   internet.

## Next steps

After merge and the manual check, proceed to `plan-webtmux-portable-release.md`.
