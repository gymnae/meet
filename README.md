<p align="center">
  <img src="public/schnackn-wordmark.svg" width="504" alt="schnackn.">
</p>

**Open a link. Type a name. Talk.** No account, no install, no nonsense. A self-hosted video room built with vanilla JS and a small Node server, on top of LiveKit.

## What it does

- **Instant rooms** with optional passwords, invite links and QR codes
- **Audience links** for talks: listen-only, invisible to the room, room name hidden. On phones it keeps the screen awake and reconnects by itself
- **Backgrounds that look good:** soft-edged blur with no halo, pixel-art and smooth backdrops, your own photos, GIFs and videos. Uses the platform's own blur where there is one, otherwise GPU segmentation that steps down on slower devices. On by default
- **Streamer mode:** your screen with you cut out in the corner, sent as one picture
- **Chat that keeps formatting** pasted from Docs, Word or code editors, plus **quick polls** and file sharing up to 200 MB
- **Gone when you're gone:** chat, files and polls are deleted once everyone has left. Disappearing messages are one click away
- Screen sharing, local recording, reactions, raised hands, sound controls and "Hear yourself" monitoring
- **Resize anything:** drag the chat wider, any video tile larger, your own preview and the speaker strip
- Two themes, **Pixel** and **Prism**, both mobile-first
- **Works on locked-down networks:** the LiveKit client is self-hosted, so no CDN is needed, and failed joins say exactly what was blocked

## Run it

You need a [LiveKit](https://livekit.io/) server, plus Node.js 20+ or Docker.

```env
LIVEKIT_URL=wss://livekit.example.com
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
LIVEKIT_HTTP_URL=https://livekit.example.com   # optional, derived from LIVEKIT_URL
PORT=3000
DATA_DIR=./data
```

```bash
npm install && npm start        # or: npm run dev
```

```bash
docker build -t schnackn .
docker run -d --name schnackn --restart unless-stopped -p 3000:3000 \
  -e LIVEKIT_URL="wss://livekit.example.com" \
  -e LIVEKIT_API_KEY="your_api_key" -e LIVEKIT_API_SECRET="your_api_secret" \
  -e DATA_DIR=/app/data -v "$(pwd)/data:/app/data" schnackn
```

The container runs as UID/GID `10001`, so the data directory must be writable by that user.

In production, serve the app over HTTPS and LiveKit over WSS: browsers only allow camera and mic access on secure pages. For strict corporate networks, put LiveKit signalling on `wss://` port 443 and enable TURN over TLS on 443 (`turn.tls_port`). TURN does not replace the WSS signalling connection.

## Data

Chat, files and polls are removed about 2 minutes after the room empties, and after 24 hours at the latest. With disappearing messages on, chat goes after 1 minute and files after 10. Room records expire after 7 days of inactivity. Everything lives in SQLite under `DATA_DIR`. Your own background pictures never leave your browser.

## Acknowledgement

Built with the help of several large language models, across design, code, review and docs.

## License

See [LICENSE](LICENSE). `public/models/selfie_segmenter*.tflite` are Google's MediaPipe models (Apache 2.0).
