import { AppState } from './state.js';

// === WEB AUDIO API SYNTH SOUND GENERATOR ===
export function playSynthSound(type) {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        if (ctx.state === 'suspended') {
            ctx.resume();
        }

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        const now = ctx.currentTime;

        if (type === '👍' || type === '👏') {
            // High-pitched retro coin/blip
            osc.type = 'square';
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
            gain.gain.setValueAtTime(0.06, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
            osc.start(now);
            osc.stop(now + 0.14);
        } else if (type === '🎉') {
            // Retro 8-bit fanfare chime
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(523.25, now); // C5
            osc.frequency.setValueAtTime(659.25, now + 0.07); // E5
            osc.frequency.setValueAtTime(783.99, now + 0.14); // G5
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
            osc.start(now);
            osc.stop(now + 0.22);
        } else if (type === 'HAND_RAISE') {
            // Synthwave radar ping
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, now);
            osc.frequency.exponentialRampToValueAtTime(440, now + 0.18);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
            osc.start(now);
            osc.stop(now + 0.18);
        } else {
            // Soft arcade pop
            osc.type = 'sine';
            osc.frequency.setValueAtTime(600, now);
            osc.frequency.exponentialRampToValueAtTime(300, now + 0.08);
            gain.gain.setValueAtTime(0.05, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
            osc.start(now);
            osc.stop(now + 0.08);
        }
    } catch (e) {
        // Suppress audio context restrictions if user has not interacted yet
    }
}

export function copyShareLink() {
    const roomName = document.getElementById('headerRoomLabel').innerText;
    const deepLink = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(roomName)}`;
    
    navigator.clipboard.writeText(deepLink)
        .then(() => alert("Deep link copied to clipboard!"))
        .catch(() => alert("Failed to copy link."));
}

export function applyDynamicMirrorEffect(videoTrackInstance) {
    const localTile = document.getElementById('tile_local_camera');
    if (!localTile || !videoTrackInstance || !videoTrackInstance.mediaStreamTrack) return;
    
    const trackLabel = (videoTrackInstance.mediaStreamTrack.label || '').toLowerCase();
    const trackSettings = videoTrackInstance.mediaStreamTrack.getSettings ? videoTrackInstance.mediaStreamTrack.getSettings() : {};
    const facingMode = trackSettings.facingMode || '';

    if (facingMode === 'environment' || trackLabel.includes('back') || trackLabel.includes('rück') || trackLabel.includes('rear')) {
        localTile.classList.remove('mirror-mode'); 
    } else {
        localTile.classList.add('mirror-mode'); 
    }
}

export function recalculateLayout() {
    const grid = document.getElementById('videoGrid');
    if (!grid) return;
    
    const rawTiles = Array.from(grid.querySelectorAll('.video-tile')); 
    let targetMaximizeId = null;

    if (AppState.pinnedTileId && document.getElementById(AppState.pinnedTileId)) {
        targetMaximizeId = AppState.pinnedTileId;
    } else if (AppState.activeScreenShareTileId && document.getElementById(AppState.activeScreenShareTileId)) {
        targetMaximizeId = AppState.activeScreenShareTileId;
    }

    const isMobile = window.innerWidth <= 768;

    // Reset base border colors and glow
    rawTiles.forEach(tile => {
        tile.classList.remove('maximized');
        tile.style.borderColor = '#7b2cbf';
        tile.style.boxShadow = '0 4px 10px rgba(123, 44, 191, 0.3)';
    });

    if (targetMaximizeId) {
        grid.classList.add('has-maximized');
        
        const gridTiles = rawTiles.sort((a, b) => {
            if (a.id === targetMaximizeId) return -1;
            if (b.id === targetMaximizeId) return 1;
            if (a.id === 'tile_local_camera') return 1;
            if (b.id === 'tile_local_camera') return -1;
            return 0;
        });
        
        const sidebarCount = Math.max(1, gridTiles.length - 1);
        
        if (!isMobile) {
            grid.style.gridTemplateColumns = 'minmax(0, 1fr) 200px';
            grid.style.gridTemplateRows = `repeat(${sidebarCount}, minmax(0, 1fr))`;
        } else {
            grid.style.gridTemplateColumns = `repeat(${sidebarCount}, minmax(0, 1fr))`;
            grid.style.gridTemplateRows = 'minmax(0, 1fr) 100px';
        }
        
        let sidebarIndex = 1; 

        gridTiles.forEach(tile => {
            if (tile.id === targetMaximizeId) {
                tile.classList.add('maximized');
                tile.style.borderColor = '#00f0ff';
                tile.style.boxShadow = '0 0 25px rgba(0, 240, 255, 0.6)';
                if (!isMobile) {
                    tile.style.gridColumn = '1';
                    tile.style.gridRow = `1 / span ${sidebarCount}`;
                } else {
                    tile.style.gridColumn = `1 / span ${sidebarCount}`;
                    tile.style.gridRow = '1';
                }
            } else {
                if (!isMobile) {
                    tile.style.gridColumn = '2';
                    tile.style.gridRow = `${sidebarIndex}`;
                } else {
                    tile.style.gridColumn = `${sidebarIndex}`;
                    tile.style.gridRow = '2';
                }
                sidebarIndex++;
            }
        });

    } else {
        grid.classList.remove('has-maximized');
        
        const gridTiles = rawTiles.filter(t => t.id !== 'tile_local_camera');
        const totalTiles = Math.max(1, gridTiles.length);
        
        let cols = Math.ceil(Math.sqrt(totalTiles));
        let rows = Math.ceil(totalTiles / cols);
        
        const aspect = grid.clientWidth / grid.clientHeight;
        if (aspect > 1.5 && totalTiles > 2) {
            cols = Math.ceil(Math.sqrt(totalTiles * aspect));
            rows = Math.ceil(totalTiles / cols);
        } else if (aspect < 0.8 && totalTiles > 2) {
            rows = Math.ceil(Math.sqrt(totalTiles / aspect));
            cols = Math.ceil(totalTiles / rows);
        }

        grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
        grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
        
        gridTiles.forEach(tile => {
            tile.style.gridColumn = 'auto'; 
            tile.style.gridRow = 'auto';
        });
        
        const localCam = document.getElementById('tile_local_camera');
        if (localCam) {
            localCam.style.gridColumn = 'auto';
            localCam.style.gridRow = 'auto';
        }
    }

    const localCameraTile = document.getElementById('tile_local_camera');
    if (localCameraTile && !localCameraTile.classList.contains('maximized')) {
        localCameraTile.style.borderColor = '#ff007f';
    }

    // === ACTIVE SPEAKER HIGHLIGHT ENGINE (INCLUDING MAXIMIZED TILES) ===
    if (AppState.activeSpeakerIdentity) {
        const isLocalSpeaker = AppState.activeRoom && AppState.activeSpeakerIdentity === AppState.activeRoom.localParticipant?.identity;
        const speakerTileId = isLocalSpeaker ? 'tile_local_camera' : `tile_${AppState.activeSpeakerIdentity}_camera`;
        const speakerScreenTileId = isLocalSpeaker ? 'tile_local_screen_share' : `tile_${AppState.activeSpeakerIdentity}_screen_share`;

        const speakerTile = document.getElementById(speakerTileId);
        if (speakerTile) {
            speakerTile.style.borderColor = '#39ff14';
            speakerTile.style.boxShadow = '0 0 15px rgba(57, 255, 20, 0.7)';
        }

        // If the maximized view belongs to the speaker (camera or their presentation), light it up green
        if (targetMaximizeId && (targetMaximizeId === speakerTileId || targetMaximizeId === speakerScreenTileId)) {
            const maxTile = document.getElementById(targetMaximizeId);
            if (maxTile) {
                maxTile.style.borderColor = '#39ff14';
                maxTile.style.boxShadow = '0 0 35px rgba(57, 255, 20, 0.9)';
            }
        }
    }
}

export function triggerFloatingEmoji(tileId, emoji) {
    const tile = document.getElementById(tileId) || document.getElementById('tile_local_camera');
    if (!tile) return;

    playSynthSound(emoji);

    const floatingEl = document.createElement('div');
    floatingEl.className = 'floating-emoji';
    floatingEl.innerText = emoji;
    
    floatingEl.style.left = `${Math.random() * 60 + 20}%`;
    floatingEl.style.bottom = `20%`;

    tile.appendChild(floatingEl);
    setTimeout(() => floatingEl.remove(), 1800);
}

export function updateHandBadge(participantIdentity, isRaised) {
    const isLocal = !participantIdentity || participantIdentity === 'local' || (AppState.activeRoom && participantIdentity === AppState.activeRoom.localParticipant?.identity);
    const tileId = isLocal ? 'tile_local_camera' : `tile_${participantIdentity}_camera`;
    const tile = document.getElementById(tileId);

    if (tile) {
        if (isRaised) {
            tile.classList.add('hand-raised');
            playSynthSound('HAND_RAISE');
        } else {
            tile.classList.remove('hand-raised');
        }
    }
}

export function toggleFullscreen() {
    const btn = document.getElementById('btnFullscreen');
    const isNativeSupported = document.fullscreenEnabled || document.webkitFullscreenEnabled;

    if (isNativeSupported) {
        const isFull = document.fullscreenElement || document.webkitFullscreenElement;
        if (!isFull) {
            const req = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
            if (req) req.call(document.documentElement).catch(() => togglePseudoFullscreen(btn));
        } else {
            const exit = document.fullscreenElement ? document.exitFullscreen : document.webkitExitFullscreen;
            if (exit) exit.call(document);
        }
    } else {
        togglePseudoFullscreen(btn);
    }
}

function togglePseudoFullscreen(btn) {
    const isPseudoActive = document.body.classList.toggle('pseudo-fullscreen');
    if (isPseudoActive) {
        btn.innerText = "Exit";
        btn.classList.add('active-off');
        window.scrollTo(0, 1); 
    } else {
        btn.innerText = "Full";
        btn.classList.remove('active-off');
        window.scrollTo(0, 0);
    }
    recalculateLayout();
}
