import type { InputState } from "../input/types";
import { randRange } from "../core/math";
import type { TileMap } from "../world/tilemap";
import { buildTileMap, type LevelData } from "../world/level";
import { generateLevel } from "../world/generator";
import { makeLight } from "../vision/visibility";
import { circleOverlap, pointInWall } from "../world/collision";
import { computeVisibility, inCone, type VisionLight } from "../vision/visibility";
import { hasLineOfSight } from "../world/raycast";
import {
  createPlayer, damagePlayer, syncLights, updatePlayer, updateRevives, type AimCommand,
} from "./player";
import { createEnemy, damageEnemy, updateEnemy } from "./enemy";
import { BulletPool, ParticlePool } from "./pools";
import type { Enemy, Player } from "./entities";

/**
 * CORE 8 — The world / simulation root.
 *
 * Owns every entity and runs the systems in a fixed order each step. Rendering reads
 * from here but never writes to it. The whole state is plain data, so a save, a replay
 * or a network snapshot is a serialisation problem rather than a rewrite.
 */

const MAP_COLS = 56;
const MAP_ROWS = 42;
/** How far from every player an enemy has to spawn — never pop in inside someone's cone. */
const SPAWN_CLEARANCE = 620;
/** Survival: enemies alive on the field, per player. The local co-op difficulty knob. */
const ENEMIES_PER_PLAYER = 5;
/** Story: how much pressure the director adds ON TOP of the zombies you placed. */
const ZONE_ENEMIES_PER_PLAYER = 3;
/** Seconds the whole squad has to stand on the exit before the mission ends. */
const EXIT_DWELL = 0.8;

/**
 * Survival is the endless procedural mode. Story runs an authored map with placed
 * zombies, spawn zones for variety, and an exit to reach. The only differences live
 * in the director and the objective — everything else is the same game.
 */
export type GameMode = "survival" | "story";

export interface GameEvent {
  kind: "kill" | "playerDown" | "revive" | "wipe" | "join" | "level"
      | "floorCleared" | "missionComplete" | "missionFailed";
  x?: number;
  y?: number;
  text?: string;
}

export class GameWorld {
  map: TileMap;
  readonly players: Player[] = [];
  readonly enemies: Enemy[] = [];
  readonly bullets = new BulletPool();
  readonly particles = new ParticlePool();
  readonly events: GameEvent[] = [];

  /** Lamps baked into the level. Static, so their visibility is solved once on load. */
  readonly staticLights: VisionLight[] = [];

  mode: GameMode = "survival";
  /**
   * Live objective state for the HUD: what the squad is standing on, how many of them
   * are on it, and how far through the dwell they are.
   */
  readonly objective = {
    kind: "none" as "none" | "exit" | "stairs",
    onExit: 0,
    needed: 0,
    progress: 0,
  };

  time = 0;
  private exitTimer = 0;
  private nextEnemyId = 1;
  private spawnTimer = 2;
  /** Grace period once the whole squad is down, so the wipe reads as a moment. */
  private wipeTimer = 0;
  private seed: number;

  constructor(level?: LevelData, seed = 1337, mode: GameMode = "survival") {
    this.seed = seed;
    this.mode = mode;
    this.map = buildTileMap(level ?? generateLevel(MAP_COLS, MAP_ROWS, seed));
    this.bakeStaticLights();
  }

  /**
   * CORE 14b — swap the map without tearing the world down. Entities are kept (players
   * keep their device bindings, colours and score) and simply re-placed on the new grid,
   * which is what makes hot-loading a map from the editor feel instant.
   */
  loadLevel(level: LevelData, opts: { keepSquad?: boolean } = {}): void {
    this.map = buildTileMap(level);
    this.bakeStaticLights();
    this.enemies.length = 0;
    this.exitTimer = 0;
    this.objective.kind = "none";
    this.objective.onExit = 0;
    this.objective.needed = 0;
    this.objective.progress = 0;
    for (const b of this.bullets.items) b.active = false;
    for (const p of this.particles.items) p.active = false;
    this.time = 0;
    this.spawnTimer = 1.5;
    this.wipeTimer = 0;

    this.players.forEach((p, i) => {
      const spawn = this.playerSpawn(i);
      p.x = spawn.x; p.y = spawn.y;
      p.prevX = p.x; p.prevY = p.y;
      p.vx = 0; p.vy = 0;
      // Climbing a floor carries your condition with you — that is the whole point of
      // a building being one mission rather than six. A fresh mission heals you up.
      if (!opts.keepSquad) {
        p.health = p.maxHealth;
        p.ammo = p.weapon.magazine;
        p.stamina = p.maxStamina;
        p.exhausted = false;
      } else if (p.downed) {
        // Nobody gets left behind on the stairs: the downed come up at low health.
        p.health = p.maxHealth * 0.35;
      }
      p.downed = false;
      p.bleedout = 0;
      p.reviveProgress = 0;
      p.reloadTimer = 0;
      p.stance = "stand";
      p.stanceTimer = 0;
      p.lean = 0;
      p.eyeX = p.x;
      p.eyeY = p.y;
      syncLights(p);
    });
    this.populateAuthoredEnemies();
    this.events.push({ kind: "level", text: level.name });
  }

  /**
   * Hand-placed zombies go down once, where the author put them. They are the part of
   * the encounter you can learn; the director's zone spawns are the part you cannot.
   */
  private populateAuthoredEnemies(): void {
    for (const spot of this.map.enemySpawns) {
      this.enemies.push(createEnemy(this.nextEnemyId++, spot.x, spot.y));
    }
  }

  /** Lamp tiles never move, so solve their visibility polygons once instead of per frame. */
  private bakeStaticLights(): void {
    this.staticLights.length = 0;
    for (const lamp of this.map.lamps) {
      const light = makeLight("#ffdca8", Math.PI, lamp.range, 0.8);
      light.x = lamp.x;
      light.y = lamp.y;
      computeVisibility(this.map, light);
      this.staticLights.push(light);
    }
  }

  addPlayer(sourceId: string): Player {
    const index = this.players.length;
    const spawn = this.map.playerSpawns.length > 0 || index === 0
      ? this.playerSpawn(index)
      : this.spawnNearSquad(index);
    const p = createPlayer(this.players.length, sourceId, spawn.x, spawn.y);
    this.players.push(p);
    this.events.push({ kind: "join", x: p.x, y: p.y, text: `P${p.id + 1} joined` });
    return p;
  }

  /**
   * Where player `index` starts on the CURRENT map: their authored spawn tile, or the
   * most open floor if the map has none.
   *
   * Deliberately does not look at where anybody currently is. It used to fall back to
   * "somewhere near the squad", which is right for a player joining a match in progress
   * and very wrong when loading a new map — on a floor with no spawn tiles it placed
   * everyone at their coordinates from the previous floor, which could be outside the
   * new map entirely. Joining near the squad is `spawnNearSquad`, used only by addPlayer.
   */
  private playerSpawn(index: number): { x: number; y: number } {
    const authored = this.map.playerSpawns;
    if (authored.length > 0) return authored[index % authored.length];

    const open = this.map.mostOpenPoint();
    if (index === 0) return open;
    // Fan the rest out around it rather than stacking them on one tile.
    for (let i = 0; i < 24; i++) {
      const a = randRange(0, Math.PI * 2);
      const d = randRange(30, 110);
      const x = open.x + Math.cos(a) * d;
      const y = open.y + Math.sin(a) * d;
      if (!pointInWall(this.map, x, y)) return { x, y };
    }
    return open;
  }

  /** A spot beside the squad, for a player joining a match already in progress. */
  private spawnNearSquad(index: number): { x: number; y: number } {
    const host = this.players[0];
    if (!host) return this.playerSpawn(index);
    for (let i = 0; i < 24; i++) {
      const a = randRange(0, Math.PI * 2);
      const d = randRange(30, 110);
      const x = host.x + Math.cos(a) * d;
      const y = host.y + Math.sin(a) * d;
      if (!pointInWall(this.map, x, y)) return { x, y };
    }
    return { x: host.x, y: host.y };
  }

  /**
   * One simulation step. `resolveAim` maps a player to a world-space aim angle
   * (null when the device gave no aim this step) — that is the only place the
   * camera is allowed to influence the sim.
   */
  update(
    dt: number,
    inputOf: (p: Player) => InputState,
    resolveAim: (p: Player, input: InputState) => AimCommand | null,
  ): void {
    this.time += dt;
    const deps = { map: this.map, bullets: this.bullets, particles: this.particles };

    for (const p of this.players) {
      const input = inputOf(p);
      updatePlayer(p, input, resolveAim(p, input), deps, dt);
    }

    const revived = updateRevives(this.players, inputOf, dt);
    if (revived) this.events.push({ kind: "revive", x: revived.x, y: revived.y, text: `P${revived.id + 1} up` });

    const enemyDeps = { ...deps, enemies: this.enemies, players: this.players };
    for (const e of this.enemies) updateEnemy(e, enemyDeps, dt);

    this.updateBullets(dt);
    this.particles.update(dt);
    this.updateDirector(dt);
    this.updateBleedout(dt);
    this.updateObjective(dt);

    // Vision is recomputed once per step and shared by all viewports.
    for (const p of this.players) {
      computeVisibility(this.map, p.cone);
      computeVisibility(this.map, p.halo);
    }
    for (const e of this.enemies) computeVisibility(this.map, e.cone);

    this.updateEnemyVisibility();
  }

  /**
   * Who can the squad actually see? Computed once here rather than per viewport, so
   * an enemy standing in the dark is not drawn at all instead of being drawn and
   * then almost-hidden by the darkness layer.
   */
  private updateEnemyVisibility(): void {
    for (const e of this.enemies) {
      e.visible = false;
      for (const p of this.players) {
        const lit =
          inCone(p.eyeX, p.eyeY, p.facing, p.cone.halfAngle, p.cone.range, e.x, e.y) ||
          Math.hypot(p.eyeX - e.x, p.eyeY - e.y) < p.halo.range;
        if (!lit) continue;
        if (!hasLineOfSight(this.map, p.eyeX, p.eyeY, e.x, e.y)) continue;
        e.visible = true;
        break;
      }
      // Standing in a lamp's pool gives you away too — that is what lamps are for.
      if (e.visible || this.players.length === 0) continue;
      for (const light of this.staticLights) {
        if (Math.hypot(light.x - e.x, light.y - e.y) > light.range) continue;
        if (!hasLineOfSight(this.map, light.x, light.y, e.x, e.y)) continue;
        e.visible = true;
        break;
      }
    }
  }

  private updateBullets(dt: number): void {
    for (const b of this.bullets.items) {
      if (!b.active) continue;
      b.prevX = b.x;
      b.prevY = b.y;
      b.life -= dt;
      if (b.life <= 0) { b.active = false; continue; }

      // Substep so fast bullets cannot skip through a wall or an actor.
      const steps = 3;
      const sx = (b.vx * dt) / steps;
      const sy = (b.vy * dt) / steps;
      for (let s = 0; s < steps && b.active; s++) {
        b.x += sx;
        b.y += sy;

        if (this.map.blocksShotsAt(b.x, b.y)) {
          b.active = false;
          this.particles.burst(b.x, b.y, 4, 130, "#c8cede", 0.22, 2);
          break;
        }

        if (b.team === "player") {
          for (const e of this.enemies) {
            if (e.health <= 0) continue;
            if (!circleOverlap(b.x, b.y, 2, e.x, e.y, e.radius)) continue;
            b.active = false;
            e.lastSeenX = b.x - b.vx * 0.3;
            e.lastSeenY = b.y - b.vy * 0.3;
            this.particles.burst(b.x, b.y, 6, 160, "#ffd0a0", 0.3, 3);
            if (damageEnemy(e, b.damage)) this.killEnemy(e, b.ownerId);
            break;
          }
        } else {
          for (const p of this.players) {
            if (p.downed) continue;
            if (!circleOverlap(b.x, b.y, 2, p.x, p.y, p.radius)) continue;
            b.active = false;
            this.particles.burst(b.x, b.y, 6, 160, "#ff9a9a", 0.3, 3);
            damagePlayer(p, b.damage);
            if (p.downed) this.events.push({ kind: "playerDown", x: p.x, y: p.y, text: `P${p.id + 1} down` });
            break;
          }
        }
      }
    }
  }

  private killEnemy(e: Enemy, killerId: number): void {
    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);
    this.particles.burst(e.x, e.y, 16, 220, "#ff8b5c", 0.5, 4);
    const killer = this.players.find((p) => p.id === killerId);
    if (killer) killer.kills++;
    this.events.push({ kind: "kill", x: e.x, y: e.y });
  }

  /** CORE 9 — a director, not a spawn table: population scales with the squad. */
  private updateDirector(dt: number): void {
    if (this.players.length === 0) return;
    const story = this.mode === "story";
    // A story map with no zones is a fixed encounter — respect the author and stop.
    if (story && this.map.spawnZones.length === 0) return;

    const perPlayer = story ? ZONE_ENEMIES_PER_PLAYER : ENEMIES_PER_PLAYER;
    const cap = perPlayer * this.players.length;
    this.spawnTimer -= dt;
    if (this.enemies.length >= cap || this.spawnTimer > 0) return;

    this.spawnTimer = story ? 3.4 : Math.max(0.6, 2.2 - this.time * 0.004);
    const spot = this.enemySpawn();
    if (spot) this.enemies.push(createEnemy(this.nextEnemyId++, spot.x, spot.y));
  }

  /**
   * Enemy spawn priority: the level's enemy-spawn tiles, then any floor tile — in both
   * cases far enough away that nobody watches one appear. A small map may legitimately
   * have nowhere valid, in which case we simply do not spawn this tick.
   */
  /**
   * Spawn zones first, in a shuffled order so pressure does not always arrive from the
   * same door. Survival falls back to any floor tile; story does not — an authored map
   * only ever spawns where the author said it could.
   */
  private enemySpawn(): { x: number; y: number } | null {
    const zones = this.map.spawnZones;
    if (zones.length > 0) {
      const start = Math.floor(Math.random() * zones.length);
      for (let i = 0; i < zones.length; i++) {
        const spot = zones[(start + i) % zones.length];
        if (this.clearOfPlayers(spot.x, spot.y)) return spot;
      }
      // Every zone is currently in someone's lap: wait rather than cheat.
      if (this.mode === "story") return null;
    }
    if (this.mode === "story") return null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const spot = this.map.randomWalkable();
      if (!spot) return null;
      if (this.clearOfPlayers(spot.x, spot.y)) return spot;
    }
    return null;
  }

  /**
   * Extraction. The whole LIVING squad has to be standing on the exit together for a
   * moment — downed players do not block it, so a wipe-in-progress can still be saved
   * by the last one standing reaching the safe room.
   */
  private updateObjective(dt: number): void {
    if (this.mode !== "story") return;

    // Stairs win over an exit: a floor with a way up is not the end of the building.
    const kind = this.map.stairs.length > 0 ? "stairs"
      : this.map.exits.length > 0 ? "exit" : "none";
    this.objective.kind = kind;
    if (kind === "none") return;

    let alive = 0;
    let onIt = 0;
    for (const p of this.players) {
      if (p.downed) continue;
      alive++;
      const standing = kind === "stairs"
        ? this.map.isStairsAt(p.x, p.y)
        : this.map.isExitAt(p.x, p.y);
      if (standing) onIt++;
    }
    this.objective.onExit = onIt;
    this.objective.needed = alive;

    if (alive > 0 && onIt === alive) this.exitTimer += dt;
    else this.exitTimer = Math.max(0, this.exitTimer - dt * 2);

    this.objective.progress = Math.min(1, this.exitTimer / EXIT_DWELL);
    if (this.exitTimer >= EXIT_DWELL) {
      this.exitTimer = 0;
      this.events.push({
        kind: kind === "stairs" ? "floorCleared" : "missionComplete",
        text: this.map.name,
      });
    }
  }

  private clearOfPlayers(x: number, y: number): boolean {
    // On a small map the clearance shrinks rather than starving the level of enemies.
    const clearance = Math.min(
      SPAWN_CLEARANCE, Math.max(this.map.worldWidth, this.map.worldHeight) * 0.45,
    );
    for (const p of this.players) {
      if (Math.hypot(p.x - x, p.y - y) < clearance) return false;
    }
    return true;
  }

  private updateBleedout(dt: number): void {
    if (this.players.length === 0) return;
    let anyUp = false;
    for (const p of this.players) if (!p.downed) anyUp = true;

    if (!anyUp) {
      // Nobody left to revive anybody: hold on the down state for a beat, then reset
      // the run. Device bindings and scores survive — only the level restarts.
      this.wipeTimer += dt;
      if (this.wipeTimer >= 3) {
        // Survival restarts on the spot; story hands the squad back to mission select.
        if (this.mode === "story") {
          this.events.push({ kind: "missionFailed", text: this.map.name });
          this.wipeTimer = 0;
        } else {
          this.events.push({ kind: "wipe", text: "SQUAD WIPED — restarting" });
          this.restart();
        }
      }
      return;
    }
    this.wipeTimer = 0;

    for (const p of this.players) {
      if (p.downed && p.bleedout <= 0) {
        // Bleeding out is not a permanent loss with teammates alive: respawn at the squad.
        const spawn = this.playerSpawnNear(p);
        p.x = spawn.x; p.y = spawn.y;
        p.prevX = p.x; p.prevY = p.y;
        p.downed = false;
        p.health = p.maxHealth * 0.4;
        p.reviveProgress = 0;
        p.ammo = p.weapon.magazine;
        p.stance = "stand";
        p.stanceTimer = 0;
        p.stamina = p.maxStamina;
        p.exhausted = false;
      }
    }
  }

  private playerSpawnNear(dead: Player): { x: number; y: number } {
    const anchor = this.players.find((p) => !p.downed && p !== dead) ?? this.players[0];
    for (let i = 0; i < 24; i++) {
      const a = randRange(0, Math.PI * 2);
      const d = randRange(40, 140);
      const x = anchor.x + Math.cos(a) * d;
      const y = anchor.y + Math.sin(a) * d;
      if (!pointInWall(this.map, x, y)) return { x, y };
    }
    return { x: anchor.x, y: anchor.y };
  }

  /**
   * Restart the run. An authored level restarts as itself; a procedural one rerolls,
   * because there is nothing to be faithful to.
   */
  restart(): void {
    if (this.map.playerSpawns.length === 0 && this.map.enemySpawns.length === 0) {
      this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
      this.loadLevel(generateLevel(MAP_COLS, MAP_ROWS, this.seed));
      return;
    }
    this.loadLevel({ name: this.map.name, grid: this.map.toGrid() });
  }
}
