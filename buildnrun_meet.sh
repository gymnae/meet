#!/bin/bash

# Host directory for persistent data (SQLite DB + uploads)
DATA_HOST_DIR="$(dirname "$(realpath "$0")")/data"
mkdir -p "$DATA_HOST_DIR"

# The container runs as unprivileged user 'meet' (uid/gid 10001).
# Make the host data dir writable for it (needs root or ownership of the dir).
if [ "$(id -u)" = "0" ]; then
  chown -R 10001:10001 "$DATA_HOST_DIR"
else
  sudo chown -R 10001:10001 "$DATA_HOST_DIR" 2>/dev/null || chmod -R a+rwX "$DATA_HOST_DIR"
fi

# Optional sound board library, shared with the Mumble soundboard. Either set
# SOUNDBOARD_URL to the running soundboard, or SOUNDS_HOST_DIR to its sounds folder
# (mounted read-only; the files only need to be readable for uid 10001).
SOUNDBOARD_URL=""
SOUNDS_HOST_DIR=""
SOUNDS_MOUNT=()
if [ -n "$SOUNDS_HOST_DIR" ]; then
  SOUNDS_MOUNT=(-v "$SOUNDS_HOST_DIR:/app/sounds:ro")
fi

docker build -t meet .
docker kill meet
docker rm meet
docker run -d \
  --name livekit-meet \
  --restart unless-stopped \
  -p 3000:3000 \
  -e LIVEKIT_URL="<YOURLIVEKITURL>" \
  -e LIVEKIT_API_KEY="<YOURLIVEKITAPIKEY>" \
  -e LIVEKIT_API_SECRET="<YOURLIVEKITAPISECRET>" \
  -e DATA_DIR=/app/data \
  -e SOUNDBOARD_URL="$SOUNDBOARD_URL" \
  -v "$DATA_HOST_DIR:/app/data" \
  "${SOUNDS_MOUNT[@]}" \
  meet
