// === BACKGROUND COMPOSITOR: puts the person in front of the blur or backdrop, on the GPU ===
// Takes the place of LiveKit's WebGL pipeline, with the same interface, in the same WebGL context
// (MediaPipe's segmenter draws in it too, so its mask textures can be read directly).
// LiveKit thresholds the mask to person / not person and then sharpens the edge again, which gives
// a hard outline that jumps from frame to frame. This one:
// - keeps MediaPipe's soft confidence and rounds off its blocky outline,
// - eases small mask changes in over a few masks (flicker) but follows large ones at once (movement),
// - feathers the edge instead of cutting it,
// - leaves the person out of the blur, so no halo of their colours around them,
// - draws backdrops that move (video, animated picture, a shared screen), uploading a frame only
//   when the backdrop has a new one.
// - can show the person small in the bottom-right corner over the backdrop, as streamers do over a
//   game (the shared screen). Where they are in the camera picture is read back from the mask a few
//   times a second, without waiting on the GPU, so the corner keeps them in frame.
// The extra work runs on the small mask (256×144) and the quarter-size blur copy, so it costs
// about what LiveKit's mask blur did at 640×360.

// Person confidence where the person starts to show, and where they fully cover the background.
// The midpoint sits a little above MediaPipe's 0.5 so the edge falls inside the person, not in the
// room behind them.
const EDGE = [0.2, 0.85];
// Below this confidence a pixel counts fully as background for the blur
const BLUR_KEEP_OUT = [0.15, 0.5];
// Of each new mask, at least this share is taken; the rest comes from the masks before
const MIN_TAKE = 0.6;
const DOWNSAMPLE = 4;
const MAX_BLUR_RADIUS = 16;
const MAX_TAPS = 1 + Math.ceil(MAX_BLUR_RADIUS / 2);
// Behind a backdrop that does not fill the picture (a screen shown whole)
const MATTE = [0.07, 0.07, 0.08];
// In the corner: the person (top of the head to the bottom of the camera picture) is this share of
// the picture's height, at most this much enlarged, and this far from the right edge.
const CORNER_HEIGHT = 0.3;
const CORNER_MAX_SCALE = 0.7;
const CORNER_MARGIN = 0.03;
// Room left above the head
const CORNER_HEADROOM = 0.05;
// How often the mask is read back, and how quickly the corner follows (time constant)
const CORNER_READ_MS = 200;
const CORNER_EASE_MS = 400;
// With the person in the corner the picture takes the backdrop's size, up to this
const CORNER_MAX_OUTPUT = [1920, 1080];

const VERTEX = `#version 300 es
in vec2 position;
uniform bool u_flipY;
out vec2 uv;
void main() {
    uv = (position + 1.0) * 0.5;
    // Textures hold their first row at the top; the canvas wants it at the bottom
    if (u_flipY) uv.y = 1.0 - uv.y;
    gl_Position = vec4(position, 0.0, 1.0);
}`;

// New mask → smoothed mask. Stays at the mask's own size.
const MASK_SHADER = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D u_confidence;
uniform sampler2D u_previous;
uniform vec2 u_texel;
uniform float u_history;
out vec4 color;
void main() {
    // 5×5 binomial: rounds off the blocky outline and widens the edge to a few mask pixels
    const float k[5] = float[5](1.0, 4.0, 6.0, 4.0, 1.0);
    float c = 0.0;
    for (int y = -2; y <= 2; y++) {
        for (int x = -2; x <= 2; x++) {
            c += k[x + 2] * k[y + 2] * texture(u_confidence, uv + vec2(x, y) * u_texel).r;
        }
    }
    c /= 256.0;
    float previous = texture(u_previous, uv).r;
    float take = mix(${MIN_TAKE.toFixed(2)}, 1.0, smoothstep(0.05, 0.3, abs(c - previous)));
    color = vec4(mix(previous, c, mix(1.0, take, u_history)), 0.0, 0.0, 1.0);
}`;

// Frame → quarter size, background only (weighted), ready for the blur
const PREPARE_SHADER = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D u_frame;
uniform sampler2D u_mask;
uniform vec2 u_texel;
out vec4 color;
void main() {
    // Four bilinear reads cover the 4×4 pixels that make up one quarter-size pixel
    vec3 rgb = 0.25 * (
        texture(u_frame, uv + vec2(-u_texel.x, -u_texel.y)).rgb +
        texture(u_frame, uv + vec2( u_texel.x, -u_texel.y)).rgb +
        texture(u_frame, uv + vec2(-u_texel.x,  u_texel.y)).rgb +
        texture(u_frame, uv + vec2( u_texel.x,  u_texel.y)).rgb);
    float w = max(1.0 - smoothstep(${BLUR_KEEP_OUT[0]}, ${BLUR_KEEP_OUT[1]}, texture(u_mask, uv).r), 0.004);
    color = vec4(rgb * w, w);
}`;

// Separable Gaussian; pairs of taps are merged so one bilinear read covers two texels
const BLUR_SHADER = `#version 300 es
precision mediump float;
const int MAX_TAPS = ${MAX_TAPS};
in vec2 uv;
uniform sampler2D u_source;
uniform vec2 u_step;
uniform float u_weights[MAX_TAPS];
uniform float u_offsets[MAX_TAPS];
uniform int u_taps;
out vec4 color;
void main() {
    vec4 sum = texture(u_source, uv) * u_weights[0];
    for (int i = 1; i < MAX_TAPS; i++) {
        if (i >= u_taps) break;
        vec2 offset = u_step * u_offsets[i];
        sum += (texture(u_source, uv + offset) + texture(u_source, uv - offset)) * u_weights[i];
    }
    color = sum;
}`;

const COMPOSITE_SHADER = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D u_frame;
uniform sampler2D u_mask;
uniform sampler2D u_background;
uniform int u_mode;        // 0: frame only, 1: blur, 2: backdrop
uniform vec4 u_fit;        // backdrop: scale (xy) and offset (zw) from picture to backdrop coordinates
uniform vec3 u_matte;
uniform vec4 u_corner;     // person in the corner: scale (xy), x in the picture, x in the camera picture
out vec4 color;
void main() {
    vec3 frame = texture(u_frame, uv).rgb;
    if (u_mode == 0) {
        color = vec4(frame, 1.0);
        return;
    }
    vec2 q = uv;
    if (u_corner.x > 0.0) {
        // The bottom of the camera picture stays on the bottom edge
        q = vec2(u_corner.w + (uv.x - u_corner.z) / u_corner.x, 1.0 - (1.0 - uv.y) / u_corner.y);
        frame = texture(u_frame, q).rgb;
    }
    bool onCamera = q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0;
    float person = onCamera ? smoothstep(${EDGE[0]}, ${EDGE[1]}, texture(u_mask, q).r) : 0.0;
    vec3 background;
    if (u_mode == 1) {
        vec4 blurred = texture(u_background, uv);
        background = blurred.rgb / max(blurred.a, 0.004);
    } else {
        vec2 p = uv * u_fit.xy + u_fit.zw;
        bool inside = p.x >= 0.0 && p.x <= 1.0 && p.y >= 0.0 && p.y <= 1.0;
        background = inside ? texture(u_background, p).rgb : u_matte;
    }
    color = vec4(mix(background, frame, person), 1.0);
}`;

function gaussianKernel(radius) {
    // Same shape as LiveKit's, so the blur keeps the strength people know
    const sigma = radius;
    const reach = Math.min(MAX_BLUR_RADIUS, Math.ceil(radius));
    const weightAt = (x) => Math.exp(-(x * x) / (2 * sigma * sigma));
    const weights = new Float32Array(MAX_TAPS);
    const offsets = new Float32Array(MAX_TAPS);
    weights[0] = weightAt(0);
    let total = weights[0];
    let taps = 1;
    for (let i = 1; i <= reach; i += 2) {
        const w1 = weightAt(i);
        const w2 = i + 1 <= reach ? weightAt(i + 1) : 0;
        weights[taps] = w1 + w2;
        offsets[taps] = (i * w1 + (i + 1) * w2) / (w1 + w2);
        total += 2 * weights[taps];
        taps++;
    }
    for (let i = 0; i < taps; i++) weights[i] /= total;
    return { weights, offsets, taps };
}

/**
 * Sets up the compositor on the canvas's WebGL2 context, or returns undefined without one.
 * Same methods as LiveKit's setupWebGL, plus setBackgroundSource for backdrops that move:
 * objects with `image` (something texImage2D takes, or null while there is none), `width`,
 * `height`, `version` (changes with each new frame), `fit` ('cover' or 'contain') and optionally
 * `corner` (true: the person is shown small in the bottom-right corner).
 */
export function createCompositor(canvas) {
    const gl = canvas.getContext('webgl2');
    if (!gl) return undefined;

    // Blur weights near the edge are small; 8 bits would band them. MediaPipe already asked for one
    // of these extensions, so half floats are there in practice.
    const halfFloat = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));

    function compile(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`Background shader did not compile: ${log}`);
        }
        return shader;
    }
    const vertexShader = compile(gl.VERTEX_SHADER, VERTEX);
    const programs = [];
    function program(fragmentSource, uniformNames) {
        const p = gl.createProgram();
        const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
        gl.attachShader(p, vertexShader);
        gl.attachShader(p, fragment);
        gl.bindAttribLocation(p, 0, 'position');
        gl.linkProgram(p);
        gl.deleteShader(fragment);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Background shader did not link: ${gl.getProgramInfoLog(p)}`);
        programs.push(p);
        const u = { program: p };
        for (const name of ['u_flipY', ...uniformNames]) u[name] = gl.getUniformLocation(p, name);
        return u;
    }
    const maskProgram = program(MASK_SHADER, ['u_confidence', 'u_previous', 'u_texel', 'u_history']);
    const prepareProgram = program(PREPARE_SHADER, ['u_frame', 'u_mask', 'u_texel']);
    const blurProgram = program(BLUR_SHADER, ['u_source', 'u_step', 'u_weights', 'u_offsets', 'u_taps']);
    const compositeProgram = program(COMPOSITE_SHADER, ['u_frame', 'u_mask', 'u_background', 'u_mode', 'u_fit', 'u_matte', 'u_corner']);

    // Own vertex array, so the attribute state of MediaPipe's passes stays untouched
    const vao = gl.createVertexArray();
    const quad = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const textures = [];
    function texture() {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        textures.push(t);
        return t;
    }
    // A texture to draw into, with its framebuffer
    const framebuffers = [];
    function target(float) {
        const t = { texture: texture(), framebuffer: gl.createFramebuffer(), width: 0, height: 0, float };
        framebuffers.push(t.framebuffer);
        return t;
    }
    function resize(t, width, height) {
        if (t.width === width && t.height === height) return false;
        t.width = width;
        t.height = height;
        gl.bindTexture(gl.TEXTURE_2D, t.texture);
        if (t.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.texture, 0);
        // Some drivers list the extension but cannot draw into half floats after all
        if (t.float && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            t.float = false;
            t.width = 0;
            return resize(t, width, height);
        }
        return true;
    }
    function clear(t) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
        gl.viewport(0, 0, t.width, t.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    const frameTexture = texture();
    const backgroundTexture = texture();
    // Smoothed masks, written in turn: one holds the last result while the other gets the next
    const masks = [target(false), target(false)];
    let maskIndex = 0;
    let hasMask = false;
    const blurTargets = [target(halfFloat), target(halfFloat)];
    // Until the first mask everything counts as background: nothing of the room shows by accident
    resize(masks[0], 1, 1);
    clear(masks[0]);

    let blurRadius = null;
    let kernelRadius = null;
    let backgroundDisabled = false;
    let picture = null;          // { width, height, fit }
    let source = null;           // a backdrop that moves
    let sourceVersion = null;
    let sourceShown = null;      // size and fit of its frame in the texture

    // Where the person is in the camera picture (0..1, top down): read from the mask, and eased
    const personTarget = { top: 0.2, left: 0.3, right: 0.7 };
    const personShown = { ...personTarget };
    let personShownAt = 0;
    let readBuffer = null;
    let readSize = 0;
    let readFence = null;
    let readWidth = 0;
    let readHeight = 0;
    let lastReadAt = -Infinity;

    function begin() {
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.CULL_FACE);
        gl.colorMask(true, true, true, true);
        gl.bindVertexArray(vao);
    }
    function end() {
        gl.bindVertexArray(null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    function draw(p, into, width, height) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.framebuffer : null);
        gl.viewport(0, 0, width, height);
        gl.uniform1i(p.u_flipY, into ? 0 : 1);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    function bind(unit, tex, location) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(location, unit);
    }
    function upload(tex, image) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    }

    /** Takes MediaPipe's confidence mask (a texture in this context; 1 = person). */
    function updateMask(confidence, width, height) {
        if (!confidence || !width || !height) return;
        begin();
        const previous = masks[maskIndex];
        const next = masks[1 - maskIndex];
        resize(next, width, height);
        // A new size (other model) starts over rather than easing from a mask that does not fit
        const fresh = previous.width !== width || previous.height !== height;
        gl.useProgram(maskProgram.program);
        bind(0, confidence, maskProgram.u_confidence);
        bind(1, previous.texture, maskProgram.u_previous);
        gl.uniform2f(maskProgram.u_texel, 1 / width, 1 / height);
        gl.uniform1f(maskProgram.u_history, hasMask && !fresh ? 1 : 0);
        draw(maskProgram, next, width, height);
        maskIndex = 1 - maskIndex;
        hasMask = true;
        if (source?.corner) startMaskRead(next, width, height);
        end();
    }

    // Copies the mask into a buffer; finishMaskRead picks it up once the GPU is done, so nothing waits
    function startMaskRead(mask, width, height) {
        const now = performance.now();
        if (readFence || now - lastReadAt < CORNER_READ_MS) return;
        lastReadAt = now;
        readBuffer ??= gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, readBuffer);
        if (readSize !== width * height * 4) {
            readSize = width * height * 4;
            gl.bufferData(gl.PIXEL_PACK_BUFFER, readSize, gl.STREAM_READ);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, mask.framebuffer);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        // MediaPipe uses this context too: leave nothing bound for it to read into
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        readFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        readWidth = width;
        readHeight = height;
    }

    function finishMaskRead() {
        if (!readFence || gl.getSyncParameter(readFence, gl.SYNC_STATUS) !== gl.SIGNALED) return;
        gl.deleteSync(readFence);
        readFence = null;
        const pixels = new Uint8Array(readSize);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, readBuffer);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        locatePerson(pixels, readWidth, readHeight);
    }

    // Top of the head, and the sides of the person without the odd stray pixel or raised hand
    function locatePerson(pixels, width, height) {
        const columns = new Uint32Array(width);
        const minInRow = Math.max(2, Math.round(width * 0.01));
        let top = -1;
        let total = 0;
        for (let y = 0; y < height; y++) {
            let inRow = 0;
            for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
                if (pixels[i] >= 128) {
                    columns[x]++;
                    inRow++;
                }
            }
            if (top < 0 && inRow >= minInRow) top = y;
            total += inRow;
        }
        // Nobody there (stepped away): the corner stays where it was
        if (top < 0 || total < width * height * 0.005) return;
        const at = (share) => {
            let sum = 0;
            for (let x = 0; x < width; x++) {
                sum += columns[x];
                if (sum >= total * share) return x;
            }
            return width - 1;
        };
        personTarget.top = top / height;
        personTarget.left = at(0.05) / width;
        personTarget.right = (at(0.95) + 1) / width;
    }

    // Scale (x and y), x in the picture and x in the camera picture for the person in the corner.
    // The picture may have another shape than the camera's, so x is scaled to keep the person's.
    function cornerMapping(width, height, frame) {
        const now = performance.now();
        const ease = personShownAt ? Math.min(1, (now - personShownAt) / CORNER_EASE_MS) : 1;
        personShownAt = now;
        for (const key in personShown) personShown[key] += (personTarget[key] - personShown[key]) * ease;
        const { top, left, right } = personShown;
        const tall = Math.min(1, Math.max(CORNER_HEIGHT / CORNER_MAX_SCALE, 1 - top + CORNER_HEADROOM));
        const scale = CORNER_HEIGHT / tall;
        const scaleX = scale * (frame.displayWidth / frame.displayHeight) / (width / height);
        return [scaleX, scale, 1 - CORNER_MARGIN - scaleX * (right - left) / 2, (left + right) / 2];
    }

    /** Size of the picture for a camera frame of this size: the backdrop's with the person in the corner. */
    function outputSize(frameWidth, frameHeight) {
        if (!source?.corner || !source.width || !source.height) return [frameWidth, frameHeight];
        const shrink = Math.min(1, CORNER_MAX_OUTPUT[0] / source.width, CORNER_MAX_OUTPUT[1] / source.height);
        // Encoders want even sizes
        return [2 * Math.round(source.width * shrink / 2), 2 * Math.round(source.height * shrink / 2)];
    }

    function blurBackground(width, height) {
        const w = Math.max(1, Math.floor(width / DOWNSAMPLE));
        const h = Math.max(1, Math.floor(height / DOWNSAMPLE));
        resize(blurTargets[0], w, h);
        resize(blurTargets[1], w, h);

        gl.useProgram(prepareProgram.program);
        bind(0, frameTexture, prepareProgram.u_frame);
        bind(1, masks[maskIndex].texture, prepareProgram.u_mask);
        gl.uniform2f(prepareProgram.u_texel, 1 / width, 1 / height);
        draw(prepareProgram, blurTargets[0], w, h);

        gl.useProgram(blurProgram.program);
        // Uniforms stay with the program, so the kernel is only sent when the radius changes
        if (kernelRadius !== blurRadius) {
            const kernel = gaussianKernel(blurRadius);
            gl.uniform1fv(blurProgram.u_weights, kernel.weights);
            gl.uniform1fv(blurProgram.u_offsets, kernel.offsets);
            gl.uniform1i(blurProgram.u_taps, kernel.taps);
            kernelRadius = blurRadius;
        }
        bind(0, blurTargets[0].texture, blurProgram.u_source);
        gl.uniform2f(blurProgram.u_step, 1 / w, 0);
        draw(blurProgram, blurTargets[1], w, h);
        bind(0, blurTargets[1].texture, blurProgram.u_source);
        gl.uniform2f(blurProgram.u_step, 0, 1 / h);
        draw(blurProgram, blurTargets[0], w, h);
        return blurTargets[0].texture;
    }

    // Scale and offset from picture coordinates to backdrop coordinates
    function fitFor(width, height, backdrop) {
        const ratio = (width / height) / (backdrop.width / backdrop.height);
        const cover = backdrop.fit !== 'contain';
        const [sx, sy] = (ratio < 1) === cover ? [ratio, 1] : [1, 1 / ratio];
        return [sx, sy, 0.5 - 0.5 * sx, 0.5 - 0.5 * sy];
    }

    function renderFrame(frame) {
        if (!frame.codedWidth) return;
        const width = canvas.width;
        const height = canvas.height;
        begin();
        upload(frameTexture, frame);

        // Without a backdrop yet (one still loading) the matte shows, never the room
        let mode = backgroundDisabled ? 0 : 2;
        let background = backgroundTexture;
        let backdrop = null;
        let corner = [0, 0, 0, 0];
        if (mode && blurRadius) {
            background = blurBackground(width, height);
            mode = 1;
        } else if (mode && source) {
            const image = source.image;
            if (image && source.width && source.height && source.version !== sourceVersion) {
                upload(backgroundTexture, image);
                sourceVersion = source.version;
                sourceShown = { width: source.width, height: source.height, fit: source.fit };
            }
            // Between frames, and while it is paused, the last frame stays
            backdrop = sourceShown;
            if (source.corner) {
                finishMaskRead();
                corner = cornerMapping(width, height, frame);
            }
        } else if (mode) {
            backdrop = picture;
        }

        gl.useProgram(compositeProgram.program);
        bind(0, frameTexture, compositeProgram.u_frame);
        bind(1, masks[maskIndex].texture, compositeProgram.u_mask);
        bind(2, background, compositeProgram.u_background);
        gl.uniform1i(compositeProgram.u_mode, mode);
        // No backdrop: every point falls outside it, onto the matte
        gl.uniform4fv(compositeProgram.u_fit, backdrop ? fitFor(width, height, backdrop) : [0, 0, -1, -1]);
        gl.uniform3fv(compositeProgram.u_matte, MATTE);
        gl.uniform4fv(compositeProgram.u_corner, corner);
        draw(compositeProgram, null, width, height);
        end();
    }

    function setBackgroundImage(image) {
        setBackgroundSource(null);
        picture = null;
        if (!image) return;
        begin();
        upload(backgroundTexture, image);
        end();
        picture = { width: image.width, height: image.height, fit: 'cover' };
    }

    function setBackgroundSource(next) {
        picture = null;
        source = next || null;
        sourceVersion = null;
        sourceShown = null;
        personShownAt = 0;
    }

    function setBlurRadius(radius) {
        // In quarter-size pixels, like LiveKit
        blurRadius = radius ? Math.max(1, Math.floor(radius / DOWNSAMPLE)) : null;
        setBackgroundImage(null);
    }

    function setBackgroundDisabled(disabled) {
        backgroundDisabled = !!disabled;
    }

    function cleanup() {
        programs.forEach(p => gl.deleteProgram(p));
        gl.deleteShader(vertexShader);
        textures.forEach(t => gl.deleteTexture(t));
        framebuffers.forEach(f => gl.deleteFramebuffer(f));
        if (readFence) gl.deleteSync(readFence);
        if (readBuffer) gl.deleteBuffer(readBuffer);
        gl.deleteBuffer(quad);
        gl.deleteVertexArray(vao);
        source = null;
        picture = null;
    }

    return { renderFrame, updateMask, setBackgroundImage, setBackgroundSource, setBlurRadius, setBackgroundDisabled, outputSize, cleanup };
}
