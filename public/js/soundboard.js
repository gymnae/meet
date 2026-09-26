// soundboard.js
// In-room sound board. Clicking a sound sends SOUND_PLAY over the data channel and
// every listener plays the file from the shared library (/api/sounds) locally, on the
// sound board bus of audio-normalizer.js. No bot joins and no extra track is published,
// so each listener controls volume and on/off for themselves.
import { AppState } from './state.js';
import { getAudioSettings, setAudioSetting, getSoundEffectsOutput } from './audio-normalizer.js';
import { sendDataPacket } from './livekit-handler.js';
import { triggerFloatingLabel } from './ui.js';

const MAX_PLAY_SECONDS = 20;    // longer files are faded out here
const MAX_CONCURRENT = 3;       // per listener; the oldest sound stops first
const SEND_GAP_MS = 500;        // per sender, between clicks
const RECEIVE_GAP_MS = 300;     // per sender, drops floods from a modified client
const STALE_MS = 4000;          // a sound that took longer than this to load is skipped
const BUFFER_CACHE_SIZE = 16;
const RECENT_KEY = 'portal_recent_sounds';
const RECENT_MAX = 4;
const SEARCH_THRESHOLD = 8;     // show the search field from this many sounds

let library = null;             // file names, null until loaded
let libraryPromise = null;
const buffers = new Map();      // id -> Promise<AudioBuffer>, oldest first
const loading = new Map();      // sender key -> token of the sound being loaded
const playing = new Map();      // sender key -> { id, source, gain, duration }, oldest first
const lastReceived = new Map(); // sender identity -> ms
let lastSent = 0;

/** Loads the library once. Resolves to the list of sound ids (file names). */
export function loadSoundLibrary() {
    if (!libraryPromise) {
        libraryPromise = fetch('/api/sounds')
            .then(res => res.ok ? res.json() : { sounds: [] })
            .then(data => { library = Array.isArray(data.sounds) ? data.sounds : []; return library; })
            .catch(() => { libraryPromise = null; return []; });
    }
    return libraryPromise;
}

export function isSoundLibraryLoaded() {
    return library !== null;
}

export function getSoundLibrary() {
    return library || [];
}

/** "air_horn-long.mp3" -> "air horn long" */
export function soundName(id) {
    return String(id).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || String(id);
}

function getBuffer(id) {
    if (buffers.has(id)) {
        const cached = buffers.get(id);
        buffers.delete(id);
        buffers.set(id, cached);
        return cached;
    }
    const { context } = getSoundEffectsOutput();
    const promise = fetch(`/api/sounds/${encodeURIComponent(id)}`)
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.arrayBuffer(); })
        .then(data => context.decodeAudioData(data));
    promise.catch(() => buffers.delete(id));
    buffers.set(id, promise);
    while (buffers.size > BUFFER_CACHE_SIZE) buffers.delete(buffers.keys().next().value);
    return promise;
}

function stopKey(key) {
    loading.delete(key);
    const entry = playing.get(key);
    if (!entry) return;
    playing.delete(key);
    try {
        // Short fade so a cut-off doesn't click
        const t = entry.source.context.currentTime;
        entry.gain.gain.setTargetAtTime(0, t, 0.015);
        entry.source.stop(t + 0.08);
    } catch (e) { /* already stopped */ }
    notifyChange();
}

async function startPlayback(key, id) {
    stopKey(key);
    if (!getAudioSettings().sfxEnabled) return;

    const token = {};
    loading.set(key, token);
    const requestedAt = performance.now();
    let buffer;
    try {
        buffer = await getBuffer(id);
    } catch (err) {
        console.warn(`[Soundboard] Couldn't load ${id}`, err);
        if (loading.get(key) === token) loading.delete(key);
        return;
    }
    // Replaced or stopped while loading, turned off meanwhile, or too late to still fit the moment
    if (loading.get(key) !== token) return;
    loading.delete(key);
    if (!getAudioSettings().sfxEnabled || performance.now() - requestedAt > STALE_MS) return;

    while (playing.size >= MAX_CONCURRENT) stopKey(playing.keys().next().value);

    const { context, node } = getSoundEffectsOutput();
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    source.connect(gain).connect(node);

    const duration = Math.min(buffer.duration, MAX_PLAY_SECONDS);
    const now = context.currentTime;
    if (buffer.duration > MAX_PLAY_SECONDS) {
        gain.gain.setValueAtTime(1, now + duration - 0.6);
        gain.gain.linearRampToValueAtTime(0, now + duration);
    }
    source.start(now, 0, duration);

    const entry = { id, source, gain, duration, startedAt: performance.now() };
    playing.set(key, entry);
    source.onended = () => {
        try { gain.disconnect(); } catch (e) { /* noop */ }
        if (playing.get(key) === entry) {
            playing.delete(key);
            notifyChange();
        }
    };
    notifyChange();
}

/** Plays a sound for everyone in the room (the local user's click). */
export function playSound(id) {
    if (!AppState.activeRoom || !getSoundLibrary().includes(id)) return;
    const now = Date.now();
    if (now - lastSent < SEND_GAP_MS) return;
    lastSent = now;

    rememberRecent(id);
    sendDataPacket({ type: 'SOUND_PLAY', id });
    triggerFloatingLabel('tile_local_camera', soundName(id));
    startPlayback('local', id);
}

/** Stops the local user's sound for everyone. */
export function stopOwnSound() {
    stopKey('local');
    sendDataPacket({ type: 'SOUND_STOP' });
}

/** SOUND_PLAY / SOUND_STOP from another participant. */
export function handleSoundPacket(data, participant) {
    const key = participant?.identity;
    if (!key) return;
    if (data.type === 'SOUND_STOP') {
        stopKey(key);
        return;
    }
    if (typeof data.id !== 'string') return;
    const now = Date.now();
    if (now - (lastReceived.get(key) || 0) < RECEIVE_GAP_MS) return;
    lastReceived.set(key, now);

    triggerFloatingLabel(`tile_${key}_camera`, soundName(data.id));
    startPlayback(key, data.id);
}

/** Stops everything that is playing or loading (sounds turned off, leaving). */
export function stopAllSounds() {
    [...new Set([...loading.keys(), ...playing.keys()])].forEach(stopKey);
}

// --- Recent sounds (this browser) -------------------------------------------

function getRecent() {
    try {
        const saved = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
        return Array.isArray(saved) ? saved.filter(id => getSoundLibrary().includes(id)) : [];
    } catch (e) {
        return [];
    }
}

function rememberRecent(id) {
    const next = [id, ...getRecent().filter(r => r !== id)].slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch (e) { /* noop */ }
}

// --- Sounds tab of the reaction menu -----------------------------------------

function notifyChange() {
    const own = playing.get('local');
    document.querySelectorAll('#reactionMenu .sfx-btn').forEach(btn => {
        const active = !!own && btn.dataset.id === own.id;
        btn.setAttribute('aria-pressed', String(active));
        if (active && btn.dataset.playing !== String(own.startedAt)) {
            // Restart the progress bar for this playback
            btn.dataset.playing = String(own.startedAt);
            btn.style.setProperty('--sfx-dur', `${own.duration}s`);
            btn.classList.remove('is-playing');
            void btn.offsetWidth;
            btn.classList.add('is-playing');
        } else if (!active) {
            delete btn.dataset.playing;
            btn.classList.remove('is-playing');
        }
    });
}

function soundButton(id) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sfx-btn';
    btn.dataset.id = id;
    btn.setAttribute('aria-pressed', 'false');
    const name = soundName(id);
    btn.title = name;
    const label = document.createElement('span');
    label.textContent = name;
    btn.append(label);
    btn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (playing.get('local')?.id === id) stopOwnSound();
        else playSound(id);
    };
    return btn;
}

function grid(ids) {
    const el = document.createElement('div');
    el.className = 'sfx-grid';
    ids.forEach(id => el.append(soundButton(id)));
    return el;
}

function subheading(text) {
    const el = document.createElement('p');
    el.className = 'sound-subheading';
    el.textContent = text;
    return el;
}

/** Renders the Sounds tab into `panel`. */
export function renderSoundsPanel(panel) {
    const sounds = getSoundLibrary();

    if (!getAudioSettings().sfxEnabled) {
        const note = document.createElement('div');
        note.className = 'sfx-note';
        const text = document.createElement('p');
        text.textContent = 'Sounds are off for you. Others still hear what you play.';
        const on = document.createElement('button');
        on.type = 'button';
        on.className = 'react-item sfx-note-btn';
        on.textContent = 'Turn sounds on';
        on.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            setAudioSetting('sfxEnabled', true);
            note.remove();
        };
        note.append(text, on);
        panel.append(note);
    }

    let search = null;
    if (sounds.length >= SEARCH_THRESHOLD) {
        search = document.createElement('input');
        search.type = 'search';
        search.className = 'sfx-search';
        search.placeholder = 'Search sounds';
        search.setAttribute('aria-label', 'Search sounds');
        search.autocomplete = 'off';
        search.spellcheck = false;
        panel.append(search);
    }

    const list = document.createElement('div');
    list.className = 'sfx-list';

    const recent = getRecent();
    const recentBlock = document.createElement('div');
    if (recent.length && sounds.length > RECENT_MAX) {
        recentBlock.append(subheading('Recent'), grid(recent), subheading('All sounds'));
    }
    const all = grid(sounds);
    const empty = document.createElement('p');
    empty.className = 'sfx-empty';
    empty.textContent = 'No sounds match.';
    empty.hidden = true;
    list.append(recentBlock, all, empty);

    const hint = document.createElement('p');
    hint.className = 'sfx-hint';
    hint.textContent = 'Everyone in the room hears it.';

    panel.append(list, hint);

    if (search) {
        const filter = () => {
            const q = search.value.trim().toLowerCase();
            let shown = 0;
            all.querySelectorAll('.sfx-btn').forEach(btn => {
                const match = !q || btn.title.toLowerCase().includes(q) || btn.dataset.id.toLowerCase().includes(q);
                btn.hidden = !match;
                if (match) shown++;
            });
            recentBlock.hidden = !!q;
            empty.hidden = shown > 0;
        };
        search.addEventListener('input', filter);
        search.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            all.querySelector('.sfx-btn:not([hidden])')?.click();
        });
        // Focus the search on desktop; on touch it would pop up the keyboard over the list
        if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
            requestAnimationFrame(() => search.focus());
        }
    }

    notifyChange();
}
