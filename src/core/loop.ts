/**
 * CORE 1 — Fixed-timestep loop.
 *
 * The simulation always advances in equal STEP-sized slices, no matter how fast or slow
 * the display refreshes. Rendering happens once per frame and interpolates between the
 * two most recent sim states using `alpha`.
 *
 * Why this matters for a 4-player co-op shooter: identical step sizes mean identical
 * physics on every machine and every refresh rate (60/120/144Hz), which is the
 * precondition for replays, deterministic AI and eventually netcode.
 */

export const STEP = 1 / 60;
const MAX_FRAME = 0.25; // never simulate more than 250ms in one frame (spiral-of-death guard)

export interface LoopCallbacks {
  /** Advance the simulation by exactly `dt` seconds. Called 0..n times per frame. */
  update(dt: number): void;
  /** Draw. `alpha` in [0,1) is how far we are between the previous and current sim state. */
  render(alpha: number, frameDt: number): void;
}

export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;

  /** Diagnostics for the debug overlay. */
  readonly stats = { fps: 0, stepsLastFrame: 0, updateMs: 0, renderMs: 0 };
  private fpsAccum = 0;
  private fpsFrames = 0;

  constructor(private readonly cb: LoopCallbacks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    let frameDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (frameDt > MAX_FRAME) frameDt = MAX_FRAME;

    this.accumulator += frameDt;

    const t0 = performance.now();
    let steps = 0;
    while (this.accumulator >= STEP) {
      this.cb.update(STEP);
      this.accumulator -= STEP;
      steps++;
    }
    const t1 = performance.now();

    this.cb.render(this.accumulator / STEP, frameDt);
    const t2 = performance.now();

    this.stats.stepsLastFrame = steps;
    this.stats.updateMs = t1 - t0;
    this.stats.renderMs = t2 - t1;

    this.fpsAccum += frameDt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.25) {
      this.stats.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
  };
}
