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
import { NOISE } from "./noise";
import { updateLurker, updateStalker, updateStrangler } from "./mutants";

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
 * heading off the squad flow field and walks the actual route there. Ambient wanderers
 * do not get one — being oblivious is what they are for.
 *
 * The field is also what gets an investigating zombie round a corner. A noise it cannot
 * see the source of was almost always made by a player — a shot, a sprint, a pane going
 * out — so when the straight line to the noise is blocked, the field is a better
 * heading than walking into the wall between here and there.
 *
 * They never shoot. The attack is a telegraphed leap you can dodge: it plants, it
 * winds up where you can see it, it commits to a direction, and if you are not there
 * any more it lands face down and takes extra damage while it gets up.
 *
 * ---
 *
 * **They are braindead, and every rule here is written to keep them that way.**
 *
 * This is worth saying out loud because the obvious improvements to a zombie are all
 * improvements to its *judgement*, and a zombie with judgement is a soldier with a bad
 * skin. Everything below is deliberately a step in the other direction — the behaviour
 * got better by getting stupider, and if a future change here needs the word "decides",
 * it is probably the wrong change:
 *
 * - **They do not know where you are.** The field they walk is built from noises you
 *   made, not from your body — see `hunches` in `sim/world.ts`. Go quiet and it decays
 *   to nothing and they walk to where you *were*, then mill about there. The old field
 *   was rebuilt from live player positions, which meant a hunting zombie had a perfect,
 *   continuously updating route to you through geometry it had never seen. That is not
 *   a zombie. That is a guided munition.
 * - **They do not tell each other anything.** One that sees you groans, and a groan is
 *   a noise on the same field a gunshot rides. The rest do not learn a fact; they hear
 *   something and walk at it. Kill the first one fast and nothing was ever said.
 * - **They have eyes, not insight.** Sight range scales with how lit you are, because
 *   eyes need photons — not because anything is reasoning about cover. A beam in a dark
 *   room is a lamp you are carrying, coolant fog blinds them exactly as it blinds you,
 *   and a suit running dark is a shape nothing sees until it is close enough to touch.
 * - **They fixate.** Once one has something in its eye it keeps it, even when a closer,
 *   softer target walks straight past. Picking the nearest player every frame was the
 *   smarter rule and it read as a machine re-evaluating; this reads as an animal.
 * - **They do not search.** One that walks to a noise and finds nothing does not sweep
 *   the room or check the next one. It keeps going roughly the way it was already
 *   going, loses interest, and blunders into whatever is there — which is more often
 *   you than any search pattern would have managed.
 * - **A body on the floor is food.** They will take a downed player over nothing at
 *   all, and they are slow to notice one, and they drop it the instant anything is
 *   upright. Nothing is being prioritised. It is just the only thing moving.
 */

const SEPARATION = 34;
/** World units per half-stride. Longer than a player's: they lurch. */
const ZOMBIE_STRIDE = 34;
/**
 * The gait cycle is `walkPhase`, which advances by PI per stride and wraps at TAU — so
 * halving it gives exactly one bucket per footfall, and a change of bucket is a foot
 * going down. The dead are not sneaking, and in a coolant bank their shuffling is the
 * only thing that tells you where they are: this is a *readability* number, not a
 * stealth one. A `silent` kind emits nothing at all.
 */
const SHAMBLE_PHASE = Math.PI;
/** How close is close enough when walking to a noise. */
const ARRIVED = 26;
/** Seconds of alertness a fresh sighting or a noise is worth. Decays in `investigate`. */
const ALERT_FULL = 1;
/**
 * Sight, as a fraction of a kind's `senseRange`. `DARK_SEEN` is what is left of you in
 * an unlit room with the beam off: the suit halo and nothing else, which for a walker
 * is about two tiles. `MAX_SEEN` caps a lit room plus a lit beam plus a muzzle flash,
 * so no stack of tells turns a walker into a sniper.
 */
const DARK_SEEN = 0.5;
const MAX_SEEN = 1.35;
/** A body on the floor is low, still, and not where anything is looking. */
const DOWNED_SEEN = 0.5;
/**
 * Seconds between groans while something has you in its eye. The first one is free —
 * the timer runs whenever it is not groaning, so a thing that has been quiet is loud
 * the instant it sees you.
 */
const GROAN_INTERVAL = 3.5;
/** How much of a downed player's bleedout one bite eats. See `damagePlayer`. */
const CHEW_BITE = 6;

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
    state: def.drop ? "roost" : def.lurks ? "lurk" : hunting ? "hunt" : "wander",
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
    lastStride: 0,
    hurtFlash: 0,
    visible: false,
    tendrilOut: 0,
    tendrilTargetId: -1,
    tendrilHealth: def.tendril?.health ?? 0,
    // A lurker's post is wherever it was put down. That is the whole of its patience.
    postX: x,
    postY: y,
    groanTimer: 0,
    pinTargetId: -1,
    blind: 0,
    litFor: 0,
    ventTimer: 0,
    ventFromX: x,
    ventFromY: y,
    ventToX: x,
    ventToY: y,
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
  /**
   * Is this point lit by something that stays put — a lamp, a burning flare? Not a
   * flashlight. The Ceiling Lurker reads it to decide whether the floor under its grate
   * is a place it is willing to come down, which is the whole of its counterplay.
   */
  lit: (x: number, y: number) => boolean;
}

export function updateEnemy(e: Enemy, deps: EnemyDeps, dt: number): void {
  const def = zombieDef(e.kind);
  e.prevX = e.x;
  e.prevY = e.y;
  e.hurtFlash = Math.max(0, e.hurtFlash - dt * 4);
  e.attackCooldown = Math.max(0, e.attackCooldown - dt);
  e.stateTimer = Math.max(0, e.stateTimer - dt);
  e.groanTimer = Math.max(0, e.groanTimer - dt);

  /*
   * The mutants get first refusal on the step. Each one takes only the frames its own
   * behaviour owns and hands back the rest — so a Stalker with nobody isolated, or a
   * Strangler that has been forced into a melee, falls through to the shared machine
   * below and behaves like the unusually unpleasant zombie it still is.
   */
  if (def.tendril && updateStrangler(e, deps, dt)) {
    advanceGait(e);
    shambleNoise(e, deps);
    return;
  }
  if (def.drop && updateLurker(e, deps, dt)) {
    advanceGait(e);
    return;
  }
  if (def.pounce && updateStalker(e, deps, dt)) {
    advanceGait(e);
    shambleNoise(e, deps);
    return;
  }

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

    // It has something in its eye, so it is loud about it. Not a signal and not a
    // call — a noise, on the field every other noise rides, and the rest of the floor
    // has ears. See `rousing` in `sim/noise.ts`.
    if (!def.silent && e.groanTimer <= 0) {
      e.groanTimer = GROAN_INTERVAL;
      deps.noise.emit(e.x, e.y, NOISE.groan, "groan", true);
    }

    if (target.downed) {
      // A body. Nothing leaps at something already lying down: it walks onto it and
      // keeps going. What a bite takes off a downed player is not health — they are
      // already at the floor — it is time, which is what makes hauling them out of the
      // room a thing you do now rather than after this fight.
      e.state = "chase";
      speed = def.chaseSpeed * 0.8;
      if (dist <= e.radius + target.radius + 6) {
        desiredX = 0;
        desiredY = 0;
        if (e.attackCooldown <= 0) {
          e.attackCooldown = def.lunge.cooldown;
          deps.particles.burst(target.x, target.y, 6, 110, "#c23b3b", 0.3, 2);
          deps.hurtPlayer(target, CHEW_BITE);
        }
      } else {
        desiredX = dx / dist;
        desiredY = dy / dist;
      }
    } else if (dist <= def.lunge.range && e.attackCooldown <= 0) {
      // Plant and telegraph. Direction is not locked until the windup ends, so it
      // tracks you a little first and then commits — dodge late, not early.
      e.state = "windup";
      e.stateTimer = def.lunge.windup;
      e.vx = 0;
      e.vy = 0;
      e.facing = rotateToward(e.facing, lookAngle, 9 * dt);
      return;
    } else {
      e.state = "chase";
      speed = def.chaseSpeed;
      desiredX = dx / dist;
      desiredY = dy / dist;
    }
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
        // Arrived and found nothing. It does not search — a search is a thing with a
        // plan. It keeps going roughly the way it was already going and loses interest
        // faster, which spreads a wave that all walked to one bang out across the deck
        // and blunders it into rooms no search pattern would have picked.
        //
        // (The wobble used to come off `performance.now()`, which put wall-clock time
        // inside a fixed-timestep simulation and made behaviour depend on frame rate.
        // The heading is state now, like everything else the sim runs on.)
        e.alertness -= dt;
        e.wanderAngle = rotateToward(e.wanderAngle, e.facing, 3 * dt)
          + randRange(-1, 1) * dt * 2.2;
        desiredX = Math.cos(e.wanderAngle);
        desiredY = Math.sin(e.wanderAngle);
        lookAngle = e.wanderAngle;
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
  shambleNoise(e, deps);
}

/**
 * A footfall, every couple of strides. Tagged as made by the dead so the horde does not
 * spend the mission walking toward its own shuffling — see `byDead` in `sim/noise.ts`.
 * What it IS for is the player: a ripple on the floor you can read when you cannot see.
 */
function shambleNoise(e: Enemy, deps: EnemyDeps): void {
  if (zombieDef(e.kind).silent) return;
  const stride = Math.floor(e.walkPhase / SHAMBLE_PHASE);
  if (stride === e.lastStride) return;
  e.lastStride = stride;
  if (Math.hypot(e.x - e.prevX, e.y - e.prevY) < 0.05) return;
  deps.noise.emit(e.x, e.y, NOISE.shamble, "step", true);
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
    // A body on the floor is not a miss. `damagePlayer` turns it into bleedout rather
    // than health, because there is nothing below downed to take.
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

/**
 * How far away a dead thing can pick this player out, as a fraction of its sense range.
 *
 * There is no cleverness in here and there must not be. It is not "the zombie reasons
 * about cover"; it is "eyes need photons", and every term is something that is either
 * throwing light at you or stopping light reaching you:
 *
 * - The floor you are standing on is lit by a lamp or a burning flare. You are a person
 *   in a lit room and there is nothing to be done about it.
 * - Your beam is on. You are carrying a lamp. The `beam` noise already tells the floor
 *   that somebody is in here; this is the other half — the thing looking your way can
 *   see who.
 * - You just fired. For a couple of seconds there was a flash where your face is.
 * - Coolant fog, at either end. It blinds them on exactly the terms it blinds you, and
 *   that makes a fog bank the one place on the ship you can genuinely hide.
 * - You are on the floor, downed. Low, still, and not where anything is looking.
 *
 * The floor is the suit halo. It is not on the battery and it never goes out, so a
 * player is never *invisible* — walking a black deck with the beam off makes you a
 * shape that nothing sees until it is close enough to bite you, which is a trade and
 * not a cheat code.
 */
export function visibleness(p: Player, lit: boolean, fog: number): number {
  let seen = DARK_SEEN;
  if (lit) seen = 1;
  if (p.lightOn && p.battery > 0) seen += 0.55;
  if (p.lightDip > 0) seen += 0.35;
  if (p.downed) seen *= DOWNED_SEEN;
  // Fog at the player's end. The looker's end is applied per enemy in `perceive`,
  // because it is the same for every player it might be looking at.
  return Math.min(seen, MAX_SEEN) * murk(fog);
}

/** What a thickness of coolant does to a sightline through it. */
export function murk(fog: number): number {
  return fog > 0 ? 1 - 0.9 * Math.min(1, fog) : 1;
}

/**
 * What this thing has its eye on, if anything.
 *
 * Two rules on top of "is it in the arc, is there a wall in the way", and both of them
 * are dumber than picking the nearest player:
 *
 * **Anything upright beats anything on the floor.** Not because a standing player is
 * the more dangerous one — nothing here knows that. Because a standing player is the
 * one that is moving.
 *
 * **It keeps what it has.** A zombie already looking at somebody does not re-run the
 * comparison every frame and swap to whoever drifted closer; it keeps going at the
 * thing it was going at until it cannot see it any more. This is strictly worse play
 * and it is the whole point: a horde that re-targets optimally reads as a formation,
 * and one that fixates reads as a pack of animals you can pull off a teammate by
 * making yourself the thing in front of one.
 */
function perceive(e: Enemy, deps: EnemyDeps): Player | null {
  const def = zombieDef(e.kind);
  // Coolant at this end, looked up once rather than once per player. `p.seenness` is
  // the other half and the world computes it once a step, because the cheap-looking
  // `lit` test behind it is a line-of-sight raycast per static light on the deck —
  // fine once per player, ruinous at players × enemies × lights.
  const here = murk(deps.map.fogAt(e.x, e.y));
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const p of deps.players) {
    const range = def.senseRange * p.seenness * here;
    if (!inCone(e.x, e.y, e.facing, def.senseHalf, range, p.x, p.y)) continue;
    if (!hasLineOfSight(deps.map, e.x, e.y, p.x, p.y)) continue;
    // Tiers, not weights: upright always outranks downed, and what it already had
    // always outranks what it did not, and distance only breaks ties inside those.
    const score = (p.downed ? 0 : 1e6) + (p.id === e.targetId ? 1e4 : 0)
      - Math.hypot(p.x - e.x, p.y - e.y);
    if (score > bestScore) { bestScore = score; best = p; }
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
