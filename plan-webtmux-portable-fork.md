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

**Honest scoping note:** only **Stage 2 onward** has a hard technical dependency here.
Stage 1 (`plan-webtmux-portable-vendor.md`) touches asset loading and the build only — it
never references a remote. If you want to start Stage 1 while doing this migration, that
is safe; it merges to `local-main` either way. The gate is written at Stage 2 for that
reason.

---

## Recommendation: a standalone repo, NOT the GitHub "Fork" button

Given "I never plan on merging back into the codebase I forked from", **do not use
GitHub's Fork button.** Create a fresh empty repo and push your history into it.

| | Fork button | Standalone repo |
|---|---|---|
| Can be made **private** | **No** — forks of public repos cannot be made private | Yes |
| New PRs default to | **`chrismccord/webtmux`** — one mis-click opens a PR against upstream | Your own repo |
| Fork network | Shares object storage with upstream; your repo is listed under theirs | Independent |
| Pull upstream changes later | Built in | `git remote add upstream …` — equally easy |
| "forked from" attribution badge | Yes | Lost (replace with a README line) |

The only thing the Fork button gives you that matters is the attribution badge, and a
sentence in the README covers that better anyway. The accidental-PR-to-upstream footgun
and the inability to go private are both real and permanent.

**Git history is preserved either way.** Pushing to a standalone repo keeps every upstream
commit with its original author and dates — you are not erasing lineage, just not using
GitHub's fork *relationship*.

---

## Worktree

**None.** This stage changes remotes and pushes history; it makes no commits to tracked
files except the two README/LICENSE touch-ups in step 0.7, which land directly on
`local-main`. Creating a worktree for a remote reconfiguration would be pure ceremony.

---

## Steps (you run these)

- [ ] **P0** 0.1 **Create an empty repo on GitHub.** Name it `webtmux`. **Do not**
      initialize with a README, `.gitignore`, or license — any initial commit creates an
      unrelated history and your first push will be rejected. *(5 min)*

      Public or private is your call; private only means the Release-asset install needs
      an authenticated `gh` instead of a bare curl (see 0.6).

- [ ] **P0** 0.2 **Push your history.** From `/workspace/webtmux`: *(10 min)*

      ```bash
      cd /workspace/webtmux
      git remote add github git@github.com:<you>/webtmux.git
      git push github local-main
      git push github main          # the upstream-tracking branch, for reference
      git push github --tags        # no-op today; tags arrive in Stage 2
      ```

      Push `local-main` **first** so GitHub picks it as the default branch. If it guesses
      wrong, fix it under Settings → General → Default branch.

- [ ] **P0** 0.3 **Keep `local-main` as the branch name.** Renaming it to `main` would be
      tidier, but seven live worktrees (`/workspace/webtmux-*`) and the deploy path all
      reference it, and the container builds from `local-main`. Not worth the disruption.
      Set the GitHub *default branch* to `local-main` and move on. *(2 min)*

      The existing `main` branch tracks `upstream/main` at `6852248` and is far behind.
      Keep it as a reference point for future upstream cherry-picks, or delete it — it is
      not used by anything.

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

- [ ] **P0** 0.6 **Decide public vs private.** *(Revised 2026-07-26: distribution is now
      GitHub Releases, so this decision only determines whether the install curl needs
      auth — binaries are no longer committed to git at all.)* *(5 min)*

      - **Public** → `curl -fsSL https://github.com/<you>/webtmux/releases/download/v0.1.0/webtmux-linux-amd64`
      - **Private** → `gh release download v0.1.0 -R <you>/webtmux -p webtmux-linux-amd64`
        (requires an authenticated `gh` on the target)

      Either way, Stage 2's publish step needs an authenticated `gh` CLI on your side —
      **all pushes and release publishing are yours to run**; the agent has no GitHub
      access. Tell Claude the answer so Stage 2's README leads with the right form.

- [ ] **P1** 0.7 **Attribution and licence hygiene.** *(15 min)*
      - Confirm `LICENSE` is intact and unmodified. This lineage is gotty (yudai) → webtmux
        (chrismccord) → yours; the licence and its copyright lines must be preserved
        regardless of how far the fork diverges.
      - Add one line near the top of `README.md`: *"A fork of
        [chrismccord/webtmux](https://github.com/chrismccord/webtmux), itself derived from
        [yudai/gotty](https://github.com/yudai/gotty). Substantially diverged; not intended
        to be merged back."* This replaces the "forked from" badge you gave up in 0.1 and
        sets expectations for anyone who finds the repo.
      - Commit both directly to `local-main` and push.

- [ ] **P0** 0.8 **Verify the gate passes.** *(5 min)*

      ```bash
      cd /workspace/webtmux
      git remote get-url origin | grep -q 'github.com' && echo "origin OK"
      git remote get-url --push upstream | grep -q '^DISABLED$' && echo "upstream neutered OK"
      git ls-remote origin local-main | grep -q . && echo "reachable OK"
      ```

---

## Gate check for downstream stages

Stage 2 (`plan-webtmux-portable-release.md`) must not begin until this passes:

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

1. **Initializing the GitHub repo with a README** → `! [rejected] … fetch first` on your
   first push, and the usual "fix" people reach for is `--force`, which is fine here but
   confusing. Just create it empty (0.1).
2. **Pushing `main` before `local-main`** → GitHub sets `main` as default, and anyone
   cloning gets the *upstream* code with none of your work. Push `local-main` first (0.2).
3. **Renaming `local-main` to `main`** would break seven worktrees and the deploy path.
   Explicitly declined in 0.3.
4. **Repo size:** history carries ~48 MB of packed binary blobs from the committed-`builds/`
   era, so clones start heavy; Stage 2 untracks `builds/` so it stops growing. No history
   rewrite — it would break the seven live worktrees.
5. **Dropbox-hosted bare repo** (if kept) can corrupt under concurrent `.git` writes if two
   machines push while Dropbox is mid-sync. Another reason to consider retiring it (0.5).

## Next steps

Once 0.8 passes, tell Claude the answer to 0.6 (public vs private) and whether the Mac
bare repo was kept. Then **Stage 3 (`plan-webtmux-portable-launcher.md`)** — the
deliverable — per the revised execution order 0 → 3 → 1 → 2.
