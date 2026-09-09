/**
 * CORE 7b — Sound.
 *
 * A zombie's second sense, and the one that makes a gunshot a decision. A noise is a
 * point with a radius and a short life; anything with ears inside that radius hears it
 * and goes to look. Sound passes **through walls** — deliberately. Blocking it on line
 * of sight would make firing from cover free, which is exactly backwards: the whole
 * point is that a shot you take behind a wall still pulls the room toward you.
 *
 * Loudness falls off linearly with distance, so a zombie standing between two noises
 * walks toward the one that is nearer to filling its ears rather than the newer one.
 */

export type NoiseKind = "shot" | "break" | "step" | "impact";

export interface Noise {
  active: boolean;
  x: number;
  y: number;
  /** World units at which the noise fades to nothing, for a listener with normal ears. */
  radius: number;
  kind: NoiseKind;
  life: number;
}

/**
 * How long a noise stays in the field. Long enough that a zombie whose update runs
 * before the shot cannot miss it, short enough that it is an event and not a smell.
 */
const NOISE_LIFE = 0.5;
const MAX_NOISES = 64;

export class NoiseField {
  readonly items: Noise[] = [];
  private cursor = 0;

  constructor() {
    for (let i = 0; i < MAX_NOISES; i++) {
      this.items.push({ active: false, x: 0, y: 0, radius: 0, kind: "step", life: 0 });
    }
  }

  emit(x: number, y: number, radius: number, kind: NoiseKind): void {
    // Oldest slot wins when the field is full: a loud world should not go deaf.
    const n = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    n.active = true;
    n.x = x;
    n.y = y;
    n.radius = radius;
    n.kind = kind;
    n.life = NOISE_LIFE;
  }

  update(dt: number): void {
    for (const n of this.items) {
      if (!n.active) continue;
      n.life -= dt;
      if (n.life <= 0) n.active = false;
    }
  }

  clear(): void {
    for (const n of this.items) n.active = false;
  }

  /**
   * The loudest thing audible from (x, y), or null. `hearing` scales the radius, so a
   * listener with better ears simply hears further.
   */
  loudestAt(x: number, y: number, hearing: number): Noise | null {
    let best: Noise | null = null;
    let bestLoudness = 0;
    for (const n of this.items) {
      if (!n.active) continue;
      const reach = n.radius * hearing;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d >= reach) continue;
      const loudness = 1 - d / reach;
      if (loudness > bestLoudness) { bestLoudness = loudness; best = n; }
    }
    return best;
  }
}

/** How far each thing carries. One table, so "is the shotgun loud?" has one answer. */
export const NOISE = {
  /** A pane going out. Nearly as loud as a shot, and you rarely mean to do it. */
  glass: 600,
  /** A sprinting footfall. Walking is silent; running is not. */
  sprint: 180,
  /** Hitting the floor at the end of a dive. */
  dive: 250,
} as const;
