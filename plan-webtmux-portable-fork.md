# Plan: webtmux portable — Stage 0, migrate to your own GitHub fork

`plan-webtmux-portable-fork.md` — subplan of `plan-webtmux-portable.md`, created
2026-07-25.

**This stage is executed by the user, not by Claude** — it needs GitHub credentials Claude
does not have. Stage 2 is gated on it. *(Revised 2026-07-27: **Stage 3 is not.** The
launcher can source binaries from a local build directory, so it is buildable and testable
before this stage runs; only its fetch-path tests and asset publishing wait.)*

## Goal

Stop pointing at `chrismccord/webtmux`. Host the fork under your own GitHub account, and
make it structurally impossible to accidentally push or PR back upstream.

*(Revised 2026-07-27: **topology changed from hub-and-spoke to a chain.** An earlier
revision made the GitHub fork `origin` of the working repo, pushing to it directly and
demoting the Mac bare to an optional mirror. That is reversed. The Mac bare is now the
hub, and GitHub is a publishing mirror downstream of it. **The steps were renumbered** —
old 0.2/0.4/0.5 and the old gate in 0.8 were rewritten or removed, and three new steps
(0.2 backup, 0.3 Mac credentials, 0.7 hook) were added; the stage now runs 0.1–0.10. The
reasoning is in "Topology" below, recorded because the shape changed, not just the
commands.)*

---

## Topology: the chain

```
  /workspace/webtmux  ──[leg 1: sync-all-repos.sh]──>  Mac bare  ──[leg 2: this plan]──>  GitHub fork
   (working repo)          automatic, host loop         (hub)          manual or hook       (publication)
```

**Every push travels one direction along that line.** The working repo never talks to
GitHub, and GitHub is never a source — only a destination.

**Why the Mac is the hub, not GitHub.** Leg 1 already exists and runs unattended on the
host; it is the backup that protects you if the container dies. Making GitHub `origin` of
the working repo (the earlier design) would have pointed the *automatic* leg at the
*public* destination and left the backup as the manual one — exactly backwards for the
thing you most want to be reliable. In the chain, the automatic leg feeds the private
backup and the manual leg feeds publication, so forgetting to do the manual step costs you
publicity, not safety.

**What each leg carries:**

| Leg | Tool | Scope | Trigger |
|---|---|---|---|
| 1. container → Mac | `sync-all-repos.sh` | **current branch only**, no tags — see Risk 8 | automatic, continuous loop on the host |
| 2. Mac → GitHub | `git push` from the bare, or a `post-receive` hook | `local-main` only, by choice — see 0.4 | manual (or automatic if you install the hook in 0.7) |

**The two legs deliberately carry different scope.** The Mac is a *full backup* — every
branch the working repo has. GitHub is a *publication* — `local-main` only. Today those
happen to coincide (the repo carries just `local-main` and `main` since the 2026-07-27
branch cleanup), but the distinction is the standing rule: if WIP branches reappear, they
belong on the Mac and **not** on a public fork.

### How the current state arose

The Mac bare was **not** made by `make-bare-repo.sh`. On 2026-07-22 at 18:59:15Z,
`move-unbacked-repos.sh` classified this repo `web-local-work` (a GitHub clone with a
local-only branch — `local-main`, then still at `6852248`) and ran
`handle_web_local_work()`, which:

1. backed the repo up to `backup/webtmux.20260722T185915Z`,
2. created the Mac bare with `git init --bare`,
3. **`git push --mirror`** to it,
4. renamed the clone's `origin` (chrismccord) → `upstream`,
5. added a new `origin` pointing at the Mac.

Two consequences matter downstream:

- **The bare carries junk `refs/remotes/*`** from step 3 — `--mirror` pushes everything
  under `refs/`, including the old GitHub tracking refs. **Never `git push --mirror` from
  the bare to GitHub**, or that junk gets published. Explicit refspecs only. Checked in 0.10.
- **`upstream` in your working repo is the clone's original `origin`**, which is why
  `branch.main.remote` says `upstream`. Nothing to fix; just don't be surprised by it.

## Why this gates the rest

`README.md:10`, `:48`, and `:61` currently tell users to clone
`github.com/chrismccord/webtmux` — **upstream**, which contains none of this fork's work.
Stage 2 rewrites those instructions, and it cannot write the right URL until the fork
exists. Stage 2 also pushes tags and release binaries, which need a canonical home.

**It is also what the launcher downloads from.** Stage 3 resolves the target machine's
platform over SSH and fetches the matching binary from this repo's Releases — so the fork
is not just a home for the code, it is the distribution host.

**Scoping:** Stage 2 hard-depends on this. Stage D (deps), Stage 1 (vendor), and — since
2026-07-27 — Stage 3 (launcher, via its local build-directory source) touch only local
code and can run before or during the migration.

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

**One fork-specific gotcha, handled in 0.5:** a fork copies upstream's git **tags**.
Inherited tags would poison `git describe --tags`, which is where `VERSION` comes from — a
stray upstream `v1.x` would make our `v0.1.0` describe strangely. GitHub *Release objects*
are **not** inherited, so `releases/latest` on the fork resolves to our own first release.

---

## Worktree

**None for execution.** This stage changes remotes and pushes history; the only
tracked-file touch is the optional README note in step 0.9, which lands directly on
`local-main`. Creating a worktree for a remote reconfiguration would be pure ceremony.

*(Edits to **this plan document** are a different matter — `local-main` is churned by
concurrent agents, so doc revisions go through a worktree and
`scripts/git-merge-worktree.sh`. The 2026-07-27 chain revision did.)*

---

## Steps (you run these)

- [x] **P0** 0.1 **Fork `chrismccord/webtmux`** on GitHub — the Fork button. Keep the name
      `webtmux`. Leave "Copy the default branch only" **unchecked** if offered; extra
      branches are harmless and you may want upstream's history intact. *(3 min)*

      **It must be public** — that is what lets the launcher download Release assets
      without a token (see 0.8).

      *Confirmed 2026-07-29: `sparant/webtmux` exists, `"fork": true`, parent
      `chrismccord/webtmux`, default branch `local-main`.*

- [x] **P0** 0.2 **~~Complete the Mac backup before restructuring anything.~~
      DISCHARGED 2026-07-28 — nothing to do.** *(0 min)*

      *Kept as a numbered step rather than deleted, so the surrounding cross-references stay
      valid and the reasoning is not silently lost.*

      **What this step was for:** the chain makes the Mac the hub, and at the time of
      writing the hub was incomplete — `local-main` and `main` were on it, but 11 other
      branches existed nowhere except this container. Their *commits* were safe (each tip
      was an ancestor of `local-main`, which was on the Mac); the *labels* were not.

      **Why it no longer applies:** on 2026-07-27 those 11 branches were deleted locally as
      part of a merged-branch cleanup. Every tip was verified reachable from `local-main`
      first, so no content was lost — the labels were the only casualty, and they were
      exactly what this step existed to preserve. With the branches gone, the hub holds
      everything the working repo holds, and the gap this step closed no longer exists.

      **The general lesson survives in Risk 8:** leg 1 pushes only the current branch, so
      *any* future branch will drift unbacked the same way. That is a standing property of
      `sync-all-repos.sh`, not a one-off, and it is the reason to keep long-lived work on
      `local-main` rather than on side branches.

      *(`claude_run_me_4471.sh` was written for this step. It is now redundant with leg 1
      rather than harmful — it would simply push `local-main` and `main`, which sync already
      does.)*

- [ ] **P0** 0.3 **Give the *Mac* GitHub credentials.** *(15 min)*

      **Why this is its own step:** leg 2 originates on the Mac, so the *Mac* must
      authenticate to GitHub. Your host's key and your container's key are both irrelevant
      here — this is the single most likely thing to block the whole stage, and it is
      invisible until you try to push.

      On the Mac:

      ```bash
      ssh -T git@github.com          # want: "Hi <you>! You've successfully authenticated"
      ```

      If that fails:

      ```bash
      ssh-keygen -t ed25519 -C 'mac-webtmux'
      cat ~/.ssh/id_ed25519.pub      # add at github.com/settings/keys
      ```

      Prefer a **passphrase-free** key, or one loaded into the Mac's keychain-backed agent.
      A passphrase-prompting key works interactively but will silently break the optional
      hook in 0.7, which runs with no terminal.

- [ ] **P0** 0.4 **Add the `github` remote *on the Mac bare* and push.** *(10 min)*

      This is leg 2. Note the working directory: the bare repo on the Mac, **not**
      `/workspace/webtmux`.

      ```bash
      cd /Users/nathanteeuwen/Dropbox/nathant/Repositories/webtmux.git
      git remote add github git@github.com:<you>/webtmux.git
      git push github refs/heads/local-main:refs/heads/local-main
      ```

      Or drive it from the host, which preflights auth, fork reachability and the junk-ref
      check before touching anything:

      ```bash
      # edit GITHUB_URL at the top first
      bash ~/Projects/claude_run_me_4471_github.sh            # dry run
      bash ~/Projects/claude_run_me_4471_github.sh --apply
      ```

      **Explicit refspec, never `--mirror`** — see "How the current state arose". A bare
      repo pushes exactly like a non-bare one; there is nothing special to configure.

      **The remote name is safe here.** `github` sorts before `origin`, and both sync
      scripts select a remote with `git remote | head -1` — but they only ever scan repos
      under the host workspace root. The Mac bare is never scanned. (This is *not* true of
      the working repo — see 0.6.)

      Then GitHub → Settings → General → **Default branch** → `local-main`. A fresh fork
      defaults to upstream's `main`, so this must be set explicitly — otherwise anyone
      cloning gets upstream's code with none of the fork's work.

      Keep the branch **name** `local-main`. Renaming to `main` would be tidier, but the
      deploy path and the container build both reference it, and
      the container builds from it. Not worth the disruption. (`local-main` *is* a
      fast-forward of `main`, so `local-main:main` would be a clean push if you ever change
      your mind — but do not, for the reasons above.)

- [x] **P0** 0.5 **Delete inherited tags — fork-specific, easy to miss.** A fork copies
      upstream's git tags, and `VERSION` comes from `git describe --tags`. A stray
      upstream tag would make `v0.1.0` describe oddly and could confuse a human reading
      `webtmux --version`. *(10 min)*

      From the Mac bare (where the `github` remote now lives):

      ```bash
      git ls-remote --tags github            # what the fork inherited
      git tag                                # the local clone had none
      # For each unwanted tag:
      git push github :refs/tags/<tag>       # delete server-side
      ```

      GitHub **Release objects are not inherited**, so `releases/latest` on the fork will
      resolve to your own first release regardless. Only the tags need cleaning.

      *Confirmed 2026-07-29: the fork's tag list is empty (`/repos/sparant/webtmux/tags`
      → `[]`), and the working repo has no local tags either.*

- [x] **P0** 0.6 **Leave the working repo's `origin` pointing at the Mac — and do *not*
      add a GitHub remote to it.** *(5 min)*

      ```bash
      cd /workspace/webtmux
      # Make pushing to chrismccord's repo structurally impossible
      git remote set-url --push upstream DISABLED
      ```

      That is the *only* remote change the working repo needs. Final state:

      ```
      origin    → ssh://…192.168.68.67//…/webtmux.git    (the Mac — leg 1's target)
      upstream  → https://github.com/chrismccord/webtmux  (fetch-only, push DISABLED)
      ```

      **Why no GitHub remote here — this is the trap.** Both `sync-all-repos.sh:134` and
      `move-unbacked-repos.sh:125` choose their remote with `git remote | head -1`, which
      is **alphabetical**. Adding a remote named `github` makes it sort ahead of `origin`,
      and the host's sync loop silently switches to pushing your work to **GitHub instead
      of the Mac** — the backup stops, with no error. Verified empirically:

      | Remotes present | `git remote \| head -1` | Sync pushes to |
      |---|---|---|
      | `origin`, `upstream` (this plan) | `origin` | ✅ Mac |
      | `github`, `origin`, `upstream` | `github` | ⚠️ GitHub — **backup stops** |

      In the chain this problem simply does not arise, because the working repo has no
      reason to know GitHub exists. That is a feature of the topology, not a coincidence.

      `upstream` stays fetchable for cherry-picking, but any `git push upstream` now fails
      immediately instead of prompting for credentials you might absent-mindedly supply.

      *Confirmed 2026-07-29: `git remote -v` shows exactly `origin` → the Mac bare and
      `upstream` → chrismccord with push URL `DISABLED`. No `github` remote here, so the
      alphabetical-`head -1` trap above is not armed.*

- [ ] **P1** 0.7 **Optionally automate leg 2 with a `post-receive` hook.** *(15 min)*

      Legs 1 and 2 are otherwise auto-then-manual. This closes the gap: when sync pushes to
      the Mac, the Mac pushes onward to GitHub.

      ```sh
      # /Users/nathanteeuwen/Dropbox/nathant/Repositories/webtmux.git/hooks/post-receive
      #!/bin/sh
      git push --quiet github refs/heads/local-main:refs/heads/local-main || true
      ```

      ```bash
      chmod +x hooks/post-receive
      ```

      **`|| true` is deliberate** — a GitHub failure must never reject the incoming push
      from the container. Leg 1 is the backup and must not be held hostage to leg 2.

      Two ways this fails silently, both worth a periodic check:
      - **Non-interactive auth.** The hook has no terminal and no agent forwarding. A
        passphrase-protected key just fails (see 0.3).
      - **Dropbox renaming the hook.** The bare lives in Dropbox, which renames files it
        believes are conflicted — `post-receive (conflicted copy)` is not executable by
        git, so the hook stops running with no error anywhere. Re-check the filename and
        the `+x` bit if the fork stops updating.

      Defer this until the manual push in 0.4 is confirmed working.

- [x] **P0** 0.8 **Confirm the fork is public.** *(Revised 2026-07-26: with the launcher
      fetching Release assets, this is no longer a free choice.)* *(5 min)*

      A **public** fork lets the launcher download with a plain unauthenticated HTTPS GET
      and no GitHub API call:

      ```
      https://github.com/<you>/webtmux/releases/download/v0.1.0/webtmux-linux-amd64
      https://github.com/<you>/webtmux/releases/latest/download/webtmux-linux-amd64
      ```

      A **private** fork would force every launcher to carry a GitHub token — a
      credential-distribution problem that defeats the "one command, no setup" goal.

      **Confirmed 2026-07-29.** `GET /repos/sparant/webtmux` returns `"private": false`,
      `"visibility": "public"`, and an **unauthenticated** `GET https://github.com/sparant/webtmux`
      returns 200 — which is the property that actually matters, tested the way the launcher
      tests it rather than read off a settings page. The launcher can therefore be built
      with `REPO_OWNER=sparant` and will fetch with no token. Note there are still **0
      releases**, so nothing is downloadable yet; that is Stage 2's job, and it is why the
      launcher's fetch-path tests remain deferred.
      Forks of a public repo are public anyway, so this is the default; just confirm it.

      Publishing still needs an authenticated `gh` **on your side** — all pushes and
      `gh release create` runs are yours; the agent has no GitHub access.

- [x] **P1** 0.9 **Licence hygiene.** Confirm `LICENSE` is intact and unmodified. The
      lineage is gotty (yudai) → webtmux (chrismccord) → yours; the licence and its
      copyright lines must be preserved however far the fork diverges. *(5 min)*

      **No README attribution line is needed** — GitHub's "forked from chrismccord/webtmux"
      badge supplies it. *(An earlier revision added one to compensate for the standalone
      repo losing the badge; forking makes it redundant.)* A line noting that the fork has
      substantially diverged and is not intended to be merged back is still worth adding
      for anyone who finds it.

      *Confirmed 2026-07-29: `LICENSE` is byte-identical to
      `chrismccord/webtmux@master` (21 lines, MIT, copyright lines intact). The optional
      "has diverged, not intended to be merged back" README line is **not** written —
      it is a nicety, not a licence obligation.*

- [ ] **P0** 0.10 **Verify the chain end to end.** *(10 min)*

      **Leg 1 verified 2026-07-29** (all four checks below pass): `origin` is the Mac,
      `git remote | head -1` is `origin`, there is no `github` remote, and `upstream`'s
      push URL is `DISABLED`.

      **Leg 2's *outcomes* verified from GitHub instead of the Mac** — the agent has no
      SSH key for the Mac, so the `ssh` block below is still yours to run. What GitHub
      shows: the fork is reachable unauthenticated, publishes exactly
      `refs/heads/local-main` and `refs/heads/main` (**no `refs/remotes/*` junk** — the
      `--mirror` hazard did not materialise), and carries **no tags**.

      **One live finding:** the fork's `local-main` is at `0d29e7d`, four commits behind
      this repo's `6b3a6cc`. The cause is not leg 2 — it is leg 1: the working repo has
      untracked files, and `sync-all-repos.sh` **skips dirty repos entirely**, so the
      automatic push stopped. Commit or remove the stray files and the chain resumes.
      Worth knowing generally: *a dirty working repo silently disables the backup*, and
      the only symptom is a stale Mac and a stale fork.

      Each check names the leg it protects.

      ```bash
      # Leg 1 — the working repo still points at the Mac, and ONLY at the Mac.
      cd /workspace/webtmux
      git remote get-url origin | grep -q '192\.168\.68\.67' && echo "origin=Mac OK"
      [ "$(git remote | head -1)" = origin ] && echo "sync picks origin OK"
      git remote | grep -qi 'github' && echo "WARNING: a github remote exists — see 0.6" \
                                     || echo "no github remote OK"
      git remote get-url --push upstream | grep -q '^DISABLED$' && echo "upstream neutered OK"

      # Leg 2 — the Mac reaches the fork, and the fork is current and clean.
      MACBARE=/Users/nathanteeuwen/Dropbox/nathant/Repositories/webtmux.git
      ssh nathanteeuwen@192.168.68.67 "
        git -C $MACBARE ls-remote github local-main | grep -q . && echo 'fork reachable OK'
        test -z \"\$(git -C $MACBARE ls-remote --tags github)\" && echo 'no inherited tags OK'
        test \"\$(git -C $MACBARE rev-parse refs/heads/local-main)\" \
           = \"\$(git -C $MACBARE ls-remote github local-main | cut -f1)\" \
           && echo 'fork up to date OK'
      "
      ```

      The `no github remote OK` line is the one that catches the 0.6 trap. It is a
      *warning*, not a failure, because a deliberate future change might add one — but if
      you did not add it on purpose, your backup has stopped.

---

## Gate check for downstream stages

Stages 2 and 3 must not begin until this passes. **Note this is the inverse of the
pre-2026-07-27 gate**, which required `origin` to be GitHub; under the chain, `origin`
being GitHub means the topology is broken.

```bash
git -C /workspace/webtmux remote get-url origin | grep -q '192\.168\.68\.67' \
  || { echo "GATE: chain broken — working-repo origin should be the Mac, is $(git -C /workspace/webtmux remote get-url origin)"; exit 1; }

ssh nathanteeuwen@192.168.68.67 \
  "git -C /Users/nathanteeuwen/Dropbox/nathant/Repositories/webtmux.git ls-remote github local-main" \
  | grep -q . \
  || { echo "GATE: Stage 0 not done — Mac bare cannot reach the GitHub fork"; exit 1; }
```

Two assertions because the chain has two legs, and either can be broken independently.

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
   upstream's code with none of your work. Fixed in 0.4 and worth double-checking.
2. **Inherited tags poisoning `git describe --tags`** → `VERSION` is derived from it, so a
   stray upstream tag shows up in `webtmux --version`. Cleaned in 0.5; verified in 0.10.
3. **Accidental PR against `chrismccord/webtmux`** → the one real cost of forking. The
   GitHub PR UI defaults the base repo to upstream. `--push upstream DISABLED` (0.6) stops
   command-line pushes but *cannot* stop a web-UI PR; check the base repo dropdown.
4. **Renaming `local-main` to `main`** would break the deploy path and the container
   build, both of which reference the branch by name. Explicitly declined in 0.4.
   *(Before 2026-07-27 this also would have orphaned 8 linked worktrees; those are gone,
   so the remaining objection is the deploy path alone — weaker, but still sufficient.)*
5. **Repo size:** history carries ~48 MB of packed binary blobs from the committed-`builds/`
   era, so clones start heavy. `builds/` is already untracked (the build/run split), so it
   no longer grows. No history rewrite — it would invalidate every clone and force the
   Mac bare to be rebuilt, for a one-off saving.
6. **A private fork would break the launcher** — every launcher would need a GitHub token.
   Confirmed public in 0.8.
7. **Dropbox-hosted bare repo is now load-bearing.** Under the chain the Mac bare is the
   hub, not an optional mirror, so its hazards are no longer avoidable by retiring it.
   Concurrent `.git` writes while Dropbox is mid-sync can corrupt it, and Dropbox's
   conflicted-copy renaming can silently disable the 0.7 hook. *(Under the old
   hub-and-spoke design this risk had an escape hatch — "retire the bare". The chain
   removes that option, so the risk is upgraded, not merely inherited.)* Mitigation: the
   permanent `backup/webtmux.<ts>/` copies, plus the container itself, mean the bare is
   never the only copy.
8. **Leg 1 pushes the current branch only, and no tags.** `sync-all-repos.sh:199` runs
   `git push --no-verify "$remote" "$branch"` — one branch, no `--tags`, no
   `--follow-tags`. Two consequences:
   - Any branch you are not standing on drifts unbacked. This is how 11 branches came to
     exist only in the container by 2026-07-27 (see the discharged 0.2). They were merged
     and deleted rather than backed up, which resolved that instance — but the mechanism is
     unchanged and will do the same to the next side branch.
   - **Tags never traverse leg 1 automatically** — which Stage 2 depends on, since a
     release needs its tag on GitHub. See "Publishing a release along the chain".
9. **Mac-side GitHub credentials are a single point of failure for leg 2** and are
   invisible until a push is attempted. Checked explicitly in 0.3.
10. **Adding a `github` remote to the working repo silently stops the Mac backup** via the
    alphabetical `git remote | head -1` selection. This is the highest-consequence,
    lowest-visibility failure in the whole plan: no error, no output, the backup just
    stops. Guarded in 0.6 and re-checked in 0.10.

---

## Publishing a release along the chain

Stage 2 tags `v0.1.0` and publishes binaries. Because tags do not traverse leg 1 (Risk 8),
the tag must be walked along the chain by hand:

```bash
# 1. tag in the working repo
cd /workspace/webtmux
git tag -a v0.1.0 -m 'webtmux fork v0.1.0'

# 2. leg 1 — push the tag to the Mac explicitly; sync will NOT do this for you
git push origin v0.1.0

# 3. leg 2 — the Mac forwards it to GitHub
ssh nathanteeuwen@192.168.68.67 \
  "git -C /Users/nathanteeuwen/Dropbox/nathant/Repositories/webtmux.git push github v0.1.0"
```

`gh release create` then runs against the fork from whichever machine has an authenticated
`gh` — release *objects* are a GitHub-side concept and do not travel through the chain at
all. Only the tag does.

Note the 0.7 hook does not cover this either: it forwards `refs/heads/local-main` only.
Widening it to tags is possible but makes an accidental local tag instantly public;
walking releases by hand is the safer default.

## Next steps

Once 0.10 passes, run **Stage 2 (`plan-webtmux-portable-release.md`)** to publish `v0.1.0`
— which is what the launcher will fetch — following "Publishing a release along the chain"
above for the tag. Execution order is D → 0 → 2 → 3 → 1.

*(The old step 0.5, "decide the fate of the Mac bare", is gone: under the chain the bare is
the hub and retiring it is no longer an option. Nothing to report back to Claude.)*
