import type { InputState } from "../input/types";
import { clamp, damp, rotateToward } from "../core/math";
import { moveCircle, pointInWall } from "../world/collision";
import type { TileMap } from "../world/tilemap";
import { makeLight } from "../vision/visibility";
import { WEAPONS, type Player, type WeaponDef } from "./entities";
import { ADRENALINE_RELOAD, ADRENALINE_SPEED, itemDef, spendCharge } from "./items";
import type { BulletPool, ParticlePool } from "./pools";
import { NOISE, type NoiseField } from "./noise";

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
/** Seconds between sprinting footfalls. Walking makes none at all. */
const STEP_INTERVAL = 0.3;
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
/**
 * The melee swing, as an animation with a hit in the middle of it rather than a hit
 * with an animation bolted on afterwards. The bar is already cocked whenever the weapon
 * is raised, so `MELEE_CONTACT` is early: a third of the way through the sweep, which
 * is the frame the renderer has the bar out in front of the body (see `meleeFrame` in
 * `src/render/actorArt.ts`). Damage resolves there, so what you watch connect connects.
 */
const SWING_TIME = 0.38;
const MELEE_CONTACT = 0.3;
/**
 * How far the body travels per half-stride, in world units. The gait cycle is advanced
 * by distance rather than by time, so the feet never skate at any speed.
 */
const STRIDE = 30;
/** How fast the shot kick decays. Drives the arms, the muzzle rise and the pump. */
const RECOIL_DECAY = 4.5;
/**
 * Light and aggro. A lit beam in a dead-dark room is a lure on the noise field: not a
 * sound, but the same thing a sound is — a reason for something to come and look. In a
 * room with its emergency lights still on it costs nothing, which is what makes "which
 * way round the deck" a real question.
 */
const LIGHT_TELL_INTERVAL = 0.9;
/** Seconds of washed-out vision from an arc flash. */
export const ARC_BLIND_TIME = 2.6;
/**
 * How much of the drag you can fight off by hauling the other way. Deliberately under
 * half: struggling should feel like it matters and never like it is the answer, because
 * the answer is somebody else cutting the thing.
 */
const STRUGGLE_RESIST = 0.35;
/** A failed item attempt does not retry until you let go. See `updateItem`. */
const ITEM_DECAY = 2.2;
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
    stepNoise: 0,
    muzzleFlash: 0,
    hurtFlash: 0,
    kills: 0,
    weaponUp: 0,
    weaponHold: 0,
    walkPhase: 0,
    item: null,
    itemCharges: 0,
    itemHold: 0,
    adrenaline: 0,
    // You wake up with it on. Turning it off is the decision, not turning it on.
    lightOn: true,
    lightTell: 0,
    blinded: 0,
    restraint: null,
    swingTimer: 0,
    swingTime: SWING_TIME,
    swingSide: 1,
    swingHit: true,
    recoil: 0,
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
  /** What the dead can hear. Walking is silent; shooting, sprinting and landing are not. */
  noise: NoiseField;
  /**
   * Resolve a melee swing: everything in the arc in front of `p` takes `damage`.
   * Returns how many things it connected with.
   *
   * A callback rather than an enemy list, for the same reason the zombie AI is handed
   * `hurtPlayer` rather than the player array: the player module has no business
   * knowing what an Enemy is, and kill accounting stays in one place in the world.
   */
  swing: (p: Player, reach: number, arc: number, damage: number) => number;
  /**
   * Spend the utility slot. Returns whether it was actually used — a welder with no
   * bulkhead under it, or a medkit on somebody already at full health, is refused and
   * keeps its charge. Same seam as `swing`: the player runs the clock, the world knows
   * what a flare lights.
   */
  useItem: (p: Player) => boolean;
  /**
   * Is this point lit by something other than a flashlight? Emergency lighting, a
   * lamp, a burning flare. Where it is true, having your beam on costs you nothing.
   */
  lit: (x: number, y: number) => boolean;
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
  p.recoil = Math.max(0, p.recoil - dt * RECOIL_DECAY);
  p.blinded = Math.max(0, p.blinded - dt);
  p.adrenaline = Math.max(0, p.adrenaline - dt);

  if (p.downed) {
    p.weaponUp = 0;
    p.weaponHold = 0;
    // Going down cancels a swing in flight: the bar never lands, so it never hits.
    p.swingTimer = 0;
    p.swingHit = true;
    p.itemHold = 0;
    // Whatever had hold of you has what it wanted. It lets go and looks for the next one.
    p.restraint = null;
    p.stance = "stand";
    p.stanceTimer = 0;
    p.lean = 0;
    updateDowned(p, input, deps, dt);
    return;
  }

  updateLight(p, input, deps, dt);
  updateItem(p, input, deps, dt);
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

  if (p.restraint !== null) {
    // Held. A pin puts you on the floor and keeps you there; a tendril hauls you toward
    // whatever threw it, and all your feet can do is take a little off the speed.
    applyRestraintDrag(p, input, dt);
  } else if (p.stance === "dive") {
    // Decelerating launch, so the dive covers ground and then puts you down.
    const t = 1 - p.stanceTimer / DIVE_TIME;
    const speed = DIVE_SPEED * Math.max(0, 1 - t);
    p.vx = p.diveDirX * speed;
    p.vy = p.diveDirY * speed;
  } else if (p.stance === "stand") {
    const speed = (sprinting ? SPRINT_SPEED : WALK_SPEED) * (p.adrenaline > 0 ? ADRENALINE_SPEED : 1);
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

  advanceSwing(p, deps, dt);
  advanceGait(p);

  // --- Shoot ---------------------------------------------------------------
  const w = p.weapon;
  p.fireCooldown = Math.max(0, p.fireCooldown - dt);
  const wantsToFire = w.auto ? input.fire : input.firePressed;

  if (w.magazine <= 0) {
    // Ammo-less: a crowbar has nothing to reload and never runs dry, so the only
    // question a swing has to answer is whether it is off cooldown.
    if (wantsToFire && p.fireCooldown <= 0 && p.weaponUp >= 1 && canFire(p)) fire(p, deps);
  } else if (p.reloadTimer > 0) {
    p.reloadTimer -= dt;
    if (p.reloadTimer <= 0) p.ammo = w.magazine;
  } else if (p.ammo <= 0) {
    // Running dry still reloads on its own — the manual button is for topping up
    // before you need it, which is the decision worth having.
    startReload(p, deps);
  } else if (input.reloadPressed && p.ammo < w.magazine && canFire(p)) {
    startReload(p, deps);
  } else {
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
  p.reloadTimer = p.weapon.reloadTime * (p.adrenaline > 0 ? ADRENALINE_RELOAD : 1);
  deps.particles.burst(p.x, p.y, 4, 55, "#8d8677", 0.45, 2);
}

/**
 * You can shoot standing or lying down, but not mid-dive and not while getting up —
 * and never while something has hold of you. That last clause is the load-bearing one:
 * a held player is a squad problem, and if they could shoot their way out it would not
 * be one.
 */
export function canFire(p: Player): boolean {
  if (p.restraint !== null) return false;
  return p.stance === "stand" || p.stance === "prone";
}

/**
 * Being dragged. The anchor and the speed both come off the restraint, refreshed by
 * whatever is holding you — so this stays true whether a tendril is reeling you in or
 * a Stalker is sitting on your chest (`pull` of zero, and you are going nowhere).
 */
function applyRestraintDrag(p: Player, input: InputState, dt: number): void {
  const r = p.restraint;
  if (r === null) return;
  r.time += dt;
  if (r.pull <= 0) {
    p.vx = damp(p.vx, 0, 22, dt);
    p.vy = damp(p.vy, 0, 22, dt);
    return;
  }
  const dx = r.anchorX - p.x;
  const dy = r.anchorY - p.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  // Hauling the other way takes a little off it. Only a little — see STRUGGLE_RESIST.
  const against = Math.max(0, -(input.moveX * ux + input.moveY * uy));
  const speed = r.pull * (1 - STRUGGLE_RESIST * against);
  p.vx = damp(p.vx, ux * speed, 14, dt);
  p.vy = damp(p.vy, uy * speed, 14, dt);
}

/**
 * Break whatever has hold of you, and say whether there was anything to break. The one
 * way a restraint ends from the victim's side — everything else (a severed tendril, a
 * dead Strangler, a shoved-off Stalker) ends it from the outside.
 */
export function breakFree(p: Player): boolean {
  if (p.restraint === null) return false;
  p.restraint = null;
  return true;
}

/**
 * The flashlight, and the price of having it on. In a room with power the beam is free.
 * In a dead-dark one it is a lure on the noise field every few seconds — which is the
 * whole of "light-dependent aggro": the dark is safer, and you cannot see in it.
 */
function updateLight(p: Player, input: InputState, deps: PlayerDeps, dt: number): void {
  if (input.lightPressed) {
    p.lightOn = !p.lightOn;
    p.lightTell = 0;
  }
  if (!p.lightOn) return;
  p.lightTell -= dt;
  if (p.lightTell > 0) return;
  p.lightTell = LIGHT_TELL_INTERVAL;
  if (!deps.lit(p.eyeX, p.eyeY)) deps.noise.emit(p.eyeX, p.eyeY, NOISE.beam, "beam");
}

/**
 * The utility slot. Everything here is clock-keeping: what the item DOES is the world's
 * business, reached through `deps.useItem`.
 *
 * A use is attempted on the single frame the dwell crosses its threshold. If the world
 * refuses it — a welder nowhere near a bulkhead — the hold keeps climbing and never
 * crosses again, so a refused item does not retry sixty times a second; let go and it
 * decays back below the line, ready for another try.
 */
function updateItem(p: Player, input: InputState, deps: PlayerDeps, dt: number): void {
  if (p.item === null) {
    p.itemHold = 0;
    return;
  }
  const def = itemDef(p.item);
  // Held, you cannot rummage — except for the one thing that is for exactly this.
  const allowed = p.restraint === null || p.item === "adrenaline";

  if (!allowed || !input.item) {
    p.itemHold = Math.max(0, p.itemHold - dt * ITEM_DECAY);
    return;
  }

  if (def.hold <= 0) {
    if (input.itemPressed && deps.useItem(p)) spendCharge(p);
    return;
  }

  const before = p.itemHold;
  p.itemHold += dt;
  if (before < def.hold && p.itemHold >= def.hold) {
    if (deps.useItem(p)) spendCharge(p);
  }
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
        deps.noise.emit(p.x, p.y, NOISE.dive, "impact");
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
    // Nothing dives with something sitting on it.
    p.restraint === null &&
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
    p.stepNoise -= dt;
    if (p.stepNoise <= 0) {
      p.stepNoise = STEP_INTERVAL;
      deps.noise.emit(p.x, p.y, NOISE.sprint, "step");
    }
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
  if (w.melee) { startSwing(p); return; }
  p.ammo--;
  p.muzzleFlash = 1;
  p.recoil = 1;

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
  // The loudest thing you can do. A shotgun carries further than an SMG.
  deps.noise.emit(mx, my, w.noise, "shot");
  p.facing += (Math.random() * 2 - 1) * w.recoil;
  // Recoil pushes you back a little. `p.recoil` above is the same kick as the arms and
  // the pump see; this is the half of it that moves the body rather than the weapon.
  p.vx -= Math.cos(p.facing) * 26;
  p.vy -= Math.sin(p.facing) * 26;
}

/**
 * Start a swing. Nothing is hurt yet — the bar has to get there first. The side
 * alternates so a flurry of swings is a flurry and not the same frame on a loop.
 */
function startSwing(p: Player): void {
  p.swingTimer = p.swingTime = Math.min(SWING_TIME, 1 / p.weapon.fireRate);
  p.swingSide = -p.swingSide;
  p.swingHit = false;
}

/**
 * Run the swing clock and resolve the hit the moment the bar is out in front. Split
 * from `startSwing` because a swing outlives the button press: the animation, the
 * damage and the noise all hang off this timer rather than off the input.
 */
function advanceSwing(p: Player, deps: PlayerDeps, dt: number): void {
  if (p.swingTimer <= 0) return;
  p.swingTimer = Math.max(0, p.swingTimer - dt);
  if (p.swingHit) return;
  if (1 - p.swingTimer / p.swingTime < MELEE_CONTACT) return;
  p.swingHit = true;
  resolveSwing(p, deps);
}

/** Gait cycle, advanced by ground covered this step. Not by time — feet would skate. */
function advanceGait(p: Player): void {
  const dist = Math.hypot(p.x - p.prevX, p.y - p.prevY);
  p.walkPhase = (p.walkPhase + (dist / STRIDE) * Math.PI) % (Math.PI * 2);
}

/**
 * A melee swing connecting. Everything in the arc in front of you takes the hit at
 * once, which is what makes a crowbar the answer to two zombies in a doorway and the
 * wrong answer to five in a corridor.
 *
 * It makes a noise, but a small one. That difference is the whole first act: a floor
 * cleared quietly stays cleared, and the first gun is a decision as much as a reward.
 */
function resolveSwing(p: Player, deps: PlayerDeps): void {
  const w = p.weapon;
  const reach = w.reach ?? 40;
  const arc = w.arc ?? 0.9;
  const tipX = p.eyeX + Math.cos(p.facing) * (p.radius + reach * 0.6);
  const tipY = p.eyeY + Math.sin(p.facing) * (p.radius + reach * 0.6);

  const hits = deps.swing(p, reach, arc, w.damage);
  // A connected swing throws blood; a miss throws the dust it hit instead, so the
  // player can tell the two apart without a hit marker.
  deps.particles.burst(tipX, tipY, hits > 0 ? 8 : 3, hits > 0 ? 150 : 70,
    hits > 0 ? "#c8443a" : "#9a9482", 0.3, 3);
  deps.noise.emit(p.x, p.y, hits > 0 ? w.noise : w.noise * 0.5, "impact");
  // A swing shoves you a little in the direction of it, at the moment it lands: the
  // sweep is drawn, but the body still has to look like it went with the bar.
  p.vx += Math.cos(p.facing) * 30;
  p.vy += Math.sin(p.facing) * 30;
}

/**
 * Hand a player a different weapon. Used by the mission loadout and by every weapon
 * locker on the ship, so "what happens when you pick something up" has one answer.
 */
export function giveWeapon(p: Player, weapon: WeaponDef): void {
  p.weapon = weapon;
  p.ammo = weapon.magazine;
  p.reloadTimer = 0;
  p.fireCooldown = Math.max(p.fireCooldown, 0.25);
  // Cancel a swing still in flight. Now that the hit lands partway through the sweep
  // rather than on the button press, a swing left running across a weapon change would
  // resolve with the new weapon's numbers — a pistol dealing crowbar damage at arm's
  // length. Picking something up puts the old one away.
  p.swingTimer = 0;
  p.swingHit = true;
}

function updateDowned(p: Player, input: InputState, deps: PlayerDeps, dt: number): void {
  p.bleedout -= dt;
  // Crawling: slow, no weapon, cone shrinks to a stub.
  p.vx = damp(p.vx, input.moveX * WALK_SPEED * 0.35, 10, dt);
  p.vy = damp(p.vy, input.moveY * WALK_SPEED * 0.35, 10, dt);
  const moved = moveCircle(deps.map, p.x, p.y, p.radius, p.vx * dt, p.vy * dt);
  p.x = moved.x;
  p.y = moved.y;
  advanceGait(p);
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

/**
 * Push the player's state into the two lights the vision system computes for them.
 *
 * Three things can take the cone away, and they are three different problems: the
 * switch is yours, an arc flash is a mistake you made, and fog is a room you walked
 * into. Only the last one leaves the halo — in coolant you can still see your own
 * boots, which is exactly enough to keep walking and not nearly enough to fight.
 *
 * `fog` is 0..1 thickness at the eye, handed in by the world because the player module
 * has no business reading the tile grid.
 */
export function syncLights(p: Player, fog = 0): void {
  const flash = 1 - Math.min(1, p.blinded / ARC_BLIND_TIME);
  // Fog eats the beam rather than blocking it: the light is still on, it just has
  // nothing to land on but the cloud in front of your face.
  const murk = 1 - Math.min(1, fog * 1.15);
  const power = p.lightOn ? flash * murk : 0;

  p.cone.x = p.eyeX;
  p.cone.y = p.eyeY;
  p.cone.facing = p.facing;
  p.cone.halfAngle = p.downed ? 0.7 : CONE_HALF_ANGLE;
  p.cone.range = (p.downed ? 210 : CONE_RANGE) * power;
  p.cone.intensity = (p.downed ? 0.5 : 1 + p.muzzleFlash * 0.35) * power;

  p.halo.x = p.eyeX;
  p.halo.y = p.eyeY;
  p.halo.facing = 0;
  // The halo is what is left when everything else is gone: your own feet, and not much
  // more. It dims in fog and in a flash, but it never goes out.
  p.halo.range = HALO_RANGE * (0.45 + 0.55 * Math.min(flash, murk));
}

export const PLAYER_TUNING = {
  WALK_SPEED, SPRINT_SPEED, STAMINA_MAX, SPRINT_DRAIN, LIGHT_TELL_INTERVAL,
  DIVE_TIME, PRONE_TIME, STAND_TIME, LEAN_OFFSET, BLEEDOUT, REVIVE_TIME, REVIVE_RANGE,
  SWING_TIME, MELEE_CONTACT, STRIDE,
};
