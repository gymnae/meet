// === BACKGROUND EFFECTS: blur or replace what is behind you on camera ===
// Cheapest first:
// 1. Blur done by the platform (Chrome on Windows Studio Effects / ChromeOS reports a
//    controllable `backgroundBlur` capability on the camera track). Costs the page nothing.
// 2. Otherwise LiveKit's background processor: MediaPipe's selfie segmenter on the GPU, blur at
//    a quarter of the resolution, one WebGL composite. On top of that, segmentation runs only on
//    every 2nd frame and the mask is reused in between, and the cost per frame is watched: a
//    device over budget steps down to less frequent masks and a smaller camera picture.
//    Nothing is turned off by itself: that would show the background the person chose to hide.
// Everything is self-hosted (see server.js) and loaded only once an effect is picked.

import { showToast } from './ui.js';

const STORAGE_KEY = 'portal_background';
const PROCESSOR_MODULE = '/vendor/track-processors.mjs';
const WASM_BASE = '/vendor/tasks-vision/wasm';
// The landscape model reads a 256×144 picture, the square one 256×256.
const MODEL_LANDSCAPE = '/models/selfie_segmenter_landscape.tflite';
const MODEL_SQUARE = '/models/selfie_segmenter.tflite';
const BLUR_RADIUS = 10;

// Main-thread time per frame the effect may use, averaged over a window. Two windows in a row
// over budget step down one level.
const BUDGET_MS = 10;
const WINDOW_MS = 2000;
const LOAD_LEVELS = [
    { segmentEvery: 2 },
    { segmentEvery: 3 },
    { segmentEvery: 3, height: 540 },
    { segmentEvery: 4, height: 360 }
];

// Art is drawn at 320×180 and scaled up without smoothing, so pixels stay crisp.
const ART_W = 320;
const ART_H = 180;
const ART_SCALE = 4;

export const BACKGROUNDS = [
    { id: 'none', name: 'No effect', short: 'None' },
    { id: 'blur', name: 'Blur', short: 'Blur' },
    { id: 'city', name: 'Night city', draw: drawCity },
    { id: 'grid', name: 'Neon grid', draw: drawGrid },
    { id: 'wall', name: 'Quiet wall', draw: drawWall }
];

export function getBackgroundChoice() {
    try {
        const id = localStorage.getItem(STORAGE_KEY);
        return BACKGROUNDS.some(b => b.id === id) ? id : 'none';
    } catch (e) {
        return 'none';
    }
}

function storeBackgroundChoice(id) {
    try { localStorage.setItem(STORAGE_KEY, id); } catch (e) {}
}

// --- what this device can do ---------------------------------------------------------------

let processingSupported;
/** True when the browser has the APIs for our own processing and the device is not a weak one. */
export function canProcessVideo() {
    if (processingSupported !== undefined) return processingSupported;
    processingSupported = false;
    try {
        const streamApis = typeof MediaStreamTrackProcessor !== 'undefined' && typeof MediaStreamTrackGenerator !== 'undefined';
        const canvasFallback = typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
        const frameApis = typeof OffscreenCanvas !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof createImageBitmap !== 'undefined';
        // 0 / undefined: the browser does not say, so do not rule the device out
        const cores = navigator.hardwareConcurrency || 0;
        const memoryGb = navigator.deviceMemory;
        const strongEnough = (cores === 0 || cores >= 4) && (memoryGb === undefined || memoryGb >= 4);
        if (!frameApis || !(streamApis || canvasFallback) || !strongEnough) return false;

        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return false;
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        processingSupported = true;
    } catch (e) {}
    return processingSupported;
}

/** The camera itself, also while a processor replaces what is sent. */
function sourceTrack(track) {
    return track?.getProcessor?.()?.source ?? track?.mediaStreamTrack;
}

function hasNativeBlur(mediaTrack) {
    try {
        const values = mediaTrack?.getCapabilities?.().backgroundBlur;
        return Array.isArray(values) && values.includes(true) && values.includes(false);
    } catch (e) {
        return false;
    }
}

/** Turns the platform's blur on or off. False when there is none to control. */
async function setNativeBlur(mediaTrack, on) {
    if (!hasNativeBlur(mediaTrack) || mediaTrack.readyState === 'ended') return false;
    if (mediaTrack.getSettings().backgroundBlur === on) return true;
    // applyConstraints replaces all constraints, so keep the current resolution and device
    await mediaTrack.applyConstraints({ ...mediaTrack.getConstraints(), advanced: [{ backgroundBlur: on }] });
    return mediaTrack.getSettings().backgroundBlur === on;
}

/** The choices that work for this camera track (or any camera, when it is off). Empty when none do. */
export function availableBackgrounds(track) {
    const own = canProcessVideo();
    const native = hasNativeBlur(sourceTrack(track));
    if (!own && !native) {
        // A choice that no longer works here (no GPU now, other camera) keeps the camera off until
        // the person picks None, so that choice has to stay reachable.
        const chosen = getBackgroundChoice();
        return chosen === 'none' ? [] : BACKGROUNDS.filter(b => b.id === 'none' || b.id === chosen);
    }
    return BACKGROUNDS.filter(b => own || b.id === 'none' || b.id === 'blur');
}

// --- applying the choice -------------------------------------------------------------------

let queue = Promise.resolve();

/**
 * Applies the stored choice to a local camera track. Runs one at a time. Rejects when the effect
 * could not start, in which case the caller must not send the camera.
 */
export function applyBackground(track) {
    const run = queue.then(() => applyNow(track, getBackgroundChoice())).finally(() => resumePreview(track));
    queue = run.catch(() => {});
    return run;
}

// Swapping the stream under a <video> can leave it paused (seen with the canvas fallback that
// Firefox and Safari use), which freezes the self-view.
function resumePreview(track) {
    track?.attachedElements?.forEach(el => {
        if (el.paused) el.play().catch(() => {});
    });
}

async function applyNow(track, id) {
    if (!track || track.kind !== 'video' || sourceTrack(track)?.readyState === 'ended') return;
    const current = track.getProcessor();
    const needsProcessing = id !== 'none' && !(id === 'blur' && hasNativeBlur(sourceTrack(track)));
    if (needsProcessing && !current && !canProcessVideo()) throw new Error('Background effects are not supported on this device');

    if (id === 'none' || id === 'blur') {
        const native = await setNativeBlur(sourceTrack(track), id === 'blur').catch(() => false);
        if (native || id === 'none') {
            // Platform blur is on before our processor goes, so nothing unblurred is sent in between.
            if (current) await track.stopProcessor();
            return;
        }
    }

    const options = await effectOptions(id);
    if (current?.switchTo) {
        await current.switchTo(options);
        // A camera switch restarts the processor on a fresh camera track, at full size
        applyLoadLevel(current);
    } else {
        await track.setProcessor(await createProcessor(track, options));
    }
    // An image covers the background on its own; the platform need not blur it as well.
    if (id !== 'blur') await setNativeBlur(sourceTrack(track), false).catch(() => {});
}

async function effectOptions(id) {
    if (id === 'blur') return { mode: 'background-blur', blurRadius: BLUR_RADIUS };
    return { mode: 'virtual-background', imagePath: await backgroundImageUrl(id) };
}

let processorModule;
function loadProcessorModule() {
    processorModule ??= import(PROCESSOR_MODULE).catch(err => {
        processorModule = undefined;
        throw err;
    });
    return processorModule;
}

async function createProcessor(track, options) {
    const { BackgroundTransformer, BackgroundProcessorWrapper } = await loadProcessorModule();
    const Transformer = thriftyTransformer(BackgroundTransformer);
    const { width = 16, height = 9 } = sourceTrack(track).getSettings();
    const transformer = new Transformer({
        blurRadius: options.blurRadius,
        imagePath: options.imagePath,
        assetPaths: {
            tasksVisionFileSet: new URL(WASM_BASE, location.href).href,
            modelAssetPath: width >= height ? MODEL_LANDSCAPE : MODEL_SQUARE
        }
    });
    const processor = new BackgroundProcessorWrapper(transformer, 'background-processor');
    watchLoad(processor);
    return processor;
}

let Thrifty;
// LiveKit's transformer segments every frame and sends the very first frame unprocessed.
// This one segments every n-th frame (the mask is kept between runs) and processes every frame.
function thriftyTransformer(Base) {
    Thrifty ??= class extends Base {
        segmentEvery = LOAD_LEVELS[0].segmentEvery;
        frameCount = 0;
        loadLevel = 0;
        onCost = null;

        async transform(frame, controller) {
            const idle = this.isDisabled || this.options.backgroundDisabled ||
                (typeof this.options.blurRadius !== 'number' && typeof this.options.imagePath !== 'string');
            if (idle || !(frame instanceof VideoFrame) || !frame.codedWidth || !this.canvas) {
                return super.transform(frame, controller);
            }
            this.isFirstFrame = false;
            const start = performance.now();
            try {
                if (this.frameCount++ % this.segmentEvery === 0) {
                    this.imageSegmenter?.segmentForVideo(frame, start, (result) => {
                        this.updateMask(result.categoryMask);
                        result.close();
                    });
                }
                // Resizing a WebGL canvas clears it, so only do it when the size changes
                if (this.canvas.width !== frame.displayWidth) this.canvas.width = frame.displayWidth;
                if (this.canvas.height !== frame.displayHeight) this.canvas.height = frame.displayHeight;
                this.drawFrame(frame);
                controller.enqueue(new VideoFrame(this.canvas, { timestamp: frame.timestamp }));
                this.onCost?.(performance.now() - start);
            } catch (err) {
                console.error('[Background] Frame processing failed', err);
            } finally {
                frame.close();
            }
        }
    };
    return Thrifty;
}

function watchLoad(processor) {
    const transformer = processor.transformer;
    let total = 0;
    let frames = 0;
    let windowStart = performance.now();
    let windowsOver = 0;
    let warned = false;

    transformer.onCost = (ms) => {
        total += ms;
        frames++;
        const now = performance.now();
        if (now - windowStart < WINDOW_MS) return;
        const average = total / frames;
        total = 0;
        frames = 0;
        windowStart = now;
        windowsOver = average > BUDGET_MS ? windowsOver + 1 : 0;
        if (windowsOver < 2) return;
        windowsOver = 0;

        if (transformer.loadLevel < LOAD_LEVELS.length - 1) {
            transformer.loadLevel++;
            console.info(`[Background] ${average.toFixed(1)} ms per frame, stepping down to level ${transformer.loadLevel}`);
            applyLoadLevel(processor);
        } else if (!warned) {
            warned = true;
            showToast('Your device is working hard on the background effect. If the call stutters, pick None under Cam.', 'warn', 6000);
        }
    };
}

function applyLoadLevel(processor) {
    const transformer = processor.transformer;
    const level = LOAD_LEVELS[transformer.loadLevel];
    transformer.segmentEvery = level.segmentEvery;
    const camera = processor.source;
    if (!level.height || !camera || camera.readyState === 'ended') return;
    const width = Math.round(level.height * 16 / 9);
    camera.applyConstraints({
        ...camera.getConstraints(),
        width: { ideal: width, max: width },
        height: { ideal: level.height, max: level.height }
    }).catch(err => console.warn('[Background] Could not lower the camera resolution', err));
}

// --- picker in the camera menu -------------------------------------------------------------

/**
 * The "Background" section of the camera menu, or null when this device can do no effect.
 * getTrack returns the live camera track, or null while the camera is off.
 */
export function buildBackgroundPicker(getTrack) {
    const options = availableBackgrounds(getTrack());
    if (options.length === 0) return null;

    const section = document.createElement('div');
    section.className = 'bg-section';
    const heading = document.createElement('p');
    heading.className = 'bg-heading';
    heading.id = 'bgHeading';
    heading.textContent = 'Background';
    const grid = document.createElement('div');
    grid.className = 'bg-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-labelledby', 'bgHeading');
    section.append(heading, grid);

    const buttons = options.map(option => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bg-option';
        btn.dataset.background = option.id;
        btn.title = option.name;
        btn.setAttribute('aria-label', option.name);
        if (option.draw) {
            btn.style.backgroundImage = `url(${artFor(option).toDataURL()})`;
        } else {
            btn.textContent = option.short;
            btn.classList.add('bg-option--text');
        }
        btn.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            pickBackground(option, getTrack(), markSelected);
        };
        return btn;
    });
    grid.append(...buttons);

    function markSelected() {
        const chosen = getBackgroundChoice();
        buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.background === chosen)));
    }
    markSelected();
    return section;
}

let picking = false;
async function pickBackground(option, track, onChange) {
    if (picking || option.id === getBackgroundChoice()) return;
    picking = true;
    const previous = getBackgroundChoice();
    storeBackgroundChoice(option.id);
    onChange();
    if (!track) {
        picking = false;
        showToast(`${option.name} is used when you start your camera.`);
        return;
    }
    // The first effect loads the segmenter (about 10 MB, once); say so if it takes a moment
    const slow = setTimeout(() => showToast('Starting the background effect…', 'info', 8000), 400);
    try {
        await applyBackground(track);
        clearTimeout(slow);
        showToast(option.id === 'none' ? 'Background effect off.' : `Background: ${option.name}.`);
    } catch (err) {
        clearTimeout(slow);
        console.error('[Background] Effect failed to start', err);
        storeBackgroundChoice(previous);
        onChange();
        await applyBackground(track).catch(() => {});
        showToast("The background effect couldn't start in this browser.", 'error', 5000);
    } finally {
        picking = false;
    }
}

// --- pixel-art backgrounds -----------------------------------------------------------------

const artCache = new Map();
function artFor(option) {
    if (!artCache.has(option.id)) {
        const canvas = document.createElement('canvas');
        canvas.width = ART_W;
        canvas.height = ART_H;
        option.draw(canvas.getContext('2d'), seededRandom(option.id.length * 7919));
        artCache.set(option.id, canvas);
    }
    return artCache.get(option.id);
}

const imageUrls = new Map();
async function backgroundImageUrl(id) {
    if (imageUrls.has(id)) return imageUrls.get(id);
    const art = artFor(BACKGROUNDS.find(b => b.id === id));
    const canvas = document.createElement('canvas');
    canvas.width = ART_W * ART_SCALE;
    canvas.height = ART_H * ART_SCALE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(art, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const url = URL.createObjectURL(blob);
    imageUrls.set(id, url);
    return url;
}

function seededRandom(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function bands(ctx, colors, top, bottom) {
    const step = (bottom - top) / colors.length;
    colors.forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.fillRect(0, Math.round(top + i * step), ART_W, Math.ceil(step));
    });
}

function disc(ctx, cx, cy, r, colorAt) {
    for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
            if (x * x + y * y > r * r) continue;
            const color = colorAt(y);
            if (!color) continue;
            ctx.fillStyle = color;
            ctx.fillRect(cx + x, cy + y, 1, 1);
        }
    }
}

// Calm colours: a background should not pull the eye away from the face in front of it.
function drawCity(ctx, random) {
    const ground = ART_H - 10;
    bands(ctx, ['#0a0b10', '#0d0e1b', '#121324', '#1b1c3a', '#24204a', '#2e2150', '#3a2254'], 0, ground);
    for (let i = 0; i < 60; i++) {
        ctx.fillStyle = random() < 0.7 ? '#4a4870' : '#8e8bb5';
        ctx.fillRect(Math.floor(random() * ART_W), Math.floor(random() * ground * 0.55), 1, 1);
    }
    disc(ctx, 252, 34, 9, () => '#d8d5f0');
    disc(ctx, 256, 31, 7, () => '#0d0e1b');

    const skyline = (color, minH, maxH, minW, maxW, windows) => {
        for (let x = -4; x < ART_W;) {
            const w = minW + Math.floor(random() * (maxW - minW));
            const h = minH + Math.floor(random() * (maxH - minH));
            ctx.fillStyle = color;
            ctx.fillRect(x, ground - h, w, h);
            if (windows) {
                for (let wy = ground - h + 4; wy < ground - 3; wy += 5) {
                    for (let wx = x + 2; wx < x + w - 2; wx += 4) {
                        if (random() > 0.22) continue;
                        ctx.fillStyle = random() < 0.75 ? '#7a6a2a' : '#2a6a74';
                        ctx.fillRect(wx, wy, 2, 2);
                    }
                }
            }
            x += w + Math.floor(random() * 3);
        }
    };
    skyline('#1e1d3c', 50, 105, 12, 26, false);
    skyline('#101120', 28, 80, 16, 38, true);
    ctx.fillStyle = '#06070c';
    ctx.fillRect(0, ground, ART_W, ART_H - ground);
}

function drawGrid(ctx) {
    const horizon = 112;
    bands(ctx, ['#0a0b10', '#0f0f22', '#17163a', '#23184a', '#331a52', '#451c58'], 0, horizon);
    // Sun: yellow to magenta from the top down, cut by widening gaps in its lower half
    const r = 38;
    const sunColors = ['#c9b830', '#d39a3a', '#d27a46', '#c95a52', '#b8405c', '#a32d62'];
    disc(ctx, ART_W / 2, horizon - 12, r, (y) => {
        const fromTop = y + r;
        const cut = y + 16;
        if (cut > 0 && (cut % 8) < 1 + Math.floor(cut / 10)) return null;
        return sunColors[Math.min(sunColors.length - 1, Math.floor(fromTop / (2 * r + 1) * sunColors.length))];
    });
    ctx.fillStyle = '#0a0b10';
    ctx.fillRect(0, horizon, ART_W, ART_H - horizon);
    ctx.fillStyle = '#5a2a6a';
    ctx.fillRect(0, horizon, ART_W, 1);
    // Floor grid: rows closer together towards the horizon, columns meeting at the centre
    ctx.fillStyle = '#3a2a5e';
    for (let k = 1; ; k++) {
        const y = horizon + Math.round(k * k * 0.9);
        if (y >= ART_H) break;
        ctx.fillRect(0, y, ART_W, 1);
    }
    // Columns start a few rows down: right at the horizon they would merge into noise
    for (let y = horizon + 4; y < ART_H; y++) {
        const t = (y - horizon) / (ART_H - horizon);
        for (let col = -9; col <= 9; col++) {
            ctx.fillRect(Math.round(ART_W / 2 + col * 28 * t * 1.6), y, 1, 1);
        }
    }
}

function drawWall(ctx, random) {
    const floor = ART_H - 22;
    ctx.fillStyle = '#2a2b45';
    ctx.fillRect(0, 0, ART_W, floor);
    ctx.fillStyle = '#2e2f4b';
    for (let x = 6; x < ART_W; x += 16) ctx.fillRect(x, 0, 2, floor);
    ctx.fillStyle = '#3a3c66';
    ctx.fillRect(0, floor, ART_W, 2);
    ctx.fillStyle = '#1b1c3a';
    ctx.fillRect(0, floor + 2, ART_W, ART_H - floor - 2);

    // Shelf with books, right side
    const shelfY = 74;
    ctx.fillStyle = '#4a3a30';
    ctx.fillRect(224, shelfY, 80, 4);
    ctx.fillStyle = '#382c25';
    ctx.fillRect(228, shelfY + 4, 4, 6);
    ctx.fillRect(296, shelfY + 4, 4, 6);
    const bookColors = ['#5a3d6b', '#2f5f6b', '#6b5a2f', '#6b2f45', '#3d4a6b'];
    for (let x = 230; x < 280;) {
        const w = 4 + Math.floor(random() * 4);
        const h = 14 + Math.floor(random() * 9);
        ctx.fillStyle = bookColors[Math.floor(random() * bookColors.length)];
        ctx.fillRect(x, shelfY - h, w, h);
        x += w + 1;
    }
    disc(ctx, 290, shelfY - 6, 5, () => '#3f6b4a');
    ctx.fillStyle = '#6b4a3a';
    ctx.fillRect(286, shelfY - 4, 8, 4);

    // Plant in a pot, left side
    ctx.fillStyle = '#6b3f2f';
    ctx.fillRect(30, floor - 18, 22, 18);
    ctx.fillStyle = '#7d4a37';
    ctx.fillRect(28, floor - 20, 26, 3);
    const leaf = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
    [[40, 92, 2, 46], [33, 104, 8, 4], [43, 98, 10, 4], [30, 116, 10, 4], [44, 112, 12, 4], [36, 88, 6, 6], [27, 124, 9, 4], [46, 124, 10, 4]]
        .forEach(([x, y, w, h], i) => leaf(x, y, w, h, i === 0 ? '#2f5a3a' : (i % 2 ? '#3f7a4a' : '#356a40')));
}
