import { AppState } from './state.js';
import { recalculateLayout } from './ui.js';

// === TILE RESIZE ENGINE ===
// 1. Drag handle on the floating local PiP tile (touch + mouse).
// 2. Draggable gutter between the maximized tile (e.g. screen share) and the
//    sidebar strip on desktop, so incoming video can be given more/less room.
// Pure DOM geometry changes — no re-layout of the page, negligible cost.

const PIP_KEY = 'portal_pip_size';
const GUTTER_KEY = 'portal_sidebar_width';

let pipSize = loadJSON(PIP_KEY, null); // { w, h } in px
let sidebarWidth = loadJSON(GUTTER_KEY, null); // px

function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
}

export function initTileResize() {
    createPipHandle();
    createGutterHandle();
    applyStoredSizes();

    // Keep the PiP handle attached across tile recreation (camera switches etc.)
    const grid = document.getElementById('videoGrid');
    if (grid) {
        new MutationObserver(() => {
            const tile = document.getElementById('tile_local_camera');
            if (tile && !tile.querySelector('.pip-resize-handle')) createPipHandle();
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
    positionGutter();
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
}
