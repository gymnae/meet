import { AppState, videoCaptureProfile, getResolutionProfile } from './state.js';
import { showToast, setDockLabel, initThemeSwitch } from './ui.js';
import { copyShareLink, toggleFullscreen, recalculateLayout, updateSpeakerHighlight, applyDynamicMirrorEffect } from './ui.js';
import { 
    attachParticipantVideoTrack, toggleMic, toggleCam, toggleReactionMenu, 
    toggleScreenShare, cleanupTileTrack, cleanupAllTilesForParticipant, 
    terminateSession, handleIncomingDataPacket, checkMassMuteRules, ensureParticipantTile,
    broadcastCodecPreference, evaluateAndNegotiateCodec
} from './livekit-handler.js';
import { initChatEngine, toggleChat, syncRoomTransmissions, handleChatSubmit, handleFileUpload } from './chat.js';
import {
    normalizeOutgoingMicTrack,
    attachNormalizedRemoteAudio, detachNormalizedRemoteAudio, getMicConstraints
} from './audio-normalizer.js';
import { toggleSoundMenu, refreshSoundMenu } from './sound-menu.js';
import { loadSoundLibrary } from './soundboard.js';
import { initTileResize } from './resize.js';
import { initRecorderButton, toggleRecording, isRecordingSupported } from './recorder.js';
import { initCapabilityChecks, refreshControlVisibility } from './capabilities.js';

window.initiateCall = initiateCall;
window.toggleMic = toggleMic;
window.toggleCam = toggleCam;
window.toggleReactionMenu = toggleReactionMenu;
window.toggleChat = toggleChat;
window.toggleScreenShare = toggleScreenShare;
window.toggleFullscreen = toggleFullscreen;
window.terminateSession = terminateSession;
window.copyShareLink = copyShareLink;
window.handleChatSubmit = handleChatSubmit;
window.handleFileUpload = handleFileUpload;
window.toggleRecording = toggleRecording;
window.toggleSoundMenu = toggleSoundMenu;

window.addEventListener('DOMContentLoaded', () => {
    initChatEngine();
    initTileResize();
    initRecorderButton();
    initCapabilityChecks();
    window.addEventListener('resize', initRecorderButton);

    const savedName = localStorage.getItem('portal_username');
    if (savedName) document.getElementById('nameInput').value = savedName;

    const getVaultPassword = (room) => {
        try { return JSON.parse(localStorage.getItem('portal_vault') || '{}')[room] || ''; } 
        catch(e) { return ''; }
    };

    const currentHashRoom = window.location.hash.replace('#', '').trim();
    const passwordInputEl = document.getElementById('passwordInput');

    if (currentHashRoom) {
        document.getElementById('passwordField').hidden = true;
        const decodedRoom = decodeURIComponent(currentHashRoom);
        document.getElementById('roomInput').value = decodedRoom;
        passwordInputEl.value = getVaultPassword(decodedRoom.toLowerCase().replace(/[^a-z0-9-_]/g, ''));
    }

    document.getElementById('roomInput').addEventListener('input', (e) => {
        document.getElementById('passwordField').hidden = false;
        passwordInputEl.removeAttribute('aria-invalid');
        passwordInputEl.value = getVaultPassword(e.target.value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, ''));
    });
});

async function initiateCall() {
    const roomName = document.getElementById('roomInput').value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    const nickname = document.getElementById('nameInput').value.trim();
    const passwordInputEl = document.getElementById('passwordInput');
    const password = passwordInputEl.value.trim();

    if (!roomName || !nickname) {
        showGateError(!roomName ? 'Enter a room name using letters, numbers, - or _.' : 'Enter the name others will see.', !roomName ? 'roomInput' : 'nameInput');
        return;
    }
    showGateError('');

    const joinBtn = document.getElementById('joinBtn');
    joinBtn.disabled = true;
    joinBtn.innerText = "Connecting…";

    try {
        // Persistent anonymous client ID (localStorage, not a cookie):
        // reconnects on the same device/browser reuse the same ID, so the
        // all-time unique user count doesn't double-count.
        let clientId = localStorage.getItem('portal_client_id');
        if (!clientId) {
            clientId = crypto.randomUUID();
            localStorage.setItem('portal_client_id', clientId);
        }

        const tokenRes = await fetch('/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomName, nickname, password, clientId })
        });
        const connectionInfo = await tokenRes.json();
        
        if (connectionInfo.requiresPassword || (connectionInfo.error && connectionInfo.error.toLowerCase().includes('password'))) {
            document.getElementById('passwordField').hidden = false;
            if (connectionInfo.error && connectionInfo.error.toLowerCase().includes('incorrect')) {
                passwordInputEl.value = ''; 
                showGateError('That password is not right. Try again.', 'passwordInput');
            } else {
                showGateError('This room is protected. Enter its password.', 'passwordInput');
            }
            
            passwordInputEl.focus();
            joinBtn.disabled = false;
            joinBtn.innerText = "Join with password";
            return; 
        }

        if (connectionInfo.error) {
            showGateError('Could not join: ' + connectionInfo.error);
            joinBtn.disabled = false;
            joinBtn.innerText = "Connect";
            return;
        }

        localStorage.setItem('portal_username', nickname);
        if (password) {
            try {
                const vault = JSON.parse(localStorage.getItem('portal_vault') || '{}');
                vault[roomName] = password;
                localStorage.setItem('portal_vault', JSON.stringify(vault));
            } catch (e) {}
        }

        window.location.hash = encodeURIComponent(roomName);

        document.body.classList.add('in-session');
        document.getElementById('loginSetup').style.display = 'none';
        const repoLink = document.getElementById('repoLink');
        if (repoLink) repoLink.style.display = 'none';
        document.getElementById('room-header').style.display = 'flex';
        document.getElementById('video-container').style.display = 'flex';
        document.getElementById('control-dock').style.display = 'flex';
        document.getElementById('headerRoomLabel').innerText = roomName;

        joinBtn.innerText = "Opening camera…";

        const audioConstraints = getMicConstraints();

        const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
        AppState.localPreferredCodec = isFirefox ? 'vp8' : 'h264';
        AppState.currentPublishedCodec = AppState.localPreferredCodec;
        AppState.participantPreferences = new Map();

        // === INITIAL RESOLUTION PROFILE CONFIGURED HERE ===
        const initialVideoProfile = {
            resolution: getResolutionProfile()
        };

        AppState.activeRoom = new LivekitClient.Room({
            adaptiveStream: true, 
            dynacast: true,
            videoCaptureDefaults: initialVideoProfile,
            audioCaptureDefaults: audioConstraints,
            publishDefaults: { 
                simulcast: true, 
                videoCodec: AppState.currentPublishedCodec
            }
        });

        const localTile = ensureParticipantTile(AppState.activeRoom.localParticipant, 'camera');
        
        let audioEnabled = true;
        let videoEnabled = true;

        try {
            AppState.preWarmedTracks = await LivekitClient.createLocalTracks({ 
                audio: audioConstraints, 
                video: initialVideoProfile 
            });
        } catch (hwErr) {
            console.warn("[Hardware] Failed both, trying audio-only...", hwErr);
            try {
                AppState.preWarmedTracks = await LivekitClient.createLocalTracks({ audio: audioConstraints });
                videoEnabled = false;
                showToast("No camera available, so you joined with audio only.", "warn", 5000);
            } catch (audioErr) {
                console.warn("[Hardware] Failed audio-only, trying video-only...", audioErr);
                try {
                    AppState.preWarmedTracks = await LivekitClient.createLocalTracks({ video: initialVideoProfile });
                    audioEnabled = false;
                    showToast("No microphone available, so you joined with video only.", "warn", 5000);
                } catch (videoErr) {
                    console.warn("[Hardware] Complete hardware failure.", videoErr);
                    AppState.preWarmedTracks = [];
                    audioEnabled = false;
                    videoEnabled = false;
                    showToast("No camera or microphone available, so you joined to listen only.", "warn", 5000);
                }
            }
        }

        if (!audioEnabled) {
            AppState.micMuted = true;
            const micBtn = document.getElementById('btnMic');
            if (micBtn) { setDockLabel(micBtn, "Unmute"); micBtn.classList.add('active-off'); }
        }
        if (!videoEnabled) {
            AppState.camMuted = true;
            const camBtn = document.getElementById('btnCam');
            if (camBtn) { setDockLabel(camBtn, "Start"); camBtn.classList.add('active-off'); }
        }

        const localVideoTrack = AppState.preWarmedTracks.find(t => t.kind === 'video');
        if (localVideoTrack) {
            let videoTag = document.createElement('video');
            videoTag.playsInline = true;
            videoTag.setAttribute('playsinline', 'true');
            videoTag.setAttribute('webkit-playsinline', 'true');
            videoTag.setAttribute('muted', '');
            videoTag.muted = true;
            videoTag.controls = false;
            videoTag.style.position = 'relative';
            videoTag.style.zIndex = '2';
            localTile.insertBefore(videoTag, localTile.firstChild);

            localVideoTrack.attach(videoTag);
            videoTag.play().catch(() => {});
            applyDynamicMirrorEffect(localVideoTrack);
            if (localVideoTrack.mediaStreamTrack) AppState.currentCameraDeviceId = localVideoTrack.mediaStreamTrack.getSettings().deviceId;
        }

        // --- LiveKit Hooks ---
        AppState.activeRoom.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === LivekitClient.Track.Kind.Video) {
                attachParticipantVideoTrack(track, participant, publication.source);
            } else if (track.kind === LivekitClient.Track.Kind.Audio) {
                if (publication.source === LivekitClient.Track.Source.Microphone || publication.source === 'unknown') {
                    // Normalize remote microphone audio for consistent loudness
                    const element = attachNormalizedRemoteAudio(track, participant.identity);
                    document.body.appendChild(element);
                } else {
                    // Screen share / other audio stays untouched
                    const element = track.attach();
                    document.body.appendChild(element);
                }
                ensureParticipantTile(participant, 'camera');
            }
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
            if (track.kind === LivekitClient.Track.Kind.Audio &&
                (publication.source === LivekitClient.Track.Source.Microphone || publication.source === 'unknown')) {
                detachNormalizedRemoteAudio(track);
            } else {
                track.detach().forEach(el => el.remove());
            }
            cleanupTileTrack(participant.identity, publication.source);
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.LocalTrackPublished, (publication, participant) => {
            if (publication.track && publication.source === LivekitClient.Track.Source.ScreenShare) {
                attachParticipantVideoTrack(publication.track, participant, publication.source);
            }
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.LocalTrackUnpublished, (publication) => {
            cleanupTileTrack('local', publication.source);
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.DataReceived, (payload, participant) => {
            handleIncomingDataPacket(payload, participant);
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.ParticipantConnected, (participant) => {
            ensureParticipantTile(participant, 'camera');
            checkMassMuteRules();
            broadcastCodecPreference();
            refreshSoundMenu();
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            cleanupAllTilesForParticipant(participant.identity);
            refreshSoundMenu();
            AppState.participantPreferences.delete(participant.identity);
            evaluateAndNegotiateCodec();
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
            const nextSpeaker = speakers.length > 0 ? speakers[0].identity : null;
            if (nextSpeaker === AppState.activeSpeakerIdentity) return;
            AppState.activeSpeakerIdentity = nextSpeaker;
            updateSpeakerHighlight();
        });

        await AppState.activeRoom.connect(connectionInfo.serverUrl, connectionInfo.token);
        
        AppState.participantPreferences.set(AppState.activeRoom.localParticipant.identity, AppState.localPreferredCodec);

        AppState.activeRoom.remoteParticipants.forEach(participant => {
            ensureParticipantTile(participant, 'camera');
        });

        broadcastCodecPreference();
        loadSoundLibrary();

        for (const track of AppState.preWarmedTracks) {
            if (track.kind === 'video') {
                await AppState.activeRoom.localParticipant.publishTrack(track, {
                    videoCodec: AppState.currentPublishedCodec,
                    simulcast: true
                });
            } else {
                // Publish the normalized version of the mic track
                const normalizedTrack = normalizeOutgoingMicTrack(track.mediaStreamTrack);
                const publishable = normalizedTrack !== track.mediaStreamTrack
                    ? new LivekitClient.LocalAudioTrack(normalizedTrack)
                    : track;
                // Tag as microphone so setMicrophoneEnabled / getTrackPublication find it
                await AppState.activeRoom.localParticipant.publishTrack(publishable, {
                    source: LivekitClient.Track.Source.Microphone
                });
            }
        }

        checkMassMuteRules();
        recalculateLayout();

        // Device access now granted — real device list available, re-evaluate
        refreshControlVisibility();

        await syncRoomTransmissions(roomName);

    } catch (err) {
        showToast("Connection failed: " + err.message, "error", 6000);
        terminateSession(true);
    }
}

const wakeAllVideos = () => {
    document.querySelectorAll('video').forEach(video => {
        if (video.paused) {
            video.muted = true;
            video.play().catch(() => {});
        }
    });
};
window.addEventListener('touchstart', wakeAllVideos, { passive: true });
window.addEventListener('click', wakeAllVideos, { passive: true });
// Resize fires many times per frame while dragging; lay out at most once per frame.
let layoutFrame = 0;
window.addEventListener('resize', () => {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; recalculateLayout(); });
});

// === GATE: real form (Enter submits), inline errors, live channel preview ===
function sanitizeRoom(v) { return v.trim().toLowerCase().replace(/[^a-z0-9-_]/g, ''); }

function showGateError(message, fieldId) {
    const el = document.getElementById('gateError');
    if (el) el.textContent = message;
    ['roomInput', 'nameInput', 'passwordInput'].forEach(id => document.getElementById(id)?.removeAttribute('aria-invalid'));
    if (fieldId) {
        const f = document.getElementById(fieldId);
        f?.setAttribute('aria-invalid', 'true');
        f?.focus();
    }
}

function updateRoomHint() {
    const input = document.getElementById('roomInput');
    const hint = document.getElementById('roomHint');
    if (!input || !hint) return;
    const clean = sanitizeRoom(input.value);
    hint.innerHTML = '';
    if (!clean) return;
    hint.append('Joins ');
    const b = document.createElement('b');
    b.textContent = '#' + clean;
    hint.append(b);
}

window.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('gateForm');
    form?.addEventListener('submit', (e) => { e.preventDefault(); initiateCall(); });
    initThemeSwitch();
    // The Prism join screen "lights up" once the form can be submitted.
    const updateReady = () => {
        const ready = !!sanitizeRoom(document.getElementById('roomInput')?.value || '') &&
                      !!(document.getElementById('nameInput')?.value || '').trim();
        document.body.classList.toggle('gate-ready', ready);
    };
    ['roomInput', 'nameInput'].forEach(id => document.getElementById(id)?.addEventListener('input', updateReady));
    updateReady();
    document.getElementById('roomInput')?.addEventListener('input', updateRoomHint);
    updateRoomHint();
});

// === MENUS & DRAWER: Escape and outside click close them ===
const MENU_IDS = ['camMenu', 'micMenu', 'reactionMenu', 'soundMenu'];
function closeMenus() { MENU_IDS.forEach(id => { const m = document.getElementById(id); if (m) m.style.display = 'none'; }); }
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const anyOpen = MENU_IDS.some(id => document.getElementById(id)?.style.display === 'flex');
    if (anyOpen) { closeMenus(); return; }
    if (document.body.classList.contains('chat-open')) toggleChat();
});
document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#camMenu, #micMenu, #reactionMenu, #soundMenu, #btnMic, #btnCam, #btnReact, #btnSound')) return;
    closeMenus();
});
