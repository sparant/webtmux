# webtmux/Dockerfile — how the webtmux ARTIFACT is built. Owned by THIS repo.
# Deployment concerns (host tmux version pin, tmux socket, uid/gid, stoplight
# wiring) live in the consuming infra repo — see scripts/webtmux-docker/.
#
#   make docker-artifact                    -> builds/webtmux-linux-amd64
#   make docker-cross-compile               -> builds/webtmux-* + SHA256SUMS
#   make release-from-commit REF=<tag>      -> the same, built FROM a commit
#
# The binary is CGO_ENABLED=0 static with go:embed assets, so the artifact is
# exactly one file with no ABI coupling to whatever runtime image consumes it.
# That is what lets the builder and the runtime disagree about their base image.
#
# The container is also what makes the build reproducible: it pins the compiler.
# The same source compiled by two Go versions is two different binaries, so a
# release built with "whatever go was on the machine" cannot be re-derived by
# anyone else. GO_VERSION is that pin, and the Makefile carries the same value —
# TestPinnedGoVersionAgrees fails the build if the two drift apart.
#
ARG GO_VERSION=1.23.12
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-bookworm AS base
# node is required by `make check-js`, which parse-guards the embedded JS so a
# stray backtick in a css`` template cannot ship and blank the page. Before the
# COPY so it stays a cached layer that does NOT rerun on source changes. Its
# exact version does not reach the binary — it parses, it does not compile.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# The dependencies, as their OWN layer, before any source is copied. `COPY . /src`
# is invalidated by every edit to every file, and without this the build layer that
# follows it re-fetches every module from proxy.golang.org each time — so a
# JS-only change (which is most changes here) could not be built without working
# DNS and a reachable module proxy. One flaky lookup failed the whole artifact
# build, with an error that reads as if the source were broken. Keyed on go.mod +
# go.sum alone, this layer is reused until a dependency actually changes.
#
# It changes nothing about WHAT is compiled: go.sum pins every module by hash, so
# this fetches exactly what the build would have fetched anyway, just earlier and
# once. The reproducibility contract is untouched.
#
# ABOVE the stamp ARGs on purpose. An ARG whose value changes invalidates the
# layers that follow it, and VERSION/GIT_COMMIT/BUILD_TIME change on every single
# build — declaring them first would put the module cache back downstream of a
# value that is different every time, which is the whole problem again.
COPY go.mod go.sum ./
RUN go mod download
ARG VERSION=dev
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
COPY . /src
# .git is excluded by .dockerignore (and absent entirely when the context is a
# `git archive` stream), so VERSION/GIT_COMMIT/BUILD_TIME MUST arrive as build
# args — command-line make vars override the Makefile's git-derived defaults.
# BUILD_TIME is the COMMIT's timestamp, passed in for exactly that reason: a
# container has no way to read it, and `date` inside the build would put the
# clock back into the binary.

# Single-platform artifact: the deploy path's build, one file out.
# The three stamp ARGs are redeclared because a stage does not inherit its
# parent's ARGs — omit them here and they expand to empty, silently producing a
# binary stamped with nothing.
FROM base AS build
ARG VERSION=dev
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH \
      make build VERSION="$VERSION" GIT_COMMIT="$GIT_COMMIT" BUILD_TIME="$BUILD_TIME" \
 && mkdir -p /out && mv webtmux "/out/webtmux-$TARGETOS-$TARGETARCH"

# Export-only stage: the build product is a file, so emit a file, not an image.
# The product moves to a dedicated /out first because a glob over /src would
# also match SOURCE paths that happen to start with "webtmux-" — the
# webtmux-launch/ directory being exactly that. Exporting from a directory that
# contains nothing but build products cannot develop that problem again.
FROM scratch AS artifact
COPY --from=build /out/ /

# Every published platform plus SHA256SUMS, from one pinned toolchain. Building
# the six binaries in six places was itself a source of drift: each machine
# brought its own compiler. verify-assets runs first so a commit whose
# bindata/static has drifted from resources/ fails here rather than shipping a
# binary that a bare `go build` of the same commit would not reproduce.
FROM base AS crossbuild
ARG VERSION=dev
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
RUN make verify-assets \
 && make cross-compile checksums \
      VERSION="$VERSION" GIT_COMMIT="$GIT_COMMIT" BUILD_TIME="$BUILD_TIME"

FROM scratch AS release-assets
COPY --from=crossbuild /src/builds/ /
