import { AppState } from './state.js';
import { sendDataPacket } from './livekit-handler.js';
import { playSynthSound } from './ui.js';

let isChatOpen = false;
let unreadCount = 0;
let countdownTimer = null;

export function initChatEngine() {
    if (!countdownTimer) {
        countdownTimer = setInterval(tickCountdowns, 1000);
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            syncDrawerToViewport();
            scrollChatToBottom();
        });
        window.visualViewport.addEventListener('scroll', () => {
            syncDrawerToViewport();
        });
    }

    const input = document.getElementById('chatInput');
    if (input) {
        input.addEventListener('focus', () => {
            setTimeout(() => {
                syncDrawerToViewport();
                scrollChatToBottom();
            }, 100);
        });
    }
}

function syncDrawerToViewport() {
    const drawer = document.getElementById('chatDrawer');
    if (!drawer || !isChatOpen) return;

    if (window.innerWidth <= 768 && window.visualViewport) {
        const vv = window.visualViewport;
        const isKeyboardOpen = vv.height < (window.innerHeight - 60);

        drawer.classList.toggle('keyboard-open', isKeyboardOpen);

        // Position drawer strictly within visualViewport bounds
        drawer.style.position = 'fixed';
        drawer.style.top = `${vv.offsetTop}px`;
        drawer.style.left = `${vv.offsetLeft}px`;
        drawer.style.width = `${vv.width}px`;
        drawer.style.height = `${vv.height}px`;
        drawer.style.bottom = 'auto';
    } else {
        drawer.classList.remove('keyboard-open');
        drawer.style.position = '';
        drawer.style.top = '';
        drawer.style.left = '';
        drawer.style.width = '';
        drawer.style.height = '';
        drawer.style.bottom = '';
    }
}

export function toggleChat() {
    const drawer = document.getElementById('chatDrawer');
    const badge = document.getElementById('chatBadge');
    if (!drawer) return;

    isChatOpen = !isChatOpen;
    drawer.style.display = isChatOpen ? 'flex' : 'none';

    if (isChatOpen) {
        unreadCount = 0;
        if (badge) badge.style.display = 'none';

        syncDrawerToViewport();

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
}

export async function syncRoomTransmissions(roomName) {
    try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/sync`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.messages) {
            data.messages.forEach(msg => renderMessage(msg, false));
        }
        if (data.files) {
            data.files.forEach(file => renderFile(file, false));
        }
        scrollChatToBottom();
    } catch (e) {
        console.error('[Chat] Failed room sync:', e);
    }
}

export async function handleChatSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || !AppState.activeRoom) return;

    const roomName = AppState.activeRoom.name;
    const sender = localStorage.getItem('portal_username') || 'You';
    input.value = '';

    try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender, text })
        });
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
        alert('File size exceeds 200MB limit.');
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

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/rooms/${encodeURIComponent(roomName)}/upload`, true);

    xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable && progressFill) {
            const pct = Math.round((evt.loaded / evt.total) * 100);
            progressFill.style.width = `${pct}%`;
        }
    };

    xhr.onload = () => {
        if (progressContainer) progressContainer.style.display = 'none';
        if (progressFill) progressFill.style.width = '0%';
        e.target.value = '';

        if (xhr.status === 200) {
            const savedFile = JSON.parse(xhr.responseText);
            renderFile(savedFile, true);
            sendDataPacket({ type: 'FILE_SHARED', payload: savedFile });
            scrollChatToBottom();
        } else {
            alert('File upload failed.');
        }
    };

    xhr.onerror = () => {
        if (progressContainer) progressContainer.style.display = 'none';
        alert('Network error during upload.');
    };

    xhr.send(formData);
}

function formatMessageContent(rawText) {
    const escaped = escapeHtml(rawText);
    const urlRegex = /(https?:\/\/[^\s<]+)/gi;

    return escaped.replace(urlRegex, (url) => {
        const isImage = /\.(?:jpe?g|gif|png|webp)(\?.*)?$/i.test(url);
        const linkHtml = `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`;
        
        if (isImage) {
            return `${linkHtml}<div class="chat-img-wrap"><img src="${url}" alt="preview" class="chat-img-preview" loading="lazy" onload="window.scrollChatBottom && window.scrollChatBottom()" /></div>`;
        }
        return linkHtml;
    }).replace(/\n/g, '<br>');
}

export function renderMessage(msg, isSelfSent) {
    const stream = document.getElementById('chatStream');
    if (!stream || document.getElementById(`msg_${msg.id}`)) return;

    const myName = localStorage.getItem('portal_username') || 'You';
    const isSelf = isSelfSent || msg.sender === myName;

    const el = document.createElement('div');
    el.id = `msg_${msg.id}`;
    el.className = `chat-bubble ${isSelf ? 'self' : ''}`;
    el.dataset.created = msg.created_at;
    el.dataset.type = 'chat';

    el.innerHTML = `
        <div class="bubble-meta">
            <span class="sender-name">${escapeHtml(msg.sender)}</span>
            <span class="ttl-pill">⏳ 60s</span>
        </div>
        <div class="chat-body">${formatMessageContent(msg.text)}</div>
    `;

    stream.appendChild(el);

    if (!isChatOpen && !isSelf) {
        unreadCount++;
        const badge = document.getElementById('chatBadge');
        if (badge) badge.style.display = 'block';
        playSynthSound('👍');
    }
}

export function renderFile(file, isSelfSent) {
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

    const imagePreviewHtml = isImage 
        ? `<div class="file-img-wrap"><img src="/api/files/${file.id}" alt="${escapeHtml(file.original_name)}" class="file-img-preview" loading="lazy" onload="window.scrollChatBottom && window.scrollChatBottom()" /></div>` 
        : '';

    el.innerHTML = `
        <div class="file-card-meta">
            <span class="sender-name">${escapeHtml(file.sender)}</span>
            <span class="ttl-pill">⏳ 10m</span>
        </div>
        <div class="file-name" title="${escapeHtml(file.original_name)}">📁 ${escapeHtml(file.original_name)}</div>
        <div class="file-size">${sizeFormatted}</div>
        ${imagePreviewHtml}
        <a class="file-dl-btn" href="/api/files/${file.id}" target="_blank" download="${escapeHtml(file.original_name)}">⬇ Download</a>
    `;

    stream.appendChild(el);

    if (!isChatOpen && !isSelf) {
        unreadCount++;
        const badge = document.getElementById('chatBadge');
        if (badge) badge.style.display = 'block';
        playSynthSound('🎉');
    }
}

function tickCountdowns() {
    const now = Date.now();
    const stream = document.getElementById('chatStream');
    if (!stream) return;

    const items = stream.querySelectorAll('[data-created]');
    items.forEach(el => {
        const created = parseInt(el.dataset.created, 10);
        const type = el.dataset.type;
        const pill = el.querySelector('.ttl-pill');

        if (type === 'chat') {
            const remaining = Math.max(0, Math.ceil((created + 60 * 1000 - now) / 1000));
            if (remaining <= 0) {
                el.style.opacity = '0';
                setTimeout(() => el.remove(), 400);
            } else if (pill) {
                pill.innerText = `⏳ ${remaining}s`;
            }
        } else if (type === 'file') {
            const remaining = Math.max(0, Math.ceil((created + 600 * 1000 - now) / 1000));
            if (remaining <= 0) {
                el.style.opacity = '0';
                setTimeout(() => el.remove(), 400);
            } else if (pill) {
                const mins = Math.floor(remaining / 60);
                const secs = remaining % 60;
                pill.innerText = `⏳ ${mins}m ${secs < 10 ? '0' : ''}${secs}s`;
            }
        }
    });
}

export function scrollChatToBottom() {
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
