<p align="center">
  <img src="public/schnackn-wordmark.svg" width="504" alt="schnackn.">
</p>

A lightweight, self-hosted video meeting app for joining a room without an account or installation. The idea is simple: open a link, enter a name, and talk—while keeping the interface playful, responsive, and resilient across devices.

The browser client is built with vanilla JavaScript and CSS; a small Node.js service handles room access, short-lived collaboration data, and LiveKit tokens.

## Features

- Instant rooms via shareable links, with optional password protection
- Invite dialog with copyable links and QR codes; a protected room's link carries its password
- Audience links for talks: a listen-only view behind a link that hides the room name and needs no password. Listeners have no mic, camera, chat or sharing, stay invisible to the room, and can pass the link on by QR code. On phones the listener view keeps the screen awake, shows lock-screen controls and reconnects by itself
- Video and audio calls powered by LiveKit, including device selection and graceful audio-only/listen-only fallbacks
- Responsive participant grids, screen-sharing layouts, resizable picture-in-picture, and fullscreen mode
- Screen sharing and local browser recording
- Reactions, raised hands, active-speaker feedback, and sound-processing controls
- Ephemeral chat (1 minute) and file sharing up to 200 MB (10 minutes)
- Pixel and Prism visual themes
- Status page with active-room and usage statistics
- Automatic removal of inactive room records after 7 days

## Deployment requirements

- A reachable [LiveKit](https://livekit.io/) deployment and API credentials
- Node.js 20 or newer for direct deployment, or Docker
- A writable persistent data directory for SQLite and temporary uploads
- HTTPS for the web app and WSS for LiveKit in production; browsers require a secure context for camera, microphone, and screen access

LiveKit's secure WebSocket (WSS) signaling connection is mandatory even when all media is relayed through TURN. TURN is a media-connectivity fallback and does not replace signaling. Corporate firewalls and proxies must therefore allow outbound WSS/HTTPS to the configured LiveKit host as well as the deployment's required WebRTC/TURN ports.

For restrictive networks, serve LiveKit signalling as `wss://` on port 443 behind your reverse proxy, and enable TURN over TLS on port 443 (LiveKit's `turn.tls_port`). Clients built on MatrixRTC (Element Call) use the same LiveKit client and WebSocket signalling. If they work on a network where this app doesn't, compare their LiveKit URL with `LIVEKIT_URL` here. When joining fails, the join screen says which step failed: the server can't be reached at all, its WebSocket is blocked, or signalling worked but audio and video couldn't get through. It also names the host, so the message can go to an IT department as is.

Configuration is provided through environment variables:

```env
PORT=3000
LIVEKIT_URL=wss://livekit.example.com
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
LIVEKIT_HTTP_URL=https://livekit.example.com
DATA_DIR=./data
```

`LIVEKIT_HTTP_URL` is optional when it can be derived from `LIVEKIT_URL`. Development defaults exist for local LiveKit, but explicit credentials should always be used in production.

## Run locally

With LiveKit available and the environment variables exported or supplied by your process manager:

```bash
npm install
npm start
```

For automatic server restarts during development:

```bash
npm run dev
```

The app listens on `http://localhost:3000` by default.

## Run with Docker

```bash
docker build -t schnackn .
docker run -d \
  --name schnackn \
  --restart unless-stopped \
  -p 3000:3000 \
  -e LIVEKIT_URL="wss://livekit.example.com" \
  -e LIVEKIT_API_KEY="your_api_key" \
  -e LIVEKIT_API_SECRET="your_api_secret" \
  -e DATA_DIR=/app/data \
  -v "$(pwd)/data:/app/data" \
  schnackn
```

The container runs as UID/GID `10001`; ensure the mounted data directory is writable by that user. Put the service behind an HTTPS reverse proxy for production use.

## Data lifetime

Chat messages are retained for about 1 minute, shared files for about 10 minutes, and inactive room records for 7 days. An audience link stops working when its room record is removed. SQLite data and uploads live under `DATA_DIR`; media streams are routed through LiveKit.

## Acknowledgement

This project was created with the assistance of multiple large language models (LLMs), used across design, implementation, review, and documentation.

## License

See [LICENSE](LICENSE).
