import { AppState } from './state.js';
import { recalculateLayout } from './ui.js';

// === TILE RESIZE ENGINE ===
// 1. Drag handle on the floating local PiP tile (touch + mouse).
// 2. Draggable gutter between the maximized tile (e.g. screen share) and the
//    sidebar strip on desktop, so incoming video can be given more/less room.
// 3. Drag the chat drawer's left edge to make it wider or narrower (desktop).
// 4. Corner handle on other people's tiles in the grid: drag (or click) to make
//    one tile 1, 2 or 3 cells large. ui.js lays the grid out around it.
// Pure DOM geometry changes — no re-layout of the page, negligible cost.

const PIP_KEY = 'portal_pip_size';
const GUTTER_KEY = 'portal_sidebar_width';
const CHAT_KEY = 'portal_chat_width';
const CHAT_MIN = 280;
const CHAT_MAX = 720;
const CHAT_DEFAULT = 340;
export const MAX_TILE_SPAN = 3;

let pipSize = loadJSON(PIP_KEY, null); // { w, h } in px
let sidebarWidth = loadJSON(GUTTER_KEY, null); // px
let chatWidth = loadJSON(CHAT_KEY, null); // px

function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
}

export function initTileResize() {
    createPipHandle();
    createGutterHandle();
    createChatHandle();
    applyStoredSizes();

    // Keep the PiP handle attached across tile recreation (camera switches etc.),
    // and give every other tile its corner handle
    const grid = document.getElementById('videoGrid');
    if (grid) {
        new MutationObserver(() => {
            const tile = document.getElementById('tile_local_camera');
            if (tile && !tile.querySelector('.pip-resize-handle')) createPipHandle();
            grid.querySelectorAll('.video-tile:not(#tile_local_camera)').forEach(createTileHandle);
        }).observe(grid, { childList: true, subtree: true });
    }
}

function applyStoredSizes() {
    const pip = document.getElementById('tile_local_camera');
    if (pip && pipSize && !pip.classList.contains('maximized')) {
        pip.style.setProperty('width', `${pipSize.w}px`, 'important');
        pip.style.setProperty('height', `${pipSize.h}px`, 'important');
    }
    if (sidebarWidth) applySidebarWidth(sidebarWidth);
    if (chatWidth) applyChatWidth(chatWidth);
}

function createPipHandle() {
    const tile = document.getElementById('tile_local_camera');
    if (!tile || tile.querySelector('.pip-resize-handle')) return;

    const handle = document.createElement('div');
    handle.className = 'pip-resize-handle';
    tile.appendChild(handle);

    let startX, startY, startW, startH, dragging = false;

    const onMove = (clientX, clientY) => {
        if (!dragging) return;
        // Handle sits top-left: dragging down-right shrinks, up-left grows
        const w = Math.min(Math.max(startW - (clientX - startX), 90), Math.min(window.innerWidth * 0.6, 640));
        const h = Math.min(Math.max(startH - (clientY - startY), 60), Math.min(window.innerHeight * 0.6, 480));
        tile.style.setProperty('width', `${w}px`, 'important');
        tile.style.setProperty('height', `${h}px`, 'important');
        pipSize = { w, h };
    };

    handle.addEventListener('pointerdown', (e) => {
        if (tile.classList.contains('maximized') || document.getElementById('videoGrid')?.classList.contains('has-maximized')) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startW = tile.offsetWidth;
        startH = tile.offsetHeight;
        handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => onMove(e.clientX, e.clientY));
    handle.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        try { localStorage.setItem(PIP_KEY, JSON.stringify(pipSize)); } catch (e) {}
    });
    handle.addEventListener('pointercancel', () => { dragging = false; });
}

function createGutterHandle() {
    const grid = document.getElementById('videoGrid');
    if (!grid || grid.querySelector('.gutter-handle')) return;

    const gutter = document.createElement('div');
    gutter.className = 'gutter-handle';
    gutter.title = 'Drag to resize';
    grid.appendChild(gutter);

    let dragging = false;

    gutter.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        dragging = true;
        gutter.setPointerCapture(e.pointerId);
        document.body.classList.add('gutter-dragging');
    });
    gutter.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const grid = document.getElementById('videoGrid');
        if (!grid) return;
        const rect = grid.getBoundingClientRect();
        const raw = rect.right - e.clientX;
        const w = Math.min(Math.max(raw, 120), rect.width * 0.5);
        applySidebarWidth(w);
    });
    const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('gutter-dragging');
        try { localStorage.setItem(GUTTER_KEY, JSON.stringify(sidebarWidth)); } catch (e) {}
    };
    gutter.addEventListener('pointerup', endDrag);
    gutter.addEventListener('pointercancel', endDrag);
}

function applySidebarWidth(px) {
    sidebarWidth = px;
    document.documentElement.style.setProperty('--sidebar-w', `${px}px`);
    // recalculateLayout() already wrote an inline gridTemplateColumns with the
    // old resolved value — override it directly so drags resize immediately.
    const grid = document.getElementById('videoGrid');
    if (grid && grid.classList.contains('has-maximized') && window.innerWidth > 768) {
        grid.style.gridTemplateColumns = `minmax(0, 1fr) ${px}px`;
    }
    positionGutter();
}

// --- chat drawer width ---------------------------------------------------------------------

function createChatHandle() {
    const drawer = document.getElementById('chatDrawer');
    if (!drawer || drawer.querySelector('.chat-resize-handle')) return;

    const handle = document.createElement('div');
    handle.className = 'chat-resize-handle';
    handle.title = 'Drag to resize';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'Chat width');
    handle.setAttribute('aria-valuemin', String(CHAT_MIN));
    handle.setAttribute('aria-valuemax', String(CHAT_MAX));
    drawer.prepend(handle);
    syncChatHandle();

    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        dragging = true;
        handle.setPointerCapture(e.pointerId);
        document.body.classList.add('chat-resizing');
    });
    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        applyChatWidth(drawer.getBoundingClientRect().right - e.clientX);
    });
    const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('chat-resizing');
        storeChatWidth();
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    // Keyboard: arrows move the edge, so left makes the drawer wider
    handle.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 80 : 20;
        const current = chatWidth || CHAT_DEFAULT;
        let next = null;
        if (e.key === 'ArrowLeft') next = current + step;
        else if (e.key === 'ArrowRight') next = current - step;
        else if (e.key === 'Home') next = CHAT_MIN;
        else if (e.key === 'End') next = CHAT_MAX;
        if (next === null) return;
        e.preventDefault();
        applyChatWidth(next);
        storeChatWidth();
    });
}

let chatLayoutFrame = 0;
function applyChatWidth(px) {
    // The drawer is also capped at 60% of the window by CSS
    chatWidth = Math.round(Math.min(Math.max(px, CHAT_MIN), CHAT_MAX, window.innerWidth * 0.6));
    document.documentElement.style.setProperty('--chat-w', `${chatWidth}px`);
    syncChatHandle();
    // The grid got narrower or wider: re-fit the tiles once per frame
    if (!chatLayoutFrame) {
        chatLayoutFrame = requestAnimationFrame(() => {
            chatLayoutFrame = 0;
            recalculateLayout();
        });
    }
}

function storeChatWidth() {
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatWidth)); } catch (e) {}
}

function syncChatHandle() {
    const handle = document.querySelector('.chat-resize-handle');
    if (handle) handle.setAttribute('aria-valuenow', String(chatWidth || CHAT_DEFAULT));
}

// --- larger tiles in the grid ----------------------------------------------------------------

function tileName(tile) {
    return tile.querySelector('.name-tag')?.textContent || 'this video';
}

function setTileSpan(tile, span) {
    span = Math.min(Math.max(span, 1), MAX_TILE_SPAN);
    if ((AppState.tileSpans.get(tile.id) || 1) === span) return;
    if (span === 1) AppState.tileSpans.delete(tile.id);
    else AppState.tileSpans.set(tile.id, span);
    recalculateLayout();
}

function createTileHandle(tile) {
    if (tile.querySelector('.tile-resize-handle')) return;
    const handle = document.createElement('div');
    handle.className = 'tile-resize-handle';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'button');
    handle.title = 'Drag to make larger or smaller; click to step through sizes';
    tile.appendChild(handle);
    syncTileHandle(tile);

    let start = null;
    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const span = AppState.tileSpans.get(tile.id) || 1;
        // One cell of the grid, measured from the tile as it is now
        start = {
            x: e.clientX, y: e.clientY,
            w: tile.offsetWidth, h: tile.offsetHeight,
            cellW: tile.offsetWidth / span, cellH: tile.offsetHeight / span,
            moved: false
        };
        handle.setPointerCapture(e.pointerId);
        document.body.classList.add('tile-resizing');
    });
    handle.addEventListener('pointermove', (e) => {
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) start.moved = true;
        if (!start.moved) return;
        // Snap to whole cells, by whichever direction was dragged further
        const span = Math.round(Math.max((start.w + dx) / start.cellW, (start.h + dy) / start.cellH));
        setTileSpan(tile, span);
    });
    const endDrag = (e) => {
        if (!start) return;
        const clicked = !start.moved && e.type === 'pointerup';
        start = null;
        document.body.classList.remove('tile-resizing');
        if (clicked) cycleTileSpan(tile);
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    // The handle sits on the tile, whose click pins it
    handle.addEventListener('click', (e) => e.stopPropagation());
    handle.addEventListener('keydown', (e) => {
        const span = AppState.tileSpans.get(tile.id) || 1;
        if (e.key === 'Enter' || e.key === ' ') cycleTileSpan(tile);
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === '+') setTileSpan(tile, span + 1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === '-') setTileSpan(tile, span - 1);
        else return;
        e.preventDefault();
        e.stopPropagation();
        handle.focus();
    });
}

function cycleTileSpan(tile) {
    const span = AppState.tileSpans.get(tile.id) || 1;
    setTileSpan(tile, span >= MAX_TILE_SPAN ? 1 : span + 1);
}

function syncTileHandle(tile) {
    const handle = tile.querySelector('.tile-resize-handle');
    if (!handle) return;
    const span = AppState.tileSpans.get(tile.id) || 1;
    const label = `Size of ${tileName(tile)}: ${span === 1 ? 'normal' : `${span} × ${span}`}`;
    if (handle.getAttribute('aria-label') !== label) handle.setAttribute('aria-label', label);
}

// Called after recalculateLayout() to keep the gutter aligned with the sidebar
export function positionGutter() {
    const gutter = document.querySelector('.gutter-handle');
    const grid = document.getElementById('videoGrid');
    if (!gutter || !grid) return;

    const active = grid.classList.contains('has-maximized') && window.innerWidth > 768;
    gutter.style.display = active ? 'block' : 'none';
    if (active) {
        gutter.style.right = `${sidebarWidth || 200}px`;
    }
}

// Hook: reset PiP inline size when it enters the maximized sidebar flow
export function syncResizeAfterLayout() {
    const pip = document.getElementById('tile_local_camera');
    const grid = document.getElementById('videoGrid');
    if (pip && grid && grid.classList.contains('has-maximized')) {
        pip.style.removeProperty('width');
        pip.style.removeProperty('height');
    } else if (pip && pipSize) {
        pip.style.setProperty('width', `${pipSize.w}px`, 'important');
        pip.style.setProperty('height', `${pipSize.h}px`, 'important');
    }
    positionGutter();
    grid?.querySelectorAll('.video-tile:not(#tile_local_camera)').forEach(tile => {
        createTileHandle(tile);
        syncTileHandle(tile);
    });
}
