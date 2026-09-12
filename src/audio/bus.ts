/**
 * CORE 15a — The audio bus.
 *
 * Everything is synthesised. There are no sample files, no loader, no asset pipeline
 * and nothing to 404 — which is the same bet the renderer makes with blocks instead of
 * sprites, for the same reason: one file you can read beats a folder of binaries you
 * cannot diff. Oscillators, filtered noise and envelopes go a very long way for a game
 * whose sounds are guns, glass, footsteps and things that groan.
 *
 * Three rules hold the whole thing together:
 *
 * - **It never throws.** A browser with no audio device, a context that will not start,
 *   a headless test runner — all of them get a bus that counts what it was asked to
 *   play and makes no sound. Audio is the last thing that should be able to break a game.
 * - **The sim never knows.** Nothing in `src/sim` imports this. Sounds are produced by
 *   watching the world from the outside, the same way the renderer does.
 * - **Voices are capped.** A panic horde can ask for forty growls in a frame; letting
 *   that through is how a game turns into a wall of noise and a stuttering frame.
 */

/** Hard ceiling on voices started in one frame. Beyond this, requests are dropped. */
const MAX_VOICES_PER_FRAME = 12;
/** Nothing further than this from the nearest player is audible at all. */
export const EARSHOT = 1100;
const STORAGE_KEY = "topdown.audio.muted";

export interface Placement {
  /** 0 to 1. Distance attenuation against the nearest listener. */
  gain: number;
  /** -1 to 1, left to right. */
  pan: number;
  /**
   * How much geometry is between the sound and whoever is listening: 0 clear, 1 behind
   * a bulkhead. Quiet things vanish behind a wall and loud ones become a rumble — the
   * filter and the gain cut are both driven from this one number, so a sound that opens
   * up as somebody steps round a corner snaps to crisp on its own.
   */
  occlusion?: number;
}

/**
 * How hard a wall works on a sound. `GAIN` is what is left of one behind geometry and
 * `CUTOFF` is where the low-pass sits: 300Hz keeps the thump of a shotgun and takes the
 * entire top off a footstep.
 *
 * `FLOOR` is the part that makes the mechanic rather than the mix. Behind a wall the
 * audibility threshold rises, so a sound that was quiet to begin with does not merely
 * get quieter — it is **not played at all**. That is the difference between "I can just
 * about hear something shuffling in the next room" (which gives the ambush away) and
 * "the room next door is silent" (which is the game).
 */
const OCCLUDED_GAIN = 0.16;
const OCCLUDED_CUTOFF = 300;
const OCCLUDED_FLOOR = 0.075;

/** A sound heard from nowhere in particular — UI, banners, mission events. */
export const CENTRE: Placement = { gain: 1, pan: 0, occlusion: 0 };

/**
 * The audibility test, in one place so the gate and the public rule cannot drift.
 * `level` is the voice's own loudness before placement — which is what lets a quiet
 * sound and a loud one behave differently through the same wall.
 */
function audibleAt(gain: number, occlusion: number, level: number): boolean {
  const floor = 0.01 + OCCLUDED_FLOOR * occlusion;
  return gain * level > floor;
}

export class AudioBus {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Shared white noise, generated once. Gunfire, glass and footsteps all use it. */
  private noiseBuffer: AudioBuffer | null = null;
  private voicesThisFrame = 0;
  private muted = false;
  /** Counts what was asked for, whether or not a device existed. The tests read this. */
  readonly played: Record<string, number> = {};

  constructor() {
    try {
      this.muted = localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      // Private browsing, storage disabled — the default is fine.
    }
  }

  get isMuted(): boolean { return this.muted; }
  /** True once a context exists and is actually running. */
  get isRunning(): boolean { return this.ctx?.state === "running"; }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.02);
    }
    try {
      localStorage.setItem(STORAGE_KEY, this.muted ? "1" : "0");
    } catch { /* nothing to do */ }
    return this.muted;
  }

  /**
   * Browsers refuse to start audio until the person has interacted with the page, so
   * this is called from the first key, click or pad press rather than at construction.
   * Safe to call every time; it does nothing once the context is running.
   */
  resume(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as {
          webkitAudioContext?: typeof AudioContext;
        }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 1;
        this.master.connect(this.ctx.destination);
        this.buildNoise();
      }
      if (this.ctx.state === "suspended") void this.ctx.resume();
    } catch {
      this.ctx = null;
      this.master = null;
    }
  }

  /** Call once per frame, before any sounds are requested. */
  beginFrame(): void {
    this.voicesThisFrame = 0;
  }

  /**
   * Would a voice of this loudness survive being placed here? Public because the
   * occlusion rule is a mechanic — "you cannot hear footsteps through a bulkhead but
   * you can hear a shotgun" is a design promise, and it should be assertable rather
   * than something you have to put your ear to the screen to check.
   */
  audible(at: Placement, level = 1): boolean {
    const occlusion = Math.max(0, Math.min(1, at.occlusion ?? 0));
    const gain = at.gain * (1 - (1 - OCCLUDED_GAIN) * occlusion);
    return audibleAt(gain, occlusion, level);
  }

  /**
   * Where a sound at (x, y) sits for the squad: loudest by the NEAREST listener, panned
   * against that listener's own view. Split screen has no single pair of ears, and
   * averaging four positions puts every sound in the middle of nowhere — the nearest
   * player is the one who cares about it.
   */
  place(
    x: number, y: number,
    listeners: readonly { x: number; y: number; facing: number }[],
    rotates: boolean,
  ): Placement {
    let best: { x: number; y: number; facing: number } | null = null;
    let bestDist = Infinity;
    for (const l of listeners) {
      const d = Math.hypot(l.x - x, l.y - y);
      if (d < bestDist) { bestDist = d; best = l; }
    }
    if (!best || bestDist >= EARSHOT) return { gain: 0, pan: 0 };

    // Falls off with the square root of distance rather than linearly: linear makes
    // everything mid-range sound equally close, which flattens the whole mix.
    const gain = Math.max(0, 1 - Math.sqrt(bestDist / EARSHOT));
    const dx = x - best.x;
    const dy = y - best.y;
    // With a rotating camera "left" means left of where the player is looking; with a
    // fixed one it means left on the screen.
    const across = rotates
      ? dx * Math.cos(-best.facing + Math.PI / 2) - dy * Math.sin(-best.facing + Math.PI / 2)
      : dx;
    return { gain, pan: Math.max(-1, Math.min(1, across / 420)), occlusion: 0 };
  }

  /**
   * A band-limited noise burst: gunfire, glass, footsteps, impacts.
   * `type`/`freq` shape the filter, `attack`/`decay` the envelope.
   */
  noise(name: string, at: Placement, opts: {
    freq: number; q?: number; type?: BiquadFilterType;
    attack?: number; decay: number; level?: number; sweepTo?: number;
  }): void {
    const gate = this.begin(name, at, opts);
    if (!gate) return;
    const { ctx, out, when } = gate;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = opts.type ?? "bandpass";
    filter.frequency.setValueAtTime(opts.freq, when);
    if (opts.sweepTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(30, opts.sweepTo), when + opts.decay);
    }
    filter.Q.value = opts.q ?? 1;
    const env = ctx.createGain();
    const attack = opts.attack ?? 0.004;
    const peak = (opts.level ?? 1) * gate.gain;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(peak, when + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, when + attack + opts.decay);
    src.connect(filter).connect(env).connect(out);
    src.start(when);
    src.stop(when + attack + opts.decay + 0.02);
  }

  /** A pitched voice: growls, alarms, UI. `to` sweeps the pitch over the decay. */
  tone(name: string, at: Placement, opts: {
    freq: number; to?: number; type?: OscillatorType;
    attack?: number; decay: number; level?: number; detune?: number;
  }): void {
    const gate = this.begin(name, at, opts);
    if (!gate) return;
    const { ctx, out, when } = gate;
    const osc = ctx.createOscillator();
    osc.type = opts.type ?? "sawtooth";
    osc.frequency.setValueAtTime(opts.freq, when);
    if (opts.to !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), when + opts.decay);
    }
    if (opts.detune) osc.detune.value = opts.detune;
    const env = ctx.createGain();
    const attack = opts.attack ?? 0.01;
    const peak = (opts.level ?? 0.5) * gate.gain;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(peak, when + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, when + attack + opts.decay);
    osc.connect(env).connect(out);
    osc.start(when);
    osc.stop(when + attack + opts.decay + 0.02);
  }

  /**
   * The common preamble: count it, drop it if it is inaudible or the frame is full,
   * and hand back a panned destination. Null means "make no sound" — every caller
   * treats that as ordinary, because a silent bus is a supported state.
   */
  private begin(name: string, at: Placement, opts: { level?: number }):
    { ctx: AudioContext; out: AudioNode; when: number; gain: number } | null {
    this.played[name] = (this.played[name] ?? 0) + 1;
    const occlusion = Math.max(0, Math.min(1, at.occlusion ?? 0));
    const gain = at.gain * (1 - (1 - OCCLUDED_GAIN) * occlusion);
    if (!audibleAt(gain, occlusion, opts.level ?? 1)) return null;
    if (this.voicesThisFrame >= MAX_VOICES_PER_FRAME) return null;
    if (!this.ctx || !this.master || this.ctx.state !== "running") return null;
    this.voicesThisFrame++;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = at.pan;
    panner.connect(this.master);

    if (occlusion <= 0.01) {
      return { ctx: this.ctx, out: panner, when: this.ctx.currentTime, gain };
    }
    // A wall is a low-pass filter. One node, in front of the panner, and every voice
    // in the game inherits the behaviour without knowing about it.
    const muffle = this.ctx.createBiquadFilter();
    muffle.type = "lowpass";
    // Sweeps from "some of the top left" to "nothing but the rumble" as the geometry
    // between the two thickens.
    muffle.frequency.value = OCCLUDED_CUTOFF + (1 - occlusion) * 4200;
    muffle.Q.value = 0.4;
    muffle.connect(panner);
    return { ctx: this.ctx, out: muffle, when: this.ctx.currentTime, gain };
  }

  private buildNoise(): void {
    if (!this.ctx) return;
    const seconds = 1;
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * seconds, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
  }
}
