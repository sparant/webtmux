# webtmux/Dockerfile — how the webtmux ARTIFACT is built. Owned by THIS repo.
# Deployment concerns (host tmux version pin, tmux socket, uid/gid, stoplight
# wiring) live in the consuming infra repo — see scripts/webtmux-docker/.
#
#   make docker-artifact          -> builds/webtmux-linux-amd64
#
# The binary is CGO_ENABLED=0 static with go:embed assets, so the artifact is
# exactly one file with no ABI coupling to whatever runtime image consumes it.
# That is what lets the builder and the runtime disagree about their base image.
#
FROM --platform=$BUILDPLATFORM golang:1.23-bookworm AS build
# node is required by `make check-js`, which parse-guards the embedded JS so a
# stray backtick in a css`` template cannot ship and blank the page. Before the
# COPY so it stays a cached layer that does NOT rerun on source changes.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
ARG VERSION=dev
ARG GIT_COMMIT=unknown
ARG TARGETOS=linux
ARG TARGETARCH=amd64
COPY . /src
# .git is excluded by .dockerignore, so VERSION/GIT_COMMIT MUST arrive as build
# args — command-line make vars override the Makefile's git-describe defaults.
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
      make build VERSION="$VERSION" GIT_COMMIT="$GIT_COMMIT" \
 && mkdir -p /out && mv webtmux "/out/webtmux-$TARGETOS-$TARGETARCH"

# Export-only stage: the build product is a file, so emit a file, not an image.
# The product moves to a dedicated /out first because a glob over /src would
# also match SOURCE paths that happen to start with "webtmux-" — the
# webtmux-launch/ directory being exactly that. Exporting from a directory that
# contains nothing but build products cannot develop that problem again.
FROM scratch AS artifact
COPY --from=build /out/ /
