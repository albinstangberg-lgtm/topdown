import { damp, randRange, rotateToward, TAU } from "../core/math";
import { moveCircle } from "../world/collision";
import { hasLineOfSight } from "../world/raycast";
import type { TileMap } from "../world/tilemap";
import { inCone, makeLight } from "../vision/visibility";
import type { Enemy, Player } from "./entities";
import type { BulletPool, ParticlePool } from "./pools";

/**
 * CORE 7 — Enemies and perception.
 *
 * The AI is a 4-state machine driven by the same vision primitive the player uses:
 * an enemy sees you when you are inside its cone AND it has line of sight. That
 * symmetry is what makes a light-and-shadow shooter readable — if you cannot see
 * them through the wall, they cannot see you either.
 */

const CONE_HALF = 0.55;
// Pulled in to match the tighter camera: an enemy that can shoot you from off-screen
// is not a difficulty setting, it is a bug you feel.
const CONE_RANGE = 300;
const ATTACK_RANGE = 210;
const SEPARATION = 34;

export function createEnemy(id: number, x: number, y: number): Enemy {
  return {
    id,
    x, y, prevX: x, prevY: y,
    vx: 0, vy: 0,
    radius: 14,
    facing: randRange(0, TAU),
    health: 40,
    maxHealth: 40,
    speed: randRange(105, 140),
    state: "patrol",
    targetId: -1,
    lastSeenX: 0,
    lastSeenY: 0,
    alertness: 0,
    fireCooldown: randRange(0.4, 1.6),
    wanderAngle: randRange(0, TAU),
    hurtFlash: 0,
    visible: false,
    cone: makeLight("#ff5a5a", CONE_HALF, CONE_RANGE, 0.55),
  };
}

export interface EnemyDeps {
  map: TileMap;
  bullets: BulletPool;
  particles: ParticlePool;
  enemies: Enemy[];
  players: Player[];
}

export function updateEnemy(e: Enemy, deps: EnemyDeps, dt: number): void {
  e.prevX = e.x;
  e.prevY = e.y;
  e.hurtFlash = Math.max(0, e.hurtFlash - dt * 4);
  e.fireCooldown -= dt;

  const target = perceive(e, deps);

  let desiredX = 0;
  let desiredY = 0;
  let lookAngle = e.facing;

  if (target) {
    e.targetId = target.id;
    e.lastSeenX = target.x;
    e.lastSeenY = target.y;
    e.alertness = 1;

    const dx = target.x - e.x;
    const dy = target.y - e.y;
    const dist = Math.hypot(dx, dy) || 1;
    lookAngle = Math.atan2(dy, dx);

    if (dist > ATTACK_RANGE * 0.8) {
      e.state = "chase";
      desiredX = dx / dist;
      desiredY = dy / dist;
    } else {
      e.state = "attack";
      // Strafe rather than stand still, so a firefight has movement in it.
      const strafe = Math.sin(performance.now() * 0.001 + e.id) * 0.7;
      desiredX = -dy / dist * strafe;
      desiredY = dx / dist * strafe;
      if (dist < ATTACK_RANGE * 0.45) { desiredX -= dx / dist * 0.6; desiredY -= dy / dist * 0.6; }
      if (e.fireCooldown <= 0) shoot(e, lookAngle, deps);
    }
  } else if (e.alertness > 0) {
    // Lost sight: walk to where the player last was before giving up.
    e.state = "alert";
    e.alertness -= dt * 0.25;
    const dx = e.lastSeenX - e.x;
    const dy = e.lastSeenY - e.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 24) {
      desiredX = dx / dist;
      desiredY = dy / dist;
      lookAngle = Math.atan2(dy, dx);
    } else {
      e.alertness -= dt;
      lookAngle = e.facing + Math.sin(performance.now() * 0.002 + e.id) * 1.2;
    }
  } else {
    e.state = "patrol";
    e.targetId = -1;
    e.wanderAngle += randRange(-1, 1) * dt * 2.2;
    desiredX = Math.cos(e.wanderAngle) * 0.55;
    desiredY = Math.sin(e.wanderAngle) * 0.55;
    lookAngle = e.wanderAngle;
  }

  // Keep enemies from piling into one blob.
  for (const other of deps.enemies) {
    if (other === e || other.health <= 0) continue;
    const dx = e.x - other.x;
    const dy = e.y - other.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > SEPARATION * SEPARATION || d2 < 1e-4) continue;
    const d = Math.sqrt(d2);
    desiredX += (dx / d) * 0.8;
    desiredY += (dy / d) * 0.8;
  }

  const speed = e.state === "patrol" ? e.speed * 0.45 : e.speed;
  e.vx = damp(e.vx, desiredX * speed, 8, dt);
  e.vy = damp(e.vy, desiredY * speed, 8, dt);

  const moved = moveCircle(deps.map, e.x, e.y, e.radius, e.vx * dt, e.vy * dt);
  if (moved.hitWall && e.state === "patrol") e.wanderAngle += Math.PI * randRange(0.4, 1.2);
  e.x = moved.x;
  e.y = moved.y;

  e.facing = rotateToward(e.facing, lookAngle, 6 * dt);

  e.cone.x = e.x;
  e.cone.y = e.y;
  e.cone.facing = e.facing;
  e.cone.intensity = e.state === "patrol" ? 0.45 : 0.8;
}

function perceive(e: Enemy, deps: EnemyDeps): Player | null {
  let best: Player | null = null;
  let bestDist = Infinity;
  for (const p of deps.players) {
    if (p.downed) continue;
    if (!inCone(e.x, e.y, e.facing, CONE_HALF, CONE_RANGE, p.x, p.y)) continue;
    if (!hasLineOfSight(deps.map, e.x, e.y, p.x, p.y)) continue;
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

function shoot(e: Enemy, angle: number, deps: EnemyDeps): void {
  e.fireCooldown = randRange(0.75, 1.4);
  const spread = randRange(-0.09, 0.09);
  const mx = e.x + Math.cos(angle) * (e.radius + 8);
  const my = e.y + Math.sin(angle) * (e.radius + 8);
  deps.bullets.spawn(mx, my, angle + spread, 520, 9, "enemy", e.id, 1.4, "#ff6b6b");
  deps.particles.burst(mx, my, 2, 60, "#ffb0b0", 0.1, 2);
}

export function damageEnemy(e: Enemy, amount: number): boolean {
  e.health -= amount;
  e.hurtFlash = 1;
  e.alertness = 1;
  return e.health <= 0;
}
