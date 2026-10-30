import { AppState } from './state.js';
import { postJson } from './api.js';
import { sendDataPacket } from './livekit-handler.js';
import { playSynthSound, recalculateLayout, showToast, hueIndexFor } from './ui.js';
import { renderPoll } from './polls.js';

const CHAT_TTL_MS = 60 * 1000;
const FILE_TTL_MS = 10 * 60 * 1000;
// Taller messages scroll inside the box
const INPUT_MAX_HEIGHT = 160;

let isChatOpen = false;
let unreadCount = 0;
let countdownTimer = null;

export function initChatEngine() {
    if (!countdownTimer) {
        countdownTimer = setInterval(tickCountdowns, 1000);
    }

    if (window.visualViewport) {
        // visualViewport fires many events per frame while scrolling/resizing; coalesce to one per frame.
        let viewportFrame = 0;
        let viewportResized = false;
        const onViewportChange = (e) => {
            if (e.type === 'resize') viewportResized = true;
            if (viewportFrame) return;
            viewportFrame = requestAnimationFrame(() => {
                viewportFrame = 0;
                if (!isChatOpen) { viewportResized = false; return; }
                syncDrawerToViewport();
                if (viewportResized) scrollChatToBottom();
                viewportResized = false;
            });
        };
        window.visualViewport.addEventListener('resize', onViewportChange);
        window.visualViewport.addEventListener('scroll', onViewportChange);
    }

    const input = document.getElementById('chatInput');
    if (input) {
        input.addEventListener('focus', () => {
            setTimeout(() => {
                syncDrawerToViewport();
                scrollChatToBottom();
            }, 100);
        });
        // Enter sends, Shift+Enter starts a new line (not while an IME is composing)
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                document.getElementById('chatForm')?.requestSubmit();
            }
        });
        input.addEventListener('input', () => fitInput(input));
        input.addEventListener('paste', (e) => pasteWithFormatting(e, input));
    }
}

function fitInput(input) {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, INPUT_MAX_HEIGHT)}px`;
}

// --- pasting: keep line breaks, indentation and basic formatting ---------------------------
// A textarea keeps plain text as it is. Formatted text (from a web page, Word, Google Docs) is
// turned into the few marks the chat shows: **bold**, *italic*, ~~struck~~, `code`, ``` blocks,
// > quotes and list markers. Text from code editors becomes a code block.

const FORMAT_TAGS = /<(b|strong|i|em|s|del|strike|code|pre|li|blockquote|h[1-6])[\s>]|font-weight:\s*(bold|[6-9]00)|font-style:\s*italic|line-through/i;
const EDITOR_HTML = /white-space:\s*pre/i;

function pasteWithFormatting(e, input) {
    const html = e.clipboardData?.getData('text/html');
    const plain = e.clipboardData?.getData('text/plain') || '';
    if (!html) return;
    let text;
    if (EDITOR_HTML.test(html) && plain.includes('\n')) {
        text = '```\n' + plain.replace(/\n+$/, '') + '\n```';
    } else if (FORMAT_TAGS.test(html)) {
        text = htmlToChatText(html);
    }
    if (!text) return;
    e.preventDefault();
    input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input'));
}

function htmlToChatText(html) {
    // DOMParser builds an inert document: no scripts run, nothing loads
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return walkNode(doc.body, { pre: false })
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Puts a mark around text, outside its surrounding spaces ("** a **" would not render)
function wrapMark(mark, text) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : text;
}

function walkNode(node, ctx) {
    if (node.nodeType === Node.TEXT_NODE) {
        return ctx.pre ? node.textContent : node.textContent.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'head', 'meta', 'title', 'template'].includes(tag)) return '';

    const kids = (childCtx = ctx) => Array.from(node.childNodes).map(n => walkNode(n, childCtx)).join('');
    const style = node.getAttribute('style') || '';
    switch (tag) {
        case 'br': return '\n';
        case 'pre': return '\n```\n' + node.textContent.replace(/\n+$/, '') + '\n```\n';
        case 'code': return ctx.pre ? kids() : wrapMark('`', node.textContent);
        // Google Docs wraps everything in <b style="font-weight:normal">
        case 'b': case 'strong': return /font-weight:\s*(normal|[1-4]00)/i.test(style) ? kids() : wrapMark('**', kids());
        case 'i': case 'em': return wrapMark('*', kids());
        case 's': case 'del': case 'strike': return wrapMark('~~', kids());
        case 'a': {
            const text = kids();
            const href = node.getAttribute('href') || '';
            return /^https?:/i.test(href) && text.trim() && text.trim() !== href ? `${text} (${href})` : text;
        }
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
            return '\n' + wrapMark('**', kids()) + '\n';
        case 'ul': case 'ol': {
            let n = 0;
            const items = Array.from(node.children).map(li => {
                const marker = tag === 'ol' ? `${++n}. ` : '- ';
                return '\n' + (ctx.indent || '') + marker + walkNode(li, { ...ctx, indent: (ctx.indent || '') + '  ', inList: true }).trim();
            });
            return items.join('') + (ctx.inList ? '' : '\n');
        }
        case 'li': return kids();
        case 'blockquote':
            return '\n' + kids().trim().split('\n').map(line => `> ${line}`).join('\n') + '\n';
        case 'p': case 'div': case 'section': case 'article': case 'header': case 'footer': case 'tr':
            return '\n' + kids() + '\n';
        case 'td': case 'th': return kids() + '\t';
        case 'span': {
            let text = kids();
            if (/font-weight:\s*(bold|[6-9]00)/i.test(style)) text = wrapMark('**', text);
            if (/font-style:\s*italic/i.test(style)) text = wrapMark('*', text);
            if (/line-through/i.test(style)) text = wrapMark('~~', text);
            return text;
        }
        default: return kids();
    }
}

function syncDrawerToViewport() {
    const drawer = document.getElementById('chatDrawer');
    if (!drawer || !isChatOpen) return;

    // Mobile: the sheet is positioned purely from visualViewport, which is the
    // only reliable source on iOS (the layout viewport does NOT shrink when the
    // keyboard opens, and `interactive-widget=resizes-content` is Chromium-only).
    if (window.innerWidth <= 768 && window.visualViewport) {
        const vv = window.visualViewport;
        // Keyboard heuristic: compare against the tallest viewport seen so far
        // (keyboard-closed baseline) rather than window.innerHeight, which is
        // unreliable on iOS with a position:fixed body.
        if (vv.height > largestVVHeight) largestVVHeight = vv.height;
        const isKeyboardOpen = vv.height < largestVVHeight - 60;

        drawer.classList.toggle('keyboard-open', isKeyboardOpen);

        // Bottom sheet: keep videos visible above the drawer. The sheet's bottom
        // edge follows the visual viewport so it always sits above the keyboard.
        const vvBottom = vv.offsetTop + vv.height; // distance from layout-viewport top
        drawer.style.position = 'fixed';
        drawer.style.left = `${vv.offsetLeft}px`;
        drawer.style.width = `${vv.width}px`;
        drawer.style.height = isKeyboardOpen
            ? `${Math.min(vv.height, Math.round(largestVVHeight * 0.65))}px`
            : '55dvh';
        drawer.style.top = 'auto';
        drawer.style.bottom = `${Math.max(0, document.documentElement.clientHeight - vvBottom)}px`;

        // Lift the control dock above the keyboard so it can never occlude the
        // chat input bar (iOS keeps the dock pinned to the layout viewport).
        const kbOffset = Math.max(0, document.documentElement.clientHeight - vvBottom);
        document.documentElement.style.setProperty('--kb-offset', `${kbOffset}px`);
    } else {
        document.documentElement.style.setProperty('--kb-offset', '0px');
        drawer.classList.remove('keyboard-open');
        drawer.style.position = '';
        drawer.style.top = '';
        drawer.style.left = '';
        drawer.style.width = '';
        drawer.style.height = '';
        drawer.style.bottom = '';
    }
}
// Tallest visual viewport seen so far (keyboard-closed baseline).
let largestVVHeight = 0;

export function toggleChat() {
    const drawer = document.getElementById('chatDrawer');
    const badge = document.getElementById('chatBadge');
    if (!drawer) return;

    isChatOpen = !isChatOpen;
    drawer.style.display = isChatOpen ? 'flex' : 'none';
    document.body.classList.toggle('chat-open', isChatOpen);
    document.getElementById('btnChat')?.classList.toggle('active-on', isChatOpen);

    if (isChatOpen) {
        unreadCount = 0;
        if (badge) badge.style.display = 'none';

        syncDrawerToViewport();
        tickCountdowns();

        const isTouch = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 768;
        const input = document.getElementById('chatInput');
        if (input && !isTouch) {
            input.focus();
        }

        scrollChatToBottom();
    } else {
        const input = document.getElementById('chatInput');
        if (input) input.blur();
        drawer.classList.remove('keyboard-open');
    }
    recalculateLayout();
}

export async function syncRoomTransmissions(roomName) {
    try {
        const viewer = localStorage.getItem('portal_username') || '';
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/sync?viewer=${encodeURIComponent(viewer)}`);
        if (!res.ok) return;
        const data = await res.json();

        setDisappearing(!!data.disappearing);
        // Shown in the order they were made: messages, files and polls interleaved
        const items = [
            ...(data.messages || []).map(item => ({ item, render: renderMessage })),
            ...(data.files || []).map(item => ({ item, render: renderFile })),
            ...(data.polls || []).map(item => ({ item, render: renderPoll }))
        ].sort((a, b) => a.item.created_at - b.item.created_at);
        items.forEach(({ item, render }) => render(item, false, { quiet: true }));
        scrollChatToBottom();
    } catch (e) {
        console.error('[Chat] Failed room sync:', e);
    }
}

// --- disappearing messages -----------------------------------------------------------------

/** Shows the room's setting. byName: who changed it just now (a note in the chat), if anyone. */
export function setDisappearing(on, byName) {
    const changed = AppState.chatDisappearing !== on;
    AppState.chatDisappearing = on;
    const btn = document.getElementById('btnDisappearing');
    btn?.setAttribute('aria-pressed', String(on));
    const subtitle = document.getElementById('chatSubtitle');
    if (subtitle) subtitle.textContent = on ? 'Chat 1 min · files 10 min' : 'Stays until all leave';
    if (changed && byName) {
        renderSystemNote(on
            ? `${byName} turned on disappearing messages: chat goes after 1 minute, files after 10.`
            : `${byName} turned off disappearing messages: chat and files stay until everyone leaves.`);
    }
    tickCountdowns();
}

let settingDisappearing = false;
export async function toggleDisappearing() {
    if (!AppState.activeRoom || settingDisappearing) return;
    const on = !AppState.chatDisappearing;
    settingDisappearing = true;
    try {
        const res = await postJson(`/api/rooms/${encodeURIComponent(AppState.activeRoom.name)}/settings`, {
            disappearing: on,
            password: AppState.roomPassword
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setDisappearing(on, 'You');
        sendDataPacket({ type: 'ROOM_SETTINGS', disappearing: on });
    } catch (err) {
        console.error('[Chat] Changing disappearing messages failed:', err);
        showToast("Couldn't change disappearing messages. Try again.", 'error');
    } finally {
        settingDisappearing = false;
    }
}

/** Marks something new in the chat while the drawer is closed. */
export function noteIncoming(sound) {
    if (isChatOpen) return;
    unreadCount++;
    const badge = document.getElementById('chatBadge');
    if (badge) badge.style.display = 'block';
    playSynthSound(sound);
}

export function isChatVisible() {
    return isChatOpen;
}

export async function handleChatSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('chatInput');
    // Keeps the first line's indentation (pasted code); drops blank lines around the message
    const text = input.value.replace(/^\s*\n|\s+$/g, '');
    if (!text.trim() || !AppState.activeRoom) return;

    const roomName = AppState.activeRoom.name;
    const sender = localStorage.getItem('portal_username') || 'You';
    input.value = '';
    fitInput(input);

    try {
        const res = await postJson(`/api/rooms/${encodeURIComponent(roomName)}/chat`, { sender, text });
        const savedMsg = await res.json();

        renderMessage(savedMsg, true);
        sendDataPacket({ type: 'CHAT_MESSAGE', payload: savedMsg });
        scrollChatToBottom();
    } catch (err) {
        console.error('[Chat] Send failed:', err);
    }
}

export function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file || !AppState.activeRoom) return;

    if (file.size > 200 * 1024 * 1024) {
        showToast('That file is over the 200 MB limit.', 'error');
        e.target.value = '';
        return;
    }

    const roomName = AppState.activeRoom.name;
    const sender = localStorage.getItem('portal_username') || 'You';

    const formData = new FormData();
    formData.append('file', file);
    formData.append('sender', sender);

    const progressContainer = document.getElementById('uploadProgressBar');
    const progressFill = document.getElementById('uploadProgressFill');
    if (progressContainer) progressContainer.style.display = 'block';

    const uploadUrl = `/api/rooms/${encodeURIComponent(roomName)}/upload`;
    const finish = (status, responseText) => {
        if (progressContainer) progressContainer.style.display = 'none';
        if (progressFill) progressFill.style.width = '0%';
        e.target.value = '';

        if (status === 200) {
            const savedFile = JSON.parse(responseText);
            renderFile(savedFile, true);
            sendDataPacket({ type: 'FILE_SHARED', payload: savedFile });
            scrollChatToBottom();
        } else {
            showToast('Upload failed. Try again.', 'error');
        }
    };

    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl, true);

    xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable && progressFill) {
            const pct = Math.round((evt.loaded / evt.total) * 100);
            progressFill.style.width = `${pct}%`;
        }
    };

    xhr.onload = () => finish(xhr.status, xhr.responseText);

    // An upload progress listener makes the request need a CORS preflight once a corporate web
    // gateway has bounced it through its own host (see api.js), and that preflight fails. Retry
    // once as a plain fetch, which needs no preflight, at the cost of the progress bar.
    xhr.onerror = async () => {
        try {
            const res = await fetch(uploadUrl, { method: 'POST', body: formData });
            finish(res.status, await res.text());
        } catch (err) {
            if (progressContainer) progressContainer.style.display = 'none';
            e.target.value = '';
            showToast('Network error during upload. Check your connection.', 'error');
        }
    };

    xhr.send(formData);
}

// Message text to HTML: everything escaped, then links and image previews, ``` code blocks,
// `code`, **bold**, *italic* or _italic_, ~~struck~~ and > quotes. Line breaks and spaces are
// kept by CSS (white-space: pre-wrap).
function formatMessageContent(rawText) {
    const parts = String(rawText || '').split('```');
    return parts.map((part, i) => {
        const isCode = i % 2 === 1 && i < parts.length - 1;
        if (!isCode) {
            // A code block is a block of its own: drop the line breaks right next to it
            let text = i % 2 === 1 ? '```' + part : part;
            if (i > 0 && i % 2 === 0) text = text.replace(/^\n/, '');
            if (i < parts.length - 2) text = text.replace(/\n$/, '');
            return formatLines(text);
        }
        // An optional language name after the opening fence is not shown
        const code = part.replace(/^[\w+#-]*\n/, '').replace(/\n$/, '');
        return `<pre class="chat-code"><code>${escapeHtml(code)}</code></pre>`;
    }).join('');
}

function formatLines(text) {
    const lines = text.split('\n');
    return lines.map((line, i) => {
        const quote = /^>\s?/.exec(line);
        if (quote) return `<span class="chat-quote">${formatLine(line.slice(quote[0].length)) || ' '}</span>`;
        // A quote is a block of its own, so no line break before one
        const breakAfter = i < lines.length - 1 && (line === '' || !/^>/.test(lines[i + 1]));
        return formatLine(line) + (breakAfter ? '\n' : '');
    }).join('');
}

function formatLine(line) {
    // `code` first: nothing inside it is formatted
    return line.split(/(`[^`]+`)/).map(seg => {
        if (/^`[^`]+`$/.test(seg)) return `<code class="chat-inline-code">${escapeHtml(seg.slice(1, -1))}</code>`;
        // then links, so marks inside a URL stay part of it
        return seg.split(/(https?:\/\/[^\s<]+)/i).map((piece, j) => {
            if (j % 2 === 0) return formatMarks(escapeHtml(piece));
            const url = escapeHtml(piece);
            const linkHtml = `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`;
            const isImage = /\.(?:jpe?g|gif|png|webp)(\?.*)?$/i.test(piece);
            return isImage
                ? `${linkHtml}<span class="chat-img-wrap"><img src="${url}" alt="preview" class="chat-img-preview" loading="lazy" onload="window.scrollChatBottom && window.scrollChatBottom()" /></span>`
                : linkHtml;
        }).join('');
    }).join('');
}

// On escaped text. No lookbehind: older Safari would refuse the whole module.
function formatMarks(html) {
    return html
        .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<strong>$1</strong>')
        .replace(/~~(\S(?:.*?\S)?)~~/g, '<del>$1</del>')
        .replace(/(^|[^*\w])\*(\S(?:[^*]*?\S)?)\*(?![*\w])/g, '$1<em>$2</em>')
        .replace(/(^|[^\w])_(\S(?:[^_]*?\S)?)_(?!\w)/g, '$1<em>$2</em>');
}

export function renderMessage(msg, isSelfSent, { quiet = false } = {}) {
    const stream = document.getElementById('chatStream');
    if (!stream || document.getElementById(`msg_${msg.id}`)) return;

    const myName = localStorage.getItem('portal_username') || 'You';
    const isSelf = isSelfSent || msg.sender === myName;

    const el = document.createElement('div');
    el.id = `msg_${msg.id}`;
    el.className = `chat-bubble ${isSelf ? 'self' : ''}`;
    el.dataset.created = msg.created_at;
    // Pinned messages (e.g. recording notices) never expire
    el.dataset.type = msg.pinned ? 'pinned' : 'chat';
    el.style.setProperty('--who-h', String(hueIndexFor(msg.sender)));
    if (msg.pinned) el.classList.add('pinned');

    el.innerHTML = `
        <div class="bubble-meta">
            <span class="sender-name">${escapeHtml(msg.sender)}</span>
            <span class="ttl-pill"${msg.pinned || AppState.chatDisappearing ? '' : ' hidden'}>${msg.pinned ? 'Pinned' : '60s'}</span>
        </div>
        <div class="chat-body">${formatMessageContent(msg.text)}</div>
    `;

    stream.appendChild(el);

    if (!isSelf && !quiet) noteIncoming('👍');
}

export function renderFile(file, isSelfSent, { quiet = false } = {}) {
    const stream = document.getElementById('chatStream');
    if (!stream || document.getElementById(`file_${file.id}`)) return;

    const myName = localStorage.getItem('portal_username') || 'You';
    const isSelf = isSelfSent || file.sender === myName;
    const isImage = /\.(jpe?g|png|gif|webp)$/i.test(file.original_name);
    const sizeFormatted = (file.size / (1024 * 1024)).toFixed(1) + ' MB';

    const el = document.createElement('div');
    el.id = `file_${file.id}`;
    el.className = 'file-card';
    el.dataset.created = file.created_at;
    el.dataset.type = 'file';
    el.style.setProperty('--who-h', String(hueIndexFor(file.sender)));

    const imagePreviewHtml = isImage 
        ? `<div class="file-img-wrap"><img src="/api/files/${file.id}" alt="${escapeHtml(file.original_name)}" class="file-img-preview" loading="lazy" onload="window.scrollChatBottom && window.scrollChatBottom()" /></div>` 
        : '';

    el.innerHTML = `
        <div class="file-card-meta">
            <span class="sender-name">${escapeHtml(file.sender)}</span>
            <span class="ttl-pill"${AppState.chatDisappearing ? '' : ' hidden'}>10m 00s</span>
        </div>
        <div class="file-name" title="${escapeHtml(file.original_name)}">${escapeHtml(file.original_name)}</div>
        <div class="file-size">${sizeFormatted}</div>
        ${imagePreviewHtml}
        <a class="file-dl-btn" href="/api/files/${file.id}" target="_blank" download="${escapeHtml(file.original_name)}">Download</a>
    `;

    stream.appendChild(el);

    if (!isSelf && !quiet) noteIncoming('🎉');
}

function tickCountdowns() {
    const now = Date.now();
    const stream = document.getElementById('chatStream');
    if (!stream) return;

    const items = stream.querySelectorAll('[data-created]');
    items.forEach(el => {
        const type = el.dataset.type;
        if (type !== 'chat' && type !== 'file') return; // pinned messages and polls never expire

        const pill = el.querySelector('.ttl-pill');
        // Without disappearing messages, everything stays until the room is empty
        if (pill) pill.hidden = !AppState.chatDisappearing;
        if (!AppState.chatDisappearing) return;

        const created = parseInt(el.dataset.created, 10);
        const ttlMs = type === 'chat' ? CHAT_TTL_MS : FILE_TTL_MS;
        const remaining = Math.max(0, Math.ceil((created + ttlMs - now) / 1000));

        if (remaining <= 0) {
            // Drop the marker so the fade-out is scheduled exactly once.
            delete el.dataset.created;
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 400);
            return;
        }

        // Pills are invisible while the drawer is closed; toggleChat refreshes them on open.
        if (!isChatOpen || !pill) return;

        // The hourglass is drawn by .ttl-pill::before, so the label is text only.
        let label;
        if (type === 'chat') {
            label = `${remaining}s`;
        } else {
            const mins = Math.floor(remaining / 60);
            const secs = remaining % 60;
            label = `${mins}m ${secs < 10 ? '0' : ''}${secs}s`;
        }
        if (pill.textContent !== label) pill.textContent = label;
        pill.classList.toggle('urgent', remaining <= (type === 'chat' ? 10 : 30));
    });
}

// Transient system note (e.g. recording status) — local-only, not broadcast
export function renderSystemNote(text) {
    const stream = document.getElementById('chatStream');
    if (!stream) return;

    const el = document.createElement('div');
    el.className = 'chat-system-note';
    el.textContent = text;
    stream.appendChild(el);
    scrollChatToBottom();

    setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 400);
    }, 8000);
}

export function scrollChatToBottom() {
    // A closed drawer has nothing to scroll (toggleChat scrolls on open); skip the forced layout.
    if (!isChatOpen) return;
    const stream = document.getElementById('chatStream');
    if (stream) {
        stream.scrollTop = stream.scrollHeight;
        setTimeout(() => {
            stream.scrollTop = stream.scrollHeight;
        }, 50);
    }
}
window.scrollChatBottom = scrollChatToBottom;

function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[m]);
}
