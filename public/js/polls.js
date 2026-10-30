// === POLLS: quick single or multiple choice questions in the chat ===
// The server keeps polls and votes (keyed by the name people joined with) and returns the tally.
// Whoever changed it sends the new tally to the room; everyone keeps the newest by version.
// The creator decides whether names are shown next to the options. Polls don't disappear with
// the chat timers; they go when everyone has left, like everything else in the room.

import { AppState } from './state.js';
import { postJson } from './api.js';
import { sendDataPacket } from './livekit-handler.js';
import { showToast, hueIndexFor } from './ui.js';
import { noteIncoming, scrollChatToBottom } from './chat.js';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

// id -> { poll, draft: Set of option indexes picked but not sent yet (multiple choice) }
const polls = new Map();

function myName() {
    return localStorage.getItem('portal_username') || 'You';
}

/**
 * Adds a poll to the chat or updates it with a newer tally. isSelfSent: this person just made the
 * change. A tally sent by someone else has no `mine`, so the one we have is kept.
 */
export function renderPoll(poll, isSelfSent = false, { quiet = false } = {}) {
    const known = polls.get(poll.id);
    const mine = 'mine' in poll ? poll.mine : known?.poll.mine ?? null;
    const entry = known || { draft: null };
    if (known && poll.version < known.poll.version) {
        // A newer tally already arrived (it counts this vote too); only our own choices are news
        if (!isSelfSent) return;
        entry.poll = { ...known.poll, mine };
    } else {
        entry.poll = { ...poll, mine };
    }
    if (!entry.draft || isSelfSent) entry.draft = new Set(mine || []);
    polls.set(poll.id, entry);

    const stream = document.getElementById('chatStream');
    if (!stream) return;
    let el = document.getElementById(`poll_${poll.id}`);
    const isNew = !el;
    if (isNew) {
        el = document.createElement('section');
        el.id = `poll_${poll.id}`;
        el.className = 'poll-card';
        el.dataset.type = 'poll';
        el.style.setProperty('--who-h', String(hueIndexFor(poll.creator)));
        el.setAttribute('aria-label', `Poll by ${poll.creator}`);
        el.addEventListener('click', (e) => onPollClick(e, poll.id));
        stream.appendChild(el);
    }
    // Keep keyboard focus on the same control across the re-render
    const focused = el.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    el.innerHTML = pollHtml(entry);
    if (focused) el.querySelector(`[data-focus-key="${focused}"]`)?.focus();

    if (isNew && !isSelfSent && !quiet && poll.creator !== myName()) noteIncoming('🎉');
}

function pollHtml({ poll, draft }) {
    const me = myName();
    const isCreator = poll.creator === me;
    const voted = Array.isArray(poll.mine) && poll.mine.length > 0;
    const showResults = voted || poll.closed || isCreator;
    const total = poll.voters;
    const kind = poll.multi ? 'Pick one or more' : 'Pick one';
    const votesLabel = `${total} ${total === 1 ? 'vote' : 'votes'}`;

    const options = poll.options.map((text, i) => {
        const picked = draft.has(i);
        const count = poll.counts[i] || 0;
        const share = total ? Math.round((count / total) * 100) : 0;
        const names = poll.names?.[i] || [];
        const result = showResults
            ? `<span class="poll-count">${count}<span class="sr-only"> ${count === 1 ? 'vote' : 'votes'}</span></span>
               <span class="poll-bar" style="--share:${share}%" aria-hidden="true"></span>`
            : '';
        const namesHtml = showResults && poll.show_names && names.length
            ? `<span class="poll-names">${names.map(escapeHtml).join(', ')}</span>`
            : '';
        return `<li>
            <button type="button" class="poll-option${picked ? ' picked' : ''}" data-option="${i}" data-focus-key="o${i}"
                aria-pressed="${picked}" ${poll.closed ? 'disabled' : ''}>
                <span class="poll-mark" aria-hidden="true"></span>
                <span class="poll-text">${escapeHtml(text)}</span>
                ${result}
            </button>
            ${namesHtml}
        </li>`;
    }).join('');

    const changed = poll.multi && !sameChoices(draft, poll.mine);
    const actions = [];
    if (poll.multi && !poll.closed) {
        actions.push(`<button type="button" class="secondary-btn" data-action="vote" data-focus-key="vote" ${changed ? '' : 'disabled'}>${voted ? 'Change vote' : 'Vote'}</button>`);
    }
    if (isCreator && !poll.closed) {
        actions.push(`<button type="button" class="secondary-btn poll-end" data-action="close" data-focus-key="close">End poll</button>`);
    }

    return `
        <div class="bubble-meta">
            <span class="sender-name">${escapeHtml(poll.creator)}</span>
            <span class="poll-chip${poll.closed ? ' closed' : ''}">${poll.closed ? 'Poll ended' : 'Poll'}</span>
        </div>
        <h3 class="poll-question">${escapeHtml(poll.question)}</h3>
        <p class="poll-hint">${kind} · ${votesLabel}${poll.show_names ? ' · names shown' : ' · anonymous'}</p>
        <ul class="poll-options" role="list">${options}</ul>
        ${actions.length ? `<div class="poll-actions">${actions.join('')}</div>` : ''}
    `;
}

function sameChoices(set, list) {
    const a = [...set].sort((x, y) => x - y);
    const b = [...(list || [])].sort((x, y) => x - y);
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

let busy = false;
async function onPollClick(e, pollId) {
    const entry = polls.get(pollId);
    const target = e.target.closest('button');
    if (!entry || !target || target.disabled || busy) return;
    const { poll } = entry;

    if (target.dataset.option !== undefined) {
        const i = Number(target.dataset.option);
        if (poll.multi) {
            if (entry.draft.has(i)) entry.draft.delete(i); else entry.draft.add(i);
            renderPoll(poll);
            return;
        }
        // Single choice votes right away; picking the same option again takes the vote back
        const choices = poll.mine?.[0] === i ? [] : [i];
        await send(`/api/polls/${encodeURIComponent(pollId)}/vote`, { voter: myName(), choices });
    } else if (target.dataset.action === 'vote') {
        await send(`/api/polls/${encodeURIComponent(pollId)}/vote`, { voter: myName(), choices: [...entry.draft] });
    } else if (target.dataset.action === 'close') {
        await send(`/api/polls/${encodeURIComponent(pollId)}/close`, { creator: myName() });
    }
}

async function send(url, body) {
    busy = true;
    try {
        const res = await postJson(url, body);
        if (res.status === 409) {
            showToast('This poll has ended.', 'warn');
            return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const poll = await res.json();
        renderPoll(poll, true);
        broadcast(poll);
    } catch (err) {
        console.error('[Polls] Request failed:', err);
        showToast("Couldn't send your vote. Try again.", 'error');
    } finally {
        busy = false;
    }
}

// Others get the tally without this person's own choices
function broadcast(poll) {
    const { mine, ...shared } = poll;
    sendDataPacket({ type: 'POLL_UPDATE', poll: shared });
}

/** A tally from someone else in the room. */
export function handlePollUpdate(poll) {
    if (poll?.id) renderPoll(poll, false);
}

// --- new poll dialog -----------------------------------------------------------------------

let dialogBound = false;

export function openPollDialog() {
    const dialog = document.getElementById('pollDialog');
    if (!dialog || !AppState.activeRoom) return;
    if (!dialogBound) bindDialog(dialog);
    document.getElementById('pollForm').reset();
    document.getElementById('pollError').textContent = '';
    const list = document.getElementById('pollOptionList');
    list.innerHTML = '';
    for (let i = 0; i < MIN_OPTIONS; i++) addOptionRow(list);
    syncOptionRows();
    dialog.showModal();
    document.getElementById('pollQuestion').focus();
}

function bindDialog(dialog) {
    dialogBound = true;
    dialog.querySelector('[data-poll-close]').addEventListener('click', () => dialog.close());
    // A click on the backdrop lands on the dialog itself
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    document.getElementById('pollAddOption').addEventListener('click', () => {
        const input = addOptionRow(document.getElementById('pollOptionList'));
        syncOptionRows();
        input.focus();
    });
    document.getElementById('pollOptionList').addEventListener('click', (e) => {
        const remove = e.target.closest('[data-remove]');
        if (!remove) return;
        const row = remove.closest('.poll-option-row');
        const next = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        syncOptionRows();
        next?.querySelector('input')?.focus();
    });
    // Enter in the last option adds another one instead of submitting half a poll
    document.getElementById('pollOptionList').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        const rows = [...document.querySelectorAll('.poll-option-row')];
        const isLast = e.target.closest('.poll-option-row') === rows[rows.length - 1];
        if (isLast && e.target.value.trim() && rows.length < MAX_OPTIONS) {
            e.preventDefault();
            addOptionRow(document.getElementById('pollOptionList')).focus();
            syncOptionRows();
        }
    });
    document.getElementById('pollForm').addEventListener('submit', submitPoll);
}

let optionSeq = 0;
function addOptionRow(list) {
    const row = document.createElement('div');
    row.className = 'poll-option-row';
    const id = `pollOpt${++optionSeq}`;
    row.innerHTML = `
        <label class="sr-only" for="${id}"></label>
        <input type="text" id="${id}" maxlength="200" autocomplete="off">
        <button type="button" class="chat-close-btn" data-remove><svg class="icon" aria-hidden="true"><use class="ic-pixel" href="#i-close"/><use class="ic-smooth" href="#s-close"/></svg></button>`;
    list.appendChild(row);
    return row.querySelector('input');
}

// Numbers the rows, and allows removing only above the minimum and adding only below the maximum
function syncOptionRows() {
    const rows = [...document.querySelectorAll('.poll-option-row')];
    rows.forEach((row, i) => {
        row.querySelector('label').textContent = `Option ${i + 1}`;
        row.querySelector('input').placeholder = `Option ${i + 1}`;
        const remove = row.querySelector('[data-remove]');
        remove.hidden = rows.length <= MIN_OPTIONS;
        remove.setAttribute('aria-label', `Remove option ${i + 1}`);
    });
    document.getElementById('pollAddOption').hidden = rows.length >= MAX_OPTIONS;
}

let submitting = false;
async function submitPoll(e) {
    e.preventDefault();
    if (submitting || !AppState.activeRoom) return;
    const error = document.getElementById('pollError');
    const questionEl = document.getElementById('pollQuestion');
    const question = questionEl.value.trim();
    const options = [...document.querySelectorAll('.poll-option-row input')].map(i => i.value.trim()).filter(Boolean);

    questionEl.removeAttribute('aria-invalid');
    if (!question) {
        error.textContent = 'Enter a question.';
        questionEl.setAttribute('aria-invalid', 'true');
        questionEl.focus();
        return;
    }
    if (options.length < MIN_OPTIONS) {
        error.textContent = `Enter at least ${MIN_OPTIONS} options.`;
        [...document.querySelectorAll('.poll-option-row input')].find(i => !i.value.trim())?.focus();
        return;
    }
    if (new Set(options.map(o => o.toLowerCase())).size !== options.length) {
        error.textContent = 'Each option needs to be different.';
        return;
    }
    error.textContent = '';

    submitting = true;
    const submit = document.getElementById('pollSubmit');
    submit.disabled = true;
    try {
        const res = await postJson(`/api/rooms/${encodeURIComponent(AppState.activeRoom.name)}/polls`, {
            creator: myName(),
            question,
            options,
            multi: document.getElementById('pollMulti').checked,
            showNames: document.getElementById('pollShowNames').checked
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const poll = await res.json();
        document.getElementById('pollDialog').close();
        renderPoll(poll, true);
        broadcast(poll);
        scrollChatToBottom();
    } catch (err) {
        console.error('[Polls] Creating the poll failed:', err);
        error.textContent = "Couldn't start the poll. Try again.";
    } finally {
        submitting = false;
        submit.disabled = false;
    }
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[m]);
}
