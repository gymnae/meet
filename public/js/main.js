import { AppState, videoCaptureProfile } from './state.js';
import { copyShareLink, toggleFullscreen, recalculateLayout, applyDynamicMirrorEffect } from './ui.js';
import { 
    attachParticipantVideoTrack, toggleMic, toggleCam, toggleReactionMenu, 
    toggleScreenShare, cleanupTileTrack, cleanupAllTilesForParticipant, 
    terminateSession, handleIncomingDataPacket, checkMassMuteRules, ensureParticipantTile,
    broadcastCodecPreference, evaluateAndNegotiateCodec
} from './livekit-handler.js';
import { initChatEngine, toggleChat, syncRoomTransmissions, handleChatSubmit, handleFileUpload } from './chat.js';

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

window.addEventListener('DOMContentLoaded', () => {
    initChatEngine();

    const savedName = localStorage.getItem('portal_username');
    if (savedName) document.getElementById('nameInput').value = savedName;

    const getVaultPassword = (room) => {
        try { return JSON.parse(localStorage.getItem('portal_vault') || '{}')[room] || ''; } 
        catch(e) { return ''; }
    };

    const currentHashRoom = window.location.hash.replace('#', '').trim();
    const passwordInputEl = document.getElementById('passwordInput');

    if (currentHashRoom) {
        passwordInputEl.style.display = 'none';
        const decodedRoom = decodeURIComponent(currentHashRoom);
        document.getElementById('roomInput').value = decodedRoom;
        passwordInputEl.value = getVaultPassword(decodedRoom.toLowerCase().replace(/[^a-z0-9-_]/g, ''));
    }

    document.getElementById('roomInput').addEventListener('input', (e) => {
        passwordInputEl.style.display = 'block';
        passwordInputEl.placeholder = "Password (Optional)";
        passwordInputEl.value = getVaultPassword(e.target.value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, ''));
    });
});

async function initiateCall() {
    const roomName = document.getElementById('roomInput').value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    const nickname = document.getElementById('nameInput').value.trim();
    const passwordInputEl = document.getElementById('passwordInput');
    const password = passwordInputEl.value.trim();

    if (!roomName || !nickname) return alert("Please enter a room name and nickname.");

    const joinBtn = document.getElementById('joinBtn');
    joinBtn.disabled = true;
    joinBtn.innerText = "Authenticating...";

    try {
        const tokenRes = await fetch('/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomName, nickname, password })
        });
        const connectionInfo = await tokenRes.json();
        
        if (connectionInfo.requiresPassword || (connectionInfo.error && connectionInfo.error.toLowerCase().includes('password'))) {
            passwordInputEl.style.display = 'block'; 
            
            if (connectionInfo.error && connectionInfo.error.toLowerCase().includes('incorrect')) {
                passwordInputEl.value = ''; 
                passwordInputEl.placeholder = "Incorrect Password - Try Again";
            } else {
                passwordInputEl.placeholder = "Room Password Required";
            }
            
            passwordInputEl.focus();
            joinBtn.disabled = false;
            joinBtn.innerText = "Join with Password";
            return; 
        }

        if (connectionInfo.error) {
            alert("Authorization Error: " + connectionInfo.error);
            joinBtn.disabled = false;
            joinBtn.innerText = "Connect Session";
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

        document.getElementById('loginSetup').style.display = 'none';
        document.getElementById('room-header').style.display = 'flex';
        document.getElementById('video-container').style.display = 'flex';
        document.getElementById('control-dock').style.display = 'flex';
        document.getElementById('headerRoomLabel').innerText = roomName;

        joinBtn.innerText = "Opening Camera...";

        const audioConstraints = {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        };

        const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
        AppState.localPreferredCodec = isFirefox ? 'vp8' : 'h264';
        AppState.currentPublishedCodec = AppState.localPreferredCodec;
        AppState.participantPreferences = new Map();

        AppState.activeRoom = new LivekitClient.Room({
            adaptiveStream: true, 
            dynacast: true,
            videoCaptureDefaults: videoCaptureProfile,
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
                video: videoCaptureProfile 
            });
        } catch (hwErr) {
            console.warn("[Hardware] Failed both, trying audio-only...", hwErr);
            try {
                AppState.preWarmedTracks = await LivekitClient.createLocalTracks({ audio: audioConstraints });
                videoEnabled = false;
                alert("Camera not found or blocked. Joining with audio only.");
            } catch (audioErr) {
                console.warn("[Hardware] Failed audio-only, trying video-only...", audioErr);
                try {
                    AppState.preWarmedTracks = await LivekitClient.createLocalTracks({ video: videoCaptureProfile });
                    audioEnabled = false;
                    alert("Microphone not found or blocked. Joining with video only.");
                } catch (videoErr) {
                    console.warn("[Hardware] Complete hardware failure.", videoErr);
                    AppState.preWarmedTracks = [];
                    audioEnabled = false;
                    videoEnabled = false;
                    alert("Could not access camera or microphone. Joining in Listen-Only mode.");
                }
            }
        }

        if (!audioEnabled) {
            AppState.micMuted = true;
            const micBtn = document.getElementById('btnMic');
            if (micBtn) { micBtn.innerText = "Unmute"; micBtn.classList.add('active-off'); }
        }
        if (!videoEnabled) {
            AppState.camMuted = true;
            const camBtn = document.getElementById('btnCam');
            if (camBtn) { camBtn.innerText = "Start"; camBtn.classList.add('active-off'); }
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
                const element = track.attach();
                document.body.appendChild(element);
                ensureParticipantTile(participant, 'camera');
            }
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
            track.detach().forEach(el => el.remove());
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
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            cleanupAllTilesForParticipant(participant.identity);
            AppState.participantPreferences.delete(participant.identity);
            evaluateAndNegotiateCodec();
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
            AppState.activeSpeakerIdentity = speakers.length > 0 ? speakers[0].identity : null;
            recalculateLayout();
        });

        await AppState.activeRoom.connect(connectionInfo.serverUrl, connectionInfo.token);
        
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
                await AppState.activeRoom.localParticipant.publishTrack(track);
            }
        }

        checkMassMuteRules();
        recalculateLayout();

        // Sync active room transmissions (messages <60s, files <10m)
        await syncRoomTransmissions(roomName);

    } catch (err) {
        alert("WebRTC Connection Failed: " + err.message);
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
window.addEventListener('resize', recalculateLayout);
