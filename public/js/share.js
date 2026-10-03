// share.js
// Invite dialog: the room link (with the password when the room has one), an
// audience link that hides the room name and joins listen-only, and QR codes
// for both. The QR encoder is loaded only when a code is first shown.
import { AppState } from './state.js';

const AUDIENCE_PREFIX = 'listen=';

/**
 * Reads an invite from the address hash.
 * "#room" or "#room?pw=secret" → { room, password }; "#listen=<id>" → { audienceId }.
 */
export function parseInviteHash(hash = window.location.hash) {
    const raw = hash.replace(/^#/, '').trim();
    if (!raw) return null;
    if (raw.startsWith(AUDIENCE_PREFIX)) {
        const audienceId = raw.slice(AUDIENCE_PREFIX.length).replace(/[^A-Za-z0-9_-]/g, '');
        return audienceId ? { audienceId } : null;
    }
    const [roomPart, query = ''] = raw.split('?');
    let room = roomPart;
    try { room = decodeURIComponent(roomPart); } catch (e) {}
    return { room, password: new URLSearchParams(query).get('pw') || '' };
}

function baseUrl() {
    return `${window.location.origin}${window.location.pathname}`;
}

export function buildRoomLink() {
    const pw = AppState.roomPassword ? `?pw=${encodeURIComponent(AppState.roomPassword)}` : '';
    return `${baseUrl()}#${encodeURIComponent(AppState.roomName)}${pw}`;
}

export function buildAudienceLink() {
    return `${baseUrl()}#${AUDIENCE_PREFIX}${AppState.audienceId}`;
}

// === DIALOG ===
let bound = false;
let statusTimer = null;

export function openShareDialog() {
    const dialog = document.getElementById('shareDialog');
    if (!dialog || !AppState.activeRoom) return;
    bindDialog(dialog);

    // Opening from a dock menu: close those first
    ['camMenu', 'micMenu', 'reactionMenu', 'soundMenu'].forEach(id => {
        const m = document.getElementById(id);
        if (m) m.style.display = 'none';
    });

    const audienceDetails = document.getElementById('shareAudience');
    setStatus('');

    if (AppState.audienceMode) {
        // Listeners only ever pass the audience link on, and the QR code is the point.
        document.getElementById('shareTitle').textContent = 'Share this stream';
        document.getElementById('shareRoom').hidden = true;
        audienceDetails.open = true;
        document.getElementById('shareAudienceBody').hidden = false;
        document.getElementById('shareAudienceNote').textContent = 'Pass it on: anyone who scans this code or opens the link can listen in.';
        setLink('shareAudienceLink', buildAudienceLink());
        showQr('audience', true);
    } else {
        document.getElementById('shareTitle').textContent = 'Invite people';
        document.getElementById('shareRoomNote').textContent = AppState.roomPassword
            ? 'Includes the room password, so anyone with it can join.'
            : 'Anyone with this link can join.';
        setLink('shareRoomLink', buildRoomLink());
        resetQr('room');
        if (audienceDetails.open) prepareAudienceLink();
    }

    dialog.showModal();
    // Focus the dialog's first action instead of selecting the link text.
    dialog.querySelector('[data-copy]:not([hidden])')?.focus();
}

function bindDialog(dialog) {
    if (bound) return;
    bound = true;

    dialog.addEventListener('click', (e) => {
        // A click on the backdrop lands on the <dialog> itself; its content sits in .share-body.
        if (e.target === dialog) { dialog.close(); return; }

        const copyBtn = e.target.closest('[data-copy]');
        if (copyBtn) { copyLink(copyBtn.dataset.copy, copyBtn); return; }

        const qrBtn = e.target.closest('[data-qr]');
        if (qrBtn) { showQr(qrBtn.dataset.qr, qrBtn.getAttribute('aria-expanded') !== 'true'); return; }

        const saveBtn = e.target.closest('[data-qr-save]');
        if (saveBtn) { saveQrImage(saveBtn.dataset.qrSave); return; }

        if (e.target.closest('[data-share-close]')) dialog.close();
    });

    // Clicking the link itself copies it too.
    dialog.querySelectorAll('.share-link-row input').forEach(input => {
        input.addEventListener('click', () => {
            const btn = input.parentElement.querySelector('[data-copy]');
            if (input.value) copyLink(input.id, btn);
        });
    });

    document.getElementById('shareAudience').addEventListener('toggle', (e) => {
        if (e.target.open && !AppState.audienceMode) prepareAudienceLink();
    });
}

function setLink(inputId, url) {
    const input = document.getElementById(inputId);
    if (input.value !== url) {
        input.value = url;
        // A new link makes an existing QR code stale.
        resetQr(inputId === 'shareRoomLink' ? 'room' : 'audience');
    }
}

function setStatus(text) {
    const el = document.getElementById('shareStatus');
    if (!el) return;
    clearTimeout(statusTimer);
    el.textContent = text;
    if (text) statusTimer = setTimeout(() => { el.textContent = ''; }, 3000);
}

async function copyLink(inputId, button) {
    const input = document.getElementById(inputId);
    if (!input?.value) return;
    let copied = false;
    try {
        await navigator.clipboard.writeText(input.value);
        copied = true;
    } catch (e) {
        // Clipboard API needs a secure context; fall back to the selection.
        input.select();
        try { copied = document.execCommand('copy'); } catch (err) {}
    }
    if (copied) {
        setStatus('Link copied.');
        if (button) {
            button.textContent = 'Copied';
            setTimeout(() => { button.textContent = 'Copy'; }, 2000);
        }
    } else {
        input.select();
        setStatus('Could not copy. The link is selected, copy it with your keyboard.');
    }
}

// === AUDIENCE LINK ===
let audienceRequest = null;

async function prepareAudienceLink() {
    const errorEl = document.getElementById('shareAudienceError');
    const body = document.getElementById('shareAudienceBody');
    errorEl.textContent = '';

    if (AppState.audienceId) {
        body.hidden = false;
        setLink('shareAudienceLink', buildAudienceLink());
        return;
    }
    if (audienceRequest) return;

    body.hidden = true;
    const loading = document.getElementById('shareAudienceLoading');
    loading.hidden = false;
    audienceRequest = fetch(`/api/rooms/${encodeURIComponent(AppState.roomName)}/audience-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: AppState.roomPassword })
    });
    try {
        const res = await audienceRequest;
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.audienceId) throw new Error(data.error || `HTTP ${res.status}`);
        AppState.audienceId = data.audienceId;
        body.hidden = false;
        setLink('shareAudienceLink', buildAudienceLink());
    } catch (err) {
        console.error('[Share] Audience link failed', err.message);
        errorEl.textContent = 'Could not create the audience link. Try again in a moment.';
    } finally {
        loading.hidden = true;
        audienceRequest = null;
    }
}

// === QR CODES ===
const QR_TARGETS = {
    room: { input: 'shareRoomLink', box: 'shareRoomQr', label: 'QR code for the room link', file: 'room' },
    audience: { input: 'shareAudienceLink', box: 'shareAudienceQr', label: 'QR code for the audience link', file: 'audience' }
};
const QUIET_ZONE = 4; // modules of white border scanners need around the code
let qrModule = null;

function qrButton(kind) {
    return document.querySelector(`#shareDialog [data-qr="${kind}"]`);
}

function resetQr(kind) {
    const target = QR_TARGETS[kind];
    const box = document.getElementById(target.box);
    box.hidden = true;
    box.replaceChildren();
    const btn = qrButton(kind);
    if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Show QR code'; }
}

async function showQr(kind, show) {
    const target = QR_TARGETS[kind];
    const box = document.getElementById(target.box);
    const btn = qrButton(kind);
    if (!show) { resetQr(kind); return; }

    const text = document.getElementById(target.input).value;
    if (!text) return;
    try {
        qrModule ||= await import('./vendor/qrcode.mjs');
    } catch (err) {
        setStatus('Could not load the QR code generator.');
        return;
    }
    const matrix = encodeQr(text);
    box.replaceChildren(renderQrSvg(matrix, target.label), saveButton(kind));
    box.dataset.text = text;
    box.hidden = false;
    if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.textContent = 'Hide QR code'; }
}

function encodeQr(text) {
    const qr = qrModule.qrcode(0, 'M'); // 0 = smallest version that fits
    qr.addData(text);
    qr.make();
    const size = qr.getModuleCount();
    const rows = [];
    for (let r = 0; r < size; r++) {
        const row = [];
        for (let c = 0; c < size; c++) row.push(qr.isDark(r, c));
        rows.push(row);
    }
    return rows;
}

function renderQrSvg(matrix, label) {
    const size = matrix.length + QUIET_ZONE * 2;
    let d = '';
    matrix.forEach((row, r) => {
        // one rectangle per horizontal run of dark modules keeps the path short
        for (let c = 0; c < row.length; c++) {
            if (!row[c]) continue;
            let end = c;
            while (end + 1 < row.length && row[end + 1]) end++;
            d += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h${end - c + 1}v1h-${end - c + 1}z`;
            c = end;
        }
    });
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.classList.add('share-qr-code');
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('width', size);
    bg.setAttribute('height', size);
    bg.setAttribute('fill', '#fff');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000');
    svg.append(bg, path);
    return svg;
}

function saveButton(kind) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary-btn';
    btn.dataset.qrSave = kind;
    btn.textContent = 'Save image';
    return btn;
}

// PNG at a fixed scale so it prints sharply.
function saveQrImage(kind) {
    const target = QR_TARGETS[kind];
    const text = document.getElementById(target.box).dataset.text;
    if (!text || !qrModule) return;
    const matrix = encodeQr(text);
    const scale = 12;
    const size = (matrix.length + QUIET_ZONE * 2) * scale;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    matrix.forEach((row, r) => row.forEach((dark, c) => {
        if (dark) ctx.fillRect((c + QUIET_ZONE) * scale, (r + QUIET_ZONE) * scale, scale, scale);
    }));
    canvas.toBlob((blob) => {
        if (!blob) { setStatus('Could not create the image.'); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `schnackn-${target.file}-qr.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
}
