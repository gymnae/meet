import { AppState } from './state.js';

// === WEB AUDIO API SYNTH SOUND GENERATOR ===
// One shared context: every AudioContext owns a real-time audio thread, so creating one
// per sound (and never closing it) piles up CPU load over the course of a call.
let sharedAudioCtx = null;
function getAudioContext() {
    if (sharedAudioCtx && sharedAudioCtx.state !== 'closed') return sharedAudioCtx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    sharedAudioCtx = new AudioCtx();
    return sharedAudioCtx;
}

export function playSynthSound(type) {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };

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

// === DOCK LABEL: swaps the caption, keeps the pixel icon, keeps AT in sync ===
export function setDockLabel(btn, text) {
    if (!btn) return;
    const label = btn.querySelector('.dock-label');
    if (label) label.textContent = text; else btn.textContent = text;
    btn.setAttribute('aria-label', text);
}

// === TOAST: non-blocking replacement for alert() ===
let toastTimer = null;
export function showToast(message, variant = 'info', duration = 3600) {
    const el = document.getElementById('toast');
    if (!el) { console.warn('[toast]', message); return; }
    clearTimeout(toastTimer);
    el.textContent = message;
    el.className = 'toast' + (variant !== 'info' ? ' ' + variant : '');
    void el.offsetWidth; // restart transition
    el.classList.add('show');
    toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

export function copyShareLink() {
    const roomName = document.getElementById('headerRoomLabel').innerText;
    const deepLink = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(roomName)}`;
    
    navigator.clipboard.writeText(deepLink)
        .then(() => showToast('Link copied. Anyone with it can join.'))
        .catch(() => showToast('Could not copy the link. Copy it from the address bar.', 'error'));
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

// Write a style value only when it changes, so re-running the layout is free when nothing moved.
// Values must be given in the browser's normalized form (e.g. "0px", not "0") for the check to hit.
function setStyle(el, prop, value) {
    if (el.style[prop] !== value) el.style[prop] = value;
}

function getMaximizeTargetId() {
    if (AppState.pinnedTileId && document.getElementById(AppState.pinnedTileId)) return AppState.pinnedTileId;
    if (AppState.activeScreenShareTileId && document.getElementById(AppState.activeScreenShareTileId)) return AppState.activeScreenShareTileId;
    return null;
}

export function recalculateLayout() {
    const grid = document.getElementById('videoGrid');
    if (!grid) return;

    const rawTiles = Array.from(grid.querySelectorAll('.video-tile'));
    const targetMaximizeId = getMaximizeTargetId();

    const isMobile = window.innerWidth <= 768;
    const sidebarW = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim() || '200px';
    // Read geometry before any writes to avoid a forced synchronous layout.
    const aspect = grid.clientWidth / grid.clientHeight;

    // State classes only; visuals are owned by CSS (design.md, video tile states).
    // toggle() with a force flag is a no-op when the class already matches.
    rawTiles.forEach(tile => {
        tile.classList.toggle('maximized', tile.id === targetMaximizeId);
        const isPinned = tile.id === AppState.pinnedTileId;
        tile.classList.toggle('is-pinned', isPinned);
        const shield = tile.querySelector('.touch-shield');
        if (shield && shield.getAttribute('aria-pressed') !== String(isPinned)) shield.setAttribute('aria-pressed', String(isPinned));
    });

    if (targetMaximizeId) {
        if (!grid.classList.contains('has-maximized')) grid.classList.add('has-maximized');
        
        const gridTiles = rawTiles.sort((a, b) => {
            if (a.id === targetMaximizeId) return -1;
            if (b.id === targetMaximizeId) return 1;
            if (a.id === 'tile_local_camera') return 1;
            if (b.id === 'tile_local_camera') return -1;
            return 0;
        });
        
        const sidebarCount = Math.max(1, gridTiles.length - 1);
        
        if (!isMobile) {
            setStyle(grid, 'gridTemplateColumns', `minmax(0px, 1fr) ${sidebarW}`);
            setStyle(grid, 'gridTemplateRows', `repeat(${sidebarCount}, minmax(0px, 1fr))`);
        } else {
            setStyle(grid, 'gridTemplateColumns', `repeat(${sidebarCount}, minmax(0px, 1fr))`);
            setStyle(grid, 'gridTemplateRows', 'minmax(0px, 1fr) 100px');
        }

        let sidebarIndex = 1;

        gridTiles.forEach(tile => {
            if (tile.id === targetMaximizeId) {
                if (!isMobile) {
                    setStyle(tile, 'gridColumn', '1');
                    setStyle(tile, 'gridRow', `1 / span ${sidebarCount}`);
                } else {
                    setStyle(tile, 'gridColumn', `1 / span ${sidebarCount}`);
                    setStyle(tile, 'gridRow', '1');
                }
            } else {
                if (!isMobile) {
                    setStyle(tile, 'gridColumn', '2');
                    setStyle(tile, 'gridRow', `${sidebarIndex}`);
                } else {
                    setStyle(tile, 'gridColumn', `${sidebarIndex}`);
                    setStyle(tile, 'gridRow', '2');
                }
                sidebarIndex++;
            }
        });

    } else {
        if (grid.classList.contains('has-maximized')) grid.classList.remove('has-maximized');

        const gridTiles = rawTiles.filter(t => t.id !== 'tile_local_camera');
        const totalTiles = Math.max(1, gridTiles.length);

        let cols = Math.ceil(Math.sqrt(totalTiles));
        let rows = Math.ceil(totalTiles / cols);

        if (aspect > 1.5 && totalTiles > 2) {
            cols = Math.ceil(Math.sqrt(totalTiles * aspect));
            rows = Math.ceil(totalTiles / cols);
        } else if (aspect < 0.8 && totalTiles > 2) {
            rows = Math.ceil(Math.sqrt(totalTiles / aspect));
            cols = Math.ceil(totalTiles / rows);
        }

        setStyle(grid, 'gridTemplateColumns', `repeat(${cols}, minmax(0px, 1fr))`);
        setStyle(grid, 'gridTemplateRows', `repeat(${rows}, minmax(0px, 1fr))`);

        // Includes the local camera tile.
        rawTiles.forEach(tile => {
            setStyle(tile, 'gridColumn', 'auto');
            setStyle(tile, 'gridRow', 'auto');
        });
    }

    updateSpeakerHighlight(rawTiles, targetMaximizeId);

    // Keep resize handles/gutter in sync (dynamic import avoids circular deps)
    import('./resize.js').then(m => m.syncResizeAfterLayout()).catch(() => {});
}

// === ACTIVE SPEAKER HIGHLIGHT ENGINE (INCLUDING MAXIMIZED TILES) ===
// Toggles .speaking only; CSS draws the ring. Speaker changes arrive several times a second, so they call this directly
// instead of re-running the grid layout.
export function updateSpeakerHighlight(tiles, targetMaximizeId) {
    if (!tiles) {
        const grid = document.getElementById('videoGrid');
        if (!grid) return;
        tiles = grid.querySelectorAll('.video-tile');
        targetMaximizeId = getMaximizeTargetId();
    }

    let speakerTileId = null;
    let speakerScreenTileId = null;
    if (AppState.activeSpeakerIdentity) {
        const isLocalSpeaker = AppState.activeRoom && AppState.activeSpeakerIdentity === AppState.activeRoom.localParticipant?.identity;
        speakerTileId = isLocalSpeaker ? 'tile_local_camera' : `tile_${AppState.activeSpeakerIdentity}_camera`;
        speakerScreenTileId = isLocalSpeaker ? 'tile_local_screen_share' : `tile_${AppState.activeSpeakerIdentity}_screen_share`;
    }
    const maximizedIsSpeaker = !!targetMaximizeId && (targetMaximizeId === speakerTileId || targetMaximizeId === speakerScreenTileId);

    tiles.forEach(tile => {
        const speaking = tile.id === speakerTileId || (maximizedIsSpeaker && tile.id === targetMaximizeId);
        tile.classList.toggle('speaking', speaking);
    });
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
        setDockLabel(btn, "Exit");
        btn.classList.add('active-on');
        window.scrollTo(0, 1); 
    } else {
        setDockLabel(btn, "Full");
        btn.classList.remove('active-on');
        window.scrollTo(0, 0);
    }
    recalculateLayout();
}
