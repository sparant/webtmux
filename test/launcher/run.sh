#!/usr/bin/env bash
# Stand up the launcher's throwaway test rig and run the end-to-end suite.
#
#   test/launcher/run.sh            # build everything and run the suite
#   test/launcher/run.sh --shell    # drop into the client container instead
#   test/launcher/run.sh --keep     # leave the containers running afterwards
#
# Two containers on a private network: a "Mac" (Go toolchain + ssh + curl) that
# runs webtmux-launch, and a target that has only sshd and tmux — no Go, no
# curl, no webtmux. That asymmetry is the point: it proves the target needs
# nothing but ssh and tmux.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
HERE="$REPO/test/launcher"
NET=wtl-net
TARGET_C=wtl-target
CLIENT_C=wtl-client
KEEP=0
MODE=run

for arg in "$@"; do
  case "$arg" in
    --shell) MODE=shell ;;
    --keep)  KEEP=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cleanup() {
  [ "$KEEP" = 1 ] && return
  docker rm -f "$TARGET_C" "$CLIENT_C" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The rig directory lives inside the repo on purpose: the docker daemon this
# runs against may not be able to bind-mount paths outside the workspace (a
# rootless daemon in a container can only share what it can see), and /tmp is
# one of those. Gitignored.
WORK="$REPO/.launcher-rig"
rm -rf "$WORK"; mkdir -p "$WORK"
echo "== generating a throwaway ssh key"
ssh-keygen -t ed25519 -N '' -f "$WORK/id_ed25519" -q
cp "$WORK/id_ed25519.pub" "$HERE/authorized_keys"

echo "== building the target image (sshd + tmux only)"
docker build -q -f "$HERE/Dockerfile.target" -t wtl-target:test "$HERE" >/dev/null
rm -f "$HERE/authorized_keys"

echo "== building the client image (go + ssh + curl)"
docker build -q -t wtl-client:test - >/dev/null <<'DOCKERFILE'
FROM golang:1.23
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client curl iproute2 \
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE

docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f "$TARGET_C" "$CLIENT_C" >/dev/null 2>&1 || true

echo "== starting the target"
docker run -d --name "$TARGET_C" --network "$NET" wtl-target:test >/dev/null
for _ in $(seq 40); do
  docker exec "$TARGET_C" sh -c 'pgrep -x sshd >/dev/null' 2>/dev/null && break
  sleep 0.25
done

echo "== cross-compiling webtmux into builds/ and building the launcher"
# cross-compile depends on clean, which wipes builds/ — so the launcher must be
# built after it, not before.
# safe.directory: the checkout is owned by a different uid than the build
# container's root, and `go build` stamps VCS info by default — without this it
# fails with "error obtaining VCS status" after a successful compile.
docker run --rm -v "$REPO":/src -v wtl-gomod:/go/pkg/mod -w /src wtl-client:test \
  sh -c 'git config --global --add safe.directory /src
         make cross-compile && make launcher-dev' >/dev/null

RUNARGS=(--rm --name "$CLIENT_C" --network "$NET"
         -v "$REPO":/src -v "$WORK":/keys -v wtl-gomod:/go/pkg/mod
         -e TARGET=dev@"$TARGET_C" -e SSH_KEY=/keys/id_ed25519 -e REPO=/src
         -e WEBTMUX_LAUNCH_SOURCE=/src/builds
         # 3.16b is opt-in because it is ~30 minutes of waiting.
         -e WTL_LONG -e WTL_IDLE_SECONDS
         -w /src wtl-client:test)

# The launcher shells out to ssh and inherits ~/.ssh/config; in the rig there is
# none, so point it at the throwaway key and skip host-key prompts.
SSHCONF='Host *
  IdentityFile /keys/id_ed25519
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
'

if [ "$MODE" = shell ]; then
  exec docker run -it "${RUNARGS[@]}" bash -c "mkdir -p ~/.ssh && printf '%s' '$SSHCONF' > ~/.ssh/config && exec bash"
fi

echo "== running the suite"
docker run "${RUNARGS[@]}" bash -c "mkdir -p ~/.ssh && printf '%s' '$SSHCONF' > ~/.ssh/config && bash /src/test/launcher/e2e.sh"
