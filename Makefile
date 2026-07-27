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

# Platforms to build for (PTY not supported on Windows)
PLATFORMS = \
	linux/amd64 \
	linux/arm64 \
	linux/arm \
	darwin/amd64 \
	darwin/arm64 \
	freebsd/amd64

export CGO_ENABLED=0

.PHONY: all build clean test test-js install cross-compile release help check-js docker-artifact launcher launcher-dev

# webtmux-launch: the SSH launcher. It carries no webtmux payload — it resolves
# the target's platform over SSH and gets the matching binary from whichever
# source is configured — so it builds from its own source alone, needs no
# cross-compiled webtmux as a prerequisite, and cannot ship a stale one.
LAUNCHER_NAME = webtmux-launch
LAUNCHER_PLATFORMS = darwin/arm64 darwin/amd64 linux/amd64
# RepoOwner is filled in by Stage 0 (the GitHub fork); until then a release
# build has no release to fetch from and must be pointed at a local source.
LAUNCHER_REPO_OWNER ?=
LAUNCHER_REPO_NAME ?= webtmux
LAUNCHER_WEBTMUX_VERSION ?= v0.1.0
LAUNCHER_LDFLAGS = -s -w \
  -X main.Version=$(VERSION) \
  -X main.RepoOwner=$(LAUNCHER_REPO_OWNER) \
  -X main.RepoName=$(LAUNCHER_REPO_NAME) \
  -X main.DefaultWebtmuxVersion=$(LAUNCHER_WEBTMUX_VERSION)

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

# Run tests (Go + the node store tests). The JS tests exercise the bug-prone
# StateStore debounce/rev-conflict logic; skipped with a note if node is absent
# (same policy as check-js), since state-store.js/client-store.js have no imports.
test: test-js
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

# Release build of the launcher, for the platforms a Mac/Linux user runs it on.
# main.DefaultSource is left EMPTY on purpose: a released launcher that defaulted
# to some directory on the builder's machine would look for a path that does not
# exist on the user's. Asserted by TestReleaseBuildHasNoDefaultSource.
launcher:
	@mkdir -p $(OUTPUT_DIR)
	@echo "Building $(LAUNCHER_NAME) $(VERSION)..."
	@for platform in $(LAUNCHER_PLATFORMS); do \
		os=$$(echo $$platform | cut -d/ -f1); \
		arch=$$(echo $$platform | cut -d/ -f2); \
		echo "  Building $$os/$$arch..."; \
		GOOS=$$os GOARCH=$$arch go build -ldflags "$(LAUNCHER_LDFLAGS)" \
			-o $(OUTPUT_DIR)/$(LAUNCHER_NAME)-$$os-$$arch ./cmd/$(LAUNCHER_NAME) || exit 1; \
	done
	@ls -lh $(OUTPUT_DIR)/$(LAUNCHER_NAME)-*

# Dev build: host platform only (a cross-compile matrix in an inner loop is
# wasted seconds), with builds/ baked in as the binary source. The full local
# workflow is then two commands with nothing to export and nothing to remember:
#
#   make cross-compile
#   make launcher-dev && ./builds/webtmux-launch testbox
launcher-dev:
	@mkdir -p $(OUTPUT_DIR)
	go build -ldflags "$(LAUNCHER_LDFLAGS) -X main.DefaultSource=$(abspath $(OUTPUT_DIR))" \
		-o $(OUTPUT_DIR)/$(LAUNCHER_NAME) ./cmd/$(LAUNCHER_NAME)
	@echo "Done: $(OUTPUT_DIR)/$(LAUNCHER_NAME) (source: $(abspath $(OUTPUT_DIR)))"

# Create release archives
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
	@echo "  make launcher     Build webtmux-launch for release (no baked-in source)"
	@echo "  make launcher-dev Build webtmux-launch for the host, deploying from ./builds"
	@echo "  make docker-artifact Build builds/webtmux-<os>-<arch> in a container (no local Go)"
	@echo "  make release      Create release archives"
	@echo "  make assets       Copy JS assets to bindata"
	@echo "  make check-js     Parse-check all JS (runs automatically before a build)"
	@echo "  make dev          Build with fresh assets"
	@echo "  make help         Show this help"
