// audio-normalizer.js
// Web Audio based loudness normalization for microphone audio.
// Outgoing: local mic track is routed through an AGC-style graph before publishing.
// Incoming: remote microphone tracks are routed through the same graph for playback.
// Screen share audio is never routed through this module and stays untouched.

let sharedAudioContext = null;
const outgoingProcs = new Map();  // original MediaStreamTrack -> { context, nodes, processedTrack }
const incomingProcs = new Map();  // remote MediaStreamTrack -> { context, source, element }

function createGraph(context, stream) {
    const source = context.createMediaStreamSource(stream);

    // High-pass: remove rumble/handling noise so the detector isn't fooled
    const hp = context.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 85;
    hp.Q.value = 0.7;

    // Dynamic range compression to level quiet/loud speakers
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -28;
    compressor.knee.value = 24;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.25;

    // Post-gain to restore a consistent loudness level
    const gain = context.createGain();
    gain.gain.value = 1.6;

    source.connect(hp).connect(compressor).connect(gain);
    return { source, hp, compressor, gain };
}

function getSharedContext(existing) {
    if (existing && existing.state !== 'closed') return existing;
    return new (window.AudioContext || window.webkitAudioContext)();
}

/**
 * Wraps a local microphone MediaStreamTrack in a normalization graph.
 * Returns a NEW MediaStreamTrack carrying the normalized audio.
 * The original track is NOT modified or stopped.
 */
export function normalizeOutgoingMicTrack(originalTrack) {
    if (!originalTrack || originalTrack.kind !== 'audio') return originalTrack;
    if (outgoingProcs.has(originalTrack)) return outgoingProcs.get(originalTrack).processedTrack;

    try {
        const context = getSharedContext(sharedAudioContext);
        sharedAudioContext = context;

        const stream = new MediaStream([originalTrack]);
        const { source, gain } = createGraph(context, stream);
        const dest = context.createMediaStreamDestination();
        gain.connect(dest);

        const processedTrack = dest.stream.getAudioTracks()[0];
        outgoingProcs.set(originalTrack, { context, source, processedTrack });

        console.log("[AudioNorm] Outgoing mic normalization active.");
        return processedTrack;
    } catch (err) {
        console.warn("[AudioNorm] Outgoing normalization unavailable, publishing raw mic.", err);
        return originalTrack;
    }
}

/** Undo normalization for an outgoing track (e.g. when unpublishing/switching devices). */
export function teardownOutgoingNormalization(originalTrack) {
    const proc = outgoingProcs.get(originalTrack);
    if (!proc) return;
    try {
        proc.source.disconnect();
        outgoingProcs.delete(originalTrack);
        console.log("[AudioNorm] Outgoing normalization torn down.");
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
 * normalization graph. Returns the element (playing normalized audio).
 */
export function attachNormalizedRemoteAudio(track) {
    const element = track.attach();
    try {
        const context = getSharedContext(sharedAudioContext);
        sharedAudioContext = context;
        if (context.state === 'suspended') context.resume().catch(() => {});

        const stream = new MediaStream([track.mediaStreamTrack || track]);
        const { source, gain } = createGraph(context, stream);
        gain.connect(context.destination);

        // Feed the Web Audio graph instead of the raw element output
        element.muted = true;
        element.srcObject = stream;
        element.play().catch(() => {});

        incomingProcs.set(track.mediaStreamTrack || track, { context, source, element });
        console.log("[AudioNorm] Incoming mic normalization active.");
    } catch (err) {
        console.warn("[AudioNorm] Incoming normalization unavailable, playing raw.", err);
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
        proc.source.disconnect();
        proc.element.remove();
    } catch (e) { /* noop */ }
    incomingProcs.delete(key);
}

/** Tears down all normalization graphs (on disconnect). */
export function teardownAllNormalization() {
    outgoingProcs.forEach((proc) => { try { proc.source.disconnect(); } catch (e) {} });
    outgoingProcs.clear();
    incomingProcs.forEach((proc) => {
        try { proc.source.disconnect(); proc.element.remove(); } catch (e) {}
    });
    incomingProcs.clear();
    if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
        sharedAudioContext.close().catch(() => {});
        sharedAudioContext = null;
    }
    console.log("[AudioNorm] All normalization graphs released.");
}
