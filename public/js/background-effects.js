// === BACKGROUND EFFECTS: blur or replace what is behind you on camera ===
// Cheapest first:
// 1. Blur done by the platform (Chrome on Windows Studio Effects / ChromeOS reports a
//    controllable `backgroundBlur` capability on the camera track). Costs the page nothing.
// 2. Otherwise LiveKit's background processor: MediaPipe's selfie segmenter on the GPU, blur at
//    a quarter of the resolution, one WebGL composite. On top of that, segmentation runs only on
//    every 2nd frame and the mask is reused in between, and the cost per frame is watched: a
//    device over budget steps down to less frequent masks and a smaller camera picture.
//    Nothing is turned off by itself: that would show the background the person chose to hide.
//    The compositing is our own (background-compositor.js): soft, steady edges and moving backdrops.
// Everything is self-hosted (see server.js) and loaded only once an effect is picked.
// People can add their own pictures, animated pictures and short videos. They stay in this browser
// (IndexedDB), filed under the name they join with, and never go to the server; only the video
// they appear in does. While someone shares their screen, it can be their backdrop too ("Streamer"):
// they show small in a corner of it, and that one picture goes out in place of camera and screen.

import { showToast } from './ui.js';
import { isIOS } from './state.js';
import { createCompositor } from './background-compositor.js';

const STORAGE_KEY = 'portal_background';
const PROCESSOR_MODULE = '/vendor/track-processors.mjs';
const WASM_BASE = '/vendor/tasks-vision/wasm';
// The landscape model reads a 256×144 picture, the square one 256×256.
const MODEL_LANDSCAPE = '/models/selfie_segmenter_landscape.tflite';
const MODEL_SQUARE = '/models/selfie_segmenter.tflite';
// LiveKit blurs a quarter-size copy of the frame and divides the radius by 4 for it; its kernel
// stops at 16, so 60 (15 on the small copy) is about as strong as it gets, and still cheap.
const BLUR_RADIUS = 60;

// Main-thread time per frame the effect may use, averaged over a window. Two windows in a row
// over budget, or one clearly over (twice the budget, or under half the expected frame rate),
// step down one level. The frame rate catches work done outside the transform, such as the
// canvas copy and capture of the fallback path.
const BUDGET_MS = 10;
const WINDOW_MS = 2000;
const MIN_FPS_SHARE = 0.75;
const LOAD_LEVELS = [
    { segmentEvery: 2 },
    { segmentEvery: 3 },
    { segmentEvery: 3, height: 540 },
    { segmentEvery: 4, height: 360 }
];
// Phones, and browsers without MediaStreamTrackProcessor (Safari, Firefox), copy every frame
// through a canvas on the main thread. They start at the lowest level and at most 24 fps:
// on an iPhone the full-size path froze the page.
const CONSTRAINED_FPS = 24;

// Pixel art is drawn at 320×180 and scaled up without smoothing, so pixels stay crisp.
// Prism art is drawn smooth at full size.
const PIXEL_CANVAS = { width: 320, height: 180, scale: 4, smooth: false };
const PRISM_CANVAS = { width: 1280, height: 720, scale: 1, smooth: true };

export const BACKGROUNDS = [
    { id: 'none', name: 'No effect', short: 'None' },
    { id: 'blur', name: 'Blur', short: 'Blur' },
    { id: 'screen', name: 'Streamer: while you share, your screen with you in the corner, sent as one picture; blur otherwise', short: 'Streamer', screen: true },
    { id: 'city', name: 'Night city', theme: 'pixel', canvas: PIXEL_CANVAS, draw: drawCity },
    { id: 'grid', name: 'Neon grid', theme: 'pixel', canvas: PIXEL_CANVAS, draw: drawGrid },
    { id: 'wall', name: 'Quiet wall', theme: 'pixel', canvas: PIXEL_CANVAS, draw: drawWall },
    { id: 'prism-light', name: 'Prism light', theme: 'prism', canvas: PRISM_CANVAS, draw: drawPrismLight },
    { id: 'prism-dusk', name: 'Dusk', theme: 'prism', canvas: PRISM_CANVAS, draw: drawPrismDusk },
    { id: 'prism-studio', name: 'Studio', theme: 'prism', canvas: PRISM_CANVAS, draw: drawPrismStudio }
];

// Own pictures: ids are "custom:<record id>"
const CUSTOM_PREFIX = 'custom:';
const MAX_CUSTOM = 8;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_EDGE = 1920;
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
// A shared screen is large and mostly still: fewer of its frames are copied to the GPU
const SCREEN_BACKDROP_FPS = 15;

export function getBackgroundChoice() {
    try {
        const id = localStorage.getItem(STORAGE_KEY);
        return BACKGROUNDS.some(b => b.id === id) || id?.startsWith(CUSTOM_PREFIX) ? id : 'none';
    } catch (e) {
        return 'none';
    }
}

function currentTheme() {
    return document.documentElement.dataset.theme === 'prism' ? 'prism' : 'pixel';
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

function isConstrainedDevice() {
    const fallbackPath = typeof MediaStreamTrackProcessor === 'undefined' || typeof MediaStreamTrackGenerator === 'undefined';
    const phone = isIOS() || /Android|Mobi/i.test(navigator.userAgent);
    return fallbackPath || phone;
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
        if (chosen === 'none') return [];
        return [BACKGROUNDS[0], BACKGROUNDS.find(b => b.id === chosen) || { id: chosen, name: 'Your picture', custom: true }];
    }
    // The set that matches the theme, plus a choice made under the other one so it stays visible
    const chosen = getBackgroundChoice();
    return BACKGROUNDS.filter(b => {
        if (b.screen) return own && canShareScreen();
        return !b.theme || (own && (b.theme === currentTheme() || b.id === chosen));
    });
}

function canShareScreen() {
    return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

// --- applying the choice -------------------------------------------------------------------

let queue = Promise.resolve();

/**
 * Applies the stored choice to a local camera track. Runs one at a time. Rejects when the effect
 * could not start, in which case the caller must not send the camera.
 */
export function applyBackground(track) {
    const run = queue.then(() => applyNow(track, getBackgroundChoice())).finally(() => {
        resumePreview(track);
        markScreenBackdrop(track);
    });
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
    // An own picture that is gone (removed, or chosen under another name) falls back to blur, not to
    // showing the background.
    if (id.startsWith(CUSTOM_PREFIX) && !(await customRecord(id))) id = 'blur';
    // The screen is the backdrop only while it is shared
    if (id === 'screen' && !liveScreen()) id = 'blur';
    const current = track.getProcessor();
    const needsProcessing = id !== 'none' && !(id === 'blur' && hasNativeBlur(sourceTrack(track)));
    if (needsProcessing && !current && !canProcessVideo()) throw new Error('Background effects are not supported on this device');

    // The platform already blurs (iOS Portrait mode in Control Center reports itself this way):
    // nothing for us to do, and nothing to slow the call down.
    if (id === 'blur' && sourceTrack(track)?.getSettings?.().backgroundBlur === true) {
        if (current) await stopProcessing(track);
        return;
    }

    if (id === 'none' || id === 'blur') {
        const native = await setNativeBlur(sourceTrack(track), id === 'blur').catch(() => false);
        if (native || id === 'none') {
            // Platform blur is on before our processor goes, so nothing unblurred is sent in between.
            if (current) await stopProcessing(track);
            return;
        }
    }

    const options = await effectOptions(id);
    if (current?.switchTo) {
        await current.switchTo(options);
        // A camera switch restarts the processor on a fresh camera track, at full size
        await applyLoadLevel(current.transformer, current.source);
    } else {
        await track.setProcessor(await createProcessor(track, options));
    }
    // The backdrop that was showing before stops playing
    releaseBackdrops(options.imagePath);
    // An image covers the background on its own; the platform need not blur it as well.
    if (id !== 'blur') await setNativeBlur(sourceTrack(track), false).catch(() => {});
}

async function stopProcessing(track) {
    const camera = sourceTrack(track);
    await track.stopProcessor();
    releaseBackdrops(null);
    await restoreCameraSize(camera);
}

async function effectOptions(id) {
    if (id === 'blur') return { mode: 'background-blur', blurRadius: BLUR_RADIUS };
    let imagePath;
    if (id === 'screen') {
        const screen = liveScreen();
        imagePath = backdropPath(`screen:${screen.id}`, () => new VideoBackdrop(new MediaStream([screen]), { fit: 'contain', maxFps: SCREEN_BACKDROP_FPS, corner: true }));
    } else if (id.startsWith(CUSTOM_PREFIX)) {
        const record = await customRecord(id);
        if (record.kind === 'video') {
            imagePath = backdropPath(id, () => new VideoBackdrop(urlForRecord(record)));
        } else if (record.kind === 'animated' && typeof ImageDecoder !== 'undefined') {
            imagePath = backdropPath(id, () => new AnimatedBackdrop(record.blob));
        } else {
            // Without ImageDecoder an animated picture shows its first frame
            imagePath = urlForRecord(record);
        }
    } else {
        imagePath = await backgroundImageUrl(id);
    }
    return { mode: 'virtual-background', imagePath };
}

// --- backdrops that move -------------------------------------------------------------------
// Handed to the processor as an imagePath of the form "backdrop:<key>", which the transformer
// looks up here instead of loading it as a picture. The compositor reads `image` on every frame
// and copies it to the GPU only when `version` changed.

const liveBackdrops = new Map();

function backdropPath(key, make) {
    const path = `backdrop:${key}`;
    if (!liveBackdrops.has(path)) liveBackdrops.set(path, make());
    return path;
}

/** Stops every moving backdrop except the one at keepPath. */
function releaseBackdrops(keepPath) {
    for (const [path, backdrop] of liveBackdrops) {
        if (path === keepPath) continue;
        backdrop.stop();
        liveBackdrops.delete(path);
    }
}

// A looping video file, or the shared screen (a MediaStream)
class VideoBackdrop {
    constructor(src, { fit = 'cover', maxFps = 0, corner = false } = {}) {
        this.fit = fit;
        // The person small in the bottom-right corner, as over a game
        this.corner = corner;
        this.minInterval = maxFps ? 1000 / maxFps : 0;
        this.lastTime = -1;
        this.lastTake = 0;
        this.lastPlayAttempt = 0;
        this.version = 0;
        const video = document.createElement('video');
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        if (src instanceof MediaStream) video.srcObject = src;
        else video.src = src;
        this.video = video;
        video.play().catch(() => {});
    }

    get width() { return this.video?.videoWidth || 0; }
    get height() { return this.video?.videoHeight || 0; }

    get image() {
        const video = this.video;
        if (!video) return null;
        const now = performance.now();
        // Browsers may pause a video nobody sees; start it again, at most once a second
        if (video.paused && now - this.lastPlayAttempt > 1000) {
            this.lastPlayAttempt = now;
            video.play().catch(() => {});
        }
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
        if (video.currentTime !== this.lastTime && now - this.lastTake >= this.minInterval) {
            this.lastTime = video.currentTime;
            this.lastTake = now;
            this.version++;
        }
        return video;
    }

    stop() {
        const video = this.video;
        if (!video) return;
        this.video = null;
        video.pause();
        // The screen's track belongs to the screen share; only this element lets go of it
        video.srcObject = null;
        video.removeAttribute('src');
        video.load();
    }
}

// An animated GIF, WebP or PNG, decoded frame by frame with WebCodecs' ImageDecoder
class AnimatedBackdrop {
    constructor(blob) {
        this.fit = 'cover';
        this.version = 0;
        this.frame = null;
        this.stopped = false;
        this.run(blob).catch(err => console.warn('[Background] Animated picture stopped', err));
    }

    get image() { return this.frame; }
    get width() { return this.frame?.displayWidth || 0; }
    get height() { return this.frame?.displayHeight || 0; }

    async run(blob) {
        this.decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type });
        await this.decoder.tracks.ready;
        await this.decoder.completed;
        const count = this.decoder.tracks.selectedTrack?.frameCount || 1;
        for (let i = 0; !this.stopped; i = (i + 1) % count) {
            const { image } = await this.decoder.decode({ frameIndex: i });
            if (this.stopped) {
                image.close();
                break;
            }
            this.frame?.close();
            this.frame = image;
            this.version++;
            if (count === 1) break;
            // Like browsers do, very short frame times (often 0 in GIFs) play at 10 per second
            const ms = (image.duration || 0) / 1000;
            await new Promise(resolve => setTimeout(resolve, ms < 20 ? 100 : ms));
        }
    }

    stop() {
        this.stopped = true;
        this.frame?.close();
        this.frame = null;
        try { this.decoder?.close(); } catch (e) {}
    }
}

// --- the shared screen as backdrop ---------------------------------------------------------

let screenTrack = null;

function liveScreen() {
    return screenTrack?.readyState === 'live' ? screenTrack : null;
}

/**
 * Tells the effects which screen this person shares (a MediaStreamTrack), or null when they stop.
 * With "Your screen" picked, the camera track's backdrop follows.
 */
export function setSharedScreen(track, cameraTrack) {
    screenTrack = track || null;
    if (getBackgroundChoice() === 'screen' && cameraTrack) {
        applyBackground(cameraTrack).catch(err => console.error('[Background] Switching the screen backdrop failed', err));
    }
}

/**
 * The camera's processed track while it shows the shared screen with the person in the corner
 * ("Streamer"), or null. That track is what goes out in place of camera and screen.
 */
export function streamerOutput(track) {
    const processor = track?.getProcessor?.();
    const shown = !!liveScreen() && processor?.transformer?.options?.imagePath?.startsWith('backdrop:screen:');
    return shown && processor.processedTrack?.readyState === 'live' ? processor.processedTrack : null;
}

let streamerListener = null;
/** Called after every change of effect, to send the Streamer picture or stop sending it. */
export function onStreamerChange(listener) {
    streamerListener = listener;
}

function markScreenBackdrop(track) {
    // A mirrored self-view would show the screen back to front and the corner on the left
    document.getElementById('tile_local_camera')?.classList.toggle('screen-backdrop', !!streamerOutput(track));
    streamerListener?.();
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
    const constrained = isConstrainedDevice();
    transformer.loadLevel = constrained ? LOAD_LEVELS.length - 1 : 0;
    // Shrink the camera before the processor sizes its canvases from it
    await applyLoadLevel(transformer, sourceTrack(track));
    const maxFps = constrained ? CONSTRAINED_FPS : 30;
    const processor = new BackgroundProcessorWrapper(transformer, 'background-processor', { maxFps });
    watchLoad(processor, maxFps);
    return processor;
}

let Thrifty;
// LiveKit's transformer segments every frame and sends the very first frame unprocessed.
// This one segments every n-th frame (the mask is kept between runs) and processes every frame.
// It composites with our own pipeline, from MediaPipe's soft confidence mask rather than the
// thresholded category mask, and also plays backdrops that move.
function thriftyTransformer(Base) {
    Thrifty ??= class extends Base {
        segmentEvery = LOAD_LEVELS[0].segmentEvery;
        frameCount = 0;
        loadLevel = 0;
        onCost = null;

        async init(opts) {
            await super.init(opts);
            await this.useOwnCompositor();
        }

        async restart(opts) {
            await super.restart(opts);
            await this.useOwnCompositor();
        }

        // LiveKit's init set up its own pipeline and gave it the options; swap it and give them again
        async useOwnCompositor() {
            if (!this.canvas || this.gl?.setBackgroundSource) return;
            this.gl?.cleanup();
            this.gl = createCompositor(this.canvas);
            if (!this.gl) throw new Error('WebGL2 is not available for the background effect');
            // The confidence mask instead of the category mask: same model run, one pass less
            await this.imageSegmenter?.setOptions({ outputCategoryMask: false, outputConfidenceMasks: true });
            this.gl.setBlurRadius(typeof this.options.blurRadius === 'number' ? this.options.blurRadius : null);
            if (typeof this.options.imagePath === 'string') {
                await this.loadAndSetBackground(this.options.imagePath)
                    .catch(err => console.error('[Background] Could not load the backdrop', err));
            }
            this.gl.setBackgroundDisabled(this.options.backgroundDisabled ?? false);
        }

        async loadAndSetBackground(path) {
            const live = liveBackdrops.get(path);
            if (!live) return super.loadAndSetBackground(path);
            // LiveKit's own pipeline (only there during init) cannot play it; ours gets it next
            this.gl?.setBackgroundSource?.(live);
        }

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
                        const mask = result.confidenceMasks?.[0];
                        if (mask) this.gl?.updateMask(mask.getAsWebGLTexture(), mask.width, mask.height);
                        result.close();
                    });
                }
                // Resizing a WebGL canvas clears it, so only do it when the size changes
                const [width, height] = this.gl?.outputSize?.(frame.displayWidth, frame.displayHeight) ?? [frame.displayWidth, frame.displayHeight];
                if (this.canvas.width !== width) this.canvas.width = width;
                if (this.canvas.height !== height) this.canvas.height = height;
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

function watchLoad(processor, maxFps) {
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
        const fps = frames * 1000 / (now - windowStart);
        const cameraFps = processor.source?.getSettings().frameRate || maxFps;
        const expectedFps = Math.min(maxFps, cameraFps);
        total = 0;
        frames = 0;
        windowStart = now;
        const slow = fps < expectedFps * MIN_FPS_SHARE;
        const badly = average > 2 * BUDGET_MS || fps < expectedFps * 0.5;
        windowsOver = average > BUDGET_MS || slow ? windowsOver + 1 : 0;
        if (windowsOver < 2 && !badly) return;
        windowsOver = 0;

        if (transformer.loadLevel < LOAD_LEVELS.length - 1) {
            transformer.loadLevel++;
            console.info(`[Background] ${average.toFixed(1)} ms per frame at ${fps.toFixed(0)} fps, stepping down to level ${transformer.loadLevel}`);
            applyLoadLevel(transformer, processor.source);
        } else if (!warned) {
            warned = true;
            showToast('Your device is working hard on the background effect. If the call stutters, pick None under Cam.', 'warn', 6000);
        }
    };
}

// Camera constraints from before the effect lowered the resolution, to go back to without it
const fullSizeConstraints = new WeakMap();

async function restoreCameraSize(camera) {
    const original = fullSizeConstraints.get(camera);
    if (!original || camera.readyState === 'ended') return;
    fullSizeConstraints.delete(camera);
    await camera.applyConstraints(original).catch(err => console.warn('[Background] Could not restore the camera resolution', err));
}

async function applyLoadLevel(transformer, camera) {
    const level = LOAD_LEVELS[transformer.loadLevel];
    transformer.segmentEvery = level.segmentEvery;
    if (!level.height || !camera || camera.readyState === 'ended') return;
    if (!fullSizeConstraints.has(camera)) fullSizeConstraints.set(camera, camera.getConstraints());
    // Long edge × short edge, matched to how the camera delivers (phones may deliver portrait)
    const longEdge = Math.round(level.height * 16 / 9);
    const { width = 16, height = 9 } = camera.getSettings();
    const [w, h] = width >= height ? [longEdge, level.height] : [level.height, longEdge];
    await camera.applyConstraints({
        ...camera.getConstraints(),
        width: { ideal: w, max: w },
        height: { ideal: h, max: h }
    }).catch(err => console.warn('[Background] Could not lower the camera resolution', err));
}

// --- picker in the camera menu -------------------------------------------------------------

/**
 * The "Background" section of the camera menu, or null when this device can do no effect.
 * getTrack returns the live camera track, or null while the camera is off. startScreenShare starts
 * sharing the screen, for when "Your screen" is picked while nothing is shared.
 */
export function buildBackgroundPicker(getTrack, { startScreenShare } = {}) {
    const builtIn = availableBackgrounds(getTrack());
    if (builtIn.length === 0) return null;
    const canAdd = canProcessVideo() && customStoreAvailable();
    let custom = [];

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
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = ['image/*', ...VIDEO_TYPES].join(',');
    fileInput.hidden = true;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'cam-item bg-remove';
    removeBtn.textContent = 'Remove this background';
    section.append(heading, grid, removeBtn, fileInput);
    if (isIOS()) {
        const hint = document.createElement('p');
        hint.className = 'bg-hint';
        hint.textContent = 'On iPhone and iPad, Portrait under Video Effects in Control Center blurs without slowing the call.';
        section.append(hint);
    }

    function optionButton(option) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bg-option';
        btn.dataset.background = option.id;
        btn.title = option.name;
        btn.setAttribute('aria-label', option.name);
        if (option.draw) {
            btn.style.backgroundImage = `url(${thumbnailFor(option)})`;
            if (option.canvas.smooth) btn.classList.add('bg-option--smooth');
        } else if (option.url) {
            btn.style.backgroundImage = `url(${option.url})`;
            btn.classList.add('bg-option--smooth');
        } else {
            btn.textContent = option.short;
            btn.classList.add('bg-option--text');
        }
        btn.onclick = async (e) => {
            e.preventDefault(); e.stopPropagation();
            await pickBackground(option, getTrack(), render);
            if (option.screen && getBackgroundChoice() === 'screen' && !liveScreen()) startScreenShare?.();
        };
        return btn;
    }

    function render() {
        const chosen = getBackgroundChoice();
        const options = [...builtIn.filter(b => !b.custom), ...custom];
        // A chosen picture that is not listed (other name, removed) still shows, so it can be left
        if (chosen.startsWith(CUSTOM_PREFIX) && !options.some(o => o.id === chosen)) {
            options.push({ id: chosen, name: 'Your background, not available here', short: 'Gone' });
        }
        const buttons = options.map(optionButton);
        if (canAdd && custom.length < MAX_CUSTOM) {
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'bg-option bg-option--text bg-option--add';
            addBtn.textContent = 'Add';
            addBtn.title = 'Add your own picture, animated picture or short video';
            addBtn.setAttribute('aria-label', addBtn.title);
            addBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fileInput.click(); };
            buttons.push(addBtn);
        }
        grid.replaceChildren(...buttons);
        buttons.forEach(b => {
            if (b.dataset.background) b.setAttribute('aria-pressed', String(b.dataset.background === chosen));
        });
        removeBtn.hidden = !custom.some(o => o.id === chosen);
    }

    fileInput.onchange = async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        try {
            const option = await addCustomBackground(file);
            custom = await listCustomBackgrounds();
            render();
            await pickBackground(option, getTrack(), render);
        } catch (err) {
            console.error('[Background] Adding a background failed', err);
            showToast(err?.userMessage || "That file couldn't be added.", 'error', 5000);
        }
    };

    removeBtn.onclick = async (e) => {
        e.preventDefault(); e.stopPropagation();
        const chosen = getBackgroundChoice();
        try {
            await removeCustomBackground(chosen);
        } catch (err) {
            console.error('[Background] Removing a background failed', err);
            showToast("That background couldn't be removed.", 'error', 5000);
            return;
        }
        custom = await listCustomBackgrounds().catch(() => []);
        // The one in use is gone; blur keeps the background hidden until another is picked
        await pickBackground(BACKGROUNDS.find(b => b.id === 'blur'), getTrack(), render);
        showToast('Removed. Using blur until you pick another background.');
    };

    render();
    if (customStoreAvailable()) {
        listCustomBackgrounds().then(list => { custom = list; render(); }).catch(err => console.warn('[Background] Could not read your pictures', err));
    }
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

// --- own pictures, per name, in this browser -----------------------------------------------

const DB_NAME = 'portal-backgrounds';
const DB_STORE = 'pictures';

function customStoreAvailable() {
    try { return typeof indexedDB !== 'undefined' && !!currentOwner(); } catch (e) { return false; }
}

// Pictures belong to the name the person joins with (saved by the join form)
function currentOwner() {
    try { return (localStorage.getItem('portal_username') || '').trim().toLowerCase(); } catch (e) { return ''; }
}

let dbPromise;
function openDb() {
    dbPromise ??= new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const store = req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
            store.createIndex('owner', 'owner');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('Background picture storage is blocked'));
    }).catch(err => {
        dbPromise = undefined;
        throw err;
    });
    return dbPromise;
}

async function dbRequest(mode, makeRequest) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode);
        const req = makeRequest(tx.objectStore(DB_STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

// Records: { id, owner, blob, created, kind, poster }. kind is 'picture' (a JPEG, also when
// missing: records from before videos), 'animated' (the file as uploaded) or 'video' (likewise);
// poster is a small still for the menu tile, kept for animated pictures and videos.
const customUrls = new Map();
function objectUrl(key, blob) {
    if (!customUrls.has(key)) customUrls.set(key, URL.createObjectURL(blob));
    return customUrls.get(key);
}
function urlForRecord(record) {
    return objectUrl(record.id, record.blob);
}
function thumbnailUrlForRecord(record) {
    return record.poster ? objectUrl(`${record.id}:poster`, record.poster) : urlForRecord(record);
}

const KIND_NAMES = { picture: 'Your picture', animated: 'Your animation', video: 'Your video' };

/** The current name's pictures as picker options, oldest first. */
async function listCustomBackgrounds() {
    const owner = currentOwner();
    if (!owner) return [];
    const records = await dbRequest('readonly', store => store.index('owner').getAll(owner));
    return records
        .sort((a, b) => a.created - b.created)
        .map((record, i) => customOption(record, i + 1));
}

function customOption(record, number) {
    return {
        id: CUSTOM_PREFIX + record.id,
        name: `${KIND_NAMES[record.kind] || KIND_NAMES.picture} ${number}`,
        url: thumbnailUrlForRecord(record),
        custom: true
    };
}

/** An own picture or video, or null when it is gone or belongs to another name. */
async function customRecord(id) {
    try {
        const record = await dbRequest('readonly', store => store.get(id.slice(CUSTOM_PREFIX.length)));
        return record && record.owner === currentOwner() ? record : null;
    } catch (e) {
        return null;
    }
}

function userError(message) {
    const err = new Error(message);
    err.userMessage = message;
    return err;
}

/** A still of an image or video, at most maxEdge wide or tall, as JPEG. */
async function stillOf(source, width, height, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

/** True for a GIF, WebP, PNG or AVIF with more than one frame (as far as this browser can tell). */
async function isAnimated(file) {
    if (typeof ImageDecoder === 'undefined' || !(await ImageDecoder.isTypeSupported(file.type).catch(() => false))) return false;
    const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type });
    try {
        await decoder.tracks.ready;
        await decoder.completed;
        const track = decoder.tracks.selectedTrack;
        return !!track?.animated && track.frameCount > 1;
    } catch (e) {
        return false;
    } finally {
        decoder.close();
    }
}

/** Checks a video plays here and takes a still from it for the menu tile. */
function videoPoster(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        const finish = (fn) => {
            clearTimeout(timeout);
            video.onloadeddata = video.onseeked = video.onerror = null;
            video.removeAttribute('src');
            video.load();
            URL.revokeObjectURL(url);
            fn();
        };
        const fail = () => finish(() => reject(userError("That video doesn't play in this browser. MP4 (H.264) works almost everywhere.")));
        const timeout = setTimeout(fail, 15000);
        video.onerror = fail;
        // The very first frame is often black; a moment in is a better picture of it
        video.onloadeddata = () => {
            const at = Math.min(0.5, (video.duration || 0) / 2);
            if (at > 0) video.currentTime = at;
            else video.onseeked();
        };
        video.onseeked = async () => {
            if (!video.videoWidth) return fail();
            const poster = await stillOf(video, video.videoWidth, video.videoHeight, 320);
            finish(() => resolve(poster));
        };
        video.src = url;
    });
}

async function addCustomBackground(file) {
    const owner = currentOwner();
    if (!owner) throw userError('Join with a name to add your own pictures.');
    if (file.size > MAX_UPLOAD_BYTES) throw userError('That file is too large. Pick one under 25 MB.');
    const existing = await listCustomBackgrounds();
    if (existing.length >= MAX_CUSTOM) throw userError(`You can keep up to ${MAX_CUSTOM} backgrounds. Remove one first.`);

    let blob;
    let poster;
    let kind = 'picture';
    if (file.type.startsWith('video/')) {
        if (!VIDEO_TYPES.includes(file.type)) throw userError('Pick an MP4, WebM or MOV video.');
        // Kept as uploaded: re-encoding in the browser would cost far more than it saves
        poster = await videoPoster(file);
        blob = file;
        kind = 'video';
    } else {
        let bitmap;
        try {
            bitmap = await createImageBitmap(file);
        } catch (e) {
            throw userError("That file isn't a picture this browser can open.");
        }
        try {
            if (await isAnimated(file).catch(() => false)) {
                // Kept as uploaded so it keeps moving; the tile gets its first frame
                poster = await stillOf(bitmap, bitmap.width, bitmap.height, 320);
                blob = file;
                kind = 'animated';
            } else {
                // Stored at most 1920 px wide or tall: plenty for a background, small enough to keep many
                blob = await stillOf(bitmap, bitmap.width, bitmap.height, MAX_UPLOAD_EDGE);
            }
        } finally {
            bitmap.close?.();
        }
    }
    if (!blob) throw userError("That picture couldn't be added.");

    const record = {
        id: (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
        owner,
        blob,
        created: Date.now(),
        kind,
        ...(poster ? { poster } : {})
    };
    try {
        await dbRequest('readwrite', store => store.add(record));
    } catch (err) {
        throw userError(err?.name === 'QuotaExceededError'
            ? 'This browser has no room left for more pictures. Remove one first.'
            : "That picture couldn't be saved in this browser.");
    }
    return customOption(record, existing.length + 1);
}

async function removeCustomBackground(id) {
    const key = id.slice(CUSTOM_PREFIX.length);
    const record = await dbRequest('readonly', store => store.get(key));
    if (!record || record.owner !== currentOwner()) return;
    await dbRequest('readwrite', store => store.delete(key));
    for (const urlKey of [key, `${key}:poster`]) {
        const url = customUrls.get(urlKey);
        if (!url) continue;
        URL.revokeObjectURL(url);
        customUrls.delete(urlKey);
    }
}

// --- pixel-art backgrounds -----------------------------------------------------------------

const artCache = new Map();
function artFor(option) {
    if (!artCache.has(option.id)) {
        const canvas = document.createElement('canvas');
        canvas.width = option.canvas.width;
        canvas.height = option.canvas.height;
        option.draw(canvas.getContext('2d'), seededRandom(option.id.length * 7919), canvas.width, canvas.height);
        artCache.set(option.id, canvas);
    }
    return artCache.get(option.id);
}

// Menu tiles show a 160×90 copy, not the full-size art
const thumbnails = new Map();
function thumbnailFor(option) {
    if (!thumbnails.has(option.id)) {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = option.canvas.smooth;
        ctx.drawImage(artFor(option), 0, 0, canvas.width, canvas.height);
        thumbnails.set(option.id, canvas.toDataURL());
    }
    return thumbnails.get(option.id);
}

const imageUrls = new Map();
async function backgroundImageUrl(id) {
    if (imageUrls.has(id)) return imageUrls.get(id);
    const option = BACKGROUNDS.find(b => b.id === id);
    const art = artFor(option);
    const canvas = document.createElement('canvas');
    canvas.width = art.width * option.canvas.scale;
    canvas.height = art.height * option.canvas.scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = option.canvas.smooth;
    ctx.drawImage(art, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const url = URL.createObjectURL(blob);
    imageUrls.set(id, url);
    return url;
}

const ART_W = PIXEL_CANVAS.width;
const ART_H = PIXEL_CANVAS.height;

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

// --- prism backgrounds ---------------------------------------------------------------------
// Smooth, dark and low in contrast like the Prism theme itself: soft light, no texture (grain
// would also cost bitrate in every frame sent).

// The identity spectrum (OKLCH .82 / .11) in sRGB, for canvases that may not parse oklch()
const PRISM_SPECTRUM = ['#f2a7b4', '#e8b98f', '#c3cc8e', '#8fd3c4', '#9cc4f0', '#c4b1ee', '#eba9d2'];

function softGlow(ctx, x, y, radius, color) {
    const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
    glow.addColorStop(0, color);
    glow.addColorStop(1, 'rgb(0 0 0 / 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function vignette(ctx, w, h, strength) {
    const v = ctx.createRadialGradient(w / 2, h * 0.45, h * 0.35, w / 2, h * 0.45, w * 0.75);
    v.addColorStop(0, 'rgb(0 0 0 / 0)');
    v.addColorStop(1, `rgb(0 0 0 / ${strength})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
}

// The join screen's motif: white light entering from the left, a faint spectrum leaving right
function drawPrismLight(ctx, random, w, h) {
    ctx.fillStyle = '#111219';
    ctx.fillRect(0, 0, w, h);
    softGlow(ctx, w * 0.5, -h * 0.15, h * 1.1, 'rgb(35 37 56 / 1)');

    const px = w * 0.3;
    const py = h * 0.58;
    const beam = ctx.createLinearGradient(0, 0, px, 0);
    beam.addColorStop(0, 'rgb(255 255 255 / 0)');
    beam.addColorStop(1, 'rgb(255 255 255 / .45)');
    ctx.strokeStyle = beam;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, py + px * Math.tan(7 * Math.PI / 180));
    ctx.lineTo(px, py);
    ctx.stroke();
    softGlow(ctx, px, py, h * 0.18, 'rgb(255 255 255 / .08)');

    // Fan drawn on its own layer, then faded out to the right
    const fan = document.createElement('canvas');
    fan.width = w;
    fan.height = h;
    const f = fan.getContext('2d');
    const bands = f.createLinearGradient(0, h * 0.05, 0, h * 0.95);
    PRISM_SPECTRUM.forEach((c, i) => bands.addColorStop(i / (PRISM_SPECTRUM.length - 1), c));
    f.fillStyle = bands;
    f.beginPath();
    f.moveTo(px, py - 3);
    f.lineTo(w, h * 0.05);
    f.lineTo(w, h * 0.95);
    f.lineTo(px, py + 3);
    f.closePath();
    f.fill();
    const fade = f.createLinearGradient(px, 0, w, 0);
    fade.addColorStop(0, 'rgb(0 0 0 / 0)');
    fade.addColorStop(0.15, 'rgb(0 0 0 / 1)');
    fade.addColorStop(0.6, 'rgb(0 0 0 / .7)');
    fade.addColorStop(1, 'rgb(0 0 0 / 0)');
    f.globalCompositeOperation = 'destination-in';
    f.fillStyle = fade;
    f.fillRect(0, 0, w, h);
    ctx.globalAlpha = 0.2;
    ctx.drawImage(fan, 0, 0);
    ctx.globalAlpha = 1;
    vignette(ctx, w, h, 0.45);
}

// Evening sky: deep indigo fading to a muted rose low on the horizon
function drawPrismDusk(ctx, random, w, h) {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#12131f');
    sky.addColorStop(0.45, '#1d1c33');
    sky.addColorStop(0.78, '#352a45');
    sky.addColorStop(1, '#4a3447');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.scale(1, 0.35);
    softGlow(ctx, w * 0.62, h / 0.35, w * 0.55, 'rgb(235 169 160 / .22)');
    ctx.restore();
    softGlow(ctx, w * 0.2, h * 0.1, h * 0.6, 'rgb(156 196 240 / .06)');
    vignette(ctx, w, h, 0.35);
}

// A plain photo-studio backdrop: lit in the middle, falling off to the edges
function drawPrismStudio(ctx, random, w, h) {
    ctx.fillStyle = '#15161d';
    ctx.fillRect(0, 0, w, h);
    softGlow(ctx, w * 0.5, h * 0.42, w * 0.6, 'rgb(70 72 86 / 1)');
    const floor = ctx.createLinearGradient(0, h * 0.7, 0, h);
    floor.addColorStop(0, 'rgb(0 0 0 / 0)');
    floor.addColorStop(1, 'rgb(0 0 0 / .35)');
    ctx.fillStyle = floor;
    ctx.fillRect(0, 0, w, h);
    vignette(ctx, w, h, 0.4);
}
