import { AppState } from './state.js';
import { sendDataPacket } from './livekit-handler.js';
import { renderFile, renderMessage, scrollChatToBottom, renderSystemNote } from './chat.js';
import { setDockLabel } from './ui.js';

let recTimer = null;
function startRecTimer(btn, startTime) {
    clearInterval(recTimer);
    const tick = () => {
        const s = Math.floor((Date.now() - startTime) / 1000);
        setDockLabel(btn, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    };
    tick();
    recTimer = setInterval(tick, 1000);
}

// === CLIENT-SIDE COMPOSITE RECORDER (Desktop-only entry point) ===
// Records only the local view: composites existing <video> elements onto a
// canvas at 15fps / 720p and mixes already-decoded audio via AudioContext.
// Zero impact on other participants: nothing is re-encoded or re-published.

let mediaRecorder = null;
let drawTimer = null;
let audioCtx = null;
let recStarting = false;
let currentRecNoticeId = null;

export function isRecordingSupported() {
    // Desktop heuristic: allow hybrid devices (touchscreen laptops) via hover too
    const wideEnough = window.innerWidth > 768;
    const hasFinePointer = window.matchMedia('(pointer: fine)').matches || window.matchMedia('(hover: hover)').matches;
    const apiOk = typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
    return wideEnough && hasFinePointer && apiOk;
}

export function initRecorderButton() {
    const btn = document.getElementById('btnRec');
    if (!btn) return;
    const supported = isRecordingSupported();
    btn.style.display = supported ? 'flex' : 'none';
    console.log('[Recorder] supported:', supported);
}

export function isRecordingActive() {
    return !!mediaRecorder;
}

export async function toggleRecording() {
    console.log('[Recorder] toggle, active:', !!mediaRecorder);
    if (mediaRecorder) {
        stopRecording();
        return;
    }
    await startRecording();
}

function resetRecButton() {
    clearInterval(recTimer);
    const btn = document.getElementById('btnRec');
    if (btn) {
        setDockLabel(btn, 'Rec');
        btn.classList.remove('is-recording');
    }
    document.body.classList.remove('is-recording');
}

function pickMimeType() {
    const candidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4'
    ];
    const picked = candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
    console.log('[Recorder] MIME:', picked || '(browser default)');
    return picked;
}

async function startRecording() {
    const btn = document.getElementById('btnRec');
    // Guard against re-entry while a previous recorder is shutting down
    if (recStarting || mediaRecorder) return;
    recStarting = true;

    try {
        const grid = document.getElementById('videoGrid');
        // Match the recording to what is currently visible: canvas mirrors the
        // on-screen grid size (device pixels), capture at display framerate.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(640, Math.round((grid?.clientWidth || 1280) * dpr));
        canvas.height = Math.max(360, Math.round((grid?.clientHeight || 720) * dpr));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0a0b10';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const REC_FPS = 30;

        const drawFrame = () => {
            ctx.fillStyle = '#0a0b10';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const videos = Array.from(document.querySelectorAll('#videoGrid video'))
                .filter(v => v.videoWidth > 0 && v.videoHeight > 0 && v.readyState >= 2);

            if (videos.length > 0) {
                const cols = Math.ceil(Math.sqrt(videos.length));
                const rows = Math.ceil(videos.length / cols);
                const cellW = canvas.width / cols;
                const cellH = canvas.height / rows;

                videos.forEach((video, i) => {
                    const col = i % cols;
                    const row = Math.floor(i / cols);
                    // Contain-fit each video inside its cell
                    const scale = Math.min(cellW / video.videoWidth, cellH / video.videoHeight);
                    const w = video.videoWidth * scale;
                    const h = video.videoHeight * scale;
                    const x = col * cellW + (cellW - w) / 2;
                    const y = row * cellH + (cellH - h) / 2;
                    try { ctx.drawImage(video, x, y, w, h); } catch (e) {}
                });
            }
        };

        // Paint the first frame BEFORE capturing — a canvas captured with no
        // painted content yields a permanently empty stream in Chrome.
        drawFrame();

        // Auto-capture at REC_FPS (cross-browser reliable path for Chrome AND
        // Firefox); rAF drives the painting so frames keep flowing.
        const canvasStream = canvas.captureStream(REC_FPS);

        // rAF runs at the display rate (up to 120-144 Hz); paint only as often as the stream
        // captures, since extra frames are dropped anyway.
        const frameInterval = 1000 / REC_FPS;
        let lastDraw = 0;
        const loop = (ts) => {
            if (!drawTimer) return;
            if (ts - lastDraw >= frameInterval - 1) {
                lastDraw = ts;
                drawFrame();
            }
            drawTimer = requestAnimationFrame(loop);
        };
        drawTimer = requestAnimationFrame(loop);

        // Mix local + remote audio from existing elements/tracks
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const audioDest = audioCtx.createMediaStreamDestination();
        let audioSources = 0;

        const seenTracks = new Set();
        const attachStream = (stream) => {
            if (!stream) return;
            stream.getAudioTracks().forEach(t => {
                if (seenTracks.has(t.id)) return;
                seenTracks.add(t.id);
                try {
                    audioCtx.createMediaStreamSource(new MediaStream([t])).connect(audioDest);
                    audioSources++;
                } catch (e) {}
            });
        };

        // Remote audio elements already attached to the DOM
        document.querySelectorAll('audio').forEach(a => attachStream(a.srcObject));

        // Local mic track
        const micPub = AppState.activeRoom?.localParticipant?.getTrackPublication(LivekitClient.Track.Source.Microphone);
        if (micPub?.audioTrack?.mediaStreamTrack && !AppState.micMuted) {
            attachStream(new MediaStream([micPub.audioTrack.mediaStreamTrack]));
        }

        audioDest.stream.getAudioTracks().forEach(t => canvasStream.addTrack(t));

        const mimeType = pickMimeType();
        // Scale bitrate with pixel count (~0.15 bits/pixel/frame, clamped)
        const bitsPerPixel = 0.15;
        const bitrate = Math.min(Math.max(
            Math.round(canvas.width * canvas.height * REC_FPS * bitsPerPixel),
            2_500_000
        ), 12_000_000);

        const options = { videoBitsPerSecond: bitrate };
        if (mimeType) options.mimeType = mimeType;

        const recorder = new MediaRecorder(canvasStream, options);

        // Closure-local state per session: never shared with the next recording
        const chunks = [];
        const startTime = Date.now();

        recorder.ondataavailable = (e) => {
            console.log('[Recorder] chunk:', e.data?.size ?? 0, 'bytes');
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        recorder.onerror = (e) => {
            console.error('[Recorder] MediaRecorder error:', e.error || e);
        };
        recorder.onstop = () => {
            console.log('[Recorder] stopped, total chunks:', chunks.length);
            handleRecordingStopped(recorder, chunks, startTime);
        };

        recorder.start(500); // collect in 500ms chunks so data flows steadily
        mediaRecorder = recorder;

        // Button keeps the "Rec" label — active color scheme signals recording
        if (btn) { btn.classList.add('is-recording'); startRecTimer(btn, startTime); }
        document.body.classList.add('is-recording');
        broadcastRecordingNotice();
    } catch (err) {
        console.error('[Recorder] Start failed:', err);
        cleanupRecording();
        resetRecButton();
        renderSystemNote('Recording is not supported in this browser.');
    } finally {
        recStarting = false;
    }
}

function broadcastRecordingNotice() {
    const sender = localStorage.getItem('portal_username') || 'You';
    const msg = {
        id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sender,
        text: '🔴 started a recording — everything visible is being captured.',
        created_at: Date.now(),
        pinned: true
    };
    currentRecNoticeId = msg.id;
    renderMessage(msg, true);
    sendDataPacket({ type: 'CHAT_MESSAGE', payload: msg });
    scrollChatToBottom();
}

function removeRecordingNotice() {
    if (!currentRecNoticeId) return;
    document.getElementById(`msg_${currentRecNoticeId}`)?.remove();
    sendDataPacket({ type: 'CHAT_MESSAGE_REMOVE', id: currentRecNoticeId });
    currentRecNoticeId = null;
}

function stopRecording() {
    // Detach the module reference FIRST so cleanup in onstop never re-stops it
    const recorder = mediaRecorder;
    mediaRecorder = null;
    if (recorder && recorder.state !== 'inactive') {
        recorder.stop(); // async: ondataavailable -> onstop -> handleRecordingStopped
    } else {
        cleanupRecording();
        resetRecButton();
        removeRecordingNotice();
    }
}

function cleanupRecording() {
    if (drawTimer) { cancelAnimationFrame(drawTimer); drawTimer = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
}

async function handleRecordingStopped(recorder, chunks, startTime) {
    const durationSec = Math.round((Date.now() - startTime) / 1000);
    const type = recorder.mimeType || 'video/webm';
    cleanupRecording();
    resetRecButton();
    removeRecordingNotice();

    const blob = new Blob(chunks, { type });

    if (blob.size === 0) {
        renderSystemNote('The recording was empty, so nothing was shared.');
        return;
    }

    const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
    renderSystemNote(`Recording stopped (${durationSec}s, ${sizeMB} MB). Uploading…`);

    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `meet-recording-${stamp}.${ext}`;

    // Bonus: auto-share into the chat so everyone can download (10m TTL applies)
    if (AppState.activeRoom) {
        try {
            const roomName = AppState.activeRoom.name;
            const sender = localStorage.getItem('portal_username') || 'You';

            const formData = new FormData();
            formData.append('file', blob, filename);
            formData.append('sender', `${sender} (🎥 ${durationSec}s recording)`);

            const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/upload`, {
                method: 'POST',
                body: formData
            });

            if (res.ok) {
                const savedFile = await res.json();
                renderFile(savedFile, true);
                sendDataPacket({ type: 'FILE_SHARED', payload: savedFile });
                renderSystemNote('Recording shared to chat.');
                scrollChatToBottom();
                return;
            }
            renderSystemNote('Upload failed, so the recording was downloaded to this device instead.');
        } catch (err) {
            console.error('[Recorder] Chat share failed, falling back to local download:', err);
            renderSystemNote('Upload failed, so the recording was downloaded to this device instead.');
        }
    }

    // Fallback: local download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}
