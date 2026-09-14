/**
 * CORE 7a — The zombie registry.
 *
 * The same trick as `TILE_DEFS`: every kind of zombie is one row in this table, and
 * the AI, the director, the renderer and the debug overlay all read their numbers
 * from it. **Adding a zombie type is one entry here** — no new state machine, no new
 * branch in `updateEnemy`, no renderer change.
 *
 * The state machine is deliberately generic: wander → investigate → chase → swipe, or
 * wander → investigate → chase → windup → lunge → recover. Which of the two a kind
 * runs is decided by the table and nothing else: a `melee` block makes it walk up and
 * claw, a `lunge.range` above zero makes it leap. A brute is a walker with more
 * `health`, a slower `chaseSpeed` and a fatter swing. That is the whole extension point.
 *
 * **Two kinds are common, and the split is deliberate.** Four in five of the dead a
 * floor throws at you are Walkers: no leap, no telegraph worth the name, they simply
 * come and they keep coming a shade slower than you walk. The fifth is a Lunger, which
 * is slower on its feet and crosses the last four metres in one jump — so the room you
 * left yourself against the first four is not room at all against the fifth. Neither is
 * interesting on its own; the mix is, because you cannot read a crowd at a glance and
 * the answer to one is the wrong answer to the other.
 */

/**
 * A plain swing, and the only attack a Walker has. It does not leave the floor and it
 * does not cross a room: it gets within arm's reach, its arms come up for a quarter of
 * a second, and then it takes a piece out of whoever is still standing there. The
 * counter is not dodging the swing — it is not letting the thing arrive.
 */
export interface MeleeDef {
  /** The gap between the two bodies it can swing across, in world units. */
  reach: number;
  /** Seconds of raised arms before the swing lands. The whole of the tell. */
  windup: number;
  damage: number;
  /** Seconds after a swing before it can raise its arms again. */
  cooldown: number;
}

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

/**
 * The Strangler's reach. A tendril is a *ranged grab* and the only one in the game, so
 * every number here is about the window the squad gets: long enough to see the thing
 * wind up, soft enough that a teammate's burst can cut it, and painful enough that
 * nobody ignores the player being dragged into the dark.
 */
export interface TendrilDef {
  /** How far it can reach a player, in world units. Well past a flashlight cone. */
  range: number;
  /** Seconds of winding up before it fires. The window to break the line. */
  aim: number;
  /** How fast it drags, in world units per second. */
  reel: number;
  /** Damage per second while you are being dragged. */
  damage: number;
  /**
   * What it takes to sever the tendril itself. Deliberately far below the Strangler's
   * own health: cutting the rope is the panicked answer, killing the thing holding it
   * is the considered one, and both should work.
   */
  health: number;
  /** Seconds before it can throw another one. */
  cooldown: number;
}

/**
 * The Stalker's leap. Unlike a Lunger's leap — which is a telegraphed hop that ends
 * on the floor if you dodge — this one ends *on top of you* and stays there. The
 * counterplay is not dodging, it is the rest of the squad.
 */
export interface PounceDef {
  /** How far away it will commit to a charge. */
  range: number;
  /** The wet skitter before it goes, and the only warning you get. */
  tell: number;
  speed: number;
  duration: number;
  /** Damage per second while it is on top of somebody. */
  damage: number;
  /** Seconds of a teammate's flashlight full in its face before it is blinded. */
  blind: number;
  /** How long a blind lasts: it cannot leap, and it moves like it has been kicked. */
  blindTime: number;
  /** Seconds of a teammate shoving before it comes off a pinned player. */
  shove: number;
}

/**
 * The Ceiling Lurker's drop. It never touches the floor: it lives in the duct network
 * and it is waiting for somebody to stand still underneath an unlit grate.
 *
 * The counterplay is the one thing the squad can do without shooting: put light on the
 * floor. A flare under a grate, or a room with its lamps still on, and the thing above
 * it will not come down there at all.
 */
export interface DropDef {
  /** Seconds a player has to loiter under a grate before it commits. */
  dwell: number;
  /** How close to under the grate counts as underneath it. */
  radius: number;
  /** Damage the landing itself does. */
  damage: number;
  /** Damage per second while it is on top of somebody afterwards. */
  chew: number;
  /** Seconds of a teammate shoving before it comes off. */
  shove: number;
  /** Seconds between grate-to-grate moves while it hunts for somebody standing still. */
  hop: number;
}

export interface ZombieDef {
  key: string;
  name: string;
  health: number;
  radius: number;
  /** Shambling pace, used while wandering and investigating. */
  wanderSpeed: number;
  /** Pace once it has a target. Always below a player's walk, so the squad can always
   *  choose to give ground — how far below is what separates the two common kinds. */
  chaseSpeed: number;
  /** Half-angle of what it can see, in radians. Wide and short: hard to walk past
   *  head-on, easy to slip behind. */
  senseHalf: number;
  senseRange: number;
  /** Scales every noise radius it hears. 1 is normal ears. */
  hearing: number;
  /** Damage multiplier while it is down after a leap — the reward for dodging. */
  vulnerable: number;
  /**
   * The leap. `range: 0` switches the whole windup → lunge → recover branch off — the
   * rest of the numbers stay because a lunge block is the shape of the table, not
   * because a kind without a range will ever use them.
   */
  lunge: LungeDef;
  /**
   * A swing on contact. A kind with this closes and claws instead of leaping, which is
   * what makes the common Walker a pressure system rather than a dodging puzzle.
   */
  melee?: MeleeDef;
  /**
   * A ranged grab. A kind with this is a Strangler: it holds a post in the dark rather
   * than shambling, and reaches for whoever walks into its line.
   */
  tendril?: TendrilDef;
  /** A leap that pins. A kind with this is a Stalker — see `PounceDef`. */
  pounce?: PounceDef;
  /** A drop out of the ceiling. A kind with this is a Ceiling Lurker — see `DropDef`. */
  drop?: DropDef;
  /** Makes no footfall a player can hear. Stalkers are silent until they are not. */
  silent?: boolean;
  /** Holds a post instead of wandering. What makes a Strangler an ambush. */
  lurks?: boolean;
  /** Travels the ceiling ducts between vent grates to reposition. */
  vents?: boolean;
  /**
   * Hunts whoever is on their own — outside everyone else's cones. The Stalker's whole
   * character, and the reason the squad stays inside each other's light.
   */
  huntsStragglers?: boolean;
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
    /*
     * Four in five of them, and the pace is the entire design. Just under a player's
     * walk (165), so backing off buys ground a foot at a time rather than instantly,
     * a sprint breaks contact outright, and standing still to line up a shot is a
     * decision you make rather than a thing you do between reloads. A slower number
     * than this and the common dead are scenery you walk around.
     */
    chaseSpeed: 155,
    senseHalf: 1.4,
    senseRange: 220,
    hearing: 1,
    // It never ends up on the floor, so this never comes up. Kept honest anyway.
    vulnerable: 1.2,
    // It does not leap: `range: 0` takes it straight past the whole windup branch.
    lunge: {
      range: 0, windup: 0.3, speed: 520, duration: 0.25,
      recover: 0.5, damage: 12, cooldown: 1,
    },
    // Less per swing than a Lunger's leap and far more often. One of them on you is
    // survivable and slow; three of them is the reason you do not let three arrive.
    melee: { reach: 10, windup: 0.28, damage: 11, cooldown: 0.9 },
    color: "#7aa77f",
    weight: 4,
  },
  {
    key: "lunger",
    name: "Lunger",
    // The one in five that does not simply arrive. Same body as a Walker — what it
    // takes off you is the four metres you thought you still had.
    health: 40,
    radius: 14,
    wanderSpeed: 52,
    // Slower on its feet than a Walker on purpose: you can see this one coming and
    // still back out of its range. The leap is the threat, not the chase.
    chaseSpeed: 128,
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
    // Sallow against a Walker's grey-green: a crowd has to be readable at a glance,
    // because the answer to one of these is the wrong answer to the other.
    color: "#9c9f5c",
    weight: 1,
  },
  {
    key: "strangler",
    name: "Strangler",
    // Tougher than a walker, and it never comes to you — you have to go and deal with
    // it, or cut what it is holding and leave.
    health: 90,
    radius: 16,
    // It barely moves. Everything about it says "this corner is not yours".
    wanderSpeed: 26,
    chaseSpeed: 58,
    // It watches one direction, far. Walk in from the side and it never sees you.
    senseHalf: 0.8,
    senseRange: 430,
    hearing: 1.2,
    vulnerable: 1.2,
    // It has the walker's leap, but the numbers make it a last resort if you close.
    lunge: {
      range: 70, windup: 0.5, speed: 480, duration: 0.25,
      recover: 0.8, damage: 12, cooldown: 2.4,
    },
    tendril: {
      range: 400, aim: 0.7, reel: 155, damage: 9, health: 26, cooldown: 3.2,
    },
    lurks: true,
    color: "#8f6f9a",
    // Never randomly drawn: a Strangler is placed where a corridor makes it awful.
    weight: 0,
  },
  {
    key: "stalker",
    name: "Stalker",
    health: 70,
    radius: 13,
    // Creeping is slow; the charge is not. That gap is the whole animal.
    wanderSpeed: 44,
    chaseSpeed: 118,
    senseHalf: 1.9,
    senseRange: 320,
    hearing: 1.6,
    vulnerable: 2,
    // Its ordinary lunge is switched off in practice — `pounce` outranks it.
    lunge: {
      range: 0, windup: 0.4, speed: 520, duration: 0.25,
      recover: 0.7, damage: 10, cooldown: 3,
    },
    pounce: {
      range: 250, tell: 0.55, speed: 820, duration: 0.34,
      damage: 15, blind: 0.6, blindTime: 2.2, shove: 0.9,
    },
    silent: true,
    vents: true,
    huntsStragglers: true,
    color: "#5c6f7a",
    weight: 0,
  },
  {
    key: "lurker",
    name: "Ceiling Lurker",
    // Squishier than a Stalker, because it gets a free hit and you get a free shot at
    // it while it is picking itself up off you.
    health: 55,
    radius: 13,
    // Never used: it does not walk. Both speeds are here because the table is one shape.
    wanderSpeed: 40,
    chaseSpeed: 90,
    senseHalf: 2.2,
    senseRange: 420,
    hearing: 1.4,
    vulnerable: 2.2,
    lunge: {
      range: 0, windup: 0.35, speed: 400, duration: 0.2,
      recover: 1.1, damage: 10, cooldown: 3,
    },
    drop: { dwell: 1.6, radius: 40, damage: 20, chew: 11, shove: 0.75, hop: 1.4 },
    silent: true,
    vents: true,
    color: "#6a5c7a",
    weight: 0,
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
