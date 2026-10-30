import { AppState, videoCaptureProfile, getResolutionProfile } from './state.js';
import { normalizeOutgoingMicTrack, getOutgoingSourceTrack, releaseOutgoingForPublished, teardownAllNormalization, getMicConstraints, setMicMonitorMuted, setPreferredMicDeviceId } from './audio-normalizer.js';
import { recalculateLayout, applyDynamicMirrorEffect, triggerFloatingEmoji, updateHandBadge, showToast, setDockLabel, hueIndexFor } from './ui.js';
import { renderMessage, renderFile, setDisappearing } from './chat.js';
import { handlePollUpdate } from './polls.js';
import { applyBackground, buildBackgroundPicker, streamerOutput, onStreamerChange } from './background-effects.js';

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

        let hash = 0;
        const seed = `${participant.identity || rawCleanName}`;
        for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
        const variant = hash % 6;

        tile.innerHTML = `
            <div class="touch-shield" role="button" tabindex="0" aria-pressed="false" aria-label="Pin ${escapeAttr(isScreenShare ? rawCleanName + ' screen' : rawCleanName)}"></div>
            <div class="hand-badge" role="img" aria-label="Hand raised"><svg class="icon" aria-hidden="true"><use class="ic-pixel" href="#i-hand"/><use class="ic-smooth" href="#s-hand"/></svg></div>
            <div class="avatar-placeholder av${variant}" data-initial="${escapeAttr(rawCleanName.charAt(0).toUpperCase())}"><div class="cyber-avatar"><div class="ca-ear l"></div><div class="ca-ear r"></div><div class="ca-head"></div><div class="ca-hair"></div><div class="ca-visor"></div><div class="ca-body"></div></div></div>
            <div class="name-tag">${isScreenShare ? `${rawCleanName} (Screen)` : rawCleanName}</div>
        `;
        
        // identity hue (Prism theme): same name → same colour everywhere
        const hue = hueIndexFor(rawCleanName);
        tile.style.setProperty('--who-h', String(hue));
        if (isLocalUser) document.documentElement.style.setProperty('--me-h', String(hue));

        const shield = tile.querySelector('.touch-shield');
        const togglePin = () => {
            if (targetTileId === 'tile_local_camera') return;
            AppState.pinnedTileId = (AppState.pinnedTileId === targetTileId) ? null : targetTileId;
            recalculateLayout();
        };
        if (targetTileId === 'tile_local_camera') {
            ['role', 'tabindex', 'aria-pressed', 'aria-label'].forEach(a => shield.removeAttribute(a));
        }
        shield.addEventListener('click', togglePin);
        shield.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePin(); }
        });

        document.getElementById('videoGrid').appendChild(tile);
    }
    return tile;
}

export function attachParticipantVideoTrack(track, participant, streamSource) {
    const tile = ensureParticipantTile(participant, streamSource);
    if (streamSource === 'screen_share') AppState.activeScreenShareTileId = tile.id;

    // Release the old element's stream so it doesn't keep decoding off-DOM.
    tile.querySelectorAll('video').forEach(v => { v.srcObject = null; v.remove(); });
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
    // Listeners have no permission to publish data.
    if (!AppState.activeRoom || AppState.audienceMode) return;
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(payload));
    AppState.activeRoom.localParticipant.publishData(data, LivekitClient.DataPacket_Kind.RELIABLE);
}

export function broadcastCodecPreference() {
    if (!AppState.activeRoom || !AppState.activeRoom.localParticipant) return;
    sendDataPacket({
        type: 'CODEC_PREFERENCE',
        identity: AppState.activeRoom.localParticipant.identity,
        preference: AppState.localPreferredCodec
    });
}

let negotiationDebounceTimer = null;
export function evaluateAndNegotiateCodec() {
    if (AppState.audienceMode) return;
    clearTimeout(negotiationDebounceTimer);
    negotiationDebounceTimer = setTimeout(async () => {
        let h264Count = 0;
        let vp8Count = 0;

        for (const pref of AppState.participantPreferences.values()) {
            if (pref === 'vp8') vp8Count++;
            else h264Count++;
        }

        const targetCodec = vp8Count > h264Count ? 'vp8' : 'h264';

        if (targetCodec !== AppState.currentPublishedCodec) {
            console.log(`[Codec Engine] Consensus shifted (H.264: ${h264Count}, VP8: ${vp8Count}). Target: ${targetCodec}`);
            await renegotiateVideoCodec(targetCodec);
        }
    }, 300);
}

export async function renegotiateVideoCodec(newCodec) {
    if (AppState.currentPublishedCodec === newCodec || AppState.isRenegotiating) return;
    if (!AppState.activeRoom || !AppState.activeRoom.localParticipant) return;

    AppState.isRenegotiating = true;
    const oldCodec = AppState.currentPublishedCodec;
    AppState.currentPublishedCodec = newCodec;

    try {
        // Republishing gives new senders; the Streamer picture is put back on them afterwards
        await syncStreamer({ off: true });
        const cameraPub = AppState.activeRoom.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
        if (cameraPub && cameraPub.videoTrack && !AppState.camMuted) {
            const track = cameraPub.videoTrack;
            await AppState.activeRoom.localParticipant.unpublishTrack(track, false);
            await AppState.activeRoom.localParticipant.publishTrack(track, {
                videoCodec: newCodec,
                simulcast: true
            });
        }

        const screenPub = AppState.activeRoom.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShare);
        if (screenPub && screenPub.videoTrack && AppState.screenSharingActive) {
            const screenTrack = screenPub.videoTrack;
            await AppState.activeRoom.localParticipant.unpublishTrack(screenTrack, false);
            await AppState.activeRoom.localParticipant.publishTrack(screenTrack, {
                videoCodec: newCodec,
                simulcast: true
            });
        }
    } catch (err) {
        console.error("[Codec Engine] Renegotiation error:", err);
        AppState.currentPublishedCodec = oldCodec;
    } finally {
        syncStreamer();
        setTimeout(() => {
            AppState.isRenegotiating = false;
        }, 200);
    }
}

export function handleIncomingDataPacket(payload, participant) {
    try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (data.type === 'REACTION') {
            const tileId = participant ? `tile_${participant.identity}_camera` : 'tile_local_camera';
            triggerFloatingEmoji(tileId, data.emoji);
        } else if (data.type === 'HAND_RAISE') {
            updateHandBadge(participant?.identity, data.raised);
        } else if (data.type === 'CODEC_PREFERENCE') {
            const isNewParticipant = !AppState.participantPreferences.has(data.identity);
            AppState.participantPreferences.set(data.identity, data.preference);

            if (isNewParticipant && AppState.activeRoom && AppState.activeRoom.localParticipant) {
                broadcastCodecPreference();
            }
            evaluateAndNegotiateCodec();
        } else if (data.type === 'CHAT_MESSAGE') {
            renderMessage(data.payload, false);
        } else if (data.type === 'CHAT_MESSAGE_REMOVE') {
            document.getElementById(`msg_${data.id}`)?.remove();
        } else if (data.type === 'FILE_SHARED') {
            renderFile(data.payload, false);
        } else if (data.type === 'POLL_UPDATE') {
            handlePollUpdate(data.poll);
        } else if (data.type === 'ROOM_SETTINGS') {
            if (typeof data.disappearing === 'boolean') setDisappearing(data.disappearing, participant?.name || 'Someone');
        }
    } catch (e) {
        console.error("[DataChannel] Packet parse error:", e);
    }
}

export function toggleReactionMenu() {
    const menu = document.getElementById('reactionMenu');
    const camMenu = document.getElementById('camMenu');
    if (camMenu) camMenu.style.display = 'none';
    hideSoundMenu();

    if (menu.style.display === 'flex') {
        menu.style.display = 'none';
        return;
    }

    menu.innerHTML = '';
    const handBtn = document.createElement('button');
    handBtn.className = 'react-item';
    handBtn.innerText = AppState.handRaised ? "Lower hand" : "Raise hand";
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

// From this room size on, people join with their mic off. Those already
// talking keep their mic; only the newcomer is muted.
export const AUTO_MUTE_ROOM_SIZE = 4;

/** True when joining now would make the room big enough to join muted. */
export function shouldJoinMuted() {
    if (!AppState.activeRoom || AppState.audienceMode) return false;
    return AppState.activeRoom.remoteParticipants.size + 1 >= AUTO_MUTE_ROOM_SIZE;
}

/** Marks the local mic as muted in state and on the dock button. */
export function markMicMuted() {
    AppState.micMuted = true;
    setMicMonitorMuted(true);
    const btn = document.getElementById('btnMic');
    if (btn) {
        setDockLabel(btn, "Unmute");
        btn.classList.add('active-off');
    }
}

/** Device id of the raw mic behind the published microphone track, if any. */
export function getActiveMicDeviceId() {
    const audioPub = AppState.activeRoom?.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
    if (!audioPub || !audioPub.audioTrack) return undefined;
    return getOutgoingSourceTrack(audioPub.audioTrack.mediaStreamTrack).getSettings().deviceId;
}

/**
 * (Re)publishes the microphone with the current browser processing settings,
 * on the given device or else the one picked in the sound panel. Always
 * republishes: switchActiveDevice / restartTrack would restart the published
 * track with a raw mic and bypass the graph.
 */
export async function republishMic(deviceId) {
    const audioPub = AppState.activeRoom.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
    if (audioPub && audioPub.audioTrack) {
        // Keep our own reference: unpublishTrack clears audioPub.audioTrack
        const oldTrack = audioPub.audioTrack;
        const oldMediaTrack = oldTrack.mediaStreamTrack;
        await AppState.activeRoom.localParticipant.unpublishTrack(oldTrack);
        oldTrack.stop();
        releaseOutgoingForPublished(oldMediaTrack);
    }
    const newMicTrack = await LivekitClient.createLocalAudioTrack({ ...getMicConstraints(), ...(deviceId && { deviceId }) });
    const normalizedMediaTrack = normalizeOutgoingMicTrack(newMicTrack.mediaStreamTrack);
    const publishableTrack = normalizedMediaTrack !== newMicTrack.mediaStreamTrack
        ? new LivekitClient.LocalAudioTrack(normalizedMediaTrack)
        : newMicTrack;
    // Tag as microphone so setMicrophoneEnabled / getTrackPublication find it
    await AppState.activeRoom.localParticipant.publishTrack(publishableTrack, {
        source: LivekitClient.Track.Source.Microphone
    });
    setMicMonitorMuted(false);
}

let micSwitching = false;

/**
 * Mutes a live mic, unmutes a muted one. Unmuting reopens the mic picked in
 * the sound panel (the system default until one is picked), so nobody has to
 * choose their mic again, and picks up processing changes made while muted.
 */
export async function toggleMic() {
    if (!AppState.activeRoom || micSwitching) return;
    ['camMenu', 'reactionMenu'].forEach(id => {
        const m = document.getElementById(id);
        if (m) m.style.display = 'none';
    });
    hideSoundMenu();

    micSwitching = true;
    try {
        if (!AppState.micMuted) {
            markMicMuted();
            try { await AppState.activeRoom.localParticipant.setMicrophoneEnabled(false); } catch (err) {}
            return;
        }
        await republishMic();
        markMicLive();
    } catch (err) {
        console.error("[Hardware] Mic start failed", err);
        showToast(err?.name === 'NotAllowedError'
            ? "Microphone access is blocked. Allow it in your browser's site settings."
            : "Couldn't turn on your microphone. Pick another one under Sound.", "error", 5000);
    } finally {
        micSwitching = false;
    }
}

/**
 * Remembers the mic picked in the sound panel ('' = system default) and
 * switches a live mic over to it. A muted mic stays muted and uses it on unmute.
 */
export async function selectMic(deviceId) {
    setPreferredMicDeviceId(deviceId);
    if (!AppState.activeRoom || AppState.micMuted) return;
    micSwitching = true;
    try {
        await republishMic();
        markMicLive();
    } finally {
        micSwitching = false;
    }
}

function markMicLive() {
    AppState.micMuted = false;
    setMicMonitorMuted(false);
    const btn = document.getElementById('btnMic');
    if (btn) {
        setDockLabel(btn, "Mic");
        btn.classList.remove('active-off');
    }
}

export async function toggleCam() {
    if (!AppState.activeRoom) return;
    const menu = document.getElementById('camMenu');
    const reactMenu = document.getElementById('reactionMenu');
    if (reactMenu) reactMenu.style.display = 'none';
    hideSoundMenu();
    
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
            requestRow.innerText = "Allow camera access";
            requestRow.onclick = async (e) => {
                e.preventDefault(); e.stopPropagation();
                menu.style.display = 'none';
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                    stream.getTracks().forEach(t => t.stop()); 
                    toggleCam();
                } catch (err) {
                    showToast("Camera access is blocked. Allow it in your browser's site settings.", "error", 5000);
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
                    if (!processedFront) { uniqueSimplifiedDevices.push({ id: device.deviceId, name: "Front camera" }); processedFront = true; }
                } else if (rawLabel.includes('back') || rawLabel.includes('rück') || rawLabel.includes('rear') || rawLabel.includes('environment')) {
                    if (!processedBack) { uniqueSimplifiedDevices.push({ id: device.deviceId, name: "Rear camera" }); processedBack = true; }
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
                setDockLabel(btn, "Start");
                btn.classList.add('active-off'); 
                // The screen goes out on its own again before the picture made from the camera ends
                await syncStreamer({ off: true });
                
                const cameraPub = AppState.activeRoom.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
                if (cameraPub && cameraPub.videoTrack) {
                    const oldCamTrack = cameraPub.videoTrack;
                    await AppState.activeRoom.localParticipant.unpublishTrack(oldCamTrack);
                    oldCamTrack.stop();
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
                    optionRow.innerText = `${device.name} (active)`;
                }

                optionRow.onclick = async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    menu.style.display = 'none';
                    AppState.camMuted = false;
                    AppState.currentCameraDeviceId = device.id; 
                    setDockLabel(btn, "Cam");
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
                                // The processor follows the new camera by itself; platform blur and a lowered resolution do not
                                applyBackground(updatedTrack).catch(err => console.error("[Background] Re-applying after camera switch failed", err));
                            }
                        } else {
                            if (cameraPub && cameraPub.videoTrack) {
                                const oldCamTrack = cameraPub.videoTrack;
                                await AppState.activeRoom.localParticipant.unpublishTrack(oldCamTrack);
                                oldCamTrack.stop();
                            }
                            AppState.preWarmedTracks = AppState.preWarmedTracks.filter(t => { if (t.kind === 'video') { t.stop(); return false; } return true; });
                            await new Promise(resolve => setTimeout(resolve, 100));

                            // === RESOLUTION PROFILER APPLIED HERE ===
                            const newLensTrack = await LivekitClient.createLocalVideoTrack({
                                deviceId: device.id,
                                resolution: getResolutionProfile(device.name)
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
                            try {
                                await applyBackground(newLensTrack);
                            } catch (bgErr) {
                                console.error("[Background] Effect failed to start", bgErr);
                                newLensTrack.stop();
                                markCamOff();
                                showToast("Your background effect couldn't start, so your camera stays off. Pick None under Cam to start it without one.", "error", 6000);
                                return;
                            }
                            await AppState.activeRoom.localParticipant.publishTrack(newLensTrack, {
                                videoCodec: AppState.currentPublishedCodec,
                                simulcast: true
                            });
                            AppState.preWarmedTracks.push(newLensTrack);
                        }
                        recalculateLayout();
                    } catch (lensErr) { console.error("[Hardware] Camera switch rejected:", lensErr); }
                };
                menu.appendChild(optionRow);
            });

            const backgroundPicker = buildBackgroundPicker(() => {
                if (AppState.camMuted) return null;
                return AppState.activeRoom?.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera)?.videoTrack || null;
            }, {
                startScreenShare: () => { if (!AppState.screenSharingActive) toggleScreenShare(); }
            });
            if (backgroundPicker) menu.appendChild(backgroundPicker);
        }
        menu.style.display = 'flex';
    } catch (err) { console.error("[Hardware] Device enumerator failed:", err); }
}

/** Marks the camera as off in state and on the dock button, and clears the local preview. */
export function markCamOff() {
    AppState.camMuted = true;
    syncStreamer({ off: true });
    const btn = document.getElementById('btnCam');
    if (btn) {
        setDockLabel(btn, "Start");
        btn.classList.add('active-off');
    }
    const localTile = document.getElementById('tile_local_camera');
    if (localTile) localTile.querySelectorAll('video').forEach(v => { v.srcObject = null; v.remove(); });
    recalculateLayout();
}

// --- Streamer: one picture of screen and person, sent in place of both ----------------------
// The screen share's sender carries the camera's processed picture (the screen, the person in the
// corner, at the screen's size), so others get it large and sharp, laid out as a shared screen.
// The camera stops sending (paused upstream: others see it as muted) but keeps running here,
// since the picture is made from it.

let streamerMerged = null;   // { camera, screen } while the screen share carries the picture
let streamerQueue = Promise.resolve();

/** Sends the Streamer picture when it is on, else camera and screen as usual. off: always as usual. */
export function syncStreamer({ off = false } = {}) {
    streamerQueue = streamerQueue.then(() => applyStreamer(off))
        .catch(err => console.error('[Streamer] Switching what is sent failed', err));
    return streamerQueue;
}

async function applyStreamer(off) {
    const local = AppState.activeRoom?.localParticipant;
    const camera = off || AppState.camMuted ? null : local?.getTrackPublication(LivekitClient.Track.Source.Camera)?.videoTrack;
    const screen = local?.getTrackPublication(LivekitClient.Track.Source.ScreenShare)?.videoTrack;
    const output = streamerOutput(camera);
    if (output && camera.sender && screen?.sender) {
        await camera.pauseUpstream();
        // LiveKit points the camera's sender at the effect again whenever the effect restarts
        await camera.sender.replaceTrack(null);
        await screen.sender.replaceTrack(output);
        // Your own screen tile shows what the others get
        showLocalScreen(output);
        streamerMerged = { camera, screen };
        return;
    }
    if (!streamerMerged) return;
    const merged = streamerMerged;
    streamerMerged = null;
    // Unpublished tracks have no sender any more
    if (merged.screen.sender && merged.screen.mediaStreamTrack.readyState === 'live') {
        await merged.screen.sender.replaceTrack(merged.screen.mediaStreamTrack);
        showLocalScreen(merged.screen.mediaStreamTrack);
    }
    if (merged.camera.sender) await merged.camera.resumeUpstream();
}

function showLocalScreen(track) {
    const video = document.querySelector('#tile_local_screen_share video');
    if (!video || video.srcObject?.getVideoTracks?.()[0] === track) return;
    video.srcObject = new MediaStream([track]);
    video.play().catch(() => {});
}

onStreamerChange(() => syncStreamer());

export async function toggleScreenShare() {
    if (!AppState.activeRoom) return;
    try {
        AppState.screenSharingActive = !AppState.screenSharingActive;
        const btn = document.getElementById('btnScreen');
        await AppState.activeRoom.localParticipant.setScreenShareEnabled(
            AppState.screenSharingActive,
            { audio: false },
            { videoCodec: AppState.currentPublishedCodec, simulcast: true }
        );
        setDockLabel(btn, AppState.screenSharingActive ? "Stop" : "Share");
        btn.classList.toggle('active-on', !!AppState.screenSharingActive);
    } catch (e) {
        AppState.screenSharingActive = false;
        document.getElementById('btnScreen').classList.remove('active-on');
        setDockLabel(document.getElementById('btnScreen'), "Share");
    }
}

export function cleanupTileTrack(participantIdentity, trackSource) {
    const isLocal = participantIdentity === 'local' || (AppState.activeRoom && participantIdentity === AppState.activeRoom.localParticipant?.identity);
    if (AppState.isRenegotiating && isLocal) return;

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
    teardownAllNormalization();
    document.body.classList.remove('in-session');
    AppState.preWarmedTracks.forEach(track => { try { track.stop(); } catch(e){} });
    AppState.preWarmedTracks = [];
    if (AppState.activeRoom) {
        try { AppState.activeRoom.disconnect(); } catch(e){}
        AppState.activeRoom = null;
    }
    if (shouldReload) location.reload();
}

function escapeAttr(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

function hideSoundMenu() {
    const soundMenu = document.getElementById('soundMenu');
    if (soundMenu) soundMenu.style.display = 'none';
}
