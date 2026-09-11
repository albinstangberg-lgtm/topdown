import { damp, randRange, rotateToward, TAU } from "../core/math";
import { moveCircle } from "../world/collision";
import { hasLineOfSight } from "../world/raycast";
import { inCone } from "../vision/visibility";
import type { Enemy, Player } from "./entities";
import { NOISE } from "./noise";
import { zombieDef } from "./zombies";
import type { EnemyDeps } from "./enemy";

/**
 * CORE 7c — The two mutants that do something a walker cannot.
 *
 * A walker is a pressure system: it comes at you, it telegraphs, you shoot it. Both
 * things in this file exist to break a habit the squad has already formed by the time
 * they meet one.
 *
 *   **The Strangler** breaks "the dark is empty". It never comes to you. It holds a
 *   corner outside your cone, reaches four hundred units, and drags whoever it catches
 *   away from the light. A held player cannot shoot, so the answer is never the person
 *   in trouble — it is a teammate's beam finding the tendril, and then cutting it.
 *
 *   **The Stalker** breaks "we can cover more ground apart". It reads the squad's
 *   overlapping cones and goes for whoever is outside them. Stay together and it will
 *   sit in the ducts all mission; split up and it takes the straggler off their feet.
 *
 * Both are one row in `ZOMBIE_DEFS` with an ability block on it (`tendril`, `pounce`)
 * — the same registry a walker comes from. What they do NOT share is a state machine,
 * which is why they live here rather than as more branches inside `updateEnemy`: an
 * ambusher and a pouncer have almost nothing in common except a body and a health bar.
 *
 * Each entry point returns whether it took the step. Anything it declines falls back
 * to the ordinary zombie machine, so a Stalker with nobody worth stalking still
 * shambles, still hears a gunshot, and still comes to look.
 */

/** How close a bullet has to pass to a tendril to cut it. Generous, on purpose. */
export const TENDRIL_SEVER_RADIUS = 16;
/** Seconds a fresh tendril takes to fly out to its target. Fast: this is not dodgeable. */
const TENDRIL_FLIGHT = 0.16;
/** How close a pinning Stalker sits to the body under it. */
const PIN_OFFSET = 10;
/** Seconds of ducting between two grates. Long enough to hear it coming. */
const VENT_TIME = 2.6;
/** How often something in the ducts scrapes loudly enough to place it. */
const DUCT_TELL = 0.55;
/**
 * How wide a player's cone counts as "covering" a teammate. Slightly narrower than the
 * real cone: the edge of somebody's light is not cover, and a Stalker knows it.
 */
const COVER_SCALE = 0.85;

// =============================================================================
// The Strangler
// =============================================================================

/**
 * Lurk, aim, throw, reel. Returns false for a Strangler with no ability block, or one
 * that has been dragged into an ordinary fight (a leap, a recovery) — those run on the
 * shared machine.
 */
export function updateStrangler(e: Enemy, deps: EnemyDeps, dt: number): boolean {
  const def = zombieDef(e.kind);
  const tendril = def.tendril;
  if (!tendril) return false;

  if (e.state === "reel") {
    reel(e, deps, dt);
    return true;
  }
  // Mid-leap or face-down: the shared machine owns those frames.
  if (e.state === "windup" || e.state === "lunge" || e.state === "recover") return false;

  // Winding up a throw. Losing the line cancels it — which is the counterplay: break
  // line of sight during the aim and nothing happens at all.
  if (e.state === "lurk" && e.tendrilTargetId >= 0) {
    const target = deps.players.find((p) => p.id === e.tendrilTargetId);
    // `stateTimer` is already run down for the step by `updateEnemy` before it hands
    // over — decrementing it again here would halve every windup in this file.
    if (!target || !reachable(e, target, deps, tendril.range)) {
      e.tendrilTargetId = -1;
      e.stateTimer = 0;
      return true;
    }
    e.facing = rotateToward(e.facing, Math.atan2(target.y - e.y, target.x - e.x), 4 * dt);
    holdPost(e, deps, dt);
    if (e.stateTimer <= 0) throwTendril(e, target, deps);
    return true;
  }

  e.attackCooldown = Math.max(0, e.attackCooldown - dt);
  holdPost(e, deps, dt);

  // Looking for a line. It sweeps its post slowly rather than staring at one wall.
  e.wanderAngle += randRange(-1, 1) * dt * 0.9;
  e.facing = rotateToward(e.facing, e.wanderAngle, 1.6 * dt);

  if (e.attackCooldown <= 0) {
    const mark = pickTendrilTarget(e, deps, tendril.range);
    if (mark) {
      e.state = "lurk";
      e.tendrilTargetId = mark.id;
      e.targetId = mark.id;
      e.stateTimer = tendril.aim;
      // The wind-up is audible. Everything this thing does happens in the dark, so it
      // has to be something you can hear as well as something you can see.
      deps.noise.emit(e.x, e.y, 210, "impact");
    }
  }
  return true;
}

/** Drift back to the post it was placed on. A Strangler that wanders is not an ambush. */
function holdPost(e: Enemy, deps: EnemyDeps, dt: number): void {
  const def = zombieDef(e.kind);
  const dx = e.postX - e.x;
  const dy = e.postY - e.y;
  const d = Math.hypot(dx, dy);
  if (d < 6) {
    e.vx = damp(e.vx, 0, 8, dt);
    e.vy = damp(e.vy, 0, 8, dt);
  } else {
    e.vx = damp(e.vx, (dx / d) * def.wanderSpeed, 6, dt);
    e.vy = damp(e.vy, (dy / d) * def.wanderSpeed, 6, dt);
  }
  const moved = moveCircle(deps.map, e.x, e.y, e.radius, e.vx * dt, e.vy * dt);
  e.x = moved.x;
  e.y = moved.y;
}

/**
 * Who is worth reaching for. Nearest wins, but only among players it can actually see a
 * line to — and never one already held, because two tendrils on one body is a bug that
 * reads as a bug.
 */
function pickTendrilTarget(e: Enemy, deps: EnemyDeps, range: number): Player | null {
  let best: Player | null = null;
  let bestD = Infinity;
  for (const p of deps.players) {
    if (p.downed || p.restraint !== null) continue;
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    if (d >= bestD || !reachable(e, p, deps, range)) continue;
    best = p;
    bestD = d;
  }
  return best;
}

function reachable(e: Enemy, p: Player, deps: EnemyDeps, range: number): boolean {
  if (p.downed) return false;
  if (Math.hypot(p.x - e.x, p.y - e.y) > range) return false;
  return hasLineOfSight(deps.map, e.x, e.y, p.x, p.y);
}

function throwTendril(e: Enemy, target: Player, deps: EnemyDeps): void {
  const def = zombieDef(e.kind);
  const tendril = def.tendril!;
  e.state = "reel";
  e.tendrilTargetId = target.id;
  e.tendrilHealth = tendril.health;
  e.tendrilOut = 0;
  e.stateTimer = 0;
  target.restraint = {
    kind: "tendril",
    byId: e.id,
    time: 0,
    shove: 0,
    anchorX: e.x,
    anchorY: e.y,
    pull: tendril.reel,
  };
  deps.particles.burst(target.x, target.y, 10, 170, "#b06ac0", 0.4, 3);
  deps.noise.emit(target.x, target.y, 260, "impact");
}

/** Holding somebody: refresh the anchor, bleed them, and notice when it ends. */
function reel(e: Enemy, deps: EnemyDeps, dt: number): void {
  const def = zombieDef(e.kind);
  const tendril = def.tendril!;
  const target = deps.players.find((p) => p.id === e.tendrilTargetId);

  // Four ways this ends, and all of them look the same from here: the rope is gone.
  const held =
    target !== undefined &&
    !target.downed &&
    target.restraint !== null &&
    target.restraint.kind === "tendril" &&
    target.restraint.byId === e.id &&
    e.tendrilHealth > 0;

  if (!held) {
    if (target?.restraint?.byId === e.id) target.restraint = null;
    e.state = "lurk";
    e.tendrilTargetId = -1;
    e.tendrilOut = 0;
    e.attackCooldown = tendril.cooldown;
    e.vx = 0;
    e.vy = 0;
    return;
  }

  e.tendrilOut = Math.min(1, e.tendrilOut + dt / TENDRIL_FLIGHT);
  const r = target.restraint!;
  r.anchorX = e.x;
  r.anchorY = e.y;
  r.pull = tendril.reel * e.tendrilOut;
  e.facing = rotateToward(e.facing, Math.atan2(target.y - e.y, target.x - e.x), 6 * dt);
  // It braces rather than walks: the player comes to it.
  e.vx = damp(e.vx, 0, 10, dt);
  e.vy = damp(e.vy, 0, 10, dt);
  deps.hurtPlayer(target, tendril.damage * dt * e.tendrilOut);
}

// =============================================================================
// The Stalker
// =============================================================================

/**
 * Stalk, pounce, pin — plus the ducts it uses to get somewhere better. Returns false
 * when there is nothing worth stalking, which drops it back to being an unusually
 * quiet zombie rather than leaving it standing still looking clever.
 */
export function updateStalker(e: Enemy, deps: EnemyDeps, dt: number): boolean {
  const def = zombieDef(e.kind);
  const pounce = def.pounce;
  if (!pounce) return false;

  e.blind = Math.max(0, e.blind - dt);
  updateBeamBlindness(e, deps, dt, pounce.blind, pounce.blindTime);

  switch (e.state) {
    case "vent": return ductTravel(e, deps, dt);
    case "pin": return pinning(e, deps, dt);
    case "pounce": return leaping(e, deps, dt);
    // A Stalker's windup is always the run-up to a pounce, never to a walker's hop, so
    // it has to be taken here. Handing it back would let the shared machine turn the
    // skitter into an ordinary lunge — which is a different attack with a different
    // counterplay, and the whole animal would quietly stop working.
    case "windup": return crouching(e, deps, dt);
  }
  if (e.state === "lunge" || e.state === "recover") return false;

  // Everything below is the hunt. No straggler, no hunt.
  const mark = pickStraggler(e, deps);
  if (!mark) {
    // Everyone is in everyone else's light. It gives up on this approach and goes
    // looking for a better door — which is what the ducts are for.
    if (def.vents && e.state !== "stalk" && enterVent(e, deps)) return true;
    return false;
  }

  e.targetId = mark.id;
  e.state = "stalk";
  e.attackCooldown = Math.max(0, e.attackCooldown - dt);

  const dx = mark.x - e.x;
  const dy = mark.y - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  const angle = Math.atan2(dy, dx);
  e.facing = rotateToward(e.facing, angle, 7 * dt);

  const canSee = hasLineOfSight(deps.map, e.x, e.y, mark.x, mark.y);
  if (
    canSee && dist <= pounce.range && e.blind <= 0 &&
    e.attackCooldown <= 0 && !mark.downed && mark.restraint === null
  ) {
    // The tell. This is the one moment a Stalker is loud, and it is the whole of the
    // counterplay for the player it has picked: turn round now.
    e.state = "windup";
    e.stateTimer = pounce.tell;
    e.vx = 0;
    e.vy = 0;
    deps.noise.emit(e.x, e.y, 320, "impact");
    return true;
  }

  // Creeping. Slower than a walker's shamble and completely silent — a Stalker closing
  // on you makes no footfall at all, which is why the skitter has to be so distinct.
  const speed = def.chaseSpeed * (e.blind > 0 ? 0.35 : 0.86);
  e.vx = damp(e.vx, (dx / dist) * speed, 7, dt);
  e.vy = damp(e.vy, (dy / dist) * speed, 7, dt);
  const moved = moveCircle(deps.map, e.x, e.y, e.radius, e.vx * dt, e.vy * dt);
  e.x = moved.x;
  e.y = moved.y;
  // Walked into a wall with a straggler on the far side: take the ceiling instead.
  if (moved.hitWall && !canSee && def.vents) enterVent(e, deps);
  return true;
}

/**
 * The whole point of the animal: find the player the rest of the squad is not looking
 * at. Coverage is how many OTHER players have them inside their cone — so a pair
 * watching each other's backs is safe and the one who wandered off is not.
 */
function pickStraggler(e: Enemy, deps: EnemyDeps): Player | null {
  const def = zombieDef(e.kind);
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const p of deps.players) {
    if (p.downed || p.restraint !== null) continue;
    if (coverageOf(p, deps) > 0) continue;   // somebody has eyes on them: not today
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    if (d > def.senseRange * 2.2) continue;
    // Nearest lonely player, with distance from their nearest teammate breaking ties:
    // the further from help, the better the target.
    const score = loneliness(p, deps) - d * 0.35;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

/** How many other players currently have this one inside their flashlight cone. */
export function coverageOf(p: Player, deps: EnemyDeps): number {
  let n = 0;
  for (const other of deps.players) {
    if (other === p || other.downed) continue;
    if (other.cone.range <= 1) continue;      // their light is off: they are covering nobody
    if (!inCone(
      other.eyeX, other.eyeY, other.facing,
      other.cone.halfAngle * COVER_SCALE, other.cone.range, p.x, p.y,
    )) continue;
    if (!hasLineOfSight(deps.map, other.eyeX, other.eyeY, p.x, p.y)) continue;
    n++;
  }
  return n;
}

/** Distance to the nearest living teammate. Alone on the map scores hugely. */
function loneliness(p: Player, deps: EnemyDeps): number {
  let nearest = 2000;
  for (const other of deps.players) {
    if (other === p || other.downed) continue;
    nearest = Math.min(nearest, Math.hypot(other.x - p.x, other.y - p.y));
  }
  return nearest;
}

/**
 * A beam held on it. High-intensity light in the face is the one thing that stops a
 * Stalker mid-air, so it is checked every step rather than only at the moment of the
 * leap — you have to be ON it, not lucky.
 */
function updateBeamBlindness(
  e: Enemy, deps: EnemyDeps, dt: number, needed: number, blindTime: number,
): void {
  let lit = false;
  for (const p of deps.players) {
    if (p.downed || p.cone.range <= 1) continue;
    // Half the cone's range, and the tight middle of it: this is a beam in the eyes,
    // not incidental illumination.
    const half = p.cone.halfAngle * 0.55;
    if (!inCone(p.eyeX, p.eyeY, p.facing, half, p.cone.range * 0.5, e.x, e.y)) continue;
    if (!hasLineOfSight(deps.map, p.eyeX, p.eyeY, e.x, e.y)) continue;
    lit = true;
    break;
  }
  if (!lit) {
    e.litFor = Math.max(0, e.litFor - dt * 1.5);
    return;
  }
  e.litFor += dt;
  if (e.litFor < needed) return;
  e.litFor = 0;
  e.blind = blindTime;
  deps.particles.burst(e.x, e.y, 8, 120, "#fff3c4", 0.35, 2);
  // Blinded out of a leap: it drops where it is and has to pick itself up.
  if (e.state === "pounce" || e.state === "windup") {
    e.state = "recover";
    e.stateTimer = zombieDef(e.kind).lunge.recover;
    e.vx = 0;
    e.vy = 0;
  }
}

/**
 * Coiled. It tracks you through the tell — dodging early does not work — and commits to
 * wherever you were when the timer ran out.
 */
function crouching(e: Enemy, deps: EnemyDeps, dt: number): boolean {
  const def = zombieDef(e.kind);
  const pounce = def.pounce!;
  const target = deps.players.find((p) => p.id === e.targetId && !p.downed);
  if (target) {
    e.facing = rotateToward(e.facing, Math.atan2(target.y - e.y, target.x - e.x), 6 * dt);
  }
  e.vx = damp(e.vx, 0, 16, dt);
  e.vy = damp(e.vy, 0, 16, dt);
  if (e.stateTimer > 0) return true;

  e.state = "pounce";
  e.stateTimer = pounce.duration;
  e.lungeDirX = Math.cos(e.facing);
  e.lungeDirY = Math.sin(e.facing);
  e.vx = e.lungeDirX * pounce.speed;
  e.vy = e.lungeDirY * pounce.speed;
  return true;
}

/** Committed. Nothing steers a pounce — but a beam can still knock it down. */
function leaping(e: Enemy, deps: EnemyDeps, dt: number): boolean {
  const def = zombieDef(e.kind);
  const pounce = def.pounce!;
  // Ditto: the shared step already took `dt` off the clock.
  const t = 1 - e.stateTimer / pounce.duration;
  const speed = pounce.speed * Math.max(0, 1 - t * 0.7);
  e.vx = e.lungeDirX * speed;
  e.vy = e.lungeDirY * speed;
  const moved = moveCircle(deps.map, e.x, e.y, e.radius, e.vx * dt, e.vy * dt);
  e.x = moved.x;
  e.y = moved.y;

  const caught = deps.players.find(
    (p) => !p.downed && p.restraint === null &&
      Math.hypot(p.x - e.x, p.y - e.y) < e.radius + p.radius + 6,
  );
  if (caught) {
    // Adrenaline is exactly one free escape, and this is what it is for.
    if (caught.adrenaline > 0) {
      caught.adrenaline = 0;
      deps.particles.burst(caught.x, caught.y, 12, 200, "#ffe66b", 0.4, 3);
      e.state = "recover";
      e.stateTimer = def.lunge.recover;
      e.vx = 0;
      e.vy = 0;
      return true;
    }
    pin(e, caught, deps);
    return true;
  }
  if (moved.hitWall || e.stateTimer <= 0) {
    e.state = "recover";
    e.stateTimer = def.lunge.recover;
    e.attackCooldown = pounce.duration + 1.2;
    e.vx = 0;
    e.vy = 0;
  }
  return true;
}

function pin(e: Enemy, target: Player, deps: EnemyDeps): void {
  e.state = "pin";
  e.pinTargetId = target.id;
  e.vx = 0;
  e.vy = 0;
  target.restraint = {
    kind: "pin", byId: e.id, time: 0, shove: 0,
    anchorX: e.x, anchorY: e.y, pull: 0,
  };
  deps.particles.burst(target.x, target.y, 14, 210, "#c23b3b", 0.45, 3);
  // Going down under one is loud. It is the only reason the rest of the squad knows.
  deps.noise.emit(target.x, target.y, 420, "impact");
}

/** Sitting on somebody. Ends when it is shoved off, shot off, or they stop moving. */
function pinning(e: Enemy, deps: EnemyDeps, dt: number): boolean {
  const def = zombieDef(e.kind);
  const pounce = def.pounce!;
  const target = deps.players.find((p) => p.id === e.pinTargetId);
  const held =
    target !== undefined && !target.downed &&
    target.restraint !== null && target.restraint.kind === "pin" &&
    target.restraint.byId === e.id;

  if (!held) {
    if (target?.restraint?.byId === e.id) target.restraint = null;
    e.state = "recover";
    e.stateTimer = def.lunge.recover;
    e.pinTargetId = -1;
    e.attackCooldown = pounce.duration + 1.5;
    return true;
  }

  const r = target.restraint!;
  // It rides the body: being dragged out from under it is not a thing.
  e.x = target.x + Math.cos(e.facing) * PIN_OFFSET;
  e.y = target.y + Math.sin(e.facing) * PIN_OFFSET;
  e.facing = rotateToward(e.facing, Math.atan2(target.y - e.y, target.x - e.x), 8 * dt);
  r.anchorX = e.x;
  r.anchorY = e.y;
  deps.hurtPlayer(target, pounce.damage * dt);

  if (r.shove >= pounce.shove) {
    target.restraint = null;
    e.state = "recover";
    e.stateTimer = def.lunge.recover * 1.6;
    e.pinTargetId = -1;
    e.attackCooldown = pounce.duration + 2;
    deps.particles.burst(e.x, e.y, 12, 220, "#dfe6f2", 0.4, 3);
  }
  return true;
}

// =============================================================================
// The ducts
// =============================================================================

/**
 * Climb into the ceiling and come out somewhere better. While it is up there it is not
 * in the room at all — nothing can touch it except a shot put through the grate it is
 * travelling under, which is why it scrapes loudly enough to be placed from below.
 */
export function enterVent(e: Enemy, deps: EnemyDeps): boolean {
  const vents = deps.map.vents;
  if (vents.length < 2) return false;
  // Nearest grate in, and a grate out that is near somebody and not the one it used.
  let from = vents[0];
  let fromD = Infinity;
  for (const v of vents) {
    const d = Math.hypot(v.x - e.x, v.y - e.y);
    if (d < fromD) { fromD = d; from = v; }
  }
  if (fromD > 400) return false;

  let to = from;
  let bestScore = -Infinity;
  for (const v of vents) {
    if (v === from) continue;
    let nearest = Infinity;
    for (const p of deps.players) {
      if (p.downed) continue;
      nearest = Math.min(nearest, Math.hypot(p.x - v.x, p.y - v.y));
    }
    if (nearest === Infinity) continue;
    // Close to somebody, but not right on top of them: it wants a flank, not a lap.
    const score = -Math.abs(nearest - 220);
    if (score > bestScore) { bestScore = score; to = v; }
  }
  if (to === from) return false;

  e.state = "vent";
  e.ventTimer = VENT_TIME;
  e.ventFromX = from.x;
  e.ventFromY = from.y;
  e.ventToX = to.x;
  e.ventToY = to.y;
  e.stateTimer = 0;
  e.vx = 0;
  e.vy = 0;
  return true;
}

/**
 * In the ceiling. It moves along the straight line between two grates, which is a lie
 * about ductwork and the right lie: the noise it makes has to be somewhere a player can
 * point at, and "above that grate over there" is a thing you can act on.
 */
function ductTravel(e: Enemy, deps: EnemyDeps, dt: number): boolean {
  e.ventTimer = Math.max(0, e.ventTimer - dt);
  const t = 1 - e.ventTimer / VENT_TIME;
  e.x = e.ventFromX + (e.ventToX - e.ventFromX) * t;
  e.y = e.ventFromY + (e.ventToY - e.ventFromY) * t;
  e.vx = 0;
  e.vy = 0;
  e.facing = Math.atan2(e.ventToY - e.ventFromY, e.ventToX - e.ventFromX);

  e.stateTimer -= dt;
  if (e.stateTimer <= 0) {
    e.stateTimer = DUCT_TELL;
    deps.noise.emit(e.x, e.y, NOISE.duct, "duct");
  }

  if (e.ventTimer <= 0) {
    // Drops out of the grate, and lands hard enough to be heard.
    e.state = "stalk";
    e.x = e.ventToX;
    e.y = e.ventToY;
    e.prevX = e.x;
    e.prevY = e.y;
    e.wanderAngle = randRange(0, TAU);
    deps.particles.burst(e.x, e.y, 12, 150, "#8d8677", 0.4, 3);
    deps.noise.emit(e.x, e.y, 240, "impact");
  }
  return true;
}

/** True while this enemy is up in the ceiling, where the floor cannot reach it. */
export function inDuct(e: Enemy): boolean {
  return e.state === "vent";
}
