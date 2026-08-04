# WebTmux Makefile
# Builds portable binaries for all standard platforms
#
# REPRODUCIBILITY CONTRACT
# ------------------------
# A commit determines the bytes. Building the same commit twice — on another
# machine, in another directory, a year later — must produce byte-identical
# binaries, so a published asset can be checked against its source by anyone.
# `make release-from-commit REF=<tag>` is that build; `make verify-repro` proves
# it. Everything below marked "reproducibility:" exists to hold the contract,
# and each such line closes a hole that was found empirically:
#
#   1. the build timestamp came from `date` — every build differed;
#   2. no -trimpath — the binary embedded the build directory, so the same
#      source built at /src and at /workspace/webtmux-release/v0.1.0 differed;
#   3. the Go toolchain was a floating tag (`golang:1.23`) picked by whoever
#      drove the build, or the builder's own `go` — a different compiler emits
#      different code from identical source;
#   4. the docker build's context was the WORKING TREE, so uncommitted edits
#      shipped silently;
#   5. GOFLAGS/GOEXPERIMENT/GOARM leaked in from the caller's environment.
#
# Binaries published before v0.1.1 predate this and are NOT reproducible.

# The pinned toolchain. Single source of truth: Dockerfile's `ARG GO_VERSION`
# default and webtmux-launch/Makefile must carry the same value, which
# TestPinnedGoVersionAgrees asserts. Bumping it is a deliberate, reviewable
# commit that changes the output bytes — which is the honest description of
# what a compiler upgrade does.
GO_VERSION = 1.23.12

# The ref a release is built from. Everything a release stamps is derived from
# it, never from the working tree or the clock — see release-from-commit.
REF ?= HEAD

# --dirty so an uncommitted build can never masquerade as a clean tag: the
# release preflight compares this stamp to the tag exactly, and "v0.1.0-dirty"
# fails that comparison loudly instead of shipping unknown source.
VERSION ?= $(shell git describe --tags --dirty 2>/dev/null || echo "dev")
GIT_COMMIT = $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
# reproducibility: the stamp is the COMMIT's committer time, not `date`. It
# still answers "which build is this?" — a commit identifies its own source far
# better than the wall clock of whatever machine happened to compile it — while
# being a function of the commit, so two builds of one commit agree.
BUILD_TIME ?= $(shell TZ=UTC0 git log -1 --format=%cd --date=format-local:'%Y-%m-%d_%H:%M:%S' 2>/dev/null || echo "unknown")

# Ref-derived stamps for release-from-commit, which builds a COMMIT rather than
# the checkout: no --dirty (a ref cannot be dirty) and no dependence on which
# branch or worktree happens to be checked out here.
REF_VERSION = $(shell git describe --tags $(REF) 2>/dev/null || echo "dev")
REF_COMMIT  = $(shell git rev-parse --short $(REF) 2>/dev/null || echo "unknown")
REF_TIME    = $(shell TZ=UTC0 git log -1 --format=%cd --date=format-local:'%Y-%m-%d_%H:%M:%S' $(REF) 2>/dev/null || echo "unknown")

# No -X main.GitCommit: package main has only Version (version.go), so that flag
# named a symbol that does not exist and the linker silently dropped it. The live
# commit stamp is -X webtmux/server.BuildCommit, which the UI reads.
#
# reproducibility:
#   -trimpath      strips the build directory out of the binary. -s -w does NOT
#                  do this — the pclntab keeps file paths for panic traces — so
#                  without it the same source built in two directories produces
#                  two different binaries. Measured, not assumed.
#   -buildvcs=false  otherwise `go build` stamps vcs.revision/vcs.time/
#                  vcs.modified from .git when one is present and omits them
#                  when it is not, so a worktree build and a container build of
#                  one commit disagree. The commit is already stamped explicitly
#                  above, so nothing is lost.
BUILD_OPTIONS = -trimpath -buildvcs=false -ldflags "-s -w -X main.Version=$(VERSION) -X webtmux/server.BuildCommit=$(GIT_COMMIT) -X webtmux/server.BuildTime=$(BUILD_TIME)"

OUTPUT_DIR = ./builds
BINARY_NAME = webtmux
DOCKER_PLATFORM ?= linux/amd64
# Where releases are published. `gh` normally infers this from a git remote, but
# it cannot here: this checkout's only writable remote is a private SSH host, not
# a GitHub one, so `gh release create` without --repo fails with "none of the git
# remotes point to a known GitHub host". Override for a different fork.
RELEASE_REPO ?= sparant/webtmux

# Platforms to build for (PTY not supported on Windows)
PLATFORMS = \
	linux/amd64 \
	linux/arm64 \
	linux/arm \
	darwin/amd64 \
	darwin/arm64 \
	freebsd/amd64

export CGO_ENABLED=0

# reproducibility: pin every environment input the compiler reads, so a caller's
# shell cannot change the output bytes without changing this file. Each value is
# the Go 1.23 default (`go env GOAMD64 GOARM GO386` in the pinned image), so
# pinning them changes nothing today and freezes them against a future default
# flip or an exported GOFLAGS in someone's profile. GOTOOLCHAIN=local forbids the
# silent toolchain download that would otherwise substitute a different compiler
# whenever go.mod asks for a newer one.
export GOTOOLCHAIN=local
export GOFLAGS=
export GOEXPERIMENT=
export GOAMD64=v1
export GOARM=7,hardfloat
export GO386=sse2
# Consumed by anything downstream that honours the reproducible-builds
# convention (archivers, packagers). Same commit time as BUILD_TIME.
export SOURCE_DATE_EPOCH ?= $(shell git log -1 --format=%ct 2>/dev/null || echo 0)

.PHONY: all build clean test test-js test-hooks install cross-compile release help check-js docker-artifact launcher launcher-dev checksums release-binaries verify-assets check-toolchain docker-cross-compile release-from-commit verify-repro

# Default target
all: build

# reproducibility: a different compiler emits different bytes from identical
# source, so a release built with an unpinned local Go is not the release anyone
# else can rebuild. Guards the targets whose output ships; plain `make build`
# and `make dev` stay unguarded so day-to-day work needs no exact toolchain.
# The container targets satisfy this by construction (pinned image).
check-toolchain:
	@have=$$(go env GOVERSION 2>/dev/null || echo "none"); \
	if [ "$$have" != "go$(GO_VERSION)" ]; then \
		echo "Toolchain mismatch: this Go is $$have, the pinned toolchain is go$(GO_VERSION)."; \
		echo "  Reproducible path with no local Go:  make release-from-commit REF=<tag>"; \
		echo "  Override (output will not match a release):  ALLOW_TOOLCHAIN_DRIFT=1"; \
		[ -n "$(ALLOW_TOOLCHAIN_DRIFT)" ] || exit 1; \
		echo "  ALLOW_TOOLCHAIN_DRIFT set — continuing with $$have"; \
	fi

# reproducibility: bindata/static is the tree that go:embed compiles in, and it
# is committed; resources/ is where the same files are edited. `make build`
# copies resources -> bindata first, but a plain `go build` does not — so if the
# two ever diverge in a commit, the binary you get depends on which command you
# ran. Assert they agree instead. gotty.js and its sidecars live only in bindata
# (vendored bundle, no resources/ source), hence the exclusion.
verify-assets:
	@if ! diff -r --exclude='gotty.*' resources/js bindata/static/js >/dev/null 2>&1 \
	   || ! cmp -s resources/index.html bindata/static/index.html; then \
		echo "bindata/static is out of sync with resources/:"; \
		diff -r --exclude='gotty.*' resources/js bindata/static/js | sed 's/^/  /' | head -20; \
		cmp -s resources/index.html bindata/static/index.html || echo "  index.html differs"; \
		echo "Run 'make sync-assets' and commit the result — a commit must build the"; \
		echo "same binary whether it is built with 'make build' or a bare 'go build'."; \
		exit 1; \
	fi

# Fail the build on any JS syntax error before it can ship. The whole UI loads as
# one ES-module graph, so a single bad file (classically a stray backtick or ${}
# inside a css`` / html`` template literal) aborts bootstrap and blanks the page —
# invisible until runtime. Parse every source module as ESM (forced via
# --input-type=module, since bare .js is treated as CommonJS and would false-fail
# on `import`). No-op with a note if node isn't installed. Accepts either `node`
# or `nodejs` (Debian's package name for the binary) so it runs in the container.
check-js:
	@node_bin=$$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true); \
	if [ -z "$$node_bin" ]; then \
		echo "note: node not found — skipping JS syntax check"; \
	else \
		echo "Checking JS syntax..."; \
		fail=0; \
		for f in resources/js/*.js resources/js/components/*.js; do \
			if ! err=$$("$$node_bin" --check --input-type=module < "$$f" 2>&1); then \
				echo "  SYNTAX ERROR in $$f:"; \
				printf '%s\n' "$$err" | head -4 | sed 's/^/    /'; \
				fail=1; \
			fi; \
		done; \
		if [ "$$fail" != "0" ]; then echo "JS syntax check FAILED — aborting build."; exit 1; fi; \
		echo "  all JS OK"; \
	fi

# Sync resources to bindata (for embedding). index.html MUST be synced too — it
# is embedded + served from bindata/static/, and the split-view markup lives in
# it; forgetting it ships a stale page (old static sidebar/#terminal) that fights
# the SplitManager-created region. Gated on check-js so a syntax error never
# reaches the embedded assets.
sync-assets: check-js
	@cp -r resources/js/* bindata/static/js/
	@cp resources/index.html bindata/static/index.html

# Build for current platform
build: sync-assets
	@echo "Building $(BINARY_NAME) $(VERSION)..."
	go build $(BUILD_OPTIONS) -o $(BINARY_NAME) .
	@echo "Done: ./$(BINARY_NAME)"

# Install to GOPATH/bin
install:
	go install $(BUILD_OPTIONS) .

# Run tests (Go + the node store tests + the shell stoplight hooks). The JS tests
# exercise the bug-prone StateStore debounce/rev-conflict logic; skipped with a note
# if node is absent (same policy as check-js), since state-store.js/client-store.js
# have no imports.
test: test-js test-hooks verify-assets
	go test ./...
	go vet ./...

test-js:
	@node_bin=$$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true); \
	if [ -z "$$node_bin" ]; then \
		echo "note: node not found — skipping JS store tests"; \
	else \
		echo "Running JS store tests..."; \
		"$$node_bin" --test test/; \
	fi

# The bash stoplight installer, driven against a real tmux server: the hooks are
# shell + tmux all the way down, so nothing above this layer can tell whether they
# address the right window. Skips itself where tmux is absent, like test-js does
# for node.
test-hooks:
	@bash test/stoplight-hooks.sh

# Build the release artifact in a pinned container — no local Go toolchain needed.
# Emits builds/webtmux-<os>-<arch>. Cheap to re-run: BuildKit caches everything.
# VERSION/GIT_COMMIT must be passed in because .dockerignore excludes .git.
#
# Create the output dir ourselves rather than letting BuildKit's local exporter
# do it: the exporter creates it 0700, which on a shared/bind-mounted checkout
# locks out every other uid (and, where POSIX ACLs are in play, collapses the
# ACL mask to ---). The next person to build then gets an opaque
# "lstat builds/webtmux-<os>-<arch>: permission denied" from the exporter.
#
# This target builds the WORKING TREE (the docker context is this directory), so
# it is the convenient dev build, not the reproducible one — uncommitted edits
# are included and the stamps describe HEAD regardless. For an auditable build
# use release-from-commit, which builds a commit and nothing else.
docker-artifact:
	@mkdir -p $(OUTPUT_DIR)
	docker build --target artifact --platform $(DOCKER_PLATFORM) \
	  --output type=local,dest=$(OUTPUT_DIR)/ \
	  --build-arg GO_VERSION=$(GO_VERSION) \
	  --build-arg VERSION=$(VERSION) --build-arg GIT_COMMIT=$(GIT_COMMIT) \
	  --build-arg BUILD_TIME=$(BUILD_TIME) .

# All six platforms in the pinned container, from the working tree. Same dev-vs-
# release distinction as docker-artifact; release-from-commit is the auditable one.
docker-cross-compile:
	@mkdir -p $(OUTPUT_DIR)
	docker build --target release-assets \
	  --output type=local,dest=$(OUTPUT_DIR)/ \
	  --build-arg GO_VERSION=$(GO_VERSION) \
	  --build-arg VERSION=$(VERSION) --build-arg GIT_COMMIT=$(GIT_COMMIT) \
	  --build-arg BUILD_TIME=$(BUILD_TIME) .

# THE RELEASE BUILD. Six binaries + SHA256SUMS in $(OUTPUT_DIR), built from a
# commit by a pinned toolchain:
#
#   make release-from-commit REF=v0.1.1
#
# `git archive` — not the working tree — is the docker context, so the input is
# exactly what the ref contains: no uncommitted edit, no untracked file, no
# stale builds/ artifact can reach the compiler. Every stamp comes from the ref
# (REF_VERSION/REF_COMMIT/REF_TIME), so the output does not depend on which
# branch is checked out, which directory this is, or what time it is. That is
# the whole reproducibility contract in one command, and `make verify-repro`
# checks it holds.
#
# Note the trailing `-`: with a tar on stdin, docker takes the context (and the
# Dockerfile) from the archive, i.e. from the ref's own Dockerfile — building an
# old tag uses the build definition that shipped with it.
release-from-commit:
	@git rev-parse --verify --quiet $(REF) >/dev/null || \
		{ echo "REF=$(REF) is not a ref in this repository"; exit 1; }
	@mkdir -p $(OUTPUT_DIR)
	@echo "Building $(REF_VERSION) from $(REF_COMMIT) (source time $(REF_TIME))..."
	git archive --format=tar $(REF) | docker build --target release-assets \
	  --output type=local,dest=$(OUTPUT_DIR)/ \
	  --build-arg GO_VERSION=$(GO_VERSION) \
	  --build-arg VERSION=$(REF_VERSION) --build-arg GIT_COMMIT=$(REF_COMMIT) \
	  --build-arg BUILD_TIME=$(REF_TIME) -
	@echo ""
	@ls -l $(OUTPUT_DIR)/
	@cd $(OUTPUT_DIR) && sha256sum --check SHA256SUMS

# Prove the contract rather than trusting it: same commit, same stamps, two
# different build directories -> the hashes must match. The directory axis is
# the one that silently broke before -trimpath, and no amount of rebuilding in
# one place can detect it. See scripts/verify-reproducible.sh.
verify-repro:
	@bash scripts/verify-reproducible.sh $(REF)

# Clean build artifacts
clean:
	rm -rf $(BINARY_NAME) $(OUTPUT_DIR)

# Cross-compile for all platforms
cross-compile: check-toolchain clean verify-assets sync-assets
	@echo "Cross-compiling $(BINARY_NAME) $(VERSION) for all platforms..."
	@mkdir -p $(OUTPUT_DIR)
	@for platform in $(PLATFORMS); do \
		os=$$(echo $$platform | cut -d/ -f1); \
		arch=$$(echo $$platform | cut -d/ -f2); \
		output=$(OUTPUT_DIR)/$(BINARY_NAME)-$$os-$$arch; \
		if [ "$$os" = "windows" ]; then output=$$output.exe; fi; \
		echo "  Building $$os/$$arch..."; \
		GOOS=$$os GOARCH=$$arch go build $(BUILD_OPTIONS) -o $$output . || exit 1; \
	done
	@echo "Done! Binaries in $(OUTPUT_DIR)/"
	@ls -lh $(OUTPUT_DIR)/

# webtmux-launch is a separate program with its own Makefile in webtmux-launch/.
# It shares this Go module and nothing else — it imports no webtmux package —
# so its build lives with its source. These two targets are conveniences so the
# familiar `make launcher` still works from the repo root.
LAUNCHER_DIR = webtmux-launch

launcher:
	$(MAKE) -C $(LAUNCHER_DIR) release VERSION=$(VERSION)

launcher-dev:
	$(MAKE) -C $(LAUNCHER_DIR) dev VERSION=$(VERSION)

# SHA256SUMS for the raw cross-compiled binaries, written next to them. This is a
# release *asset*, not a committed file — builds/ is untracked. webtmux-launch
# fetches it first (a few hundred bytes) to decide whether the 12 MB binary
# download is needed at all, so a release without it loses the launcher's cheap
# path entirely.
#
# reproducibility: LC_ALL=C so the file's line order comes from byte order, not
# from the builder's collation locale. Same bytes in, same file out — otherwise
# the one release asset everybody checks against would itself differ per builder.
checksums:
	@cd $(OUTPUT_DIR) && LC_ALL=C sha256sum $$(LC_ALL=C ls | grep "^$(BINARY_NAME)-" | LC_ALL=C sort) > SHA256SUMS
	@echo "Wrote $(OUTPUT_DIR)/SHA256SUMS"

# Build everything a release needs, then print the publish command rather than
# running it: tagging and `gh release create` are deliberately manual, so the
# assets can be reviewed first.
#
#   make release-binaries        # after tagging — VERSION comes from git describe
#
# This is the LOCAL-toolchain path, kept for a machine that has the pinned Go.
# `make release-from-commit REF=<tag>` is the preferred one: it needs no local Go,
# builds the commit rather than the checkout, and is what the published assets
# are expected to match. Both are reproducible; only this one can be run against
# a dirty tree, which is why cross-compile now gates on check-toolchain and the
# stamp carries `-dirty`.
#
# Do NOT rename the webtmux-<os>-<arch> outputs. The launcher builds its download
# URLs from `uname` mapped to exactly these names, and its local-source mode reads
# the same names out of builds/; a rename breaks every launcher already in the field.
#
# No `launcher` prerequisite: the two programs release on independent cadences, and
# a webtmux patch needs no launcher rebuild. To publish launcher assets too, build
# them AFTER this target and re-run `checksums` — cross-compile's `clean` wipes
# builds/, so `make launcher` first would lose them.
release-binaries: cross-compile checksums
	@echo ""
	@echo "Built $(VERSION). Publish (user-executed — the agent has no GitHub auth):"
	@echo "  gh release create $(VERSION) builds/webtmux-* builds/SHA256SUMS \\"
	@echo "     --repo $(RELEASE_REPO) \\"
	@echo "     --title 'webtmux $(VERSION)' --notes-file release-notes.md"

# Create release archives (tarballs under builds/dist/). Predates the move to
# GitHub Releases, which publishes the raw binaries — see release-binaries.
#
# reproducibility: a tarball is a second place for the clock to leak in — plain
# `tar -czf` records each member's mtime/uid/gid and gzip stamps its own header
# with the current time, so identical binaries would still produce differing
# archives. Every varying field is pinned to the commit or to zero. --sort=name
# is GNU tar; on BSD tar (macOS) this target degrades to non-reproducible
# archives, which is acceptable for a legacy path the release does not use.
release: cross-compile
	@echo "Creating release archives..."
	@mkdir -p $(OUTPUT_DIR)/dist
	@cd $(OUTPUT_DIR) && for f in $(BINARY_NAME)-*; do \
		if [ -f "$$f" ]; then \
			tar --sort=name --owner=0 --group=0 --numeric-owner \
			    --mtime="@$(SOURCE_DATE_EPOCH)" -cf - "$$f" \
			  | gzip -n -9 > dist/$$f.tar.gz; \
		fi; \
	done
	@cd $(OUTPUT_DIR)/dist && LC_ALL=C sha256sum \
		$$(LC_ALL=C ls | grep -v '^SHA256SUMS$$' | LC_ALL=C sort) > SHA256SUMS
	@echo "Release archives in $(OUTPUT_DIR)/dist/"
	@ls -lh $(OUTPUT_DIR)/dist/

# Copy JS assets to bindata (for development)
assets: check-js
	cp resources/js/webtmux.js bindata/static/js/
	cp resources/js/components/*.js bindata/static/js/components/

# Development build with assets
dev: assets build

help:
	@echo "WebTmux Makefile"
	@echo ""
	@echo "Usage:"
	@echo "  make              Build for current platform"
	@echo "  make build        Build for current platform"
	@echo "  make install      Install to GOPATH/bin"
	@echo "  make test         Run tests"
	@echo "  make clean        Remove build artifacts"
	@echo "  make cross-compile Build for all platforms"
	@echo "  make launcher     Build webtmux-launch for release (see webtmux-launch/)"
	@echo "  make launcher-dev Build webtmux-launch for the host, deploying from ./builds"
	@echo "  make docker-artifact Build builds/webtmux-<os>-<arch> in a container (no local Go)"
	@echo "  make docker-cross-compile  All platforms in the pinned container (no local Go)"
	@echo "  make release-from-commit REF=<tag>  Reproducible release build FROM a commit"
	@echo "  make verify-repro [REF=<tag>]  Prove the build is byte-identical across directories"
	@echo "  make verify-assets  Check bindata/static matches resources/"
	@echo "  make checksums    Write builds/SHA256SUMS for the cross-compiled binaries"
	@echo "  make release-binaries  Cross-compile + checksums, then print the gh publish command"
	@echo "  make release      Create release archives"
	@echo "  make assets       Copy JS assets to bindata"
	@echo "  make check-js     Parse-check all JS (runs automatically before a build)"
	@echo "  make dev          Build with fresh assets"
	@echo "  make help         Show this help"
