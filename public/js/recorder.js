import { AppState } from './state.js';
import { sendDataPacket } from './livekit-handler.js';
import { renderFile, renderMessage, scrollChatToBottom, renderSystemNote } from './chat.js';

// === CLIENT-SIDE COMPOSITE RECORDER (Desktop-only entry point) ===
// Records only the local view: composites existing <video> elements onto a
// canvas at 15fps / 720p and mixes already-decoded audio via AudioContext.
// Zero impact on other participants: nothing is re-encoded or re-published.

let mediaRecorder = null;
let drawTimer = null;
let audioCtx = null;
let recStartTime = 0;
let recStarting = false;

export function isRecordingSupported() {
    const isDesktop = window.matchMedia('(pointer: fine)').matches && window.innerWidth > 768;
    return isDesktop && typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
}

export function initRecorderButton() {
    const btn = document.getElementById('btnRec');
    if (!btn) return;
    btn.style.display = isRecordingSupported() ? 'flex' : 'none';
}

export function isRecordingActive() {
    return !!mediaRecorder;
}

export async function toggleRecording() {
    if (mediaRecorder) {
        stopRecording();
        return;
    }
    await startRecording();
}

function resetRecButton() {
    const btn = document.getElementById('btnRec');
    if (btn) {
        btn.innerText = 'Rec';
        btn.classList.remove('active-off');
    }
}

function pickMimeType() {
    const candidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4'
    ];
    return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
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
        const canvasStream = canvas.captureStream(REC_FPS);

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

        const drawFrame = () => {
            ctx.fillStyle = '#0a0b10';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const videos = Array.from(document.querySelectorAll('#videoGrid video'))
                .filter(v => v.videoWidth > 0 && v.videoHeight > 0);

            if (videos.length === 0) return;

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
        };

        drawFrame();
        drawTimer = setInterval(drawFrame, 1000 / REC_FPS);

        const mimeType = pickMimeType();
        // Scale bitrate with pixel count (~0.15 bits/pixel/frame, clamped)
        const bitsPerPixel = 0.15;
        const bitrate = Math.min(Math.max(
            Math.round(canvas.width * canvas.height * REC_FPS * bitsPerPixel),
            2_500_000
        ), 12_000_000);

        const recorder = new MediaRecorder(canvasStream, {
            mimeType,
            videoBitsPerSecond: bitrate
        });

        // Closure-local state per session: never shared with the next recording
        const chunks = [];
        const startTime = Date.now();

        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        recorder.onstop = () => handleRecordingStopped(recorder, chunks, startTime);

        recorder.start(500); // collect in 500ms chunks so data flows steadily
        mediaRecorder = recorder;
        recStartTime = startTime;

        // Button keeps the "Rec" label — active color scheme signals recording
        if (btn) btn.classList.add('active-off');
        broadcastRecordingNotice();
    } catch (err) {
        console.error('[Recorder] Start failed:', err);
        cleanupRecording();
        resetRecButton();
        renderSystemNote('⚠️ Recording is not supported on this device/browser.');
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
    renderMessage(msg, true);
    sendDataPacket({ type: 'CHAT_MESSAGE', payload: msg });
    scrollChatToBottom();
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
}

function cleanupRecording() {
    if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.stop(); } catch (e) {}
    }
    mediaRecorder = null;
}

async function handleRecordingStopped(recorder, chunks, startTime) {
    const durationSec = Math.round((Date.now() - startTime) / 1000);
    const type = recorder.mimeType || 'video/webm';
    cleanupRecording();
    resetRecButton();

    const blob = new Blob(chunks, { type });

    if (blob.size === 0) {
        renderSystemNote('⚠️ Recording was empty.');
        return;
    }

    const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
    renderSystemNote(`⏳ Recording stopped (${durationSec}s, ${sizeMB} MB) — preparing upload…`);

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
                renderSystemNote('✅ Recording shared to chat.');
                scrollChatToBottom();
                return;
            }
            renderSystemNote('⚠️ Upload failed — downloading locally instead.');
        } catch (err) {
            console.error('[Recorder] Chat share failed, falling back to local download:', err);
            renderSystemNote('⚠️ Upload failed — downloading locally instead.');
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
