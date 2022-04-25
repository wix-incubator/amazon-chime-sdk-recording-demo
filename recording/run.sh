#!/bin/bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

_kill_procs() {
  kill -TERM $node
  wait $node
  kill -TERM $firefox
  wait $firefox
  kill -TERM $xvfb
  wait $xvfb
}

# Setup a trap to catch SIGTERM/SIGINT and relay it to child processes
trap _kill_procs SIGTERM SIGINT

echo v16-wix

set -xeo pipefail

: "${RECORDER_DELAY:=7}"
: "${UNBLOCK_CLICK_X:=1}"
: "${UNBLOCK_CLICK_Y:=100}"
BROWSER_URL="${TARGET_URL}"
SCREEN_WIDTH=${RECORDING_SCREEN_WIDTH:-'1280'}
SCREEN_HEIGHT=${RECORDING_SCREEN_HEIGHT:-'720'}
SCREEN_RESOLUTION=${SCREEN_WIDTH}x${SCREEN_HEIGHT}
COLOR_DEPTH=24
XVFB_WHD="${SCREEN_RESOLUTION}x${COLOR_DEPTH}"
X_SERVER_NUM=1
S3_BUCKET_NAME=${RECORDING_ARTIFACTS_BUCKET}

# Start PulseAudio server so Firefox will have somewhere to which to send audio
pulseaudio -D --exit-idle-time=-1
pacmd load-module module-virtual-sink sink_name=v1  # Load a virtual sink as `v1`
pacmd set-default-sink v1  # Set the `v1` as the default sink device
pacmd set-default-source v1.monitor  # Set the monitor of the v1 sink to be the default source

# Start X11 virtual framebuffer so Firefox will have somewhere to draw
sudo Xvfb :${X_SERVER_NUM} -ac -screen 0 $XVFB_WHD -nolisten tcp &
xvfb=$!
export DISPLAY=:${X_SERVER_NUM}.0
sleep 0.5  # Ensure this has started before moving on

# Create a new Firefox profile for capturing preferences for this
firefox --no-remote --new-instance --createprofile "foo4 /tmp/foo4"

# Install the OpenH264 plugin for Firefox
mkdir -p /tmp/foo4/gmp-gmpopenh264/2.2.0/
cp /tmp/libopenh264-2.2.0-linux64.6.so /tmp/foo4/gmp-gmpopenh264/2.2.0/libgmpopenh264.so
cat <<EOF >> /tmp/foo4/gmp-gmpopenh264/2.2.0/gmpopenh264.info
Name: gmpopenh264
Description: GMP Plugin for OpenH264.
Version: 2.2.0
APIs: encode-video[h264], decode-video[h264]
EOF

# Set the Firefox preferences to enable automatic media playing with no user
# interaction and the use of the OpenH264 plugin.
# media.setsinkid.enabled is recommended for firefox: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId
cat <<EOF >> /tmp/foo4/prefs.js
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.enabled.user-gestures-needed", false);
user_pref("media.navigator.permission.disabled", true);
user_pref("media.gmp-gmpopenh264.abi", "x86_64-gcc3");
user_pref("media.gmp-gmpopenh264.lastUpdate", 1571534329);
user_pref("media.gmp-gmpopenh264.version", "2.2.0");
user_pref("doh-rollout.doorhanger-shown", true);
user_pref("media.setsinkid.enabled", true);
EOF

# Start Firefox browser and point it at the URL we want to capture
#
# NB: The `--width` and `--height` arguments have to be very early in the
# argument list or else only a white screen will result in the capture for some
# reason.

firefox \
  -P foo4 \
  --width ${SCREEN_WIDTH} \
  --height ${SCREEN_HEIGHT} \
  --new-instance \
  --first-startup \
  --foreground \
  --kiosk \
  --ssb ${BROWSER_URL} \
  &
firefox=$!
# sleep 0.5  # Ensure this has started before moving on
# xdotool mousemove 1 1 click 1  # Move mouse out of the way so it doesn't trigger the "pause" overlay on the video tile

# Let's make sure user action is performed to show video
while true; do
  # Since we do not know whether we joined yet -
  # keep clicking harmlessly forever in a separate thread
  xdotool mousemove $UNBLOCK_CLICK_X $UNBLOCK_CLICK_Y click 1 > /dev/null 2>&1
  sleep 1 > /dev/null 2>&1
done &

sleep $RECORDER_DELAY # Skip part of long loading procedure...

node /recording/record.js ${S3_BUCKET_NAME} ${SCREEN_WIDTH} ${SCREEN_HEIGHT} &
node=$!

wait $node
wait $firefox
wait $xvfb
