# webtmux-launch — the SSH launcher. Built independently of webtmux itself.
#
#   make          # host-platform dev build, deploying from ../builds
#   make release  # darwin/arm64, darwin/amd64, linux/amd64 — no baked-in source
#   make test     # unit tests
#   make e2e      # the full end-to-end suite against a throwaway sshd container
#
# The launcher carries NO webtmux payload: it resolves the target's platform over
# SSH and fetches the matching binary from whichever source is configured. So it
# builds from its own source alone, needs no cross-compiled webtmux as a
# prerequisite, and cannot ship a stale one — which is also why a webtmux fix
# reaches every launcher already in the field with no launcher release at all.
#
# The repo root's Makefile delegates `make launcher` / `make launcher-dev` here.

NAME = webtmux-launch
PLATFORMS = darwin/arm64 darwin/amd64 linux/amd64

# Binaries land in the REPO ROOT's builds/, next to the webtmux binaries. That is
# deliberate: it is where release assets are published from, and it is the
# directory launcher-dev bakes in as the default binary source, so
# `make -C webtmux-launch && ../builds/webtmux-launch <host>` just works.
OUTPUT_DIR ?= ../builds

# Pinned toolchain, kept equal to the root Makefile's GO_VERSION and the
# Dockerfile's ARG default — TestPinnedGoVersionAgrees fails if they drift.
# Same reason as the root build: a different compiler emits different bytes, so
# a released launcher nobody can rebuild is a released launcher nobody can audit.
GO_VERSION = 1.23.12

VERSION ?= $(shell git describe --tags --dirty 2>/dev/null || echo "dev")
# Filled in by Stage 0 (the GitHub fork). Until then a release build has no
# release to fetch from and must be pointed at a local source.
REPO_OWNER ?=
REPO_NAME ?= webtmux
WEBTMUX_VERSION ?= v0.1.0

LDFLAGS = -s -w \
  -X main.Version=$(VERSION) \
  -X main.RepoOwner=$(REPO_OWNER) \
  -X main.RepoName=$(REPO_NAME) \
  -X main.DefaultWebtmuxVersion=$(WEBTMUX_VERSION)

# reproducibility, for the same reasons as the root Makefile — see its header.
# -trimpath: without it the binary embeds the build directory, so the same
# commit built in two checkouts is two different binaries (and -s -w does not
# strip those paths). -buildvcs=false: otherwise `go build` stamps .git state
# when a .git is present and omits it when it is not, which is the difference
# between a worktree build and a container build of one commit.
BUILD_FLAGS = -trimpath -buildvcs=false

export CGO_ENABLED=0
# Pin every compiler-visible environment input at the Go 1.23 defaults so a
# caller's exported GOFLAGS/GOARM cannot change the output bytes.
export GOTOOLCHAIN=local
export GOFLAGS=
export GOEXPERIMENT=
export GOAMD64=v1
export GOARM=7,hardfloat
export GO386=sse2

.PHONY: all dev release test e2e clean help check-toolchain

all: dev

# Host platform only — a cross-compile matrix in an inner loop is wasted
# seconds — with ../builds baked in as the binary source, so the full local
# workflow needs nothing exported and nothing remembered:
#
#   make -C .. cross-compile      # builds/webtmux-<os>-<arch>
#   make && ../builds/webtmux-launch testbox
dev:
	@mkdir -p $(OUTPUT_DIR)
	go build $(BUILD_FLAGS) -ldflags "$(LDFLAGS) -X main.DefaultSource=$(abspath $(OUTPUT_DIR))" \
		-o $(OUTPUT_DIR)/$(NAME) .
	@echo "Done: $(OUTPUT_DIR)/$(NAME) (source: $(abspath $(OUTPUT_DIR)))"

# main.DefaultSource is left EMPTY on purpose: a released launcher that defaulted
# to some directory on the builder's machine would look for a path that does not
# exist on the user's. Asserted by TestReleaseBuildHasNoDefaultSource.
#
# check-toolchain first: a release built by an unpinned compiler is one nobody
# else can reproduce, and that is worth failing over — unlike `dev`, which is
# left unguarded so ordinary work needs no exact Go version.
release: check-toolchain
	@mkdir -p $(OUTPUT_DIR)
	@echo "Building $(NAME) $(VERSION)..."
	@for platform in $(PLATFORMS); do \
		os=$$(echo $$platform | cut -d/ -f1); \
		arch=$$(echo $$platform | cut -d/ -f2); \
		echo "  Building $$os/$$arch..."; \
		GOOS=$$os GOARCH=$$arch go build $(BUILD_FLAGS) -ldflags "$(LDFLAGS)" \
			-o $(OUTPUT_DIR)/$(NAME)-$$os-$$arch . || exit 1; \
	done
	@ls -lh $(OUTPUT_DIR)/$(NAME)-*

# Same guard, same wording as the root Makefile's check-toolchain.
check-toolchain:
	@have=$$(go env GOVERSION 2>/dev/null || echo "none"); \
	if [ "$$have" != "go$(GO_VERSION)" ]; then \
		echo "Toolchain mismatch: this Go is $$have, the pinned toolchain is go$(GO_VERSION)."; \
		echo "  Override (output will not match a release):  ALLOW_TOOLCHAIN_DRIFT=1"; \
		[ -n "$(ALLOW_TOOLCHAIN_DRIFT)" ] || exit 1; \
		echo "  ALLOW_TOOLCHAIN_DRIFT set — continuing with $$have"; \
	fi

test:
	go test ./...
	go vet ./...

# Stands up a throwaway sshd+tmux container and drives the real launcher against
# it — probe, deploy, tunnel, adopt, split-view, durability, reconnect — entirely
# offline. Needs docker.
e2e:
	bash test/run.sh

clean:
	rm -f $(OUTPUT_DIR)/$(NAME) $(OUTPUT_DIR)/$(NAME)-*

help:
	@echo "webtmux-launch"
	@echo ""
	@echo "  make dev      Build for this machine, deploying webtmux from ../builds"
	@echo "  make release  Cross-compile for darwin/arm64, darwin/amd64, linux/amd64"
	@echo "  make test     Unit tests + go vet"
	@echo "  make e2e      End-to-end suite against a throwaway sshd container"
	@echo "  make clean    Remove built launcher binaries"
