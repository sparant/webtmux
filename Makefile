# WebTmux Makefile
# Builds portable binaries for all standard platforms

VERSION ?= $(shell git describe --tags 2>/dev/null || echo "dev")
GIT_COMMIT = $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME = $(shell date -u '+%Y-%m-%d_%H:%M:%S')
# No -X main.GitCommit: package main has only Version (version.go), so that flag
# named a symbol that does not exist and the linker silently dropped it. The live
# commit stamp is -X webtmux/server.BuildCommit, which the UI reads.
BUILD_OPTIONS = -ldflags "-s -w -X main.Version=$(VERSION) -X webtmux/server.BuildCommit=$(GIT_COMMIT) -X webtmux/server.BuildTime=$(BUILD_TIME)"

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

.PHONY: all build clean test test-js test-hooks install cross-compile release help check-js docker-artifact launcher launcher-dev checksums release-binaries

# Default target
all: build

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
test: test-js test-hooks
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
docker-artifact:
	@mkdir -p $(OUTPUT_DIR)
	docker build --target artifact --platform $(DOCKER_PLATFORM) \
	  --output type=local,dest=$(OUTPUT_DIR)/ \
	  --build-arg VERSION=$(VERSION) --build-arg GIT_COMMIT=$(GIT_COMMIT) .

# Clean build artifacts
clean:
	rm -rf $(BINARY_NAME) $(OUTPUT_DIR)

# Cross-compile for all platforms
cross-compile: clean sync-assets
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
checksums:
	@cd $(OUTPUT_DIR) && sha256sum $(BINARY_NAME)-* > SHA256SUMS
	@echo "Wrote $(OUTPUT_DIR)/SHA256SUMS"

# Build everything a release needs, then print the publish command rather than
# running it: tagging and `gh release create` are deliberately manual, so the
# assets can be reviewed first.
#
#   make release-binaries        # after tagging — VERSION comes from git describe
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
release: cross-compile
	@echo "Creating release archives..."
	@mkdir -p $(OUTPUT_DIR)/dist
	@cd $(OUTPUT_DIR) && for f in $(BINARY_NAME)-*; do \
		if [ -f "$$f" ]; then \
			tar -czf dist/$$f.tar.gz $$f; \
		fi; \
	done
	@cd $(OUTPUT_DIR)/dist && sha256sum * > SHA256SUMS
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
	@echo "  make checksums    Write builds/SHA256SUMS for the cross-compiled binaries"
	@echo "  make release-binaries  Cross-compile + checksums, then print the gh publish command"
	@echo "  make release      Create release archives"
	@echo "  make assets       Copy JS assets to bindata"
	@echo "  make check-js     Parse-check all JS (runs automatically before a build)"
	@echo "  make dev          Build with fresh assets"
	@echo "  make help         Show this help"
