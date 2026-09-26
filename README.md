# meet.

> A frictionless, zero-install WebRTC video workspace wrapped in an 80s/90s Synthwave aesthetic.

---

## Project Goals

* **Zero Friction:** No account creation, installations, or app downloads. Instant room entry via deep links (`/#room-name`).
* **Resilient UX:** Graceful degradation across missing hardware, permission locks, and dynamic viewport resizing without crashing the call.
* **Minimalist Footprint:** Built entirely with Vanilla JavaScript and native CSS Grid—no bulky frontend frameworks (React/Vue), ensuring instantaneous loading and low resource usage.
* **Ephemeral Privacy:** Rooms are created on demand, can be optionally secured with passwords, and automatically self-purge after 7 days of inactivity.

---

## System Architecture

The application implements a decoupled, event-driven client-server model powered by **LiveKit SFU**.

* **Client:** Pure HTML5, CSS3, and Vanilla ES6 modules using `livekit-client` for WebRTC media routing and real-time DataChannel signaling.
* **Backend:** Node.js (v20+) with Express, functioning as a lightweight authentication gateway that issues cryptographic JWT tokens and tracks room states via `livekit-server-sdk`.
* **Data Storage:** SQLite via `better-sqlite3` for fast, low-overhead room tracking, password hashing (SHA-256), and automated cleanup routines.
* **Containerization:** Multi-stage Docker build (`node:20-slim`). Compilation toolchains (Python, make, g++) are isolated to the build stage, producing a minimal, secure production image.

---

## Core Features & Solution

* **Dynamic Geometry Engine:** A mathematical layout algorithm that computes optimal grid dimensions using viewport aspect ratios. Tiles scale dynamically to ensure zero overflow or scrolling.
* **Presentation Mode:** Automatically transitions to a split-screen layout when screen sharing is detected—locking the presentation to the primary view and stacking attendee cards in a responsive side column.
* **Waterfall Fallback Engine:** Gracefully steps down media acquisition if devices are disconnected or missing (`Video + Audio` -> `Audio Only` -> `Video Only` -> `Listen-Only Mode`) to prevent WebRTC initialization panics.
* **Permission Gateway:** Bypasses browser device-fingerprinting shields by providing explicit permission prompts directly inside contextual audio/video selector menus.
* **Local Vault:** Persists usernames and room passwords in `localStorage` for frictionless re-entry into recurrent or protected meetings.
* **Contextual Collaboration:** In-call emoji reactions, hand-raising state flags, active speaker indicators, and automatic mass-mute rules (>5 participants) with speaking-state exemptions.
* **Sound Board:** A *Sounds* tab in the React menu plays short sounds for everyone in the room. A click is sent over the DataChannel and every listener plays the file locally, so no bot joins and each person has their own sound volume and on/off switch (Sound settings). The playing person's tile shows the sound's name. Recordings include the sounds.

---

## Quick Start

### 1. Environment Setup
Create a `.env` file in the project root:

```env
PORT=3000
LIVEKIT_URL=wss://your-livekit-instance.com
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
```

Optional sound board settings:

```env
SOUNDBOARD_URL=https://soundboard.example.com   # use a running Mumble Retro Soundboard's library
SOUNDS_DIR=/app/sounds   # or: folder with .mp3 .wav .m4a .ogg .flac files (default: ./sounds)
SOUNDS_MAX_MB=3          # larger files are left out of the board (default: 3)
```

The sound board shares its library with the [Mumble Retro Soundboard](https://github.com/gymnae/mumblesoundboard), in one of two ways:

* **From a running soundboard:** set `SOUNDBOARD_URL`. meet reads the list from its `/api/sounds` endpoint (refreshed every minute) and passes the files through, so browsers only ever talk to meet and the soundboard can stay on an internal address. If it sits behind Basic auth, put the credentials in the URL (`https://user:pass@host`). If the soundboard is unreachable, the last known list stays in use.
* **From its folder:** mount the soundboard's `sounds/` folder read-only: `-v /path/to/retro-soundboard/sounds:/app/sounds:ro`. The container runs as uid 10001, so the files must be readable for it (e.g. `chmod -R a+rX sounds`).

Without a library the board is simply not shown. Every listener downloads and decodes a sound in full, and playback stops after 20 seconds, so the board is meant for short sounds; long music belongs to the soundboard's bot.

### 2. Run with Docker Compose

```bash
docker compose up -d --build
```

### 3. Local Development

```bash
npm install
npm start
```
