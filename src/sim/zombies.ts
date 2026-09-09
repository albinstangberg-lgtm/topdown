/**
 * CORE 7a — The zombie registry.
 *
 * The same trick as `TILE_DEFS`: every kind of zombie is one row in this table, and
 * the AI, the director, the renderer and the debug overlay all read their numbers
 * from it. **Adding a zombie type is one entry here** — no new state machine, no new
 * branch in `updateEnemy`, no renderer change.
 *
 * The state machine is deliberately generic: wander → investigate → chase → windup →
 * lunge → recover. A runner is a walker with a bigger `chaseSpeed` and a shorter
 * `windup`; a brute is one with more `health`, a slower `chaseSpeed` and a fatter
 * `lunge.damage`. That is the whole extension point.
 */

export interface LungeDef {
  /** Starts the windup once the target is this close and in sight. */
  range: number;
  /** Seconds of telegraph before the leap. The window you dodge in. */
  windup: number;
  /** Launch speed, in world units per second. */
  speed: number;
  /** Seconds the leap lasts. `speed * duration` is roughly how far it travels. */
  duration: number;
  /** Seconds face-down on the floor afterwards. Cannot move, cannot turn. */
  recover: number;
  damage: number;
  /** Seconds after a recovery before it may wind up again. */
  cooldown: number;
}

export interface ZombieDef {
  key: string;
  name: string;
  health: number;
  radius: number;
  /** Shambling pace, used while wandering and investigating. */
  wanderSpeed: number;
  /** Pace once it has a target. Below the player's walk on purpose — the lunge is
   *  the threat, not the chase. */
  chaseSpeed: number;
  /** Half-angle of what it can see, in radians. Wide and short: hard to walk past
   *  head-on, easy to slip behind. */
  senseHalf: number;
  senseRange: number;
  /** Scales every noise radius it hears. 1 is normal ears. */
  hearing: number;
  /** Damage multiplier while it is down after a leap — the reward for dodging. */
  vulnerable: number;
  lunge: LungeDef;
  color: string;
  /** Relative odds the director picks this kind. 0 means "only if authored". */
  weight: number;
}

export const ZOMBIE_DEFS: readonly ZombieDef[] = [
  {
    key: "walker",
    name: "Walker",
    health: 40,
    radius: 14,
    wanderSpeed: 52,
    chaseSpeed: 140,
    senseHalf: 1.4,
    senseRange: 220,
    hearing: 1,
    vulnerable: 1.6,
    // The leap has to cover more ground than the range it starts from, or a zombie
    // that winds up at maximum range lands harmlessly short every single time.
    // speed * duration * 0.6 (the deceleration) is the distance: ~126 against 120.
    lunge: {
      range: 120, windup: 0.35, speed: 700, duration: 0.3,
      recover: 0.55, damage: 18, cooldown: 1.1,
    },
    color: "#7aa77f",
    weight: 1,
  },
];

const BY_KEY = new Map(ZOMBIE_DEFS.map((z) => [z.key, z]));
export const DEFAULT_ZOMBIE = ZOMBIE_DEFS[0].key;

/** Unknown keys fall back to the first kind rather than throwing — same rule as tiles. */
export function zombieDef(key: string): ZombieDef {
  return BY_KEY.get(key) ?? ZOMBIE_DEFS[0];
}

/** Weighted draw, for the director. Authored spawns name their kind instead. */
export function randomZombieKind(rand: () => number = Math.random): string {
  let total = 0;
  for (const z of ZOMBIE_DEFS) total += z.weight;
  if (total <= 0) return DEFAULT_ZOMBIE;
  let roll = rand() * total;
  for (const z of ZOMBIE_DEFS) {
    roll -= z.weight;
    if (roll <= 0) return z.key;
  }
  return DEFAULT_ZOMBIE;
}
