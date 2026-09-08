import { AppState, videoCaptureProfile } from './state.js';
import { recalculateLayout, applyDynamicMirrorEffect, triggerFloatingEmoji, updateHandBadge } from './ui.js';

export function ensureParticipantTile(participant, streamSource = 'camera') {
    const isLocalUser = participant.isLocal || (AppState.activeRoom && participant.identity === AppState.activeRoom.localParticipant?.identity);
    const isScreenShare = streamSource === 'screen_share';
    
    let targetTileId = isLocalUser 
        ? (isScreenShare ? 'tile_local_screen_share' : 'tile_local_camera') 
        : `tile_${participant.identity}_${streamSource}`;

    let tile = document.getElementById(targetTileId);

    if (!tile) {
        tile = document.createElement('div');
        tile.id = targetTileId;
        tile.className = `video-tile`;
        if (isScreenShare) tile.classList.add('screen-share');

        let rawCleanName = "Attendee";
        if (participant.name) {
            rawCleanName = participant.name;
        } else if (isLocalUser) {
            rawCleanName = localStorage.getItem('portal_username') || "You";
        } else if (participant.identity) {
            rawCleanName = participant.identity.split('_')[0];
        }

        const initial = rawCleanName.charAt(0).toUpperCase();

        tile.innerHTML = `
            <div class="touch-shield"></div>
            <div class="hand-badge">🖐️</div>
            <div class="avatar-placeholder">${initial}</div>
            <div class="name-tag">${isScreenShare ? `${rawCleanName} (Screen)` : rawCleanName}</div>
        `;
        
        tile.querySelector('.touch-shield').addEventListener('click', () => {
            if (targetTileId === 'tile_local_camera') return;
            AppState.pinnedTileId = (AppState.pinnedTileId === targetTileId) ? null : targetTileId;
            recalculateLayout();
        });

        document.getElementById('videoGrid').appendChild(tile);
    }
    return tile;
}

export function attachParticipantVideoTrack(track, participant, streamSource) {
    const tile = ensureParticipantTile(participant, streamSource);
    if (streamSource === 'screen_share') AppState.activeScreenShareTileId = tile.id;

    tile.querySelectorAll('video').forEach(v => v.remove());
    const nativeVideoTag = track.attach();
    
    nativeVideoTag.muted = true;
    nativeVideoTag.playsInline = true;
    nativeVideoTag.autoplay = true;
    nativeVideoTag.controls = false;
    nativeVideoTag.setAttribute('playsinline', 'true');
    nativeVideoTag.setAttribute('webkit-playsinline', 'true');
    nativeVideoTag.setAttribute('muted', '');
    nativeVideoTag.style.pointerEvents = 'none';
    nativeVideoTag.style.position = 'relative';
    nativeVideoTag.style.zIndex = '2';

    tile.insertBefore(nativeVideoTag, tile.firstChild);

    setTimeout(() => {
        nativeVideoTag.muted = true;
        nativeVideoTag.play().catch(() => {});
        recalculateLayout();
    }, 20);
}

export function sendDataPacket(payload) {
    if (!AppState.activeRoom) return;
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(payload));
    AppState.activeRoom.localParticipant.publishData(data, LivekitClient.DataPacket_Kind.RELIABLE);
}

export function handleIncomingDataPacket(payload, participant) {
    try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (data.type === 'REACTION') {
            const tileId = participant ? `tile_${participant.identity}_camera` : 'tile_local_camera';
            triggerFloatingEmoji(tileId, data.emoji);
        } else if (data.type === 'HAND_RAISE') {
            updateHandBadge(participant?.identity, data.raised);
        }
    } catch (e) {
        console.error("[DataChannel] Failed to parse incoming packet:", e);
    }
}

export function toggleReactionMenu() {
    const menu = document.getElementById('reactionMenu');
    const camMenu = document.getElementById('camMenu');
    const micMenu = document.getElementById('micMenu');
    if (camMenu) camMenu.style.display = 'none';
    if (micMenu) micMenu.style.display = 'none';

    if (menu.style.display === 'flex') {
        menu.style.display = 'none';
        return;
    }

    menu.innerHTML = '';
    const handBtn = document.createElement('button');
    handBtn.className = 'react-item';
    handBtn.innerText = AppState.handRaised ? "Lower Hand 🖐️" : "Raise Hand 🖐️";
    handBtn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        AppState.handRaised = !AppState.handRaised;
        updateHandBadge('local', AppState.handRaised);
        sendDataPacket({ type: 'HAND_RAISE', raised: AppState.handRaised });
        menu.style.display = 'none';
    };
    menu.appendChild(handBtn);

    const emojis = ['👏', '👍', '🎉', '😊', '😢'];
    const emojiGrid = document.createElement('div');
    emojiGrid.className = 'react-grid';

    emojis.forEach(emoji => {
        const emojiBtn = document.createElement('button');
        emojiBtn.className = 'react-emoji-btn';
        emojiBtn.innerText = emoji;
        emojiBtn.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            triggerFloatingEmoji('tile_local_camera', emoji);
            sendDataPacket({ type: 'REACTION', emoji });
            menu.style.display = 'none';
        };
        emojiGrid.appendChild(emojiBtn);
    });

    menu.appendChild(emojiGrid);
    menu.style.display = 'flex';
}

export function checkMassMuteRules() {
    if (!AppState.activeRoom || !AppState.activeRoom.localParticipant) return;
    
    const totalParticipants = AppState.activeRoom.remoteParticipants.size + 1; 
    
    if (totalParticipants > 5) {
        if (AppState.activeRoom.localParticipant.isSpeaking) {
            return;
        }

        if (!AppState.micMuted) {
            AppState.micMuted = true;
            const btn = document.getElementById('btnMic');
            if (btn) {
                btn.innerText = "Unmute";
                btn.classList.add('active-off');
            }
            AppState.activeRoom.localParticipant.setMicrophoneEnabled(false);
            alert("Room reached >5 participants. Microphone auto-muted.");
        }
    }
}

export async function toggleMic() {
    if (!AppState.activeRoom) return;

    let micMenu = document.getElementById('micMenu');
    if (!micMenu) {
        micMenu = document.createElement('div');
        micMenu.id = 'micMenu';
        document.getElementById('video-container').appendChild(micMenu);
    }

    const camMenu = document.getElementById('camMenu');
    const reactMenu = document.getElementById('reactionMenu');
    if (camMenu) camMenu.style.display = 'none';
    if (reactMenu) reactMenu.style.display = 'none';

    const btn = document.getElementById('btnMic');
    
    if (micMenu.style.display === 'flex') { micMenu.style.display = 'none'; return; }
    
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioDevices = devices.filter(d => d.kind === 'audioinput');
        
        const needsPermission = audioDevices.length === 0 || audioDevices.every(d => d.label === '');

        micMenu.innerHTML = '';
        
        if (needsPermission) {
            const requestRow = document.createElement('button');
            requestRow.className = 'cam-item';
            requestRow.innerText = "Allow Microphone Access";
            requestRow.onclick = async (e) => {
                e.preventDefault(); e.stopPropagation();
                micMenu.style.display = 'none';
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ 
                        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
                    });
                    stream.getTracks().forEach(t => t.stop());
                    toggleMic();
                } catch (err) {
                    alert("Microphone access is blocked by browser settings. Please check your URL bar permissions.");
                }
            };
            micMenu.appendChild(requestRow);
        } else {
            const disableRow = document.createElement('button');
            disableRow.className = 'cam-item turn-off';
            disableRow.innerText = "Mute Microphone";
            if (AppState.micMuted) disableRow.disabled = true;
            
            disableRow.onclick = async (e) => {
                e.preventDefault(); e.stopPropagation();
                micMenu.style.display = 'none';
                AppState.micMuted = true;
                btn.innerText = "Unmute";
                btn.classList.add('active-off');
                try { await AppState.activeRoom.localParticipant.setMicrophoneEnabled(false); } catch(err) {}
            };
            micMenu.appendChild(disableRow);
            
            audioDevices.forEach((device, index) => {
                const optionRow = document.createElement('button');
                optionRow.className = 'cam-item';
                const label = device.label || `Microphone ${index + 1}`;
                optionRow.innerText = label;
                
                const audioPub = AppState.activeRoom.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
                const isActive = !AppState.micMuted && audioPub && audioPub.audioTrack && audioPub.audioTrack.mediaStreamTrack.getSettings().deviceId === device.deviceId;
                
                if (isActive) {
                    optionRow.disabled = true;
                    optionRow.innerText = `${label} (Active)`;
                }
                
                optionRow.onclick = async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    micMenu.style.display = 'none';
                    
                    try {
                        if (audioPub && audioPub.audioTrack && !audioPub.isMuted) {
                            await AppState.activeRoom.switchActiveDevice('audioinput', device.deviceId);
                        } else {
                            if (audioPub && audioPub.audioTrack) {
                                await AppState.activeRoom.localParticipant.unpublishTrack(audioPub.audioTrack);
                                audioPub.audioTrack.stop();
                            }
                            // Enforce WebRTC hardware noise suppression and echo cancellation
                            const newMicTrack = await LivekitClient.createLocalAudioTrack({ 
                                deviceId: device.deviceId,
                                echoCancellation: true,
                                noiseSuppression: true,
                                autoGainControl: true
                            });
                            await AppState.activeRoom.localParticipant.publishTrack(newMicTrack);
                        }
                        
                        AppState.micMuted = false;
                        btn.innerText = "Mic";
                        btn.classList.remove('active-off');
                    } catch (err) {
                        console.error("[Hardware] Mic switch failed", err);
                        alert("Could not access this microphone. It may be in use by another app.");
                    }
                };
                micMenu.appendChild(optionRow);
            });
        }
        micMenu.style.display = 'flex';
    } catch (err) { 
        console.error("[Hardware] Mic enumerator failed:", err); 
        AppState.micMuted = !AppState.micMuted;
        btn.innerText = AppState.micMuted ? "Unmute" : "Mic";
        AppState.micMuted ? btn.classList.add('active-off') : btn.classList.remove('active-off');
        try { await AppState.activeRoom.localParticipant.setMicrophoneEnabled(!AppState.micMuted); } catch(e){}
    }
}

export async function toggleCam() {
    if (!AppState.activeRoom) return;
    const menu = document.getElementById('camMenu');
    const reactMenu = document.getElementById('reactionMenu');
    const micMenu = document.getElementById('micMenu');
    if (reactMenu) reactMenu.style.display = 'none';
    if (micMenu) micMenu.style.display = 'none';
    
    const btn = document.getElementById('btnCam');
    
    if (menu.style.display === 'flex') { menu.style.display = 'none'; return; }
    
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        
        const needsPermission = videoDevices.length === 0 || videoDevices.every(d => d.label === '');

        menu.innerHTML = '';

        if (needsPermission) {
            const requestRow = document.createElement('button');
            requestRow.className = 'cam-item';
            requestRow.innerText = "Allow Camera Access";
            requestRow.onclick = async (e) => {
                e.preventDefault(); e.stopPropagation();
                menu.style.display = 'none';
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                    stream.getTracks().forEach(t => t.stop()); 
                    toggleCam();
                } catch (err) {
                    alert("Camera access is blocked by browser settings. Please check your URL bar permissions.");
                }
            };
            menu.appendChild(requestRow);
        } else {
            videoDevices.sort((a, b) => {
                if (a.label.toLowerCase().includes('triple') || a.label.toLowerCase().includes('dual')) return -1;
                return 0;
            });

            let uniqueSimplifiedDevices = [];
            let processedFront = false;
            let processedBack = false;

            videoDevices.forEach(device => {
                const rawLabel = device.label.toLowerCase();
                if (rawLabel.includes('front') || rawLabel.includes('vorder') || rawLabel.includes('facetime')) {
                    if (!processedFront) { uniqueSimplifiedDevices.push({ id: device.deviceId, name: "Front Camera" }); processedFront = true; }
                } else if (rawLabel.includes('back') || rawLabel.includes('rück') || rawLabel.includes('rear') || rawLabel.includes('environment')) {
                    if (!processedBack) { uniqueSimplifiedDevices.push({ id: device.deviceId, name: "Rear Camera" }); processedBack = true; }
                } else {
                    uniqueSimplifiedDevices.push({ id: device.deviceId, name: device.label || `Camera ${uniqueSimplifiedDevices.length + 1}` });
                }
            });

            const disableRow = document.createElement('button');
            disableRow.className = 'cam-item turn-off';
            disableRow.innerText = "Turn off camera";
            if (AppState.camMuted) disableRow.disabled = true;

            disableRow.onclick = async (e) => {
                e.preventDefault(); e.stopPropagation();
                menu.style.display = 'none';
                AppState.camMuted = true;
                btn.innerText = "Start";
                btn.classList.add('active-off'); 
                
                const cameraPub = AppState.activeRoom.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
                if (cameraPub && cameraPub.videoTrack) {
                    await AppState.activeRoom.localParticipant.unpublishTrack(cameraPub.videoTrack);
                    cameraPub.videoTrack.stop();
                }
                AppState.preWarmedTracks = AppState.preWarmedTracks.filter(t => { if (t.kind === 'video') { t.stop(); return false; } return true; });

                const localTile = document.getElementById('tile_local_camera');
                if (localTile) localTile.querySelectorAll('video').forEach(v => { v.srcObject = null; v.remove(); });
                
                recalculateLayout();
            };
            menu.appendChild(disableRow);

            uniqueSimplifiedDevices.forEach((device) => {
                const optionRow = document.createElement('button');
                optionRow.className = 'cam-item';
                optionRow.innerText = device.name;
                
                const isCurrentActiveLens = !AppState.camMuted && (device.id === AppState.currentCameraDeviceId);
                if (isCurrentActiveLens) {
                    optionRow.disabled = true; 
                    optionRow.innerText = `${device.name} (Active)`;
                }

                optionRow.onclick = async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    menu.style.display = 'none';
                    AppState.camMuted = false;
                    AppState.currentCameraDeviceId = device.id; 
                    btn.innerText = "Cam";
                    btn.classList.remove('active-off'); 

                    try {
                        const cameraPub = AppState.activeRoom.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
                        if (cameraPub && cameraPub.videoTrack && !cameraPub.isMuted) {
                            await AppState.activeRoom.switchActiveDevice('videoinput', device.id);
                            const updatedTrack = cameraPub.videoTrack;
                            if (updatedTrack) {
                                const localTile = ensureParticipantTile(AppState.activeRoom.localParticipant, 'camera');
                                let videoTag = localTile?.querySelector('video');
                                if (videoTag) updatedTrack.attach(videoTag);
                                applyDynamicMirrorEffect(updatedTrack);
                            }
                        } else {
                            if (cameraPub && cameraPub.videoTrack) {
                                await AppState.activeRoom.localParticipant.unpublishTrack(cameraPub.videoTrack);
                                cameraPub.videoTrack.stop();
                            }
                            AppState.preWarmedTracks = AppState.preWarmedTracks.filter(t => { if (t.kind === 'video') { t.stop(); return false; } return true; });
                            await new Promise(resolve => setTimeout(resolve, 100));

                            const newLensTrack = await LivekitClient.createLocalVideoTrack({
                                deviceId: device.id,
                                resolution: { width: { ideal: 2560 }, height: { ideal: 1440 } }
                            });
                            
                            const localTile = ensureParticipantTile(AppState.activeRoom.localParticipant, 'camera');
                            if (localTile) {
                                let videoTag = localTile.querySelector('video');
                                if (!videoTag) {
                                    videoTag = document.createElement('video');
                                    videoTag.playsInline = true;
                                    videoTag.setAttribute('playsinline', 'true');
                                    videoTag.setAttribute('webkit-playsinline', 'true');
                                    videoTag.muted = true;
                                    videoTag.controls = false;
                                    videoTag.style.position = 'relative';
                                    videoTag.style.zIndex = '2';
                                    localTile.insertBefore(videoTag, localTile.firstChild);
                                }
                                newLensTrack.attach(videoTag);
                                videoTag.muted = true;
                                videoTag.playsInline = true;
                                videoTag.play().catch(() => {});
                                applyDynamicMirrorEffect(newLensTrack);
                            }
                            await AppState.activeRoom.localParticipant.publishTrack(newLensTrack);
                            AppState.preWarmedTracks.push(newLensTrack);
                        }
                        recalculateLayout();
                    } catch (lensErr) { console.error("[Hardware] Camera switch rejected:", lensErr); }
                };
                menu.appendChild(optionRow);
            });
        }
        menu.style.display = 'flex';
    } catch (err) { console.error("[Hardware] Device enumerator failed:", err); }
}

export async function toggleScreenShare() {
    if (!AppState.activeRoom) return;
    try {
        AppState.screenSharingActive = !AppState.screenSharingActive;
        const btn = document.getElementById('btnScreen');
        await AppState.activeRoom.localParticipant.setScreenShareEnabled(AppState.screenSharingActive);
        btn.innerText = AppState.screenSharingActive ? "Stop" : "Share";
        AppState.screenSharingActive ? btn.classList.add('active-off') : btn.classList.remove('active-off');
    } catch (e) {
        AppState.screenSharingActive = false;
        document.getElementById('btnScreen').classList.remove('active-off');
        document.getElementById('btnScreen').innerText = "Share";
    }
}

export function cleanupTileTrack(participantIdentity, trackSource) {
    const isLocal = participantIdentity === 'local' || (AppState.activeRoom && participantIdentity === AppState.activeRoom.localParticipant?.identity);
    const targetTileId = isLocal ? (trackSource === 'camera' ? 'tile_local_camera' : 'tile_local_screen_share') : `tile_${participantIdentity}_${trackSource}`;
    
    if (targetTileId === AppState.activeScreenShareTileId) AppState.activeScreenShareTileId = null;
    if (targetTileId === AppState.pinnedTileId) AppState.pinnedTileId = null;

    const targetTile = document.getElementById(targetTileId);
    if (targetTile) {
        if (trackSource === 'screen_share') {
            targetTile.remove();
        } else {
            targetTile.querySelectorAll('video').forEach(v => { v.srcObject = null; v.remove(); });
        }
    }
    recalculateLayout();
}

export function cleanupAllTilesForParticipant(participantIdentity) {
    const matchingTiles = document.querySelectorAll(`[id^="tile_${participantIdentity}_"]`);
    matchingTiles.forEach(tile => {
        if (tile.id === AppState.pinnedTileId) AppState.pinnedTileId = null;
        if (tile.id === AppState.activeScreenShareTileId) AppState.activeScreenShareTileId = null;
        tile.remove();
    });
    recalculateLayout();
}

export function terminateSession(shouldReload = true) {
    AppState.preWarmedTracks.forEach(track => { try { track.stop(); } catch(e){} });
    AppState.preWarmedTracks = [];
    if (AppState.activeRoom) {
        try { AppState.activeRoom.disconnect(); } catch(e){}
        AppState.activeRoom = null;
    }
    if (shouldReload) location.reload();
}
