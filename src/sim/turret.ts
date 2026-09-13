import { TILE, type TileMap } from "../world/tilemap";
import { hasLineOfSight, raycast } from "../world/raycast";
import type { Player } from "./entities";

/**
 * CORE 22 — The guns the ship points at its own corridors.
 *
 * A turret is the only hostile in the game that is not alive: it does not path, it does
 * not investigate, it cannot be lured, and nothing it does is affected by the dark. It
 * sits on its post and denies a piece of floor.
 *
 * It exists to make the console worth the risk. Everything else on the deck can be
 * solved by shooting it or running away from it; this can be solved by neither, and the
 * answer — somebody standing still at a screen for eight seconds while the rest of the
 * squad covers them — is the mechanic the whole round is built around.
 *
 * Three things keep it fair, and all three are readable from across a room:
 *
 * - **It sweeps.** The cone is drawn, it moves slowly, and it is looking somewhere
 *   specific at all times. Crossing behind it is a plan.
 * - **It takes a second to decide.** Between seeing you and shooting you there is a
 *   sight window with a tell on it, which is exactly long enough to get behind cover.
 * - **It fires bullets.** Real ones, out of the same pool players use, so they can be
 *   ducked, blocked by geometry, and watched coming. Nothing here is hitscan.
 *
 * It is IFF-keyed to a crew list nobody on this ship is still on, which is the in-world
 * reason it shoots the squad and ignores the horde — and the design reason is simpler:
 * a turret that thinned the horde for you would be a turret you leave switched on.
 */

export interface Turret {
  tx: number;
  ty: number;
  x: number;
  y: number;
  /** The middle of its arc: worked out at build time from where the room actually is. */
  home: number;
  facing: number;
  /** Which way the sweep is going. */
  dir: 1 | -1;
  state: "sweep" | "sight" | "fire" | "cool";
  timer: number;
  /** Who it is looking at, or -1. */
  targetId: number;
  /** Rounds left in the burst it is firing. */
  shots: number;
}

/** How far it can see and shoot. Most of a long room. */
export const TURRET_RANGE = TILE * 7.5;
/** Half-angle of the cone it can see inside, and how far either side of home it sweeps. */
const TURRET_CONE = 0.5;
const SWEEP_ARC = 0.85;
const SWEEP_RATE = 0.65;
/** Seconds between seeing somebody and shooting them. The tell lives in this window. */
const SIGHT_TIME = 0.9;
/** How fast it tracks once it has you. Slower than a sprint, which is the counterplay. */
const TRACK_RATE = 2.1;
/** The burst, and the pause afterwards. */
const BURST = 4;
const SHOT_INTERVAL = 0.17;
const COOL_TIME = 1.3;
export const TURRET_DAMAGE = 7;
const BULLET_SPEED = 900;
const BULLET_SPREAD = 0.05;
/** How far the report carries. A turret going off tells the whole deck where you are. */
export const TURRET_NOISE = 620;

export interface TurretDeps {
  map: TileMap;
  players: Player[];
  /** Fire one round from the turret. The world owns the bullet pool. */
  fire: (x: number, y: number, angle: number, damage: number, speed: number) => void;
  /** A gunshot, on the same field the horde listens to. */
  noise: (x: number, y: number, radius: number) => void;
}

/** Build the live turrets for a freshly loaded floor. */
export function buildTurrets(map: TileMap): Turret[] {
  return map.turrets.map((t) => ({
    tx: t.tx, ty: t.ty, x: t.x, y: t.y,
    home: homeAngle(map, t.x, t.y),
    facing: homeAngle(map, t.x, t.y),
    dir: 1,
    state: "sweep",
    timer: 0,
    targetId: -1,
    shots: 0,
  }));
}

/**
 * Which way a turret faces by default: down the longest open line from its post. An
 * author who drops one in a corridor gets a turret covering the corridor without having
 * to say so, which is the same courtesy the car renderer does with its bounding box.
 */
function homeAngle(map: TileMap, x: number, y: number): number {
  let best = 0;
  let bestDist = -1;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const d = raycast(map, x, y, Math.cos(a), Math.sin(a), TURRET_RANGE, "shot");
    if (d > bestDist) { bestDist = d; best = a; }
  }
  return best;
}

export function updateTurret(t: Turret, deps: TurretDeps, dt: number): void {
  const target = pick(t, deps);

  if (t.state === "cool") {
    t.timer -= dt;
    if (t.timer <= 0) { t.state = "sweep"; t.targetId = -1; }
    sweep(t, dt);
    return;
  }

  if (!target) {
    // Lost them. It does not go straight back to sweeping — it holds the last bearing
    // for a moment, which is what makes ducking behind a crate and waiting feel tense
    // rather than free.
    if (t.state === "sight" || t.state === "fire") {
      t.state = "cool";
      t.timer = 0.6;
      t.shots = 0;
    }
    sweep(t, dt);
    return;
  }

  t.targetId = target.id;
  const want = Math.atan2(target.y - t.y, target.x - t.x);
  t.facing = turnToward(t.facing, want, TRACK_RATE * dt);

  if (t.state === "sweep") {
    t.state = "sight";
    t.timer = SIGHT_TIME;
    return;
  }

  if (t.state === "sight") {
    t.timer -= dt;
    if (t.timer > 0) return;
    t.state = "fire";
    t.shots = BURST;
    t.timer = 0;
    return;
  }

  // Firing.
  t.timer -= dt;
  if (t.timer > 0) return;
  const spread = (Math.random() * 2 - 1) * BULLET_SPREAD;
  deps.fire(
    t.x + Math.cos(t.facing) * (TILE * 0.4), t.y + Math.sin(t.facing) * (TILE * 0.4),
    t.facing + spread, TURRET_DAMAGE, BULLET_SPEED,
  );
  deps.noise(t.x, t.y, TURRET_NOISE);
  t.shots--;
  t.timer = SHOT_INTERVAL;
  if (t.shots <= 0) {
    t.state = "cool";
    t.timer = COOL_TIME;
  }
}

/** The nearest player it can actually see, inside its cone. */
function pick(t: Turret, deps: TurretDeps): Player | null {
  let best: Player | null = null;
  let bestDist = Infinity;
  for (const p of deps.players) {
    // A downed player is not a target. Finishing somebody on the floor is the horde's
    // job, and a turret that did it would make a downed teammate unreachable.
    if (p.downed) continue;
    const dist = Math.hypot(p.x - t.x, p.y - t.y);
    if (dist > TURRET_RANGE || dist >= bestDist) continue;
    // Once it has you, it keeps you as long as it can see you at all — otherwise
    // stepping a few degrees out of a cone that is already tracking you would drop it.
    const arc = t.state === "sweep" ? TURRET_CONE : Math.PI * 0.75;
    if (Math.abs(angleDelta(Math.atan2(p.y - t.y, p.x - t.x), t.facing)) > arc) continue;
    if (!hasLineOfSight(deps.map, t.x, t.y, p.x, p.y)) continue;
    best = p;
    bestDist = dist;
  }
  return best;
}

/** The idle arc, ping-ponging either side of home. */
function sweep(t: Turret, dt: number): void {
  t.facing += t.dir * SWEEP_RATE * dt;
  const off = angleDelta(t.facing, t.home);
  if (off > SWEEP_ARC) { t.facing = t.home + SWEEP_ARC; t.dir = -1; }
  if (off < -SWEEP_ARC) { t.facing = t.home - SWEEP_ARC; t.dir = 1; }
}

function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function turnToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(to, from);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

/** 0..1 — how far through the sight window it is, for the tell the renderer draws. */
export function turretLock(t: Turret): number {
  if (t.state === "fire") return 1;
  if (t.state !== "sight") return 0;
  return 1 - Math.max(0, t.timer) / SIGHT_TIME;
}
