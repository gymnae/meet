// sound-menu.js
// In-call sound panel: leveling strength and volume for what you hear,
// per-person volume, and leveling / level / browser processing for your mic.
import { AppState } from './state.js';
import {
    getAudioSettings, setAudioSetting, resetAudioSettings,
    getPeerVolume, setPeerVolume
} from './audio-normalizer.js';
import { republishMic, getActiveMicDeviceId } from './livekit-handler.js';
import { showToast } from './ui.js';

const LEVELING_CHOICES = [
    { value: 'off', label: 'Off' },
    { value: 'gentle', label: 'Gentle' },
    { value: 'strong', label: 'Strong' },
];

const PROCESSING_TOGGLES = [
    { key: 'noiseSuppression', label: 'Noise suppression' },
    { key: 'echoCancellation', label: 'Echo cancellation' },
    { key: 'autoGainControl', label: 'Browser auto gain' },
];

let republishing = false;

export function toggleSoundMenu() {
    if (!AppState.activeRoom) return;
    const menu = document.getElementById('soundMenu');
    ['camMenu', 'micMenu', 'reactionMenu'].forEach(id => {
        const m = document.getElementById(id);
        if (m) m.style.display = 'none';
    });
    if (menu.style.display === 'flex') { menu.style.display = 'none'; return; }
    // On phones the chat is a bottom sheet that would cover the panel
    if (document.body.classList.contains('chat-open') && window.matchMedia('(max-width: 768px)').matches) {
        window.toggleChat();
    }
    renderSoundMenu(menu);
    menu.style.display = 'flex';
}

/** Re-renders the panel if it is open (e.g. someone joined or left). */
export function refreshSoundMenu() {
    const menu = document.getElementById('soundMenu');
    if (!menu || menu.style.display !== 'flex') return;
    // Don't yank a slider out from under an active drag
    if (menu.contains(document.activeElement) && document.activeElement.type === 'range') return;
    const scroll = menu.scrollTop;
    renderSoundMenu(menu);
    menu.scrollTop = scroll;
}

function renderSoundMenu(menu) {
    const s = getAudioSettings();
    menu.innerHTML = '';

    // --- What you hear ---
    const hear = section('What you hear');
    hear.append(
        segmented('Leveling', LEVELING_CHOICES, s.incomingLeveling, v => setAudioSetting('incomingLeveling', v)),
        slider('Volume', s.volume, v => setAudioSetting('volume', v))
    );
    const peers = [...(AppState.activeRoom?.remoteParticipants.values() || [])];
    if (peers.length) {
        hear.append(subheading('People'));
        peers.forEach(p => {
            const name = p.name || (p.identity || '').split('_')[0] || 'Attendee';
            hear.append(slider(name, getPeerVolume(p.identity), v => setPeerVolume(p.identity, v)));
        });
    }

    // --- Your microphone ---
    const mic = section('Your microphone');
    mic.append(
        segmented('Leveling', LEVELING_CHOICES, s.outgoingLeveling, v => setAudioSetting('outgoingLeveling', v)),
        slider('Mic level', s.micGain, v => setAudioSetting('micGain', v))
    );
    PROCESSING_TOGGLES.forEach(({ key, label }) => mic.append(toggle(key, label, s[key])));

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'cam-item sound-reset';
    reset.textContent = 'Reset to defaults';
    reset.onclick = async (e) => {
        e.preventDefault(); e.stopPropagation();
        const before = getAudioSettings();
        resetAudioSettings();
        const after = getAudioSettings();
        renderSoundMenu(menu);
        if (PROCESSING_TOGGLES.some(({ key }) => before[key] !== after[key])) await applyProcessingChange(menu);
    };

    menu.append(hear, mic, reset);
}

function section(title) {
    const el = document.createElement('section');
    el.className = 'sound-section';
    const h = document.createElement('h3');
    h.className = 'sound-heading';
    h.textContent = title;
    el.append(h);
    return el;
}

function subheading(text) {
    const el = document.createElement('p');
    el.className = 'sound-subheading';
    el.textContent = text;
    return el;
}

function segmented(label, choices, current, onChange) {
    const row = document.createElement('div');
    row.className = 'sound-row';
    const name = document.createElement('span');
    name.className = 'sound-label';
    name.textContent = label;
    const group = document.createElement('div');
    group.className = 'sound-seg';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    choices.forEach(choice => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', String(choice.value === current));
        btn.textContent = choice.label;
        btn.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            group.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b === btn)));
            onChange(choice.value);
        };
        group.append(btn);
    });
    row.append(name, group);
    return row;
}

function slider(label, value, onChange) {
    const row = document.createElement('label');
    row.className = 'sound-slider';
    const name = document.createElement('span');
    name.className = 'sound-label';
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '200';
    input.step = '5';
    input.value = String(Math.round(value * 100));
    const out = document.createElement('output');
    out.textContent = `${input.value}%`;
    input.addEventListener('input', () => {
        out.textContent = `${input.value}%`;
        onChange(Number(input.value) / 100);
    });
    // Double-click / double-tap snaps back to 100%
    input.addEventListener('dblclick', () => {
        input.value = '100';
        input.dispatchEvent(new Event('input'));
    });
    row.append(name, input, out);
    return row;
}

function toggle(key, label, checked) {
    const row = document.createElement('label');
    row.className = 'sound-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.dataset.processing = key;
    const text = document.createElement('span');
    text.textContent = label;
    input.addEventListener('change', async () => {
        setAudioSetting(key, input.checked);
        await applyProcessingChange(input.closest('#soundMenu'));
    });
    row.append(input, text);
    return row;
}

// Browser processing is fixed when the mic is opened, so a live mic gets
// republished with the new constraints. A muted mic picks them up on unmute.
async function applyProcessingChange(menu) {
    const deviceId = getActiveMicDeviceId();
    if (AppState.micMuted || !deviceId) {
        showToast('Saved. Applies when you turn your mic back on.', 'info', 3000);
        return;
    }
    if (republishing) return;
    republishing = true;
    const boxes = menu ? [...menu.querySelectorAll('input[data-processing]')] : [];
    boxes.forEach(b => { b.disabled = true; });
    try {
        await republishMic(deviceId);
    } catch (err) {
        console.error("[Sound] Mic restart failed", err);
        showToast("Couldn't restart your microphone with the new setting.", 'error', 5000);
    } finally {
        republishing = false;
        boxes.forEach(b => { b.disabled = false; });
    }
}
