# WebTmux Makefile
# Builds portable binaries for all standard platforms

VERSION ?= $(shell git describe --tags 2>/dev/null || echo "dev")
GIT_COMMIT = $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME = $(shell date -u '+%Y-%m-%d_%H:%M:%S')
BUILD_OPTIONS = -ldflags "-s -w -X main.Version=$(VERSION) -X main.GitCommit=$(GIT_COMMIT) -X webtmux/server.BuildCommit=$(GIT_COMMIT) -X webtmux/server.BuildTime=$(BUILD_TIME)"

OUTPUT_DIR = ./builds
BINARY_NAME = webtmux

# Platforms to build for (PTY not supported on Windows)
PLATFORMS = \
	linux/amd64 \
	linux/arm64 \
	linux/arm \
	darwin/amd64 \
	darwin/arm64 \
	freebsd/amd64

export CGO_ENABLED=0

.PHONY: all build clean test install cross-compile release help check-js

# Default target
all: build

# Fail the build on any JS syntax error before it can ship. The whole UI loads as
# one ES-module graph, so a single bad file (classically a stray backtick or ${}
# inside a css`` / html`` template literal) aborts bootstrap and blanks the page —
# invisible until runtime. Parse every source module as ESM (forced via
# --input-type=module, since bare .js is treated as CommonJS and would false-fail
# on `import`). No-op with a note if node isn't installed.
check-js:
	@if ! command -v node >/dev/null 2>&1; then \
		echo "note: node not found — skipping JS syntax check"; \
	else \
		echo "Checking JS syntax..."; \
		fail=0; \
		for f in resources/js/*.js resources/js/components/*.js; do \
			if ! err=$$(node --check --input-type=module < "$$f" 2>&1); then \
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

# Run tests
test:
	go test ./...
	go vet ./...

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
	@echo "  make release      Create release archives"
	@echo "  make assets       Copy JS assets to bindata"
	@echo "  make check-js     Parse-check all JS (runs automatically before a build)"
	@echo "  make dev          Build with fresh assets"
	@echo "  make help         Show this help"
