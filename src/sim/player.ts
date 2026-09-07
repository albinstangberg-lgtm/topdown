import type { InputState } from "../input/types";
import { clamp, damp, rotateToward } from "../core/math";
import { moveCircle } from "../world/collision";
import type { TileMap } from "../world/tilemap";
import { makeLight } from "../vision/visibility";
import { WEAPONS, type Player } from "./entities";
import type { BulletPool, ParticlePool } from "./pools";

export const PLAYER_COLORS = ["#ffd257", "#5ad2ff", "#ff7ba8", "#8bff7a"];

const SPEED = 235;
const ACCEL = 18;            // exponential approach rate, not units/s^2
const DASH_SPEED = 720;
const DASH_TIME = 0.16;
const DASH_COOLDOWN = 0.85;
const TURN_RATE = 14;        // radians/second toward the aim direction
const CONE_HALF_ANGLE = 0.42; // ~48 degree cone, matching the reference art
const CONE_RANGE = 620;
const HALO_RANGE = 96;       // small always-on glow so you can see your own feet
const BLEEDOUT = 30;
const REVIVE_TIME = 2.2;
const REVIVE_RANGE = 62;

export function createPlayer(id: number, sourceId: string, x: number, y: number): Player {
  return {
    id,
    sourceId,
    color: PLAYER_COLORS[id % PLAYER_COLORS.length],
    x, y, prevX: x, prevY: y,
    vx: 0, vy: 0,
    radius: 15,
    facing: -Math.PI / 2,
    prevFacing: -Math.PI / 2,
    health: 100,
    maxHealth: 100,
    downed: false,
    bleedout: 0,
    reviveProgress: 0,
    weapon: WEAPONS.smg,
    ammo: WEAPONS.smg.magazine,
    fireCooldown: 0,
    reloadTimer: 0,
    dashTimer: 0,
    dashCooldown: 0,
    dashDirX: 0,
    dashDirY: 0,
    muzzleFlash: 0,
    hurtFlash: 0,
    kills: 0,
    cone: makeLight("#ffe9b0", CONE_HALF_ANGLE, CONE_RANGE, 1),
    halo: makeLight("#9fb4d0", Math.PI, HALO_RANGE, 0.34),
  };
}

export interface PlayerDeps {
  map: TileMap;
  bullets: BulletPool;
  particles: ParticlePool;
}

/**
 * One player, one simulation step. `aimAngle` is resolved by the game layer because
 * pointer aiming needs the camera — the sim itself stays screen-agnostic.
 */
export function updatePlayer(
  p: Player, input: InputState, aimAngle: number | null, deps: PlayerDeps, dt: number,
): void {
  p.prevX = p.x;
  p.prevY = p.y;
  p.prevFacing = p.facing;
  p.muzzleFlash = Math.max(0, p.muzzleFlash - dt * 8);
  p.hurtFlash = Math.max(0, p.hurtFlash - dt * 3);

  if (p.downed) {
    updateDowned(p, input, deps, dt);
    return;
  }

  // --- Aim -----------------------------------------------------------------
  if (aimAngle !== null) {
    p.facing = rotateToward(p.facing, aimAngle, TURN_RATE * dt);
  } else if (input.moveX !== 0 || input.moveY !== 0) {
    // No aim input: face where you are walking, so the cone is never behind you.
    p.facing = rotateToward(p.facing, Math.atan2(input.moveY, input.moveX), TURN_RATE * 0.6 * dt);
  }

  // --- Move ----------------------------------------------------------------
  p.dashCooldown = Math.max(0, p.dashCooldown - dt);
  if (input.dashPressed && p.dashCooldown <= 0 && (input.moveX !== 0 || input.moveY !== 0)) {
    const len = Math.hypot(input.moveX, input.moveY);
    p.dashDirX = input.moveX / len;
    p.dashDirY = input.moveY / len;
    p.dashTimer = DASH_TIME;
    p.dashCooldown = DASH_COOLDOWN;
    deps.particles.burst(p.x, p.y, 8, 120, "#ffffff", 0.25, 2);
  }

  if (p.dashTimer > 0) {
    p.dashTimer -= dt;
    p.vx = p.dashDirX * DASH_SPEED;
    p.vy = p.dashDirY * DASH_SPEED;
  } else {
    p.vx = damp(p.vx, input.moveX * SPEED, ACCEL, dt);
    p.vy = damp(p.vy, input.moveY * SPEED, ACCEL, dt);
  }

  const moved = moveCircle(deps.map, p.x, p.y, p.radius, p.vx * dt, p.vy * dt);
  p.x = moved.x;
  p.y = moved.y;
  if (moved.hitWall && p.dashTimer > 0) p.dashTimer = 0;

  // --- Shoot ---------------------------------------------------------------
  const w = p.weapon;
  p.fireCooldown = Math.max(0, p.fireCooldown - dt);

  if (p.reloadTimer > 0) {
    p.reloadTimer -= dt;
    if (p.reloadTimer <= 0) p.ammo = w.magazine;
  } else if (p.ammo <= 0) {
    p.reloadTimer = w.reloadTime;
  } else {
    const wantsToFire = w.auto ? input.fire : input.firePressed;
    if (wantsToFire && p.fireCooldown <= 0) fire(p, deps);
  }

  syncLights(p);
}

function fire(p: Player, deps: PlayerDeps): void {
  const w = p.weapon;
  p.fireCooldown = 1 / w.fireRate;
  p.ammo--;
  p.muzzleFlash = 1;

  const muzzle = p.radius + 10;
  const mx = p.x + Math.cos(p.facing) * muzzle;
  const my = p.y + Math.sin(p.facing) * muzzle;

  for (let i = 0; i < w.pellets; i++) {
    const spread = (Math.random() * 2 - 1) * w.spread;
    deps.bullets.spawn(
      mx, my, p.facing + spread, w.bulletSpeed * (0.94 + Math.random() * 0.12),
      w.damage, "player", p.id, w.range / w.bulletSpeed, p.color,
    );
  }

  deps.particles.burst(mx, my, 3, 90, "#fff3c4", 0.12, 2);
  p.facing += (Math.random() * 2 - 1) * w.recoil;
  // Recoil pushes you back a little — free weight without an animation system.
  p.vx -= Math.cos(p.facing) * 26;
  p.vy -= Math.sin(p.facing) * 26;
}

function updateDowned(p: Player, input: InputState, deps: PlayerDeps, dt: number): void {
  p.bleedout -= dt;
  // Crawling: slow, no weapon, cone shrinks to a stub.
  p.vx = damp(p.vx, input.moveX * SPEED * 0.35, 10, dt);
  p.vy = damp(p.vy, input.moveY * SPEED * 0.35, 10, dt);
  const moved = moveCircle(deps.map, p.x, p.y, p.radius, p.vx * dt, p.vy * dt);
  p.x = moved.x;
  p.y = moved.y;
  syncLights(p);
}

/** CORE 6 — teammates pick each other up. Returns true when someone was revived. */
export function updateRevives(
  players: Player[], inputOf: (p: Player) => InputState, dt: number,
): Player | null {
  for (const target of players) {
    if (!target.downed) continue;
    let beingRevived = false;
    for (const helper of players) {
      if (helper === target || helper.downed) continue;
      const d = Math.hypot(helper.x - target.x, helper.y - target.y);
      if (d > REVIVE_RANGE) continue;
      if (!inputOf(helper).interact) continue;
      beingRevived = true;
      break;
    }
    target.reviveProgress = clamp(
      target.reviveProgress + (beingRevived ? dt : -dt * 0.6), 0, REVIVE_TIME,
    );
    if (target.reviveProgress >= REVIVE_TIME) {
      target.downed = false;
      target.reviveProgress = 0;
      target.health = target.maxHealth * 0.5;
      target.ammo = target.weapon.magazine;
      return target;
    }
  }
  return null;
}

export function damagePlayer(p: Player, amount: number): void {
  if (p.downed) return;
  p.health -= amount;
  p.hurtFlash = 1;
  if (p.health <= 0) {
    p.health = 0;
    p.downed = true;
    p.bleedout = BLEEDOUT;
    p.reviveProgress = 0;
  }
}

export function syncLights(p: Player): void {
  p.cone.x = p.x;
  p.cone.y = p.y;
  p.cone.facing = p.facing;
  p.cone.halfAngle = p.downed ? 0.7 : CONE_HALF_ANGLE;
  p.cone.range = p.downed ? 210 : CONE_RANGE;
  p.cone.intensity = p.downed ? 0.5 : 1 + p.muzzleFlash * 0.35;

  p.halo.x = p.x;
  p.halo.y = p.y;
  p.halo.facing = 0;
  p.halo.range = HALO_RANGE;
}

export const PLAYER_TUNING = { SPEED, DASH_COOLDOWN, BLEEDOUT, REVIVE_TIME, REVIVE_RANGE };
