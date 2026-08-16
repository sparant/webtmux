#!/bin/bash
# End-to-end check of the two file-transfer routes against a REAL running
# webtmux with a REAL tmux session behind it.
#
# The Go tests call the handlers directly, which proves the logic but says
# nothing about the things only a booted server can get wrong: whether the routes
# are registered at all, whether they ended up behind Basic auth (they must) or
# in front of it (a hole), and whether a folder really arrives as a zip that
# `unzip` will open.
#
# Run inside a container that has tmux, curl, unzip and the built binary:
#   docker run --rm -v $PWD:/src -w /src webtmux-verify:latest bash test/verify-transfer.sh
set -u

PORT=8091
CRED="wt:wt"
BASE="http://127.0.0.1:$PORT"
FAR=/tmp/far          # stands in for the machine tmux runs on
NEAR=/tmp/near        # stands in for the machine the browser runs on
pass=0; fail=0

ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; echo "        $2"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got '$2', want '$3'"; fi; }

rm -rf "$FAR" "$NEAR"; mkdir -p "$FAR/incoming" "$FAR/project/nested" "$NEAR"
echo "the build log" > "$FAR/build.log"
echo "alpha" > "$FAR/project/a.txt"
echo "bravo" > "$FAR/project/nested/b.txt"
ln -sf /etc/passwd "$FAR/project/escape-link"
echo "a secret nobody asked for" > /tmp/secret-outside

echo "upload me"  > "$NEAR/report.txt"
mkdir -p "$NEAR/tree/src"
echo "nested upload" > "$NEAR/tree/src/util.js"

# WEBTMUX_SAVE_DIR is the operator declaring "this directory is shared", which is
# the only thing that makes any path reachable. Everything outside it must stay
# unreachable, and that is what most of the checks below are about.
export WEBTMUX_SAVE_DIR="$FAR" WEBTMUX_HOME="$FAR" WEBTMUX_IN_CONTAINER=1
export WEBTMUX_SOCKET=/tmp/wt-xfer.sock WEBTMUX_SESSION=xfer

tmux -S "$WEBTMUX_SOCKET" kill-server 2>/dev/null
tmux -S "$WEBTMUX_SOCKET" new-session -d -s xfer -c "$FAR" -x 80 -y 24
sleep 0.5

./webtmux-test -w -p $PORT -a 127.0.0.1 -c "$CRED" \
  tmux -S "$WEBTMUX_SOCKET" attach -t xfer > /tmp/xfer-server.log 2>&1 &
SV=$!
trap 'kill $SV 2>/dev/null; tmux -S "$WEBTMUX_SOCKET" kill-server 2>/dev/null' EXIT

for _ in $(seq 1 40); do
  curl -fsS -u "$CRED" -o /dev/null "$BASE/" && break
  sleep 0.25
done
if ! curl -fsS -u "$CRED" -o /dev/null "$BASE/"; then
  echo "server never came up"; tail -20 /tmp/xfer-server.log; exit 1
fi
echo "webtmux up on :$PORT"

echo
echo "-- the routes are behind the same auth as the page --"
# A transfer route in front of Basic auth would hand the filesystem to anyone who
# can reach the port. This is the check that matters most.
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/transfer/download?path=$FAR/build.log")
check "unauthenticated download is refused" "$code" "401"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/transfer/upload?dest=$FAR/incoming")
check "unauthenticated upload is refused" "$code" "401"

echo
echo "-- download: the machine tmux runs on -> this browser --"
curl -fsS -u "$CRED" -o "$NEAR/got.log" "$BASE/transfer/download?path=$FAR/build.log"
check "a single file arrives intact" "$(cat "$NEAR/got.log" 2>/dev/null)" "the build log"

hdr=$(curl -sS -u "$CRED" -D - -o /dev/null "$BASE/transfer/download?path=$FAR/build.log")
if echo "$hdr" | grep -qi 'content-disposition: *attachment'; then
  ok "it is sent as an attachment"
else
  bad "it is sent as an attachment" "$(echo "$hdr" | grep -i content-disposition)"
fi

# A bare name resolves against the declared directory, which is what lets the
# dropdown's hint say "plain names are relative to <dir>".
curl -fsS -u "$CRED" -o "$NEAR/rel.log" "$BASE/transfer/download?path=build.log"
check "a bare name resolves on the far machine" "$(cat "$NEAR/rel.log" 2>/dev/null)" "the build log"

probe=$(curl -sS -u "$CRED" "$BASE/transfer/download?probe=1&path=$FAR/project")
echo "$probe" | grep -q '"isDir":true' && ok "the probe reports a folder as a folder" \
  || bad "the probe reports a folder as a folder" "$probe"
echo "$probe" | grep -q 'symlink' && ok "the probe names the symlink it will skip" \
  || bad "the probe names the symlink it will skip" "$probe"

curl -fsS -u "$CRED" -o "$NEAR/project.zip" "$BASE/transfer/download?path=$FAR/project"
if unzip -l "$NEAR/project.zip" > /tmp/ziplist 2>&1; then
  ok "a folder arrives as a zip that unzip can open"
  grep -q 'project/a.txt' /tmp/ziplist && grep -q 'project/nested/b.txt' /tmp/ziplist \
    && ok "the zip keeps the folder's shape" || bad "the zip keeps the folder's shape" "$(cat /tmp/ziplist)"
  # Following it would turn "download this folder" into "download /etc/passwd".
  grep -q 'escape-link' /tmp/ziplist \
    && bad "the zip omits symlinks" "escape-link was archived" || ok "the zip omits symlinks"
else
  bad "a folder arrives as a zip that unzip can open" "$(cat /tmp/ziplist)"
fi

echo
echo "-- containment holds over HTTP, not just in the unit tests --"
body=$(curl -sS -u "$CRED" "$BASE/transfer/download?path=/tmp/secret-outside")
echo "$body" | grep -q 'secret nobody asked for' \
  && bad "a path outside the declared directory is refused" "the file was served" \
  || ok "a path outside the declared directory is refused"
body=$(curl -sS -u "$CRED" "$BASE/transfer/download?path=$FAR/project/escape-link")
echo "$body" | grep -q 'root:' \
  && bad "a symlink out of the directory is refused" "/etc/passwd was served" \
  || ok "a symlink out of the directory is refused"

echo
echo "-- upload: this browser -> the machine tmux runs on --"
out=$(curl -sS -u "$CRED" -X POST "$BASE/transfer/upload?dest=$FAR/incoming" \
  -F "path:report.txt=@$NEAR/report.txt")
echo "$out" | grep -q '"ok":true' && ok "a single file uploads" || bad "a single file uploads" "$out"
check "…and lands with its contents" "$(cat "$FAR/incoming/report.txt" 2>/dev/null)" "upload me"

out=$(curl -sS -u "$CRED" -X POST "$BASE/transfer/upload?dest=$FAR/incoming" \
  -F "path:tree/src/util.js=@$NEAR/tree/src/util.js")
echo "$out" | grep -q '"ok":true' && ok "a folder upload rebuilds its tree" \
  || bad "a folder upload rebuilds its tree" "$out"
check "…at the right depth" "$(cat "$FAR/incoming/tree/src/util.js" 2>/dev/null)" "nested upload"

# Re-sending the same name must not silently replace what is there.
out=$(curl -sS -u "$CRED" -X POST "$BASE/transfer/upload?dest=$FAR/incoming" \
  -F "path:report.txt=@$NEAR/report.txt")
echo "$out" | grep -q 'already exists' && ok "an existing file is not replaced unasked" \
  || bad "an existing file is not replaced unasked" "$out"

echo "replaced" > "$NEAR/report.txt"
out=$(curl -sS -u "$CRED" -X POST "$BASE/transfer/upload?dest=$FAR/incoming&overwrite=1" \
  -F "path:report.txt=@$NEAR/report.txt")
check "…and is replaced when asked" "$(cat "$FAR/incoming/report.txt" 2>/dev/null)" "replaced"

out=$(curl -sS -u "$CRED" -X POST "$BASE/transfer/upload?dest=$FAR/incoming" \
  -F "path:../../escaped.txt=@$NEAR/report.txt")
if [ -f /escaped.txt ] || [ -f /tmp/escaped.txt ]; then
  bad "a .. in an uploaded name cannot escape" "a file landed outside the destination"
else
  ok "a .. in an uploaded name cannot escape"
fi

out=$(curl -sS -u "$CRED" -X POST "$BASE/transfer/upload?dest=/tmp" \
  -F "path:x.txt=@$NEAR/report.txt")
[ -f /tmp/x.txt ] && bad "an undeclared destination is refused" "wrote /tmp/x.txt" \
  || ok "an undeclared destination is refused"

echo
echo "======================================"
echo "  $pass passed, $fail failed"
echo "======================================"
[ "$fail" = "0" ]
