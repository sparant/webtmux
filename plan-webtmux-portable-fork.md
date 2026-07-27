# Plan: webtmux portable — Stage 0, migrate to your own GitHub fork

`plan-webtmux-portable-fork.md` — subplan of `plan-webtmux-portable.md`, created
2026-07-25.

**This stage is executed by the user, not by Claude** — it needs GitHub credentials Claude
does not have. Stages 1-3 are gated on it.

## Goal

Stop pointing at `chrismccord/webtmux`. Host the fork under your own GitHub account, make
it the canonical origin for all fork work, and make it structurally impossible to
accidentally push or PR back upstream.

## Why this gates the rest

`README.md:10`, `:48`, and `:61` currently tell users to clone
`github.com/chrismccord/webtmux` — **upstream**, which contains none of this fork's work.
Stage 2 rewrites those instructions, and it cannot write the right URL until the fork
exists. Stage 2 also pushes tags and release binaries, which need a canonical home.

**It is also what the launcher downloads from.** Stage 3 resolves the target machine's
platform over SSH and fetches the matching binary from this repo's Releases — so the fork
is not just a home for the code, it is the distribution host.

**Scoping:** Stages 2 and 3 both hard-depend on this. Stage D (deps) and Stage 1 (vendor)
touch only local code and could run before or during the migration.

---

## Approach: use the GitHub "Fork" button

*(Revised 2026-07-26 — reverses an earlier recommendation to create a standalone repo.
Recorded here because the reasoning changed, not just the conclusion.)*

Fork `chrismccord/webtmux` normally. The earlier objections were real but no longer bind:

| Earlier objection | Why it no longer applies |
|---|---|
| Forks of public repos **cannot be made private** | The fork must be **public** anyway — that is what makes Release assets downloadable without a token, which is exactly what the launcher needs. |
| Fork network lists your repo under upstream's | Not a problem; the lineage is real and worth showing. |
| Lost "forked from" attribution badge | Now a *reason to fork* — the badge is the attribution, so the README needs no substitute sentence. |
| **New PRs default to `chrismccord/webtmux`** | **Still true.** This is the one live caveat: when opening a PR from the GitHub UI, check the base repo. Mitigated below by disabling pushes to `upstream` entirely. |

**Git history is identical either way** — a fork is a server-side clone. What differs is
only GitHub's fork *relationship*, which is now wanted rather than avoided.

**One fork-specific gotcha, handled in 0.3:** a fork copies upstream's git **tags**.
Inherited tags would poison `git describe --tags`, which is where `VERSION` comes from — a
stray upstream `v1.x` would make our `v0.1.0` describe strangely. GitHub *Release objects*
are **not** inherited, so `releases/latest` on the fork resolves to our own first release.

---

## Worktree

**None.** This stage changes remotes and pushes history; the only tracked-file touch is
the optional README note in step 0.7, which lands directly on `local-main`. Creating a
worktree for a remote reconfiguration would be pure ceremony.

---

## Steps (you run these)

- [ ] **P0** 0.1 **Fork `chrismccord/webtmux`** on GitHub — the Fork button. Keep the name
      `webtmux`. Leave "Copy the default branch only" **unchecked** if offered; extra
      branches are harmless and you may want upstream's history intact. *(3 min)*

      **It must be public** — that is what lets the launcher download Release assets
      without a token (see 0.6).

- [ ] **P0** 0.2 **Push `local-main` and make it the default.** *(10 min)*

      ```bash
      cd /workspace/webtmux
      git remote add github git@github.com:<you>/webtmux.git
      git push github local-main
      ```

      Then GitHub → Settings → General → **Default branch** → `local-main`. A fresh fork
      defaults to upstream's `main`, so this must be set explicitly — otherwise anyone
      cloning gets upstream's code with none of the fork's work.

      Keep the branch **name** `local-main`. Renaming to `main` would be tidier, but the
      live worktrees (`/workspace/webtmux-*`) and the deploy path all reference it, and
      the container builds from it. Not worth the disruption.

      The local `main` branch tracks `upstream/main` at `6852248` and is far behind; the
      fork already has upstream's `main` server-side, so there is nothing to push.

- [ ] **P0** 0.3 **Delete inherited tags — fork-specific, easy to miss.** A fork copies
      upstream's git tags, and `VERSION` comes from `git describe --tags`. A stray
      upstream tag would make `v0.1.0` describe oddly and could confuse a human reading
      `webtmux --version`. *(10 min)*

      ```bash
      git ls-remote --tags github            # what the fork inherited
      git tag                                # what the local clone has (was empty)
      # For each unwanted tag:
      git push github :refs/tags/<tag>       # delete server-side
      git tag -d <tag>                       # delete locally, if present
      ```

      GitHub **Release objects are not inherited**, so `releases/latest` on the fork will
      resolve to your own first release regardless. Only the tags need cleaning.

- [ ] **P0** 0.4 **Repoint `origin` and neuter `upstream`.** *(10 min)*

      ```bash
      # Your GitHub repo becomes origin
      git remote rename origin mac-bare          # the Dropbox SSH bare repo — see 0.5
      git remote rename github origin
      git branch --set-upstream-to=origin/local-main local-main

      # Make pushing to chrismccord's repo structurally impossible
      git remote set-url --push upstream DISABLED
      ```

      That last line is the important one: `upstream` stays fetchable for cherry-picking,
      but any `git push upstream` fails immediately instead of prompting for credentials
      you might absent-mindedly supply.

- [ ] **P1** 0.5 **Decide the fate of the Mac bare repo**
      (`ssh://nathanteeuwen@192.168.68.67/…/Dropbox/…/webtmux.git`). Two sane options:
      *(10 min)*
      - **Keep as an offline mirror** — useful when GitHub is unreachable or you're on the
        LAN. Push to it explicitly after releases: `git push mac-bare local-main --tags`.
      - **Retire it** — `git remote remove mac-bare`. One less thing to keep in sync, and
        Dropbox syncing a git repo has its own hazards (concurrent `.git` writes).

      Whichever you choose, tell Claude — it changes what Stage 2's README documents.

- [ ] **P0** 0.6 **Confirm the fork is public.** *(Revised 2026-07-26: with the launcher
      fetching Release assets, this is no longer a free choice.)* *(5 min)*

      A **public** fork lets the launcher download with a plain unauthenticated HTTPS GET
      and no GitHub API call:

      ```
      https://github.com/<you>/webtmux/releases/download/v0.1.0/webtmux-linux-amd64
      https://github.com/<you>/webtmux/releases/latest/download/webtmux-linux-amd64
      ```

      A **private** fork would force every launcher to carry a GitHub token — a
      credential-distribution problem that defeats the "one command, no setup" goal.
      Forks of a public repo are public anyway, so this is the default; just confirm it.

      Publishing still needs an authenticated `gh` **on your side** — all pushes and
      `gh release create` runs are yours; the agent has no GitHub access.

- [ ] **P1** 0.7 **Licence hygiene.** Confirm `LICENSE` is intact and unmodified. The
      lineage is gotty (yudai) → webtmux (chrismccord) → yours; the licence and its
      copyright lines must be preserved however far the fork diverges. *(5 min)*

      **No README attribution line is needed** — GitHub's "forked from chrismccord/webtmux"
      badge supplies it. *(An earlier revision added one to compensate for the standalone
      repo losing the badge; forking makes it redundant.)* A line noting that the fork has
      substantially diverged and is not intended to be merged back is still worth adding
      for anyone who finds it.

- [ ] **P0** 0.8 **Verify the gate passes.** *(5 min)*

      ```bash
      cd /workspace/webtmux
      git remote get-url origin | grep -q 'github.com' && echo "origin OK"
      git remote get-url --push upstream | grep -q '^DISABLED$' && echo "upstream neutered OK"
      git ls-remote origin local-main | grep -q . && echo "reachable OK"
      test -z "$(git ls-remote --tags origin)" && echo "no inherited tags OK"
      ```

---

## Gate check for downstream stages

Stages 2 and 3 must not begin until this passes:

```bash
git -C /workspace/webtmux remote get-url origin | grep -q 'github.com' \
  || { echo "GATE: Stage 0 not done — origin still points at $(git -C /workspace/webtmux remote get-url origin)"; exit 1; }
```

---

## Pulling upstream changes later (optional, for reference)

You said you never intend to merge back — but pulling *forward* occasionally is still
useful if chrismccord fixes something. `upstream` remains fetchable after 0.4:

```bash
git fetch upstream
git log --oneline local-main..upstream/main     # what's new upstream
git cherry-pick <sha>                            # take just what you want
```

Prefer cherry-picking over merging. `local-main` has diverged far enough (split-view,
capture/Exposé, state persistence, stoplights, save-path handling) that a merge would
produce conflicts across most of the frontend for very little gain.

---

## Risks

1. **Forgetting to change the default branch** → a fresh fork defaults to upstream's
   `main`, so anyone cloning (and every `releases/latest` reader looking for source) gets
   upstream's code with none of your work. Fixed in 0.2 and worth double-checking.
2. **Inherited tags poisoning `git describe --tags`** → `VERSION` is derived from it, so a
   stray upstream tag shows up in `webtmux --version`. Cleaned in 0.3; verified in 0.8.
3. **Accidental PR against `chrismccord/webtmux`** → the one real cost of forking. The
   GitHub PR UI defaults the base repo to upstream. `--push upstream DISABLED` (0.4) stops
   command-line pushes but *cannot* stop a web-UI PR; check the base repo dropdown.
4. **Renaming `local-main` to `main`** would break the live worktrees and the deploy path.
   Explicitly declined in 0.2.
5. **Repo size:** history carries ~48 MB of packed binary blobs from the committed-`builds/`
   era, so clones start heavy. `builds/` is already untracked (the build/run split), so it
   no longer grows. No history rewrite — it would break the live worktrees.
6. **A private fork would break the launcher** — every launcher would need a GitHub token.
   Confirmed public in 0.6.
7. **Dropbox-hosted bare repo** (if kept) can corrupt under concurrent `.git` writes if two
   machines push while Dropbox is mid-sync. Another reason to consider retiring it (0.5).

## Next steps

Once 0.8 passes, tell Claude whether the Mac bare repo was kept, then run **Stage 2
(`plan-webtmux-portable-release.md`)** to publish `v0.1.0` — which is what the launcher
will fetch. Execution order is D → 0 → 2 → 3 → 1.
