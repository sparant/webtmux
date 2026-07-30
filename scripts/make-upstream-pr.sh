#!/usr/bin/env bash
# make-upstream-pr.sh — rebuild the `pr/upstream` branch from this fork's head.
#
#   scripts/make-upstream-pr.sh [options]
#
# The branch offered upstream is a DERIVED ARTIFACT, not a second line of
# development. Nothing is ever committed to it by hand and nothing is ever merged
# back out of it: it is `local-main` minus the paths that only make sense here.
# That is the whole reason this is a script — a hand-curated PR branch has to be
# re-curated every time local-main moves, and the second time you skip that, the
# PR silently stops matching the fork it claims to be.
#
# So each run throws the branch away and builds it again from the current base.
# Its history is disposable by construction (one delete commit on top of the
# base), which is also why force-pushing it is not a hazard.
#
# What is stripped, and why each one is not upstream's problem:
#
#   plan-*.md, PR-DESCRIPTION.md  the fork's own execution plans and the text of
#                                 the PR itself — process, not product.
#   scripts/                      fork tooling: this script, and the delegate
#                                 patterns naming one machine's launchers
#                                 (install_stoplight_hooks_bash.sh sources that
#                                 file only if present, so removing it restores
#                                 the empty upstream default — see
#                                 test/stoplight-hooks.sh).
#   js/, bindata/static/js/gotty* the pre-fork webpack bundle. index.html loads
#                                 ./js/webtmux.js as an ES-module graph and never
#                                 references gotty.js; the bundle and the project
#                                 that builds it are 2.5 MB of dead weight, and
#                                 they only go TOGETHER — deleting the artifact
#                                 while leaving the project that regenerates it
#                                 just invites someone to run `npm run build`.
#   builds/                       release artifacts. Already untracked on
#                                 local-main; kept in the list so the script
#                                 still does the right thing against an older
#                                 base, and reports honestly when there is
#                                 nothing to do.
#
# Verification is part of the job, not a follow-up: stripping a path is exactly
# the change whose failure mode is "something still referenced it", and that does
# not show up in the delete commit. See --no-verify for the escape hatch.
set -euo pipefail

BASE=local-main
BRANCH=pr/upstream
WORKDIR=
KEEP=0
VERIFY=1

usage() {
	cat <<'USAGE'
Usage: scripts/make-upstream-pr.sh [options]

  --base <ref>       branch/commit to derive from      (default: local-main)
  --branch <name>    branch to (re)create              (default: pr/upstream)
  --work-dir <path>  where to check it out             (default: <repo>/../webtmux-pr-upstream)
  --keep             leave the worktree in place afterwards, to inspect or push from
  --no-verify        skip the build/test pass on the stripped tree
  -h, --help         this

The work dir must be somewhere a container can bind-mount if verification is to
run through docker (the usual case on a machine with no Go toolchain).
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
	--base) BASE="$2"; shift 2 ;;
	--branch) BRANCH="$2"; shift 2 ;;
	--work-dir) WORKDIR="$2"; shift 2 ;;
	--keep) KEEP=1; shift ;;
	--no-verify) VERIFY=0; shift ;;
	-h | --help) usage; exit 0 ;;
	*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
	esac
done

REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"
: "${WORKDIR:="$(dirname "$REPO")/webtmux-pr-upstream"}"

git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null ||
	{ echo "no such base ref: $BASE" >&2; exit 1; }
BASE_SHA="$(git rev-parse --short "$BASE")"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. A clean worktree at the base.
#
# A worktree rather than a branch switch in place: this repo is normally one of
# several linked worktrees on one .git, and checking out a derived branch under
# somebody's feet is how you lose their uncommitted work.
say "worktree $WORKDIR at $BASE ($BASE_SHA)"
git worktree prune
if git worktree list --porcelain | grep -qxF "worktree $(cd "$WORKDIR" 2>/dev/null && pwd || echo "$WORKDIR")"; then
	git worktree remove --force "$WORKDIR"
elif [ -e "$WORKDIR" ]; then
	echo "$WORKDIR exists and is not a registered worktree — refusing to touch it" >&2
	exit 1
fi
# -B resets the branch even if it already exists, which is the point: the branch
# is regenerated, never advanced.
git worktree add --force -B "$BRANCH" "$WORKDIR" "$BASE" >/dev/null
WORKDIR="$(cd "$WORKDIR" && pwd)"

# ---------------------------------------------------------------------------
# 2. Strip.
STRIP_GLOBS=(
	'plan-*.md'
	'PR-DESCRIPTION.md'
	'scripts'
	'js'
	'bindata/static/js/gotty.js'
	'bindata/static/js/gotty.js.LICENSE.txt'
	'bindata/static/js/gotty.js.map'
	'bindata/static/js/gotty.licenses.txt'
	'builds'
)

say "strip"
removed=0
for glob in "${STRIP_GLOBS[@]}"; do
	# Ask git what is actually TRACKED under the pattern. A path that is already
	# untracked (builds/, once releases moved off-tree) is not an error and not a
	# silence either — it is reported as the no-op it is.
	mapfile -t hits < <(git -C "$WORKDIR" ls-files -z -- "$glob" | tr '\0' '\n' | sed '/^$/d')
	if [ "${#hits[@]}" -eq 0 ]; then
		printf '  %-38s nothing tracked (no-op)\n' "$glob"
		continue
	fi
	git -C "$WORKDIR" rm -r -q --ignore-unmatch -- "$glob"
	printf '  %-38s %d file(s)\n' "$glob" "${#hits[@]}"
	removed=$((removed + ${#hits[@]}))
done

# Local droppings that have no pattern worth hard-coding but must never ship.
# Checked rather than deleted: one appearing means something upstream of here
# started committing it, and that wants a human, not a quiet `rm`.
say "leak check"
LEAK_GLOBS=('claude-costs*' 'claude_run_me_*' 'CLAUDE.md' '.claude' '.wq' '*.orig' '*.rej')
leaked=0
for glob in "${LEAK_GLOBS[@]}"; do
	if git -C "$WORKDIR" ls-files --error-unmatch -- "$glob" >/dev/null 2>&1; then
		echo "  LEAK: $glob is tracked on $BASE" >&2
		git -C "$WORKDIR" ls-files -- "$glob" | sed 's/^/    /' >&2
		leaked=1
	fi
done
[ "$leaked" -eq 0 ] && echo "  none"
[ "$leaked" -eq 0 ] || { echo "refusing to build a PR branch over a local-file leak" >&2; exit 1; }

if [ "$removed" -eq 0 ]; then
	echo "nothing to strip — $BRANCH is $BASE unchanged"
else
	git -C "$WORKDIR" commit -q -m "strip fork-local paths for the upstream PR

Derived branch: $BASE minus the paths that only mean something in this fork —
execution plans, fork tooling, the machine-specific stoplight delegate list, and
the pre-fork webpack bundle (js/ + bindata/static/js/gotty*) that index.html
stopped loading when the UI became an ES-module graph.

Regenerate with scripts/make-upstream-pr.sh; do not commit here by hand."
fi

# ---------------------------------------------------------------------------
# 3. Verify the STRIPPED tree, which is the only tree nobody has ever built.
if [ "$VERIFY" -eq 1 ]; then
	say "verify (stripped tree)"

	( cd "$WORKDIR" && make check-js )

	# sync-assets must still be a no-op: if it is not, resources/ and bindata/
	# disagree on the stripped tree and the embedded UI would ship stale.
	( cd "$WORKDIR" && make sync-assets >/dev/null )
	if ! git -C "$WORKDIR" diff --quiet; then
		echo "make sync-assets changed files on the stripped tree:" >&2
		git -C "$WORKDIR" diff --name-only | sed 's/^/  /' >&2
		exit 1
	fi
	echo "  sync-assets: clean"

	( cd "$WORKDIR" && make test-js )
	# The hook suite matters HERE in particular: the stripped tree is the one with
	# no scripts/stoplight-delegates.env.sh, i.e. the empty upstream default that
	# nothing else exercises.
	( cd "$WORKDIR" && bash test/stoplight-hooks.sh )

	if command -v go >/dev/null 2>&1; then
		( cd "$WORKDIR" && go vet ./... && go test -count=1 ./... && go build -o /dev/null . )
	elif command -v docker >/dev/null 2>&1; then
		echo "  no local go — running the Go pass in golang:1.23"
		docker run --rm -v "$WORKDIR:/src" -w /src \
			-e GOFLAGS=-mod=mod -e HOME=/tmp -e CGO_ENABLED=0 golang:1.23 \
			sh -c 'go vet ./... && go test -count=1 ./... && go build -buildvcs=false -o /tmp/webtmux .'
	else
		echo "  WARNING: neither go nor docker — the Go pass did NOT run" >&2
	fi
fi

# ---------------------------------------------------------------------------
say "done"
printf '  %s = %s\n' "$BRANCH" "$(git -C "$WORKDIR" rev-parse --short HEAD)"
printf '  base %s = %s\n' "$BASE" "$BASE_SHA"
git -C "$WORKDIR" diff --stat "$BASE" HEAD | tail -1 | sed 's/^/  /'

if [ "$KEEP" -eq 1 ]; then
	printf '  worktree kept at %s\n' "$WORKDIR"
else
	git worktree remove --force "$WORKDIR"
	printf '  worktree removed; check it out again with:\n'
	printf '    git worktree add <path> %s\n' "$BRANCH"
fi
