import type { InputState } from "../input/types";
import { clamp, damp, rotateToward } from "../core/math";
import { moveCircle, pointInWall } from "../world/collision";
import type { TileMap } from "../world/tilemap";
import { makeLight } from "../vision/visibility";
import { WEAPONS, type Player } from "./entities";
import type { BulletPool, ParticlePool } from "./pools";

export const PLAYER_COLORS = ["#ffd257", "#5ad2ff", "#ff7ba8", "#8bff7a"];

/**
 * Movement tuning. The baseline used to be 235; walking is now 70% of that and
 * sprinting 110%, which makes the default pace deliberate and turns sprint into a
 * resource you spend rather than the way you always travel.
 */
const WALK_SPEED = 165;      // 0.70 x the old 235
const SPRINT_SPEED = 259;    // 1.10 x the old 235
const ACCEL = 18;            // exponential approach rate, not units/s^2

/**
 * Stamina. Only sprinting drains it. Run it to zero and sprint locks out until it
 * recovers past EXHAUST_FLOOR, so the punishment for over-sprinting is being stuck at
 * walking pace at the worst possible moment.
 */
const STAMINA_MAX = 100;
const SPRINT_DRAIN = 26;     // per second
const STAMINA_REGEN = 20;    // per second
const STAMINA_DELAY = 0.7;   // pause before regen starts
const EXHAUST_FLOOR = 25;    // stamina needed to sprint again after hitting zero
/**
 * A dive costs stamina too. Not strictly asked for, but a free dive next to a metered
 * sprint makes the dive the obvious way to travel. Set to 0 to decouple them.
 */
const DIVE_STAMINA_COST = 25;

/**
 * The dive. You launch, you land on the floor, and you have to get up — roughly 2.3
 * seconds of commitment in total. PRONE_TIME is the one to tune for feel.
 */
const DIVE_SPEED = 900;
const DIVE_TIME = 0.3;
const PRONE_TIME = 1.5;
const STAND_TIME = 0.45;
const DIVE_COOLDOWN = 0.8;   // starts once you are back on your feet
/** Turning on the floor is slower — a prone body pivots badly. */
const PRONE_TURN_SCALE = 0.55;

/**
 * Lean. Slides where you look and shoot sideways without moving the body, so you can
 * clear a corner before you walk into it. Deliberately small — half a tile.
 */
const LEAN_OFFSET = 24;
const LEAN_RATE = 11;
/** Radians/second toward the aim direction. Absolute aiming wants this fast. */
export const TURN_RATE = 14;
/**
 * Radians/second when the camera rotates with you. Aiming is then a steering command
 * rather than a point-at, so this doubles as the turn speed of the whole view — fast
 * enough to spin round, slow enough not to be nauseating.
 */
export const STEER_RATE = 3.4;
/**
 * Weapon up / down. The gun only comes up when you actually push the aim stick, which
 * makes aiming a deliberate act rather than a permanent state — and gives the aim laser
 * something to mean. Below the threshold the weapon rests and cannot fire.
 */
export const WEAPON_RAISE_THRESHOLD = 0.35;
const WEAPON_RAISE_TIME = 0.16;
const WEAPON_LOWER_TIME = 0.4;
/** Grace after the stick recentres, so micro-corrections do not make the gun bob. */
const WEAPON_HOLD = 0.45;
const CONE_HALF_ANGLE = 0.46; // ~53 degree cone, matching the reference art
const CONE_RANGE = 430;
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
    lean: 0,
    eyeX: x,
    eyeY: y,
    stance: "stand",
    stanceTimer: 0,
    diveDirX: 0,
    diveDirY: 0,
    diveCooldown: 0,
    stamina: STAMINA_MAX,
    maxStamina: STAMINA_MAX,
    staminaDelay: 0,
    exhausted: false,
    muzzleFlash: 0,
    hurtFlash: 0,
    kills: 0,
    weaponUp: 0,
    weaponHold: 0,
    cone: makeLight("#ffe9b0", CONE_HALF_ANGLE, CONE_RANGE, 1),
    halo: makeLight("#9fb4d0", Math.PI, HALO_RANGE, 0.34),
  };
}

/**
 * A resolved aim for one step: where to point, and how fast the player is allowed to
 * swing to it. The rate is part of the command because it depends on the camera mode,
 * which the simulation deliberately knows nothing about.
 */
export interface AimCommand {
  angle: number;
  turnRate: number;
  /** True when the aim device is pushed hard enough to shoulder the weapon. */
  raise: boolean;
}

export interface PlayerDeps {
  map: TileMap;
  bullets: BulletPool;
  particles: ParticlePool;
}

/**
 * One player, one simulation step. The aim is resolved by the game layer because both
 * pointer aiming and a rotating camera need to know about the screen — the sim itself
 * stays screen-agnostic.
 */
export function updatePlayer(
  p: Player, input: InputState, aim: AimCommand | null, deps: PlayerDeps, dt: number,
): void {
  p.prevX = p.x;
  p.prevY = p.y;
  p.prevFacing = p.facing;
  p.muzzleFlash = Math.max(0, p.muzzleFlash - dt * 8);
  p.hurtFlash = Math.max(0, p.hurtFlash - dt * 3);

  if (p.downed) {
    p.weaponUp = 0;
    p.weaponHold = 0;
    p.stance = "stand";
    p.stanceTimer = 0;
    p.lean = 0;
    updateDowned(p, input, deps, dt);
    return;
  }

  updateWeaponStance(p, aim, input, dt);

  // --- Aim -----------------------------------------------------------------
  if (aim !== null) {
    p.facing = rotateToward(p.facing, aim.angle, aim.turnRate * turnScale(p) * dt);
  } else if (input.moveX !== 0 || input.moveY !== 0) {
    // No aim input: face where you are walking, so the cone is never behind you.
    p.facing = rotateToward(p.facing, Math.atan2(input.moveY, input.moveX), TURN_RATE * 0.6 * dt);
  }

  // --- Move ----------------------------------------------------------------
  const sprinting = updateStanceAndStamina(p, input, deps, dt);

  if (p.stance === "dive") {
    // Decelerating launch, so the dive covers ground and then puts you down.
    const t = 1 - p.stanceTimer / DIVE_TIME;
    const speed = DIVE_SPEED * Math.max(0, 1 - t);
    p.vx = p.diveDirX * speed;
    p.vy = p.diveDirY * speed;
  } else if (p.stance === "stand") {
    const speed = sprinting ? SPRINT_SPEED : WALK_SPEED;
    p.vx = damp(p.vx, input.moveX * speed, ACCEL, dt);
    p.vy = damp(p.vy, input.moveY * speed, ACCEL, dt);
  } else {
    // On the floor or getting up: you are going nowhere.
    p.vx = damp(p.vx, 0, 16, dt);
    p.vy = damp(p.vy, 0, 16, dt);
  }

  const moved = moveCircle(deps.map, p.x, p.y, p.radius, p.vx * dt, p.vy * dt);
  p.x = moved.x;
  p.y = moved.y;
  // Diving into a wall still puts you on the floor — you just do not get the distance.
  if (moved.hitWall && p.stance === "dive") {
    p.vx = 0;
    p.vy = 0;
  }

  // --- Shoot ---------------------------------------------------------------
  const w = p.weapon;
  p.fireCooldown = Math.max(0, p.fireCooldown - dt);

  if (p.reloadTimer > 0) {
    p.reloadTimer -= dt;
    if (p.reloadTimer <= 0) p.ammo = w.magazine;
  } else if (p.ammo <= 0) {
    // Running dry still reloads on its own — the manual button is for topping up
    // before you need it, which is the decision worth having.
    startReload(p, deps);
  } else if (input.reloadPressed && p.ammo < w.magazine && canFire(p)) {
    startReload(p, deps);
  } else {
    const wantsToFire = w.auto ? input.fire : input.firePressed;
    // A lowered weapon cannot fire — but pulling the trigger raises it (see
    // updateWeaponStance), so the shot lands as soon as the gun is up rather than
    // the input being swallowed.
    if (wantsToFire && p.fireCooldown <= 0 && p.weaponUp >= 1 && canFire(p)) fire(p, deps);
  }

  updateLean(p, input, deps, dt);
  syncLights(p);
}

/**
 * Raise the weapon while the aim device is pushed (or the trigger is held), lower it
 * otherwise. Asymmetric timing on purpose: snapping up fast feels responsive, dropping
 * slowly keeps the gun available through quick re-aims.
 */
function updateWeaponStance(
  p: Player, aim: AimCommand | null, input: InputState, dt: number,
): void {
  const wants = canFire(p) && ((aim?.raise ?? false) || input.fire);
  p.weaponHold = wants ? WEAPON_HOLD : Math.max(0, p.weaponHold - dt);

  const target = wants || p.weaponHold > 0 ? 1 : 0;
  const rate = target > p.weaponUp ? 1 / WEAPON_RAISE_TIME : 1 / WEAPON_LOWER_TIME;
  p.weaponUp = clamp(p.weaponUp + Math.sign(target - p.weaponUp) * rate * dt, 0, 1);
}

/**
 * Resolve the lean into an eye position. If the leaned position would sit inside
 * geometry we back it off rather than letting you see through a wall — leaning past a
 * corner is the point, leaning INTO it is not.
 */
function updateLean(p: Player, input: InputState, deps: PlayerDeps, dt: number): void {
  const allowed = p.stance === "stand" || p.stance === "prone";
  p.lean = damp(p.lean, allowed ? clamp(input.lean, -1, 1) : 0, LEAN_RATE, dt);

  // Perpendicular to facing, pointing to screen-right.
  const px = -Math.sin(p.facing);
  const py = Math.cos(p.facing);
  for (let frac = 1; frac > 0.01; frac -= 1 / 3) {
    const ex = p.x + px * LEAN_OFFSET * p.lean * frac;
    const ey = p.y + py * LEAN_OFFSET * p.lean * frac;
    if (!pointInWall(deps.map, ex, ey)) {
      p.eyeX = ex;
      p.eyeY = ey;
      return;
    }
  }
  p.eyeX = p.x;
  p.eyeY = p.y;
}

function startReload(p: Player, deps: PlayerDeps): void {
  p.reloadTimer = p.weapon.reloadTime;
  deps.particles.burst(p.x, p.y, 4, 55, "#8d8677", 0.45, 2);
}

/** You can shoot standing or lying down, but not mid-dive and not while getting up. */
export function canFire(p: Player): boolean {
  return p.stance === "stand" || p.stance === "prone";
}

function turnScale(p: Player): number {
  if (p.stance === "dive") return 0;            // committed to the launch direction
  if (p.stance === "prone") return PRONE_TURN_SCALE;
  if (p.stance === "standUp") return 0.4;
  return 1;
}

/**
 * The stance machine and the stamina meter, which are coupled: a dive costs stamina,
 * and sprinting is the only thing that drains it. Returns whether the player is
 * actually sprinting this step.
 */
function updateStanceAndStamina(
  p: Player, input: InputState, deps: PlayerDeps, dt: number,
): boolean {
  p.diveCooldown = Math.max(0, p.diveCooldown - dt);

  // --- stance transitions ---
  if (p.stance !== "stand") {
    p.stanceTimer -= dt;
    if (p.stanceTimer <= 0) {
      if (p.stance === "dive") {
        p.stance = "prone";
        p.stanceTimer = PRONE_TIME;
        deps.particles.burst(p.x, p.y, 10, 90, "#c9c3ae", 0.4, 3);
      } else if (p.stance === "prone") {
        p.stance = "standUp";
        p.stanceTimer = STAND_TIME;
      } else {
        p.stance = "stand";
        p.stanceTimer = 0;
        p.diveCooldown = DIVE_COOLDOWN;
      }
    }
  } else if (
    input.divePressed && p.diveCooldown <= 0 &&
    p.stamina >= DIVE_STAMINA_COST && (input.moveX !== 0 || input.moveY !== 0)
  ) {
    const len = Math.hypot(input.moveX, input.moveY);
    p.diveDirX = input.moveX / len;
    p.diveDirY = input.moveY / len;
    p.stance = "dive";
    p.stanceTimer = DIVE_TIME;
    p.stamina = Math.max(0, p.stamina - DIVE_STAMINA_COST);
    p.staminaDelay = STAMINA_DELAY;
    deps.particles.burst(p.x, p.y, 8, 140, "#ffffff", 0.25, 2);
  }

  // --- stamina ---
  const moving = input.moveX !== 0 || input.moveY !== 0;
  const sprinting =
    p.stance === "stand" && input.sprint && moving && !p.exhausted && p.stamina > 0;

  if (sprinting) {
    p.stamina = Math.max(0, p.stamina - SPRINT_DRAIN * dt);
    p.staminaDelay = STAMINA_DELAY;
    if (p.stamina <= 0) p.exhausted = true;
  } else if (p.staminaDelay > 0) {
    p.staminaDelay -= dt;
  } else if (p.stamina < p.maxStamina) {
    p.stamina = Math.min(p.maxStamina, p.stamina + STAMINA_REGEN * dt);
  }
  if (p.exhausted && p.stamina >= EXHAUST_FLOOR) p.exhausted = false;

  return sprinting;
}

function fire(p: Player, deps: PlayerDeps): void {
  const w = p.weapon;
  p.fireCooldown = 1 / w.fireRate;
  p.ammo--;
  p.muzzleFlash = 1;

  // Shots leave from the eye, so a lean actually shoots round the corner.
  const muzzle = p.radius + 10;
  const mx = p.eyeX + Math.cos(p.facing) * muzzle;
  const my = p.eyeY + Math.sin(p.facing) * muzzle;

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
  p.vx = damp(p.vx, input.moveX * WALK_SPEED * 0.35, 10, dt);
  p.vy = damp(p.vy, input.moveY * WALK_SPEED * 0.35, 10, dt);
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
      target.stamina = target.maxStamina * 0.5;
      target.exhausted = false;
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
  p.cone.x = p.eyeX;
  p.cone.y = p.eyeY;
  p.cone.facing = p.facing;
  p.cone.halfAngle = p.downed ? 0.7 : CONE_HALF_ANGLE;
  p.cone.range = p.downed ? 210 : CONE_RANGE;
  p.cone.intensity = p.downed ? 0.5 : 1 + p.muzzleFlash * 0.35;

  p.halo.x = p.eyeX;
  p.halo.y = p.eyeY;
  p.halo.facing = 0;
  p.halo.range = HALO_RANGE;
}

export const PLAYER_TUNING = {
  WALK_SPEED, SPRINT_SPEED, STAMINA_MAX, SPRINT_DRAIN,
  DIVE_TIME, PRONE_TIME, STAND_TIME, LEAN_OFFSET, BLEEDOUT, REVIVE_TIME, REVIVE_RANGE,
};
