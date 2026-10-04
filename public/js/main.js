import { AppState, videoCaptureProfile, getResolutionProfile } from './state.js';
import { showToast, setDockLabel, initThemeSwitch } from './ui.js';
import { toggleFullscreen, recalculateLayout, updateSpeakerHighlight, applyDynamicMirrorEffect } from './ui.js';
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
import { openShareDialog, parseInviteHash } from './share.js';
import { attachAudienceAudio, startAudienceSession } from './audience.js';
import { toggleSoundMenu, refreshSoundMenu } from './sound-menu.js';
import { initTileResize } from './resize.js';
import { initRecorderButton, toggleRecording, isRecordingSupported } from './recorder.js';
import { initCapabilityChecks, refreshControlVisibility } from './capabilities.js';

const INITIAL_CONNECT_TIMEOUT_MS = 15000;

window.initiateCall = initiateCall;
window.toggleMic = toggleMic;
window.toggleCam = toggleCam;
window.toggleReactionMenu = toggleReactionMenu;
window.toggleChat = toggleChat;
window.toggleScreenShare = toggleScreenShare;
window.toggleFullscreen = toggleFullscreen;
window.terminateSession = terminateSession;
window.openShareDialog = openShareDialog;
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

    const invite = parseInviteHash();
    const passwordInputEl = document.getElementById('passwordInput');

    if (invite?.audienceId) {
        enterAudienceGate(invite.audienceId);
    } else if (invite?.room) {
        document.getElementById('passwordField').hidden = true;
        document.getElementById('roomInput').value = invite.room;
        // A password carried by the link wins over a remembered one.
        passwordInputEl.value = invite.password || getVaultPassword(sanitizeRoom(invite.room));
        // Keep the password out of the address bar, history and screenshots.
        if (invite.password) history.replaceState(null, '', `#${encodeURIComponent(invite.room)}`);
    }

    document.getElementById('roomInput').addEventListener('input', (e) => {
        document.getElementById('passwordField').hidden = false;
        passwordInputEl.removeAttribute('aria-invalid');
        passwordInputEl.value = getVaultPassword(e.target.value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, ''));
    });
});

// Changing only the #part of the address does not reload the page, so a tab opened from an
// audience link would stay listen-only when someone pastes a room link into it (and the other
// way round). Start fresh for any invite the app did not set itself.
window.addEventListener('hashchange', () => {
    const inSession = document.body.classList.contains('in-session');
    if (inSession && !AppState.audienceMode && window.location.hash === `#${encodeURIComponent(AppState.roomName)}`) return;
    location.reload();
});

// Audience link: listen-only join. The room name is never shown, and no name is asked for
// because listeners are hidden from the room.
function enterAudienceGate(audienceId) {
    AppState.audienceMode = true;
    AppState.audienceId = audienceId;
    document.body.classList.add('audience-mode');
    ['roomField', 'nameField', 'passwordField'].forEach(id => { document.getElementById(id).hidden = true; });
    document.getElementById('gateTitle').textContent = 'Listen in on a schnackn. stream';
    document.getElementById('gateTagline').textContent = "You're invited to listen in. No mic, no camera.";
    document.getElementById('joinBtn').innerText = 'Start listening';
}

async function initiateCall() {
    const audience = AppState.audienceMode;
    const roomName = audience ? '' : sanitizeRoom(document.getElementById('roomInput').value);
    const nickname = audience ? 'Listener' : document.getElementById('nameInput').value.trim();
    const passwordInputEl = document.getElementById('passwordInput');
    const password = audience ? '' : passwordInputEl.value.trim();

    if (!audience && (!roomName || !nickname)) {
        showGateError(!roomName ? 'Enter a room name using letters, numbers, - or _.' : 'Enter the name others will see.', !roomName ? 'roomInput' : 'nameInput');
        return;
    }
    showGateError('');

    const joinBtn = document.getElementById('joinBtn');
    joinBtn.disabled = true;
    joinBtn.innerText = "Connecting…";

    let joinStage = 'token';

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
            body: JSON.stringify(audience ? { audienceId: AppState.audienceId, clientId } : { roomName, nickname, password, clientId })
        });
        if (audience && tokenRes.status === 404) {
            showGateError('This audience link is no longer valid. Ask the host for a new one.');
            joinBtn.disabled = false;
            joinBtn.innerText = 'Start listening';
            return;
        }
        if (!tokenRes.ok) {
            throw new Error('TOKEN_REQUEST_FAILED');
        }

        let connectionInfo;
        try {
            connectionInfo = await tokenRes.json();
        } catch (e) {
            throw new Error('TOKEN_RESPONSE_INVALID');
        }

        if (!connectionInfo || !connectionInfo.serverUrl || !connectionInfo.token) {
            if (!connectionInfo?.requiresPassword && !connectionInfo?.error) {
                throw new Error('TOKEN_RESPONSE_INVALID');
            }
        }
        
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
            showGateError('Could not get permission to join. Check the room details and try again.');
            joinBtn.disabled = false;
            joinBtn.innerText = "Connect";
            return;
        }

        if (!audience) {
            localStorage.setItem('portal_username', nickname);
            if (password) {
                try {
                    const vault = JSON.parse(localStorage.getItem('portal_vault') || '{}');
                    vault[roomName] = password;
                    localStorage.setItem('portal_vault', JSON.stringify(vault));
                } catch (e) {}
            }
            window.location.hash = encodeURIComponent(roomName);
            AppState.roomName = roomName;
            // Only a protected room's password belongs in the links people share.
            AppState.roomPassword = connectionInfo.protected ? password : '';
        }

        document.body.classList.add('in-session');
        document.getElementById('loginSetup').style.display = 'none';
        const repoLink = document.getElementById('repoLink');
        if (repoLink) repoLink.style.display = 'none';
        document.getElementById('room-header').style.display = 'flex';
        document.getElementById('video-container').style.display = 'flex';
        document.getElementById('control-dock').style.display = 'flex';
        document.getElementById('headerRoomLabel').innerText = audience ? 'Audience' : roomName;
        if (audience) document.querySelector('#room-header .channel-label').textContent = 'Listening';

        joinBtn.innerText = audience ? "Connecting…" : "Opening camera…";

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

        const localTile = audience ? null : ensureParticipantTile(AppState.activeRoom.localParticipant, 'camera');
        
        let audioEnabled = !audience;
        let videoEnabled = !audience;

        if (audience) {
            AppState.preWarmedTracks = [];
        } else try {
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

        if (!audioEnabled && !audience) {
            AppState.micMuted = true;
            const micBtn = document.getElementById('btnMic');
            if (micBtn) { setDockLabel(micBtn, "Unmute"); micBtn.classList.add('active-off'); }
        }
        if (!videoEnabled && !audience) {
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
                if (audience) {
                    // Plain media element: phones keep it playing with the screen off,
                    // which they do not do for Web Audio output.
                    document.body.appendChild(attachAudienceAudio(track));
                } else if (publication.source === LivekitClient.Track.Source.Microphone || publication.source === 'unknown') {
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

        // Without a mic prompt the browser may still hold back playback; the next tap releases it.
        AppState.activeRoom.on(LivekitClient.RoomEvent.AudioPlaybackStatusChanged, () => {
            if (AppState.activeRoom && !AppState.activeRoom.canPlaybackAudio) {
                showToast('Tap anywhere to turn on sound.', 'warn', 6000);
            }
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
            const nextSpeaker = speakers.length > 0 ? speakers[0].identity : null;
            if (nextSpeaker === AppState.activeSpeakerIdentity) return;
            AppState.activeSpeakerIdentity = nextSpeaker;
            updateSpeakerHighlight();
        });

        joinStage = 'connect';
        let connectTimer;
        try {
            await Promise.race([
                AppState.activeRoom.connect(connectionInfo.serverUrl, connectionInfo.token),
                new Promise((resolve, reject) => {
                    connectTimer = setTimeout(() => reject(new Error('INITIAL_CONNECT_TIMEOUT')), INITIAL_CONNECT_TIMEOUT_MS);
                })
            ]);
        } finally {
            clearTimeout(connectTimer);
        }
        joinStage = 'session';

        if (audience) {
            AppState.activeRoom.remoteParticipants.forEach(participant => {
                ensureParticipantTile(participant, 'camera');
            });
            recalculateLayout();
            startAudienceSession();
            return;
        }
        
        AppState.participantPreferences.set(AppState.activeRoom.localParticipant.identity, AppState.localPreferredCodec);

        AppState.activeRoom.remoteParticipants.forEach(participant => {
            ensureParticipantTile(participant, 'camera');
        });

        broadcastCodecPreference();

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
        // Do not log the SDK error object: authentication failures may include
        // connection details that should not be exposed in browser logs.
        console.error(`[Join] ${joinStage} initialization failed (${err?.name || 'Error'})`);
        terminateSession(false);
        restoreJoinGate();

        if (audience && joinStage === 'token') {
            showGateError('Could not start listening. Check your connection and try again.');
            document.getElementById('joinBtn').innerText = 'Start listening';
        } else if (joinStage === 'token') {
            showGateError('Could not get permission to join. Check the room details and server availability, then try again.');
        } else if (joinStage === 'connect') {
            showGateError('Could not reach the meeting service. Secure WebSocket (WSS) traffic may be blocked by your network, firewall, or proxy. Check your connection or ask your network administrator, then try again.');
        } else {
            showGateError('The meeting could not finish starting. Check your connection and try again.');
        }
    }
}

function restoreJoinGate() {
    document.body.classList.remove('in-session');
    document.getElementById('loginSetup').style.display = '';
    const repoLink = document.getElementById('repoLink');
    if (repoLink) repoLink.style.display = '';
    document.getElementById('room-header').style.display = 'none';
    document.getElementById('video-container').style.display = 'none';
    document.getElementById('control-dock').style.display = 'none';
    document.querySelectorAll('[id^="tile_"]').forEach(tile => tile.remove());

    const joinBtn = document.getElementById('joinBtn');
    joinBtn.disabled = false;
    joinBtn.innerText = AppState.audienceMode ? 'Start listening' : 'Connect';
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
        const ready = AppState.audienceMode || !!sanitizeRoom(document.getElementById('roomInput')?.value || '') &&
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
    // An open dialog handles Escape itself.
    if (document.querySelector('dialog[open]')) return;
    const anyOpen = MENU_IDS.some(id => document.getElementById(id)?.style.display === 'flex');
    if (anyOpen) { closeMenus(); return; }
    if (document.body.classList.contains('chat-open')) toggleChat();
});
document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#camMenu, #micMenu, #reactionMenu, #soundMenu, #btnMic, #btnCam, #btnReact, #btnSound')) return;
    closeMenus();
});
