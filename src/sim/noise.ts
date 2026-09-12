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

export type NoiseKind =
  | "shot" | "break" | "step" | "impact" | "alarm" | "flare" | "rotor"
  /**
   * Not a sound at all: a lit flashlight in a dead-dark room. It rides this field
   * because the field is really the game's *attention* system — "what pulls the dead
   * toward a point" — and a beam swinging round a black corridor does exactly that.
   * The audio layer deliberately plays nothing for it.
   */
  | "beam"
  /** A Stalker moving through the ducts overhead. The only warning you get. */
  | "duct"
  /** A deck going to vacuum. The loudest thing on the ship bar the helicopter. */
  | "breach"
  /** A discharge through standing water. Loud, and it carries. */
  | "arc";

export interface Noise {
  active: boolean;
  x: number;
  y: number;
  /** World units at which the noise fades to nothing, for a listener with normal ears. */
  radius: number;
  kind: NoiseKind;
  life: number;
  /**
   * Made by something that is already dead. The horde does not investigate its own
   * shuffling — otherwise a crowd would spend the mission walking toward itself — but
   * a player watching the sound ripples absolutely should see it, which is the entire
   * reason a shambler in a fog bank is findable at all.
   */
  byDead: boolean;
}

/**
 * How long a noise stays in the field. Long enough that a zombie whose update runs
 * before the shot cannot miss it, short enough that it is an event and not a smell.
 */
const NOISE_LIFE = 0.5;
const MAX_NOISES = 64;

export class NoiseField {
  readonly items: Noise[] = [];
  /**
   * Optional observer, called for every emission. The audio layer hangs off this so
   * what the player hears is exactly what the zombies heard; the sim itself neither
   * knows nor cares whether anything is listening.
   */
  onEmit: ((n: Noise) => void) | null = null;
  private cursor = 0;

  constructor() {
    for (let i = 0; i < MAX_NOISES; i++) {
      this.items.push({
        active: false, x: 0, y: 0, radius: 0, kind: "step", life: 0, byDead: false,
      });
    }
  }

  emit(x: number, y: number, radius: number, kind: NoiseKind, byDead = false): void {
    // Oldest slot wins when the field is full: a loud world should not go deaf.
    const n = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    n.active = true;
    n.x = x;
    n.y = y;
    n.radius = radius;
    n.kind = kind;
    n.life = NOISE_LIFE;
    n.byDead = byDead;
    this.onEmit?.(n);
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
      if (!n.active || n.byDead) continue;
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
  /** A car alarm. Loud enough to be heard across any floor — that is the point of it. */
  alarm: 1600,
  /** A signal flare going up. A bang and then a light every dead thing walks toward. */
  flare: 900,
  /** Rotor wash. The loudest thing in the game, and it is parked on your extraction. */
  rotor: 1900,
  /**
   * How far a lit beam carries in the dark. Short — this is "something moved in here",
   * not a gunshot — but it is the whole reason to walk a black deck with the light off.
   */
  beam: 300,
  /** Something dragging itself along a duct. Heard through the ceiling, not the walls. */
  duct: 330,
  /** Current going through standing water. */
  arc: 780,
  /**
   * A depressurisation. Enormous — and that is the price of the lever: you cleared the
   * room and told the rest of the deck exactly where you are standing.
   */
  breach: 1500,
  /**
   * A shambling footfall. Nothing hunts it — it is tagged as made by the dead — but it
   * is what you read the room by when coolant fog has taken your eyes.
   */
  shamble: 210,
} as const;
