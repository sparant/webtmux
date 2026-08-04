#!/usr/bin/env bash
# Prove that a commit builds to the same bytes twice — including from a
# different directory.
#
#   make verify-repro            # HEAD
#   make verify-repro REF=v0.1.1
#
# WHY THE DIRECTORY AXIS. Building twice in one place proves almost nothing:
# the compiler is already deterministic there, and the two failures this repo
# actually had were invisible to that test. `date` in the Makefile made every
# build differ (caught by any repeat), but the missing -trimpath made the binary
# depend on WHERE it was built — and the release path built in a throwaway
# worktree whose path changed per release, while the container built in /src. So
# this script builds the same source at two deliberately different container
# paths and compares. It is the check that would have caught the bug.
#
# Nothing here touches the working tree: the source is `git archive` of the ref,
# extracted into a scratch directory, and both builds write outside the mount.
set -euo pipefail

REF="${1:-HEAD}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$REPO/.repro-check"
# Two paths of deliberately different LENGTH as well as spelling. Go pads
# nothing, but a length difference makes a leaked path visible as a size
# difference too, not merely a hash mismatch.
PATH_A=/repro-a
PATH_B=/repro-b-considerably-longer-directory

command -v docker >/dev/null 2>&1 || { echo "docker is required"; exit 1; }
git -C "$REPO" rev-parse --verify --quiet "$REF" >/dev/null || {
	echo "REF=$REF is not a ref in this repository"; exit 1; }

# The pinned toolchain and the stamps, read from the same places the release
# build reads them. If any of these were computed here instead, this script
# would be testing itself rather than the build.
GO_VERSION="$(awk -F'= *' '/^GO_VERSION *=/{print $2; exit}' "$REPO/Makefile")"
VERSION="$(git -C "$REPO" describe --tags "$REF" 2>/dev/null || echo dev)"
COMMIT="$(git -C "$REPO" rev-parse --short "$REF")"
BUILD_TIME="$(TZ=UTC0 git -C "$REPO" log -1 --format=%cd \
	--date=format-local:'%Y-%m-%d_%H:%M:%S' "$REF")"

echo "ref:        $REF ($COMMIT)"
echo "version:    $VERSION"
echo "build time: $BUILD_TIME  (the commit's, not the clock's)"
echo "toolchain:  go$GO_VERSION"
echo

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/src"
git -C "$REPO" archive --format=tar "$REF" | tar -x -C "$SCRATCH/src"

# One source directory, mounted at two paths — the source cannot differ between
# the runs by construction, so a hash difference can only come from the build.
build_at() {
	local at="$1" out="$2"
	docker run --rm -u "$(id -u):$(id -g)" \
		-v "$SCRATCH/src:$at" -v "$SCRATCH/out:/out" -w "$at" \
		-e HOME=/tmp -e GOCACHE=/tmp/gocache -e GOPATH=/tmp/gopath \
		"golang:${GO_VERSION}-bookworm" \
		make build VERSION="$VERSION" GIT_COMMIT="$COMMIT" BUILD_TIME="$BUILD_TIME" \
		>/dev/null
	# `make build` writes ./webtmux inside the mount; move it out so the second
	# run cannot accidentally compare a binary against itself.
	mv "$SCRATCH/src/webtmux" "$SCRATCH/out/$out"
}

mkdir -p "$SCRATCH/out"
echo "build 1 at $PATH_A ..."
build_at "$PATH_A" a
echo "build 2 at $PATH_B ..."
build_at "$PATH_B" b

HASH_A="$(sha256sum "$SCRATCH/out/a" | cut -d' ' -f1)"
HASH_B="$(sha256sum "$SCRATCH/out/b" | cut -d' ' -f1)"
echo
echo "  $HASH_A  (built at $PATH_A)"
echo "  $HASH_B  (built at $PATH_B)"
echo

if [ "$HASH_A" != "$HASH_B" ]; then
	echo "NOT REPRODUCIBLE: identical source built in two directories differs."
	echo "Something in the build is reading its environment — a path, the clock,"
	echo "or an env var the Makefile does not pin. See the reproducibility notes"
	echo "at the top of the Makefile."
	exit 1
fi

# A build that is stable but stamped from the clock would pass the comparison
# above and still be irreproducible tomorrow, so check the stamp is the ref's.
if ! grep -aqF "$BUILD_TIME" "$SCRATCH/out/a"; then
	echo "NOT REPRODUCIBLE: the binary does not carry the commit's timestamp"
	echo "($BUILD_TIME) — BUILD_TIME is not coming from the commit."
	exit 1
fi

echo "REPRODUCIBLE: byte-identical across build directories, stamped from the commit."
rm -rf "$SCRATCH"
