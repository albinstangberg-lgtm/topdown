import type { InputState } from "../input/types";
import { randRange } from "../core/math";
import { generateLevel, TILE, type TileMap } from "../world/tilemap";
import { circleOverlap, pointInWall } from "../world/collision";
import { computeVisibility, inCone, type VisionLight } from "../vision/visibility";
import { hasLineOfSight } from "../world/raycast";
import { createPlayer, damagePlayer, updatePlayer, updateRevives } from "./player";
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
/** Enemies alive on the field, per player. Local co-op difficulty knob. */
const ENEMIES_PER_PLAYER = 5;

export interface GameEvent {
  kind: "kill" | "playerDown" | "revive" | "wipe" | "join";
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

  time = 0;
  private nextEnemyId = 1;
  private spawnTimer = 2;
  /** Grace period once the whole squad is down, so the wipe reads as a moment. */
  private wipeTimer = 0;
  private seed: number;

  constructor(seed = 1337) {
    this.seed = seed;
    this.map = generateLevel(MAP_COLS, MAP_ROWS, seed);
  }

  /** Every light in the world that a viewport might need to draw. */
  get lights(): VisionLight[] {
    const out: VisionLight[] = [];
    for (const p of this.players) { out.push(p.cone, p.halo); }
    return out;
  }

  addPlayer(sourceId: string): Player {
    const spawn = this.playerSpawn();
    const p = createPlayer(this.players.length, sourceId, spawn.x, spawn.y);
    this.players.push(p);
    this.events.push({ kind: "join", x: p.x, y: p.y, text: `P${p.id + 1} joined` });
    return p;
  }

  private playerSpawn(): { x: number; y: number } {
    if (this.players.length > 0) {
      // Drop in next to the squad, not across the level.
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
    const room = this.map.rooms[0];
    return this.map.centerOf(room);
  }

  /**
   * One simulation step. `resolveAim` maps a player to a world-space aim angle
   * (null when the device gave no aim this step) — that is the only place the
   * camera is allowed to influence the sim.
   */
  update(
    dt: number,
    inputOf: (p: Player) => InputState,
    resolveAim: (p: Player, input: InputState) => number | null,
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
          inCone(p.x, p.y, p.facing, p.cone.halfAngle, p.cone.range, e.x, e.y) ||
          Math.hypot(p.x - e.x, p.y - e.y) < p.halo.range;
        if (!lit) continue;
        if (!hasLineOfSight(this.map, p.x, p.y, e.x, e.y)) continue;
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

  private enemySpawn(): { x: number; y: number } | null {
    const rooms = this.map.rooms;
    for (let attempt = 0; attempt < 30; attempt++) {
      const room = rooms[Math.floor(Math.random() * rooms.length)];
      const x = (room.x + 0.5 + Math.random() * (room.w - 1)) * TILE;
      const y = (room.y + 0.5 + Math.random() * (room.h - 1)) * TILE;
      if (pointInWall(this.map, x, y)) continue;
      // Never pop into existence in front of somebody.
      let tooClose = false;
      for (const p of this.players) {
        if (Math.hypot(p.x - x, p.y - y) < 620) { tooClose = true; break; }
      }
      if (!tooClose) return { x, y };
    }
    return null;
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

  restart(): void {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    this.map = generateLevel(MAP_COLS, MAP_ROWS, this.seed);
    this.enemies.length = 0;
    for (const b of this.bullets.items) b.active = false;
    this.time = 0;
    this.spawnTimer = 3;
    this.wipeTimer = 0;

    const start = this.map.centerOf(this.map.rooms[0]);
    for (const p of this.players) {
      p.x = start.x + randRange(-40, 40);
      p.y = start.y + randRange(-40, 40);
      p.prevX = p.x; p.prevY = p.y;
      p.vx = 0; p.vy = 0;
      p.health = p.maxHealth;
      p.downed = false;
      p.bleedout = 0;
      p.reviveProgress = 0;
      p.ammo = p.weapon.magazine;
      p.reloadTimer = 0;
    }
  }
}
