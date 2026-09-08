import { AppState, videoCaptureProfile } from './state.js';
import { copyShareLink, toggleFullscreen, recalculateLayout, applyDynamicMirrorEffect } from './ui.js';
import { 
    attachParticipantVideoTrack, toggleMic, toggleCam, toggleReactionMenu, 
    toggleScreenShare, cleanupTileTrack, cleanupAllTilesForParticipant, 
    terminateSession, handleIncomingDataPacket, checkMassMuteRules, ensureParticipantTile 
} from './livekit-handler.js';

window.initiateCall = initiateCall;
window.toggleMic = toggleMic;
window.toggleCam = toggleCam;
window.toggleReactionMenu = toggleReactionMenu;
window.toggleScreenShare = toggleScreenShare;
window.toggleFullscreen = toggleFullscreen;
window.terminateSession = terminateSession;
window.copyShareLink = copyShareLink;

window.addEventListener('DOMContentLoaded', () => {
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

        AppState.activeRoom = new LivekitClient.Room({
            adaptiveStream: { pixelDensity: "screen" }, 
            dynacast: true,
            videoCaptureDefaults: videoCaptureProfile,
            publishDefaults: { simulcast: true, videoCodec: 'h264' }
        });

        const localTile = ensureParticipantTile(AppState.activeRoom.localParticipant, 'camera');
        
        // === FIXED: MULTI-STAGE WATERFALL HARDWARE ENGINE ===
        let audioEnabled = true;
        let videoEnabled = true;

        try {
            // First Attempt: Try to get BOTH Mic and Cam
            AppState.preWarmedTracks = await LivekitClient.createLocalTracks({ audio: true, video: videoCaptureProfile });
        } catch (hwErr) {
            console.warn("[Hardware] Failed both, trying audio-only...", hwErr);
            try {
                // Second Attempt: Try just the Microphone
                AppState.preWarmedTracks = await LivekitClient.createLocalTracks({ audio: true });
                videoEnabled = false;
                alert("Camera not found or blocked. Joining with audio only.");
            } catch (audioErr) {
                console.warn("[Hardware] Failed audio-only, trying video-only...", audioErr);
                try {
                    // Third Attempt: Try just the Camera
                    AppState.preWarmedTracks = await LivekitClient.createLocalTracks({ video: videoCaptureProfile });
                    audioEnabled = false;
                    alert("Microphone not found or blocked. Joining with video only.");
                } catch (videoErr) {
                    // Final Fallback: Complete Hardware Failure -> Listen Only Mode
                    console.warn("[Hardware] Complete hardware failure.", videoErr);
                    AppState.preWarmedTracks = [];
                    audioEnabled = false;
                    videoEnabled = false;
                    alert("Could not access your camera or microphone. You are joining in Listen-Only mode.");
                }
            }
        }

        // Sync UI states based on fallback results
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
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            cleanupAllTilesForParticipant(participant.identity);
        });

        AppState.activeRoom.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
            AppState.activeSpeakerIdentity = speakers.length > 0 ? speakers[0].identity : null;
            recalculateLayout();
        });

        await AppState.activeRoom.connect(connectionInfo.serverUrl, connectionInfo.token);
        
        AppState.activeRoom.remoteParticipants.forEach(participant => {
            ensureParticipantTile(participant, 'camera');
        });

        for (const track of AppState.preWarmedTracks) {
            await AppState.activeRoom.localParticipant.publishTrack(track);
        }

        checkMassMuteRules();
        recalculateLayout();

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
