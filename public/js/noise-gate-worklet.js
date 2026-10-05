// noise-gate-worklet.js
// Adaptive noise gate (AudioWorklet). Turns a mic down while it only carries
// background noise: hiss from sensitive mics, room tone, keyboard clicks.
//
// - The threshold follows the mic's own noise floor (the quietest level seen
//   over the last few seconds), so it works for quiet and noisy setups alike.
// - Short bursts (key clicks) don't open it: the level has to stay above the
//   threshold for a few blocks, which speech does and clicks don't.
// - It closes to a low level rather than silence and holds open across the
//   gaps between words, so speech isn't chopped.

const OPEN_ABOVE_FLOOR_DB = 9;     // open this far above the noise floor
const CLOSE_HYSTERESIS_DB = 3;     // close a bit lower than we open
const MIN_OPEN_DB = -58;           // never open below this, whatever the floor
const MAX_FLOOR_DB = -30;          // a floor estimate above this is speech, not noise
const OPEN_AFTER_S = 0.03;         // raw level must stay up this long, unbroken, to open
const HOLD_S = 0.35;               // stay open this long after the level drops
const ATTACK_S = 0.004;            // gain ramp when opening
const RELEASE_S = 0.12;            // gain ramp when closing
const CLOSED_GAIN = 0.06;          // about -24 dB
const DETECT_S = 0.03;             // level detector smoothing
const FLOOR_SEGMENT_S = 1;         // noise floor = quietest of the last N segments
const FLOOR_SEGMENTS = 3;

const toDb = (power) => 10 * Math.log10(power + 1e-12);

class NoiseGateProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [{ name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
    }

    constructor() {
        super();
        this.level = null;            // smoothed power
        this.gain = 1;
        this.open = true;             // start open: nothing is lost before the floor is known
        this.aboveFor = 0;            // seconds above the open threshold
        this.holdLeft = HOLD_S;
        this.segmentMin = Infinity;
        this.segmentTime = 0;
        this.segmentMins = [];
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        // No input left means the chain was torn down: let the node go
        if (!input || input.length === 0) return false;

        const frames = input[0].length;
        const blockS = frames / sampleRate;
        const enabled = parameters.enabled[0] >= 0.5;

        // Block power across channels
        let sum = 0;
        for (let c = 0; c < input.length; c++) {
            const ch = input[c];
            for (let i = 0; i < frames; i++) sum += ch[i] * ch[i];
        }
        const power = sum / (frames * input.length);
        if (this.level === null) this.level = power;
        this.level += (power - this.level) * (1 - Math.exp(-blockS / DETECT_S));
        const levelDb = toDb(this.level);

        // Noise floor: quietest smoothed level over the last few segments
        if (levelDb < this.segmentMin) this.segmentMin = levelDb;
        this.segmentTime += blockS;
        if (this.segmentTime >= FLOOR_SEGMENT_S) {
            this.segmentMins.push(this.segmentMin);
            if (this.segmentMins.length > FLOOR_SEGMENTS) this.segmentMins.shift();
            this.segmentMin = Infinity;
            this.segmentTime = 0;
        }
        const known = this.segmentMins.length > 0;
        const floorDb = Math.min(MAX_FLOOR_DB, Math.min(this.segmentMin, ...this.segmentMins));
        const openDb = Math.max(MIN_OPEN_DB, floorDb + OPEN_ABOVE_FLOOR_DB);

        if (!known) {
            this.open = true;
        } else {
            // Opening looks at each raw block, so a click's short burst can't
            // add up; closing looks at the smoothed level, so syllables can.
            this.aboveFor = toDb(power) >= openDb ? this.aboveFor + blockS : 0;
            if (this.aboveFor >= OPEN_AFTER_S) {
                this.open = true;
                this.holdLeft = HOLD_S;
            } else if (this.open && levelDb < openDb - CLOSE_HYSTERESIS_DB) {
                this.holdLeft -= blockS;
                if (this.holdLeft <= 0) this.open = false;
            } else if (this.open) {
                this.holdLeft = HOLD_S;
            }
        }

        const target = !enabled || this.open ? 1 : CLOSED_GAIN;
        const tau = target > this.gain ? ATTACK_S : RELEASE_S;
        const step = 1 - Math.exp(-1 / (tau * sampleRate));

        for (let c = 0; c < output.length; c++) {
            const inCh = input[Math.min(c, input.length - 1)];
            const outCh = output[c];
            let g = this.gain;
            for (let i = 0; i < frames; i++) {
                g += (target - g) * step;
                outCh[i] = inCh[i] * g;
            }
            if (c === output.length - 1) this.gain = g;
        }
        return true;
    }
}

registerProcessor('noise-gate', NoiseGateProcessor);
