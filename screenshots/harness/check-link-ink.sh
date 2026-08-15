#!/bin/bash
# Assert the toolbar spinner's three connection states are distinguishable ON THE
# PIXELS, from the crops verify-link-health.js writes (live / slow / lost).
#
# The companion to check-spinner-ink.sh, and it exists for the same reason: the
# spinner's colour has been un-checkable from inside the page twice over (a colour-emoji
# glyph that ignores `color`, and an interpolated <svg> child that rendered nothing),
# and every class and computed-style assertion passed happily through both. A third
# state is worth exactly nothing if it looks like one of the other two.
#
# Usage: check-link-ink.sh <live.png> <slow.png> <lost.png>
set -u
live=$1
slow=$2
lost=$3

# Mean colour of a crop. The spinner is a thin figure on a fixed navy background
# (#16213e = 22,33,62), so the mean moves with the ink and nothing else.
mean() { convert "$1" -resize 1x1! -format "%[fx:round(255*u.$2)]" info:; }

lvr=$(mean "$live" r); lvg=$(mean "$live" g); lvb=$(mean "$live" b)
slr=$(mean "$slow" r); slg=$(mean "$slow" g); slb=$(mean "$slow" b)
lsr=$(mean "$lost" r); lsg=$(mean "$lost" g); lsb=$(mean "$lost" b)

echo "live rgb($lvr,$lvg,$lvb)  slow rgb($slr,$slg,$slb)  lost rgb($lsr,$lsg,$lsb)"

fail=0
pass() { echo "PASS  $1"; }
bad()  { echo "FAIL  $1"; fail=1; }

# 1. Live is COOL: the healthy spinner is blue (#6cb6ff), so blue leads red.
[ "$lvb" -gt "$lvr" ] && pass "the healthy spinner is blue on the pixels" \
  || bad "the healthy spinner is not blue"

# 2. Slow is WARM: amber (#ffb454) leads with red and drops blue below it. This is the
#    check that would have caught an amber class that never reached the drawn icon.
[ "$slr" -gt "$slb" ] && pass "the slow spinner is warm (amber) on the pixels" \
  || bad "the slow spinner is not warm — amber never reached the ink"

# 3. Amber is not just "live with extra red": it has to read as a different control.
[ "$slr" -gt "$lvr" ] && [ "$slg" -gt "$lvg" ] && pass "slow is clearly distinct from live" \
  || bad "slow and live are too close to tell apart"

# 4. …and not a shade of the red one either. Amber keeps its green; red does not.
[ "$slg" -gt "$lsg" ] && pass "slow is clearly distinct from lost" \
  || bad "slow and lost are too close to tell apart"

# 5. Lost is still red-leaning, as it always was.
[ "$lsr" -gt "$lsg" ] && pass "the lost spinner is still red on the pixels" \
  || bad "the lost spinner is not red"

exit $fail
