// audio-normalizer.js
// Web Audio based loudness leveling for microphone audio, plus the listener's
// sound settings (leveling strength, volumes, browser mic processing).
// Outgoing: local mic track is routed through a leveling graph before publishing.
// Incoming: remote microphone tracks are routed through the same graph for playback.
// Screen share audio is never routed through this module and stays untouched.
//
// Every graph has a wet (leveled) and a dry (raw) path, so leveling strength and
// volumes change live without republishing or re-attaching anything.

// Leveling presets. The compressor applies its own automatic makeup gain, so
// `trim` pulls the result back: typical speech (-25..-18 dBFS in) comes out
// around -20 dBFS instead of being boosted. Measured with OfflineAudioContext.
export const LEVELING_PRESETS = {
    off: null,
    gentle: { threshold: -30, knee: 20, ratio: 3, attack: 0.01, release: 0.3, trim: 0.7 },
    strong: { threshold: -36, knee: 20, ratio: 6, attack: 0.005, release: 0.25, trim: 0.8 },
};

const STORAGE_KEY = 'portal_audio';
const DEFAULT_SETTINGS = {
    incomingLeveling: 'gentle',   // what you hear
    outgoingLeveling: 'off',      // your mic (listeners already level what they hear)
    volume: 1,                    // master volume for incoming voices, 0..2
    micGain: 1,                   // your mic level, 0..2
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
};

let settings = loadSettings();
const peerVolumes = new Map();    // participant identity -> 0..2 (this session only)

let sharedAudioContext = null;
let masterGain = null;            // incoming voices -> masterGain -> speakers
const outgoingProcs = new Map();  // original MediaStreamTrack -> { chain, micGain, processedTrack }
const incomingProcs = new Map();  // remote MediaStreamTrack -> { chain, peerGain, element, identity }

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        const merged = { ...DEFAULT_SETTINGS, ...saved };
        if (!(merged.incomingLeveling in LEVELING_PRESETS)) merged.incomingLeveling = DEFAULT_SETTINGS.incomingLeveling;
        if (!(merged.outgoingLeveling in LEVELING_PRESETS)) merged.outgoingLeveling = DEFAULT_SETTINGS.outgoingLeveling;
        return merged;
    } catch (e) {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* noop */ }
}

export function getAudioSettings() {
    return { ...settings };
}

/** Browser-side mic processing constraints, for getUserMedia / createLocalAudioTrack. */
export function getMicConstraints() {
    return {
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
    };
}

/** Updates one setting, persists it and applies it to all live graphs. */
export function setAudioSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return;
    settings[key] = value;
    saveSettings();
    applyLiveSettings();
}

export function resetAudioSettings() {
    settings = { ...DEFAULT_SETTINGS };
    peerVolumes.clear();
    saveSettings();
    applyLiveSettings();
    incomingProcs.forEach(proc => rampTo(proc.peerGain.gain, 1));
}

export function getPeerVolume(identity) {
    return peerVolumes.has(identity) ? peerVolumes.get(identity) : 1;
}

export function setPeerVolume(identity, value) {
    peerVolumes.set(identity, value);
    incomingProcs.forEach(proc => {
        if (proc.identity === identity) rampTo(proc.peerGain.gain, value);
    });
}

// Short ramp so slider drags don't click.
function rampTo(param, value) {
    try { param.setTargetAtTime(value, param.context.currentTime, 0.02); }
    catch (e) { param.value = value; }
}

function applyLeveling(chain, presetName, immediate = false) {
    const set = immediate ? (param, value) => { param.value = value; } : rampTo;
    const preset = LEVELING_PRESETS[presetName];
    if (preset) {
        const { compressor } = chain;
        compressor.threshold.value = preset.threshold;
        compressor.knee.value = preset.knee;
        compressor.ratio.value = preset.ratio;
        compressor.attack.value = preset.attack;
        compressor.release.value = preset.release;
        set(chain.trim.gain, preset.trim);
    }
    set(chain.wet.gain, preset ? 1 : 0);
    set(chain.dry.gain, preset ? 0 : 1);
}

function applyLiveSettings() {
    if (masterGain) rampTo(masterGain.gain, settings.volume);
    incomingProcs.forEach(proc => applyLeveling(proc.chain, settings.incomingLeveling));
    outgoingProcs.forEach(proc => {
        applyLeveling(proc.chain, settings.outgoingLeveling);
        rampTo(proc.micGain.gain, settings.micGain);
    });
}

/** source -> [highpass -> compressor -> trim -> wet] + [dry] -> output */
function createChain(context, stream, output, presetName) {
    const source = context.createMediaStreamSource(stream);

    // High-pass: remove rumble/handling noise so the detector isn't fooled
    const hp = context.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 85;
    hp.Q.value = 0.7;

    const compressor = context.createDynamicsCompressor();
    const trim = context.createGain();
    const wet = context.createGain();
    const dry = context.createGain();

    source.connect(hp).connect(compressor).connect(trim).connect(wet).connect(output);
    source.connect(dry).connect(output);

    const chain = { source, hp, compressor, trim, wet, dry };
    applyLeveling(chain, presetName, true);
    return chain;
}

function getSharedContext() {
    if (sharedAudioContext && sharedAudioContext.state !== 'closed') return sharedAudioContext;
    sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = null;
    return sharedAudioContext;
}

function getMasterGain(context) {
    if (!masterGain) {
        masterGain = context.createGain();
        masterGain.gain.value = settings.volume;
        masterGain.connect(context.destination);
    }
    return masterGain;
}

/**
 * Wraps a local microphone MediaStreamTrack in a leveling graph.
 * Returns a NEW MediaStreamTrack carrying the processed audio.
 * The original track is NOT modified or stopped.
 */
export function normalizeOutgoingMicTrack(originalTrack) {
    if (!originalTrack || originalTrack.kind !== 'audio') return originalTrack;
    if (outgoingProcs.has(originalTrack)) return outgoingProcs.get(originalTrack).processedTrack;

    try {
        const context = getSharedContext();
        const dest = context.createMediaStreamDestination();
        const micGain = context.createGain();
        micGain.gain.value = settings.micGain;
        micGain.connect(dest);

        const chain = createChain(context, new MediaStream([originalTrack]), micGain, settings.outgoingLeveling);
        const processedTrack = dest.stream.getAudioTracks()[0];
        outgoingProcs.set(originalTrack, { chain, micGain, processedTrack });

        console.log("[AudioNorm] Outgoing mic graph active.");
        return processedTrack;
    } catch (err) {
        console.warn("[AudioNorm] Outgoing graph unavailable, publishing raw mic.", err);
        return originalTrack;
    }
}

/** Undo normalization for an outgoing track (e.g. when unpublishing/switching devices). */
export function teardownOutgoingNormalization(originalTrack) {
    const proc = outgoingProcs.get(originalTrack);
    if (!proc) return;
    try {
        proc.chain.source.disconnect();
        proc.micGain.disconnect();
        outgoingProcs.delete(originalTrack);
        console.log("[AudioNorm] Outgoing mic graph torn down.");
    } catch (e) { /* noop */ }
}

function findOutgoingByProcessed(processedTrack) {
    for (const [originalTrack, proc] of outgoingProcs) {
        if (proc.processedTrack === processedTrack) return originalTrack;
    }
    return null;
}

/** The raw mic track behind a published normalized track (or the track itself if not normalized). */
export function getOutgoingSourceTrack(publishedTrack) {
    return findOutgoingByProcessed(publishedTrack) || publishedTrack;
}

/**
 * Releases the graph behind a published normalized track and stops the raw
 * mic track feeding it (e.g. before republishing on a different device).
 */
export function releaseOutgoingForPublished(publishedTrack) {
    const originalTrack = findOutgoingByProcessed(publishedTrack);
    if (!originalTrack) return;
    teardownOutgoingNormalization(originalTrack);
    try { originalTrack.stop(); } catch (e) { /* noop */ }
}

/**
 * Attaches a remote microphone track to an <audio> element through the
 * leveling graph. Returns the element.
 */
export function attachNormalizedRemoteAudio(track, identity) {
    const element = track.attach();
    try {
        const context = getSharedContext();
        if (context.state === 'suspended') context.resume().catch(() => {});

        const stream = new MediaStream([track.mediaStreamTrack || track]);
        const peerGain = context.createGain();
        peerGain.gain.value = getPeerVolume(identity);
        peerGain.connect(getMasterGain(context));
        const chain = createChain(context, stream, peerGain, settings.incomingLeveling);

        // Feed the Web Audio graph instead of the raw element output
        element.muted = true;
        element.srcObject = stream;
        element.play().catch(() => {});

        incomingProcs.set(track.mediaStreamTrack || track, { chain, peerGain, element, identity });
        console.log("[AudioNorm] Incoming mic graph active.");
    } catch (err) {
        console.warn("[AudioNorm] Incoming graph unavailable, playing raw.", err);
        element.muted = false;
    }
    return element;
}

/** Tears down normalization for a remote track and removes its audio element. */
export function detachNormalizedRemoteAudio(track) {
    const key = track && (track.mediaStreamTrack || track);
    const proc = incomingProcs.get(key);
    if (!proc) {
        // Fall back to LiveKit's default detach
        track.detach().forEach(el => el.remove());
        return;
    }
    try {
        proc.chain.source.disconnect();
        proc.peerGain.disconnect();
        proc.element.remove();
    } catch (e) { /* noop */ }
    incomingProcs.delete(key);
}

/** Tears down all normalization graphs (on disconnect). */
export function teardownAllNormalization() {
    outgoingProcs.forEach((proc) => { try { proc.chain.source.disconnect(); proc.micGain.disconnect(); } catch (e) {} });
    outgoingProcs.clear();
    incomingProcs.forEach((proc) => {
        try { proc.chain.source.disconnect(); proc.peerGain.disconnect(); proc.element.remove(); } catch (e) {}
    });
    incomingProcs.clear();
    if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
        sharedAudioContext.close().catch(() => {});
    }
    sharedAudioContext = null;
    masterGain = null;
    console.log("[AudioNorm] All normalization graphs released.");
}
