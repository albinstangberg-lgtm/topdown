import { randRange } from "../core/math";
import { TILE, type TileMap } from "../world/tilemap";
import type { Enemy, Player } from "./entities";

/**
 * CORE 9 — The AI Director.
 *
 * Modelled on Left 4 Dead's, and for the same reason: a constant drip of enemies is
 * something you stop noticing after ninety seconds. Pressure has to have a shape —
 * quiet, a build, a peak, and then quiet again — and the shape has to be driven by
 * how the squad is actually doing rather than by a fixed timetable.
 *
 * Four phases, in a loop:
 *
 *   buildup → peak → fade → relax → buildup
 *
 * - **buildup** releases a wave every few seconds from one door at a time, until the
 *   squad's intensity crosses the peak threshold.
 * - **peak** holds there for a moment with nothing new arriving. The fight you are
 *   already in is the fight.
 * - **fade** stops spawning entirely and waits for intensity to come down.
 * - **relax** is a guaranteed quiet stretch — no waves at all, just the ambient
 *   wanderers, so the squad can move, reload and breathe.
 *
 * **Intensity** is the survivor-stress metric: it climbs when you take damage, when
 * zombies are close, and hard when someone goes down, and it decays whenever none of
 * that is happening. The squad's intensity is the worst player's, not the average —
 * one person being mauled is a peak even if the other three are fine.
 *
 * **Doors.** The zone tiles an author paints are clustered into groups of touching
 * tiles, and each group is a door. A wave comes out of ONE door, never the same one
 * twice running, and never one the squad can see. That is what makes a map with
 * several zones play differently each run: the same level, a different door each time.
 */

export type DirectorPhase = "buildup" | "peak" | "fade" | "relax";

export interface DirectorTuning {
  /** Wanderers kept alive at all times, per player. The map is never empty. */
  ambientPerPlayer: number;
  /** Zombies released per player in one wave. */
  wavePerPlayer: number;
  /** Hard ceiling on live zombies, per player. */
  maxAlivePerPlayer: number;
  /** Seconds between waves during buildup. */
  waveGap: [number, number];
  /** Seconds held at the peak with nothing new arriving. */
  peakHold: number;
  /** Seconds to wait for intensity to fall before giving up and relaxing anyway. */
  fadeMax: number;
  /** Seconds of guaranteed quiet. */
  relax: [number, number];
}

export const STORY_TUNING: DirectorTuning = {
  ambientPerPlayer: 1,
  wavePerPlayer: 5,
  maxAlivePerPlayer: 8,
  waveGap: [9, 16],
  peakHold: 4,
  fadeMax: 12,
  relax: [18, 30],
};

/** Survival is the endless mode: bigger waves, shorter breathers. */
export const SURVIVAL_TUNING: DirectorTuning = {
  ambientPerPlayer: 2,
  wavePerPlayer: 6,
  maxAlivePerPlayer: 12,
  waveGap: [7, 12],
  peakHold: 4,
  fadeMax: 10,
  relax: [12, 20],
};

/** Intensity at which the squad counts as peaking. */
const PEAK_INTENSITY = 0.85;
/** Intensity the squad has to come back down to before a relax can start. */
const CALM_INTENSITY = 0.25;
/** How fast intensity bleeds off with nothing happening. Per second. */
const INTENSITY_DECAY = 0.11;
/** A zombie inside this radius is stressful, whether or not it has connected. */
const THREAT_RADIUS = 190;
const THREAT_RATE = 0.16;      // per second, per nearby zombie, capped below
const THREAT_MAX_RATE = 0.45;  // however many are on you, stress rises at most this fast
const DOWNED_RATE = 0.5;       // per second while anyone is down
/** Intensity added per point of damage taken. 50 damage in one go is a full peak. */
const DAMAGE_STRESS = 0.02;

/** Tiles this far apart or closer belong to the same door. */
const DOOR_SPREAD = TILE * 1.6;
/** No wave lands closer than this to a player, seen or not. */
const MIN_WAVE_DISTANCE = 260;
/** Ambient wanderers keep the old, more generous clearance — they arrive alone. */
const AMBIENT_CLEARANCE = 620;
/**
 * If every door has been in view this long, take the furthest one anyway. A director
 * that can be starved by the squad standing in the open is a director that stops.
 */
const BLOCKED_PATIENCE = 6;

export interface Door {
  tiles: { x: number; y: number }[];
  cx: number;
  cy: number;
}

export interface DirectorDeps {
  map: TileMap;
  players: Player[];
  enemies: Enemy[];
  /** True when any player could see this point right now — the renderer's own test. */
  squadCanSee: (x: number, y: number) => boolean;
  /** Put one zombie here. The world owns ids and kinds. */
  spawn: (x: number, y: number) => void;
  /**
   * May a wave use plain floor when the map declares no zones? Survival says yes —
   * it is the endless mode and has to keep going. A story map says no: an authored
   * level only ever spawns where the author said it could.
   */
  allowFallback: boolean;
  /** Raised when a wave is released, so the game can shake the screen. */
  onWave: (x: number, y: number, count: number) => void;
}

export class Director {
  phase: DirectorPhase = "relax";
  /** 0 to 1. The worst player's stress, not the average. */
  intensity = 0;
  /** Seconds until the next wave. Only meaningful during buildup. */
  waveTimer = 4;
  /** Index of the door the last wave came from, or -1. Never used twice running. */
  lastDoor = -1;
  /** How many waves this floor has seen. Handy for the debug overlay. */
  waves = 0;

  private doors: Door[] = [];
  private phaseTimer = 0;
  private blockedFor = 0;
  private ambientTimer = 2;
  private stress = new Map<number, number>();
  private health = new Map<number, number>();

  constructor(private tuning: DirectorTuning) {}

  setTuning(tuning: DirectorTuning): void {
    this.tuning = tuning;
  }

  /**
   * Rebuild the doors from the map. Called on load and whenever the grid changes —
   * shooting out a window creates a new way in, and the director should know.
   */
  rebuild(map: TileMap): void {
    this.doors = clusterDoors(map.spawnZones);
    this.lastDoor = -1;
  }

  /** Fresh floor: quiet to start with, so the squad arrives before anything does. */
  reset(): void {
    this.phase = "relax";
    this.phaseTimer = randRange(4, 7);
    this.intensity = 0;
    this.waveTimer = randRange(...this.tuning.waveGap);
    this.waves = 0;
    this.blockedFor = 0;
    this.ambientTimer = 2;
    this.lastDoor = -1;
    this.stress.clear();
    this.health.clear();
  }

  get doorCount(): number {
    return this.doors.length;
  }

  update(dt: number, deps: DirectorDeps): void {
    if (deps.players.length === 0) return;
    this.updateIntensity(dt, deps);
    this.updatePhase(dt);
    this.updateAmbient(dt, deps);

    if (this.phase !== "buildup") return;

    const cap = this.tuning.maxAlivePerPlayer * deps.players.length;
    this.waveTimer -= dt;
    if (this.waveTimer > 0 || deps.enemies.length >= cap) return;

    const size = Math.min(
      this.tuning.wavePerPlayer * deps.players.length, cap - deps.enemies.length,
    );
    if (size <= 0) return;
    if (this.releaseWave(size, deps)) {
      this.waveTimer = randRange(...this.tuning.waveGap);
      this.blockedFor = 0;
    } else {
      // Nowhere to put them yet. Try again next step rather than losing the wave.
      this.blockedFor += dt;
    }
  }

  /**
   * Survivor stress. Rises with damage, with zombies in your lap, and with anyone
   * downed; decays the rest of the time. Damage is read by watching health rather
   * than by plumbing a callback through every source of it.
   */
  private updateIntensity(dt: number, deps: DirectorDeps): void {
    let worst = 0;
    for (const p of deps.players) {
      let s = this.stress.get(p.id) ?? 0;
      const before = this.health.get(p.id);
      if (before !== undefined && p.health < before) s += (before - p.health) * DAMAGE_STRESS;
      this.health.set(p.id, p.health);

      if (p.downed) {
        s += DOWNED_RATE * dt;
      } else {
        let near = 0;
        for (const e of deps.enemies) {
          if (Math.hypot(e.x - p.x, e.y - p.y) < THREAT_RADIUS) near++;
        }
        s += Math.min(near * THREAT_RATE, THREAT_MAX_RATE) * dt;
      }

      s = Math.max(0, Math.min(1, s - INTENSITY_DECAY * dt));
      this.stress.set(p.id, s);
      worst = Math.max(worst, s);
    }
    this.intensity = worst;
  }

  private updatePhase(dt: number): void {
    this.phaseTimer -= dt;
    switch (this.phase) {
      case "buildup":
        if (this.intensity >= PEAK_INTENSITY) {
          this.phase = "peak";
          this.phaseTimer = this.tuning.peakHold;
        }
        break;
      case "peak":
        if (this.phaseTimer <= 0) {
          this.phase = "fade";
          this.phaseTimer = this.tuning.fadeMax;
        }
        break;
      case "fade":
        // Either they got on top of it, or they have been at it long enough.
        if (this.intensity <= CALM_INTENSITY || this.phaseTimer <= 0) {
          this.phase = "relax";
          this.phaseTimer = randRange(...this.tuning.relax);
        }
        break;
      case "relax":
        if (this.phaseTimer <= 0) {
          this.phase = "buildup";
          this.waveTimer = randRange(0.5, 2.5);
        }
        break;
    }
  }

  /**
   * The wandering population. One at a time, well away from everyone, so the map is
   * never actually empty — including during a relax, which would otherwise read as
   * the level having run out.
   */
  private updateAmbient(dt: number, deps: DirectorDeps): void {
    const want = this.tuning.ambientPerPlayer * deps.players.length;
    if (deps.enemies.length >= want) return;
    this.ambientTimer -= dt;
    if (this.ambientTimer > 0) return;
    this.ambientTimer = 3;

    const spot = this.pickAmbientSpot(deps);
    if (spot) deps.spawn(spot.x, spot.y);
  }

  private improviseDoor(deps: DirectorDeps): Door | null {
    for (let attempt = 0; attempt < 30; attempt++) {
      const spot = deps.map.randomWalkable();
      if (!spot) return null;
      if (deps.squadCanSee(spot.x, spot.y)) continue;
      if (deps.players.some((p) => Math.hypot(p.x - spot.x, p.y - spot.y) < MIN_WAVE_DISTANCE)) continue;
      return improviseDoorFrom(deps, spot);
    }
    return null;
  }

  private pickAmbientSpot(deps: DirectorDeps): { x: number; y: number } | null {
    const clearance = Math.min(
      AMBIENT_CLEARANCE,
      Math.max(deps.map.worldWidth, deps.map.worldHeight) * 0.45,
    );
    const clear = (x: number, y: number) =>
      !deps.squadCanSee(x, y) &&
      deps.players.every((p) => Math.hypot(p.x - x, p.y - y) >= clearance);

    if (this.doors.length > 0) {
      const start = Math.floor(Math.random() * this.doors.length);
      for (let i = 0; i < this.doors.length; i++) {
        const door = this.doors[(start + i) % this.doors.length];
        const tile = door.tiles[Math.floor(Math.random() * door.tiles.length)];
        if (clear(tile.x, tile.y)) return tile;
      }
      return null;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const spot = deps.map.randomWalkable();
      if (spot && clear(spot.x, spot.y)) return spot;
    }
    return null;
  }

  /**
   * One wave, out of one door. Returns false when every door is currently watched or
   * too close, which is a reason to wait rather than to spawn something in the
   * squad's face — up to a point, after which the furthest door is used anyway.
   */
  private releaseWave(size: number, deps: DirectorDeps): boolean {
    const door = this.pickDoor(deps);
    if (!door) return false;

    // Spread the group across the door's tiles, cycling if the wave is wider than the
    // door. Deliberately no jitter: a spawn is always exactly on a tile the author
    // painted, and two zombies sharing one push apart on the first step anyway.
    const tiles = shuffled(door.tiles);
    for (let i = 0; i < size; i++) {
      const tile = tiles[i % tiles.length];
      deps.spawn(tile.x, tile.y);
    }
    this.lastDoor = this.doors.indexOf(door);   // -1 for an improvised one, which is fine
    this.waves++;
    deps.onWave(door.cx, door.cy, size);
    return true;
  }

  private pickDoor(deps: DirectorDeps): Door | null {
    if (this.doors.length === 0) {
      return deps.allowFallback ? this.improviseDoor(deps) : null;
    }

    const farEnough = (d: Door) =>
      deps.players.every((p) => Math.hypot(p.x - d.cx, p.y - d.cy) >= MIN_WAVE_DISTANCE);

    const candidates = this.doors.filter((d, i) => {
      if (i === this.lastDoor && this.doors.length > 1) return false;
      return farEnough(d);
    });
    if (candidates.length === 0) return null;

    const unseen = candidates.filter((d) => !deps.squadCanSee(d.cx, d.cy));
    if (unseen.length > 0) return unseen[Math.floor(Math.random() * unseen.length)];

    // Every door is in view. Hold off — but not forever, or standing in the open
    // in the middle of the map would switch the director off.
    if (this.blockedFor < BLOCKED_PATIENCE) return null;
    return candidates.reduce((best, d) => {
      const score = (c: Door) => Math.min(...deps.players.map((p) => Math.hypot(p.x - c.cx, p.y - c.cy)));
      return score(d) > score(best) ? d : best;
    });
  }
}

/**
 * A map with no zone tiles at all, in a mode that still has to produce waves: find an
 * unwatched patch of floor and treat it as a door for this one wave.
 */
function improviseDoorFrom(deps: DirectorDeps, seed: { x: number; y: number }): Door {
  const tiles = [seed];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = seed.x + dx * TILE;
      const y = seed.y + dy * TILE;
      if (!deps.map.isSolidAt(x, y)) tiles.push({ x, y });
    }
  }
  return { tiles, cx: seed.x, cy: seed.y };
}

/**
 * Group touching zone tiles into doors. A row of twelve zone tiles along one wall is
 * one way in, not twelve — treating them separately would make "pick a different door
 * each time" pick the tile next to the last one.
 */
export function clusterDoors(zones: readonly { x: number; y: number }[]): Door[] {
  const doors: Door[] = [];
  const used = new Set<number>();

  for (let i = 0; i < zones.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const tiles = [zones[i]];
    // Flood outward: anything touching anything already in the group joins it.
    for (let head = 0; head < tiles.length; head++) {
      for (let j = 0; j < zones.length; j++) {
        if (used.has(j)) continue;
        if (Math.hypot(zones[j].x - tiles[head].x, zones[j].y - tiles[head].y) > DOOR_SPREAD) continue;
        used.add(j);
        tiles.push(zones[j]);
      }
    }
    const cx = tiles.reduce((s, t) => s + t.x, 0) / tiles.length;
    const cy = tiles.reduce((s, t) => s + t.y, 0) / tiles.length;
    doors.push({ tiles, cx, cy });
  }
  return doors;
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
