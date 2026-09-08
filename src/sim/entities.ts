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
}

export const WEAPONS: Record<string, WeaponDef> = {
  smg: {
    name: "SMG", fireRate: 9, bulletSpeed: 900, damage: 12, spread: 0.055,
    pellets: 1, magazine: 30, reloadTime: 1.3, recoil: 0.02, auto: true, range: 900,
  },
  shotgun: {
    name: "Shotgun", fireRate: 1.6, bulletSpeed: 780, damage: 9, spread: 0.16,
    pellets: 7, magazine: 6, reloadTime: 1.9, recoil: 0.09, auto: false, range: 500,
  },
  pistol: {
    name: "Pistol", fireRate: 5, bulletSpeed: 820, damage: 10, spread: 0.03,
    pellets: 1, magazine: 14, reloadTime: 1.0, recoil: 0.03, auto: false, range: 800,
  },
};

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
  stamina: number;
  maxStamina: number;
  /** Counts down before stamina starts coming back, so tapping sprint is not free. */
  staminaDelay: number;
  /** Ran the tank dry — sprint stays locked out until stamina recovers past a floor. */
  exhausted: boolean;
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

export interface Enemy {
  id: number;
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  radius: number;
  facing: number;
  health: number;
  maxHealth: number;
  speed: number;
  state: "patrol" | "alert" | "chase" | "attack";
  /** Player id this enemy is currently interested in, or -1. */
  targetId: number;
  lastSeenX: number;
  lastSeenY: number;
  alertness: number;
  fireCooldown: number;
  wanderAngle: number;
  hurtFlash: number;
  cone: VisionLight;
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
