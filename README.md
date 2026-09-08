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

### 2. Run with Docker Compose

```bash
docker compose up -d --build
```

### 3. Local Development

```bash
npm install
npm start
```
