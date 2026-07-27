#!/bin/bash
# Assert the toolbar spinner's INK, on the pixels, from the two crops verify-ux5.js
# writes (connected vs connection-lost).
#
# This exists because the spinner's colour has been un-checkable from inside the page
# twice over. It shipped as the character ✳, which Chromium renders from the
# color-emoji font — a colour-emoji glyph ignores `color` outright, so the control was
# green-on-navy forever while getComputedStyle cheerfully reported whatever CSS said.
# Replacing it with a drawn SVG then hit lit's namespace trap (interpolated children of
# an <svg> need the svg`` tag, not html``), which draws NOTHING at all — and, again,
# every class and computed-style assertion passed. Only the rendered pixels can tell
# you this control is on screen and the right colour.
#
# Usage: check-spinner-ink.sh <connected.png> <lost.png>
set -u
ok=$1
lost=$2

# Mean colour of a crop. The spinner is a thin figure on a fixed navy background, so
# the mean moves with the ink and nothing else; comparing the two states against each
# other is what makes a fixed threshold unnecessary.
mean() {  # $1 file, $2 channel index (0=r,1=g,2=b)
  convert "$1" -resize 1x1! -format "%[fx:round(255*u.$2)]" info:
}

okr=$(mean "$ok" r);   okg=$(mean "$ok" g);   okb=$(mean "$ok" b)
lor=$(mean "$lost" r); log=$(mean "$lost" g); lob=$(mean "$lost" b)

echo "connected mean rgb($okr,$okg,$okb)"
echo "lost      mean rgb($lor,$log,$lob)"

fail=0
# 1. The spinner is actually drawn: its crop cannot be the bare toolbar background
#    (#16213e = 22,33,62). An invisible control passes every DOM assertion there is.
if [ "$okr" -eq 22 ] && [ "$okg" -eq 33 ] && [ "$okb" -eq 62 ]; then
  echo "FAIL  the connected spinner is invisible — the crop is pure background"; fail=1
else
  echo "PASS  the spinner is drawn while connected"
fi

# 2. Losing tmux moves it toward red: more red than the connected state, and redder
#    than it is green. (Connected is blue #4a9eff, so this separates cleanly.)
if [ "$lor" -gt "$okr" ] && [ "$lor" -gt "$log" ]; then
  echo "PASS  the lost spinner's ink is red on the pixels"
else
  echo "FAIL  the lost spinner is not red on the pixels"; fail=1
fi

exit $fail
