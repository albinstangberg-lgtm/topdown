/** Small math helpers. Everything in the sim works in world units (1 unit = 1 pixel at zoom 1). */

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest signed delta between two angles, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Rotate `from` toward `to` by at most `maxStep` radians. */
export function rotateToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  return from + clamp(d, -maxStep, maxStep);
}

/** Frame-rate independent exponential smoothing. `rate` is roughly "how fast", dt in seconds. */
export function damp(a: number, b: number, rate: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-rate * dt));
}

export function length(x: number, y: number): number {
  return Math.hypot(x, y);
}

/** Clamp a vector's magnitude to 1 without killing analog-stick precision. */
export function clampMagnitude(x: number, y: number, max: number): [number, number] {
  const len = Math.hypot(x, y);
  if (len <= max || len === 0) return [x, y];
  const s = max / len;
  return [x * s, y * s];
}

export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Deterministic 32-bit RNG — swap Math.random for this once you want replays / lockstep netcode. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
