#!/bin/bash

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
  meet
