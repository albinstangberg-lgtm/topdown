import { damp, randRange, rotateToward, TAU } from "../core/math";
import { moveCircle } from "../world/collision";
import { hasLineOfSight } from "../world/raycast";
import type { TileMap } from "../world/tilemap";
import { inCone } from "../vision/visibility";
import type { Enemy, Player } from "./entities";
import type { ParticlePool } from "./pools";
import type { NoiseField } from "./noise";
import type { FlowField } from "../world/flow";
import { DEFAULT_ZOMBIE, zombieDef } from "./zombies";

/**
 * CORE 7 — Zombies and perception.
 *
 * A six-state machine, and every number it runs on comes from the row in `ZOMBIE_DEFS`
 * named by `e.kind` — so a new kind of zombie is a table entry, not a new file.
 *
 *   wander → hunt → investigate → chase → windup → lunge → recover
 *
 * They have two senses, and both are the ones the player already understands:
 *
 * - **Sight** is the same primitive the player's flashlight uses: a wide, short arc
 *   plus line of sight. Wide and short on purpose — walking past one head-on is hard,
 *   slipping behind it is easy. If a wall stops you seeing it, it cannot see you.
 * - **Hearing** goes through walls. A gunshot pulls a room toward you whether or not
 *   anything could have watched you fire, which is what stops shooting from cover
 *   being free.
 *
 * Neither sense tells a zombie where you are when it has never seen or heard you, and
 * a wave that spawns behind three walls would otherwise shamble around at random until
 * the fight found it. So a zombie that arrives WITH A WAVE is `hunting`: it reads a
 * heading off the squad flow field and walks the actual route to you. Ambient wanderers
 * do not get one — being oblivious is what they are for.
 *
 * The field is also what gets an investigating zombie round a corner. A noise it cannot
 * see the source of was almost always made by a player — a shot, a sprint, a pane going
 * out — so when the straight line to the noise is blocked, the squad field is the right
 * heading rather than a guess.
 *
 * They never shoot. The attack is a telegraphed leap you can dodge: it plants, it
 * winds up where you can see it, it commits to a direction, and if you are not there
 * any more it lands face down and takes extra damage while it gets up.
 */

const SEPARATION = 34;
/** World units per half-stride. Longer than a player's: they lurch. */
const ZOMBIE_STRIDE = 34;
/** How close is close enough when walking to a noise. */
const ARRIVED = 26;
/** Seconds of alertness a fresh sighting or a noise is worth. Decays in `investigate`. */
const ALERT_FULL = 1;

export function createEnemy(
  id: number, x: number, y: number, kind = DEFAULT_ZOMBIE, hunting = false,
): Enemy {
  const def = zombieDef(kind);
  return {
    id,
    kind: def.key,
    x, y, prevX: x, prevY: y,
    vx: 0, vy: 0,
    radius: def.radius,
    facing: randRange(0, TAU),
    health: def.health,
    maxHealth: def.health,
    state: hunting ? "hunt" : "wander",
    hunting,
    stateTimer: 0,
    lungeDirX: 0,
    lungeDirY: 0,
    targetId: -1,
    lastSeenX: 0,
    lastSeenY: 0,
    alertness: 0,
    attackCooldown: randRange(0, 0.6),
    wanderAngle: randRange(0, TAU),
    // Offset so a crowd of them does not step in lockstep.
    walkPhase: randRange(0, TAU),
    hurtFlash: 0,
    visible: false,
  };
}

export interface EnemyDeps {
  map: TileMap;
  particles: ParticlePool;
  noise: NoiseField;
  enemies: Enemy[];
  players: Player[];
  /** Distance-to-squad over the tile grid. The heading a hunting zombie walks. */
  squadFlow: FlowField;
  /** Distance to whatever is currently screaming, or an empty field when nothing is. */
  lureFlow: FlowField;
  /** How a bite reaches a player. The world owns damage, so it can raise the event. */
  hurtPlayer: (p: Player, amount: number) => void;
}

export function updateEnemy(e: Enemy, deps: EnemyDeps, dt: number): void {
  const def = zombieDef(e.kind);
  e.prevX = e.x;
  e.prevY = e.y;
  e.hurtFlash = Math.max(0, e.hurtFlash - dt * 4);
  e.attackCooldown = Math.max(0, e.attackCooldown - dt);
  e.stateTimer = Math.max(0, e.stateTimer - dt);

  // The leap is a commitment: nothing it perceives mid-flight changes where it lands.
  if (e.state === "windup" || e.state === "lunge" || e.state === "recover") {
    updateAttack(e, deps, dt);
    advanceGait(e);
    return;
  }

  const target = perceive(e, deps);

  let desiredX = 0;
  let desiredY = 0;
  let lookAngle = e.facing;
  let speed = def.wanderSpeed;

  if (target) {
    e.targetId = target.id;
    e.lastSeenX = target.x;
    e.lastSeenY = target.y;
    e.alertness = ALERT_FULL;

    const dx = target.x - e.x;
    const dy = target.y - e.y;
    const dist = Math.hypot(dx, dy) || 1;
    lookAngle = Math.atan2(dy, dx);

    if (dist <= def.lunge.range && e.attackCooldown <= 0) {
      // Plant and telegraph. Direction is not locked until the windup ends, so it
      // tracks you a little first and then commits — dodge late, not early.
      e.state = "windup";
      e.stateTimer = def.lunge.windup;
      e.vx = 0;
      e.vy = 0;
      e.facing = rotateToward(e.facing, lookAngle, 9 * dt);
      return;
    }

    e.state = "chase";
    speed = def.chaseSpeed;
    desiredX = dx / dist;
    desiredY = dy / dist;
  } else {
    // Nothing in sight. A noise it can hear beats whatever it was already doing.
    const heard = deps.noise.loudestAt(e.x, e.y, def.hearing);
    if (heard) {
      e.lastSeenX = heard.x;
      e.lastSeenY = heard.y;
      e.alertness = ALERT_FULL;
      e.targetId = -1;
    }

    // A car alarm outranks everything a zombie has its own opinion about.
    if (deps.lureFlow.goalCount > 0 && deps.lureFlow.steer(deps.map, e.x, e.y, heading)) {
      e.state = "investigate";
      e.alertness = ALERT_FULL;
      e.targetId = -1;
      speed = def.chaseSpeed;
      desiredX = heading.x;
      desiredY = heading.y;
      lookAngle = Math.atan2(heading.y, heading.x);
    } else if (e.alertness > 0) {
      e.state = "investigate";
      e.alertness -= dt * 0.25;
      const dx = e.lastSeenX - e.x;
      const dy = e.lastSeenY - e.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= ARRIVED) {
        // Arrived and found nothing: mill about, lose interest faster.
        e.alertness -= dt;
        lookAngle = e.facing + Math.sin(performance.now() * 0.002 + e.id) * 1.2;
      } else if (hasLineOfSight(deps.map, e.x, e.y, e.lastSeenX, e.lastSeenY)) {
        desiredX = dx / dist;
        desiredY = dy / dist;
        lookAngle = Math.atan2(dy, dx);
      } else if (deps.squadFlow.steer(deps.map, e.x, e.y, heading)) {
        // Can't see where the noise came from. A player made it, so the squad field
        // is a better guess than walking into the wall between here and there.
        desiredX = heading.x;
        desiredY = heading.y;
        lookAngle = Math.atan2(heading.y, heading.x);
      } else {
        desiredX = dx / dist;
        desiredY = dy / dist;
        lookAngle = Math.atan2(dy, dx);
      }
    } else if (e.hunting && deps.squadFlow.steer(deps.map, e.x, e.y, heading)) {
      // Came in with a wave: walk the route to the squad rather than wander into it.
      e.state = "hunt";
      e.targetId = -1;
      speed = def.chaseSpeed * 0.85;
      desiredX = heading.x;
      desiredY = heading.y;
      lookAngle = Math.atan2(heading.y, heading.x);
    } else {
      e.state = "wander";
      e.targetId = -1;
      e.wanderAngle += randRange(-1, 1) * dt * 2.2;
      desiredX = Math.cos(e.wanderAngle);
      desiredY = Math.sin(e.wanderAngle);
      lookAngle = e.wanderAngle;
    }
  }

  applySeparation(e, deps);
  desiredX += separation.x;
  desiredY += separation.y;

  e.vx = damp(e.vx, desiredX * speed, 8, dt);
  e.vy = damp(e.vy, desiredY * speed, 8, dt);

  const moved = moveCircle(deps.map, e.x, e.y, e.radius, e.vx * dt, e.vy * dt);
  if (moved.hitWall && e.state === "wander") e.wanderAngle += Math.PI * randRange(0.4, 1.2);
  e.x = moved.x;
  e.y = moved.y;

  e.facing = rotateToward(e.facing, lookAngle, 6 * dt);
  advanceGait(e);
}

/**
 * The shamble, advanced by ground covered rather than by time — same rule as the
 * player's gait, for the same reason: feet that move at the pace the body does.
 * Presentation reads it and nothing else does.
 */
function advanceGait(e: Enemy): void {
  const dist = Math.hypot(e.x - e.prevX, e.y - e.prevY);
  e.walkPhase = (e.walkPhase + (dist / ZOMBIE_STRIDE) * Math.PI) % TAU;
}

/** The three committed states. Nothing here looks at what the zombie can perceive. */
function updateAttack(e: Enemy, deps: EnemyDeps, dt: number): void {
  const def = zombieDef(e.kind);

  if (e.state === "windup") {
    // Track the target through the telegraph, then launch at wherever it ended up.
    const target = deps.players.find((p) => p.id === e.targetId && !p.downed);
    if (target) {
      const angle = Math.atan2(target.y - e.y, target.x - e.x);
      e.facing = rotateToward(e.facing, angle, 5 * dt);
    }
    e.vx = damp(e.vx, 0, 14, dt);
    e.vy = damp(e.vy, 0, 14, dt);
    if (e.stateTimer <= 0) {
      e.state = "lunge";
      e.stateTimer = def.lunge.duration;
      e.lungeDirX = Math.cos(e.facing);
      e.lungeDirY = Math.sin(e.facing);
      e.vx = e.lungeDirX * def.lunge.speed;
      e.vy = e.lungeDirY * def.lunge.speed;
    }
    return;
  }

  if (e.state === "lunge") {
    // Decelerating, so the leap covers ground and then puts it on the floor.
    const t = 1 - e.stateTimer / def.lunge.duration;
    const speed = def.lunge.speed * Math.max(0, 1 - t * 0.8);
    e.vx = e.lungeDirX * speed;
    e.vy = e.lungeDirY * speed;

    const moved = moveCircle(deps.map, e.x, e.y, e.radius, e.vx * dt, e.vy * dt);
    e.x = moved.x;
    e.y = moved.y;

    if (bite(e, deps, def.lunge.damage) || moved.hitWall || e.stateTimer <= 0) {
      e.state = "recover";
      e.stateTimer = def.lunge.recover;
      e.vx = 0;
      e.vy = 0;
    }
    return;
  }

  // recover: face down, no movement, no turning, and open to a free shot.
  e.vx = 0;
  e.vy = 0;
  if (e.stateTimer <= 0) {
    e.state = e.targetId >= 0 ? "chase" : "investigate";
    e.attackCooldown = def.lunge.cooldown;
  }
}

/** Contact damage, mid-leap only. Returns whether it connected. */
function bite(e: Enemy, deps: EnemyDeps, damage: number): boolean {
  for (const p of deps.players) {
    if (p.downed) continue;
    const reach = e.radius + p.radius;
    if (Math.hypot(p.x - e.x, p.y - e.y) > reach) continue;
    deps.particles.burst(p.x, p.y, 8, 150, "#c23b3b", 0.35, 3);
    deps.hurtPlayer(p, damage);
    return true;
  }
  return false;
}

/** Scratch vectors, so the AI loop never allocates. */
const separation = { x: 0, y: 0 };
const heading = { x: 0, y: 0 };

/** Keep zombies from piling into one blob. */
function applySeparation(e: Enemy, deps: EnemyDeps): void {
  separation.x = 0;
  separation.y = 0;
  for (const other of deps.enemies) {
    if (other === e || other.health <= 0) continue;
    const dx = e.x - other.x;
    const dy = e.y - other.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > SEPARATION * SEPARATION || d2 < 1e-4) continue;
    const d = Math.sqrt(d2);
    separation.x += (dx / d) * 0.8;
    separation.y += (dy / d) * 0.8;
  }
}

function perceive(e: Enemy, deps: EnemyDeps): Player | null {
  const def = zombieDef(e.kind);
  let best: Player | null = null;
  let bestDist = Infinity;
  for (const p of deps.players) {
    if (p.downed) continue;
    if (!inCone(e.x, e.y, e.facing, def.senseHalf, def.senseRange, p.x, p.y)) continue;
    if (!hasLineOfSight(deps.map, e.x, e.y, p.x, p.y)) continue;
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

/**
 * Damage. Being shot always wakes one up, and a zombie caught on the floor after a
 * missed leap takes its kind's `vulnerable` multiplier — the payoff for dodging.
 */
export function damageEnemy(e: Enemy, amount: number): boolean {
  const def = zombieDef(e.kind);
  e.health -= e.state === "recover" ? amount * def.vulnerable : amount;
  e.hurtFlash = 1;
  e.alertness = ALERT_FULL;
  return e.health <= 0;
}
