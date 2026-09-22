#!/bin/bash

# Host directory for persistent data (SQLite DB + uploads)
DATA_HOST_DIR="$(dirname "$(realpath "$0")")/data"
mkdir -p "$DATA_HOST_DIR"

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
  -v "$DATA_HOST_DIR:/app/data" \
  meet
