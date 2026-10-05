// audience.js
// Keeps a listen-only session going on phones: listener audio plays through plain
// <audio> elements (treated as media, unlike Web Audio), the screen is kept awake,
// the lock screen gets media controls, and the session recovers by itself after
// the page was in the background or the connection dropped.
import { AppState } from './state.js';
import { showToast, recalculateLayout } from './ui.js';
import { ensureParticipantTile } from './livekit-handler.js';

const audioElements = new Set();
let wakeLock = null;
let pausedByUser = false;
let rejoinTimer = null;
let rejoinDelay = 0;
let started = false;

/** Plain media element for a speaker's audio; no Web Audio graph in between. */
export function attachAudienceAudio(track) {
    const element = track.attach();
    element.muted = pausedByUser;
    audioElements.add(element);
    track.once?.('ended', () => audioElements.delete(element));
    return element;
}

export function startAudienceSession() {
    if (started) return;
    started = true;
    requestWakeLock();
    setupMediaSession();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    // A tap releases audio the browser held back (see AudioPlaybackStatusChanged in main.js).
    window.addEventListener('pointerdown', resumePlayback, { passive: true });
    AppState.activeRoom.on(LivekitClient.RoomEvent.Disconnected, onDisconnected);
    AppState.activeRoom.on(LivekitClient.RoomEvent.Reconnected, () => { rejoinDelay = 0; resumePlayback(); });
}

export function stopAudienceSession() {
    if (!started) return;
    started = false;
    clearTimeout(rejoinTimer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pageshow', onVisible);
    window.removeEventListener('pointerdown', resumePlayback);
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
    }
}

// === 1. Screen wake lock: the browser drops it whenever the page is hidden ===
async function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
        // Denied (battery saver, unsupported context): listening still works.
    }
}

// === 3. Lock-screen / notification controls ===
function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: 'Listening', artist: 'schnackn.', album: 'Audience' });
        navigator.mediaSession.playbackState = 'playing';
        const set = (action, handler) => {
            try { navigator.mediaSession.setActionHandler(action, handler); } catch (e) {}
        };
        // Live audio cannot be paused, so pause mutes and play unmutes.
        set('pause', () => setPaused(true));
        set('stop', () => setPaused(true));
        set('play', () => setPaused(false));
    } catch (e) {}
}

function setPaused(paused) {
    pausedByUser = paused;
    audioElements.forEach(el => { el.muted = paused; });
    if (!paused) resumePlayback();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
}

// === 4. Recover after the background or a dropped connection ===
function resumePlayback() {
    const room = AppState.activeRoom;
    if (!room) return;
    if (!room.canPlaybackAudio) room.startAudio().catch(() => {});
    audioElements.forEach(el => {
        if (!el.isConnected) { audioElements.delete(el); return; }
        if (el.paused) el.play().catch(() => {});
    });
}

function onVisible() {
    if (document.visibilityState !== 'visible' || !AppState.activeRoom) return;
    requestWakeLock();
    resumePlayback();
    // Rejoin now instead of waiting out the backoff: the person is looking at the page.
    if (AppState.activeRoom.state === 'disconnected') { clearTimeout(rejoinTimer); rejoin(); }
}

function onDisconnected(reason) {
    // Leaving on purpose is not something to recover from.
    if (!started || reason === LivekitClient.DisconnectReason?.CLIENT_INITIATED) return;
    showToast('Connection lost. Reconnecting…', 'warn', 5000);
    scheduleRejoin();
}

function scheduleRejoin() {
    clearTimeout(rejoinTimer);
    rejoinDelay = Math.min(rejoinDelay ? rejoinDelay * 2 : 2000, 30000);
    rejoinTimer = setTimeout(rejoin, rejoinDelay);
}

// LiveKit retries short drops itself; this handles a session that ended (long sleep,
// network switch). A fresh token is needed because the old one may have expired.
async function rejoin() {
    const room = AppState.activeRoom;
    if (!started || !room || room.state !== 'disconnected') return;
    // Hidden pages get throttled timers anyway; try again when the page is visible.
    if (document.visibilityState !== 'visible') { scheduleRejoin(); return; }
    try {
        const res = await fetch('/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audienceId: AppState.audienceId, clientId: localStorage.getItem('portal_client_id') })
        });
        if (res.status === 404) {
            stopAudienceSession();
            showToast('This audience link is no longer valid. Ask the host for a new one.', 'error', 8000);
            return;
        }
        const info = await res.json();
        if (!res.ok || !info.token) throw new Error('TOKEN');
        await room.connect(info.serverUrl, info.token);
        room.remoteParticipants.forEach(p => ensureParticipantTile(p, 'camera'));
        recalculateLayout();
        rejoinDelay = 0;
        showToast('Reconnected.');
        resumePlayback();
    } catch (e) {
        console.warn('[Audience] Rejoin failed, retrying');
        scheduleRejoin();
    }
}
