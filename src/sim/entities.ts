import type { VisionLight } from "../vision/visibility";

/**
 * CORE 5 — Entities.
 *
 * Deliberately plain data in flat per-kind arrays instead of a full ECS. At this size
 * that is faster to read, faster to run, and trivial to serialise. The rule that keeps
 * the door open for an ECS later: systems never store references to entities across
 * frames, they only ever hold ids.
 */

export type Team = "player" | "enemy";

/**
 * The movement state machine. A dive is a commitment: you launch, you land on the
 * floor, and you have to get up again. That commitment is the tactical cost that
 * makes it a decision rather than a dodge you spam.
 */
export type Stance = "stand" | "dive" | "prone" | "standUp";

export interface WeaponDef {
  name: string;
  /** Shots per second. */
  fireRate: number;
  bulletSpeed: number;
  damage: number;
  /** Half-spread in radians. */
  spread: number;
  pellets: number;
  magazine: number;
  reloadTime: number;
  /** Radians of kick added to facing per shot. */
  recoil: number;
  auto: boolean;
  range: number;
  /** How far the report carries, in world units. What the dead hear. */
  noise: number;
  /**
   * A melee weapon swings instead of firing. No bullets, no magazine, and quiet
   * enough that clearing a room with one does not call the next one — which is the
   * entire reason the first act of the ship has no gun in it.
   */
  melee?: boolean;
  /** Melee only: how far past the body the swing reaches, in world units. */
  reach?: number;
  /** Melee only: half-angle of the arc it sweeps, in radians. */
  arc?: number;
}

export const WEAPONS: Record<string, WeaponDef> = {
  /**
   * Melee. `magazine: 0` is what marks a weapon as ammo-less everywhere else — the
   * reload path, the HUD and the locker all read it rather than checking `melee`.
   */
  crowbar: {
    name: "Crowbar", fireRate: 1.8, bulletSpeed: 0, damage: 48, spread: 0,
    pellets: 0, magazine: 0, reloadTime: 0, recoil: 0, auto: false, range: 0,
    noise: 130, melee: true, reach: 46, arc: 0.85,
  },
  pipe: {
    name: "Pipe", fireRate: 2.3, bulletSpeed: 0, damage: 34, spread: 0,
    pellets: 0, magazine: 0, reloadTime: 0, recoil: 0, auto: false, range: 0,
    noise: 110, melee: true, reach: 40, arc: 0.95,
  },
  smg: {
    name: "SMG", fireRate: 9, bulletSpeed: 900, damage: 12, spread: 0.055,
    pellets: 1, magazine: 30, reloadTime: 1.3, recoil: 0.02, auto: true, range: 900,
    noise: 650,
  },
  shotgun: {
    name: "Shotgun", fireRate: 1.6, bulletSpeed: 780, damage: 9, spread: 0.16,
    pellets: 7, magazine: 6, reloadTime: 1.9, recoil: 0.09, auto: false, range: 500,
    noise: 850,
  },
  pistol: {
    name: "Pistol", fireRate: 5, bulletSpeed: 820, damage: 10, spread: 0.03,
    pellets: 1, magazine: 14, reloadTime: 1.0, recoil: 0.03, auto: false, range: 800,
    noise: 600,
  },
};

/**
 * What a weapon locker hands out: the next gun up from whatever you are carrying.
 *
 * Deliberately guns only. Melee weapons are a *loadout* — what a mission decides you
 * woke up holding — not a rung on this ladder, so anything not on the list counts as
 * below all of it. That is what makes the first locker on the ship hand an unarmed
 * squad a pistol rather than a second crowbar, and it is why the ladder does not have
 * to know which melee weapons exist.
 */
export const WEAPON_LADDER = ["pistol", "smg", "shotgun"] as const;

/**
 * The next gun up, or null when you are already carrying the best thing on the ship.
 * A locker that cannot upgrade you tops your magazine up instead — see `src/sim/devices.ts`.
 */
export function nextWeaponUp(current: WeaponDef): WeaponDef | null {
  const at = WEAPON_LADDER.findIndex((key) => WEAPONS[key] === current);
  if (at < 0) return WEAPONS[WEAPON_LADDER[0]];
  const next = WEAPON_LADDER[at + 1];
  return next ? WEAPONS[next] : null;
}

export interface Player {
  id: number;
  /** Input device driving this player. The only link between sim and hardware. */
  sourceId: string;
  color: string;
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  radius: number;
  facing: number;
  prevFacing: number;
  health: number;
  maxHealth: number;
  /** Co-op down-and-revive rather than instant death. */
  downed: boolean;
  bleedout: number;
  reviveProgress: number;
  weapon: WeaponDef;
  ammo: number;
  fireCooldown: number;
  reloadTimer: number;
  /** Where the body is: upright, mid-dive, on the floor, or getting back up. */
  stance: Stance;
  /** Seconds left in the current stance. Unused while standing. */
  stanceTimer: number;
  diveDirX: number;
  diveDirY: number;
  diveCooldown: number;
  /** Current lean, -1 left to +1 right, damped toward the input. */
  lean: number;
  /**
   * Where the player looks and shoots from. Equals the body position when upright and
   * slides sideways when leaning — the collision circle never moves, which is what
   * lets you peek round a corner without stepping into it.
   */
  eyeX: number;
  eyeY: number;
  stamina: number;
  maxStamina: number;
  /** Counts down before stamina starts coming back, so tapping sprint is not free. */
  staminaDelay: number;
  /** Ran the tank dry — sprint stays locked out until stamina recovers past a floor. */
  exhausted: boolean;
  /** Counts down to the next sprinting footfall. Only sprinting makes noise. */
  stepNoise: number;
  muzzleFlash: number;
  hurtFlash: number;
  kills: number;
  /** 0 = weapon at rest, 1 = shouldered and ready. Only a raised weapon can fire. */
  weaponUp: number;
  /** Keeps the weapon up through brief lulls, so small aim corrections do not bob it. */
  weaponHold: number;
  cone: VisionLight;
  halo: VisionLight;
}

/**
 * A hostile. Today every one of them is a zombie — `kind` names the row in
 * `ZOMBIE_DEFS` it takes its numbers from, which is how a second kind arrives without
 * a second entity type. `Enemy` stays the faction word, `kind` is what it actually is.
 */
export interface Enemy {
  id: number;
  /** Key into ZOMBIE_DEFS. Stats are looked up, never copied, so a def edit is live. */
  kind: string;
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  radius: number;
  facing: number;
  health: number;
  maxHealth: number;
  /**
   * The zombie state machine.
   * - `hunt` — knows roughly where the squad is and is walking there, by flow field
   * - `wander` — shambling with no idea you exist
   * - `investigate` — walking to a noise or to where you last were
   * - `chase` — has you in sight and is closing
   * - `windup` — planted, telegraphing the leap. This is the window you dodge in
   * - `lunge` — committed to a direction, damage on contact
   * - `recover` — face down, cannot move or turn, takes extra damage
   */
  state: "wander" | "hunt" | "investigate" | "chase" | "windup" | "lunge" | "recover";
  /**
   * Came in with a wave, so it has a heading. A horde that spawns and then mills about
   * is not a horde. Ambient wanderers do not get this — being oblivious is their job.
   */
  hunting: boolean;
  /** Seconds left in windup / lunge / recover. Unused in the other states. */
  stateTimer: number;
  /** Locked in at the end of the windup: a lunge does not steer. */
  lungeDirX: number;
  lungeDirY: number;
  /** Player id this zombie is currently interested in, or -1. */
  targetId: number;
  /** Where it is walking to when it cannot see you: last sighting, or a noise. */
  lastSeenX: number;
  lastSeenY: number;
  alertness: number;
  /** Seconds before it may wind up another leap. */
  attackCooldown: number;
  wanderAngle: number;
  hurtFlash: number;
  /** Recomputed each step: is this enemy inside any player's vision right now? */
  visible: boolean;
}

export interface Bullet {
  active: boolean;
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  life: number;
  damage: number;
  team: Team;
  ownerId: number;
  color: string;
}

export interface Particle {
  active: boolean;
  x: number; y: number;
  vx: number; vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}
