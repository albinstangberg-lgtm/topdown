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
/** Enemies alive on the field, per player. Local co-op difficulty knob. */
const ENEMIES_PER_PLAYER = 5;

export interface GameEvent {
  kind: "kill" | "playerDown" | "revive" | "wipe" | "join" | "level";
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

  time = 0;
  private nextEnemyId = 1;
  private spawnTimer = 2;
  /** Grace period once the whole squad is down, so the wipe reads as a moment. */
  private wipeTimer = 0;
  private seed: number;

  constructor(level?: LevelData, seed = 1337) {
    this.seed = seed;
    this.map = buildTileMap(level ?? generateLevel(MAP_COLS, MAP_ROWS, seed));
    this.bakeStaticLights();
  }

  /**
   * CORE 14b — swap the map without tearing the world down. Entities are kept (players
   * keep their device bindings, colours and score) and simply re-placed on the new grid,
   * which is what makes hot-loading a map from the editor feel instant.
   */
  loadLevel(level: LevelData): void {
    this.map = buildTileMap(level);
    this.bakeStaticLights();
    this.enemies.length = 0;
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
      p.health = p.maxHealth;
      p.downed = false;
      p.bleedout = 0;
      p.reviveProgress = 0;
      p.ammo = p.weapon.magazine;
      p.reloadTimer = 0;
      p.stance = "stand";
      p.stanceTimer = 0;
      p.lean = 0;
      p.eyeX = p.x;
      p.eyeY = p.y;
      p.stamina = p.maxStamina;
      p.exhausted = false;
      syncLights(p);
    });
    this.events.push({ kind: "level", text: level.name });
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
    const spawn = this.playerSpawn(this.players.length);
    const p = createPlayer(this.players.length, sourceId, spawn.x, spawn.y);
    this.players.push(p);
    this.events.push({ kind: "join", x: p.x, y: p.y, text: `P${p.id + 1} joined` });
    return p;
  }

  /**
   * Player spawn priority: the level's own player-spawn tiles first (one per player,
   * in grid order), then next to the squad, then the most open floor the map has.
   */
  private playerSpawn(index: number): { x: number; y: number } {
    const authored = this.map.playerSpawns;
    if (authored.length > 0) return authored[index % authored.length];

    if (this.players.length > 0) {
      const host = this.players[0];
      for (let i = 0; i < 24; i++) {
        const a = randRange(0, Math.PI * 2);
        const d = randRange(30, 110);
        const x = host.x + Math.cos(a) * d;
        const y = host.y + Math.sin(a) * d;
        if (!pointInWall(this.map, x, y)) return { x, y };
      }
      return { x: host.x, y: host.y };
    }
    return this.map.mostOpenPoint();
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

        if (pointInWall(this.map, b.x, b.y)) {
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
    const cap = ENEMIES_PER_PLAYER * this.players.length;
    this.spawnTimer -= dt;
    if (this.enemies.length >= cap || this.spawnTimer > 0) return;

    this.spawnTimer = Math.max(0.6, 2.2 - this.time * 0.004);
    const spot = this.enemySpawn();
    if (spot) this.enemies.push(createEnemy(this.nextEnemyId++, spot.x, spot.y));
  }

  /**
   * Enemy spawn priority: the level's enemy-spawn tiles, then any floor tile — in both
   * cases far enough away that nobody watches one appear. A small map may legitimately
   * have nowhere valid, in which case we simply do not spawn this tick.
   */
  private enemySpawn(): { x: number; y: number } | null {
    const authored = this.map.enemySpawns;
    if (authored.length > 0) {
      const start = Math.floor(Math.random() * authored.length);
      for (let i = 0; i < authored.length; i++) {
        const spot = authored[(start + i) % authored.length];
        if (this.clearOfPlayers(spot.x, spot.y)) return spot;
      }
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      const spot = this.map.randomWalkable();
      if (!spot) return null;
      if (this.clearOfPlayers(spot.x, spot.y)) return spot;
    }
    return null;
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
        this.events.push({ kind: "wipe", text: "SQUAD WIPED — restarting" });
        this.restart();
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
