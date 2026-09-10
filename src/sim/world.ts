import type { InputState } from "../input/types";
import { lerp, randRange } from "../core/math";
import { TILE, type CarBody, type TileMap } from "../world/tilemap";
import { tileDef } from "../world/tiles";
import { buildTileMap, type LevelData } from "../world/level";
import { FlowField } from "../world/flow";
import { generateLevel } from "../world/generator";
import { makeLight } from "../vision/visibility";
import { circleOverlap, pointInWall } from "../world/collision";
import { computeVisibility, inCone, type VisionLight } from "../vision/visibility";
import { hasLineOfSight } from "../world/raycast";
import {
  createPlayer, damagePlayer, syncLights, updatePlayer, updateRevives, type AimCommand,
} from "./player";
import { createEnemy, damageEnemy, updateEnemy } from "./enemy";
import { randomZombieKind } from "./zombies";
import { NOISE, NoiseField } from "./noise";
import { Director, STORY_TUNING, SURVIVAL_TUNING, type DirectorDeps } from "./director";
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
/**
 * No authored zombie is placed this close to a player spawn tile. Arriving on a floor
 * should give you a moment to read the room; the director's own arrival grace covers
 * the other half of that.
 */
const SPAWN_SAFE_RADIUS = 300;
/** How long a car alarm keeps screaming once a bullet sets it off. */
const ALARM_TIME = 20;
/** Seconds between the alarm's noise pulses. Every zombie on the floor hears these. */
const ALARM_PULSE = 0.6;
/**
 * How often the squad's flow field is swept again. A breadth-first pass over a few
 * thousand tiles is far cheaper than the vision raycasts, but four times a second is
 * already finer than anything walking at 140 units/s can tell.
 */
const FLOW_INTERVAL = 0.25;
/** Seconds the whole squad has to stand on the exit before the mission ends. */
const EXIT_DWELL = 0.8;

// --- the extraction finale ---------------------------------------------------
//
// A floor carrying a signal flare (`F`) and an exit does not end when the squad
// reaches the exit: the exit is a helipad with nothing on it. Somebody has to light
// the flare, and then the roof has to be held until what it called actually arrives.

/** Seconds one player has to stand on the flare to light it. */
const FLARE_DWELL = 1.5;
/** How long the squad holds the roof between lighting the flare and the pickup. */
const HOLDOUT_TIME = 120;
/** Seconds between the countdown running out and the skids touching the pad. */
const CHOPPER_APPROACH = 9;
/** How far out the helicopter starts its run in, in world units. */
const CHOPPER_RUN_IN = 1600;
/** Radius of the light a burning signal flare throws. */
const FLARE_LIGHT = 340;
/** Seconds between rotor noise pulses while the helicopter is over the map. */
const ROTOR_PULSE = 0.5;
/** Seconds remaining at which the holdout calls the time. */
const HOLDOUT_CALLS = [60, 30, 10];

/**
 * Survival is the endless procedural mode. Story runs an authored map with placed
 * zombies, spawn zones for variety, and an exit to reach. The only differences live
 * in the director and the objective — everything else is the same game.
 */
export type GameMode = "survival" | "story";

/**
 * Where the finale has got to. `none` is every ordinary floor, including one with an
 * exit but no flare — those still end the moment the squad reaches the safe room.
 */
export type ExtractionPhase = "none" | "signal" | "holdout" | "inbound" | "ready";

export interface GameEvent {
  kind: "kill" | "playerDown" | "revive" | "wipe" | "join" | "level" | "horde" | "alarm"
      | "floorCleared" | "missionComplete" | "missionFailed"
      | "flareLit" | "holdout" | "chopperInbound" | "chopperDown";
  x?: number;
  y?: number;
  text?: string;
  /** How many zombies a `horde` event released. */
  count?: number;
}

export class GameWorld {
  map: TileMap;
  readonly players: Player[] = [];
  readonly enemies: Enemy[] = [];
  readonly bullets = new BulletPool();
  readonly particles = new ParticlePool();
  /** Every noise made this step. Zombies hear it; walls do not stop it. */
  readonly noise = new NoiseField();
  /** Waves, peaks and breathers. See `src/sim/director.ts`. */
  readonly director = new Director(SURVIVAL_TUNING);
  /**
   * The car alarm, if one is going. Read by the renderer (the strobe) and the HUD.
   * There is only ever one: setting off a second car moves it rather than stacking.
   */
  readonly alarm = { active: false, x: 0, y: 0, timeLeft: 0, pulse: 0 };
  /**
   * Distance to the squad over the tile grid, swept a few times a second and read by
   * every zombie that needs a route rather than a straight line. See `world/flow.ts`.
   */
  readonly squadFlow = new FlowField();
  /** The same, toward whatever is currently screaming. Empty unless an alarm is going. */
  readonly lureFlow = new FlowField();
  readonly events: GameEvent[] = [];

  /** Lamps baked into the level. Static, so their visibility is solved once on load. */
  readonly staticLights: VisionLight[] = [];

  private _mode: GameMode = "survival";
  /** Setting the mode re-tunes the director: survival leans harder than story. */
  get mode(): GameMode { return this._mode; }
  set mode(next: GameMode) {
    this._mode = next;
    this.director.setTuning(next === "story" ? STORY_TUNING : SURVIVAL_TUNING);
  }
  /**
   * Live objective state for the HUD: what the squad is standing on, how many of them
   * are on it, and how far through the dwell they are.
   */
  readonly objective = {
    kind: "none" as "none" | "exit" | "stairs" | "signal" | "holdout" | "inbound",
    onExit: 0,
    needed: 0,
    progress: 0,
    /** Seconds left of the holdout, or of the helicopter's run in. Zero otherwise. */
    timeLeft: 0,
  };

  /**
   * CORE 17b — the extraction finale. Read by the HUD and the renderer; driven by
   * `updateExtraction`. A floor with no signal flare leaves this at `none` and plays
   * exactly as it always did.
   */
  readonly extraction = {
    phase: "none" as ExtractionPhase,
    /** Dwell on the flare so far, 0 to 1. */
    lighting: 0,
    /** Seconds left of the holdout, or of the helicopter's run in. */
    timeLeft: 0,
    /** What `timeLeft` started at, so the HUD can draw a bar. */
    total: 0,
    /** Where the flare is. */
    x: 0,
    y: 0,
    /** The middle of the exit tiles — where the helicopter puts its skids down. */
    padX: 0,
    padY: 0,
    /** Countdown calls already made, so each one is said once. */
    called: 0,
  };

  /**
   * The helicopter. Inactive until the countdown ends, then it flies in and lands on
   * the pad. `altitude` is 1 out on the run in and 0 with the skids down.
   */
  readonly chopper = {
    active: false,
    x: 0,
    y: 0,
    fromX: 0,
    fromY: 0,
    angle: 0,
    altitude: 1,
    /** Seconds until the next rotor pulse. */
    pulse: 0,
  };

  time = 0;
  private exitTimer = 0;
  private nextEnemyId = 1;
  private flowTimer = 0;
  /** Grace period once the whole squad is down, so the wipe reads as a moment. */
  private wipeTimer = 0;
  private seed: number;

  constructor(level?: LevelData, seed = 1337, mode: GameMode = "survival") {
    this.seed = seed;
    this.mode = mode;
    this.map = buildTileMap(level ?? generateLevel(MAP_COLS, MAP_ROWS, seed));
    this.bakeStaticLights();
    this.director.rebuild(this.map);
    this.director.reset();
    this.resetExtraction();
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
    this.objective.timeLeft = 0;
    for (const b of this.bullets.items) b.active = false;
    for (const p of this.particles.items) p.active = false;
    this.noise.clear();
    this.alarm.active = false;
    this.alarm.timeLeft = 0;
    this.lureFlow.clear();
    this.flowTimer = 0;
    this.time = 0;
    this.wipeTimer = 0;
    this.director.rebuild(this.map);
    this.director.reset();
    this.resetExtraction();

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
      // Not on top of where the squad comes in. An author placing a zombie near the
      // stairwell means "this floor is hostile", not "lose health before you can look".
      if (this.nearPlayerSpawn(spot.x, spot.y)) continue;
      this.enemies.push(createEnemy(this.nextEnemyId++, spot.x, spot.y));
    }
  }

  /** Inside the no-spawn bubble around any of this floor's arrival tiles? */
  private nearPlayerSpawn(x: number, y: number): boolean {
    return this.map.playerSpawns.some(
      (p) => Math.hypot(p.x - x, p.y - y) < SPAWN_SAFE_RADIUS,
    );
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
    const deps = {
      map: this.map, bullets: this.bullets, particles: this.particles, noise: this.noise,
    };

    for (const p of this.players) {
      const input = inputOf(p);
      updatePlayer(p, input, resolveAim(p, input), deps, dt);
    }

    const revived = updateRevives(this.players, inputOf, dt);
    if (revived) this.events.push({ kind: "revive", x: revived.x, y: revived.y, text: `P${revived.id + 1} up` });

    this.updateFlow(dt);
    const enemyDeps = {
      map: this.map,
      particles: this.particles,
      noise: this.noise,
      enemies: this.enemies,
      players: this.players,
      squadFlow: this.squadFlow,
      lureFlow: this.lureFlow,
      hurtPlayer: this.hurtPlayer,
    };
    for (const e of this.enemies) updateEnemy(e, enemyDeps, dt);

    this.updateBullets(dt);
    this.particles.update(dt);
    // Noises age out after every listener has had a step to hear them.
    this.noise.update(dt);
    this.updateAlarm(dt);
    this.updateDirector(dt);
    this.updateBleedout(dt);
    this.updateObjective(dt);

    // Vision is recomputed once per step and shared by all viewports.
    for (const p of this.players) {
      computeVisibility(this.map, p.cone);
      computeVisibility(this.map, p.halo);
    }
    this.updateEnemyVisibility();
  }

  /**
   * Who can the squad actually see? Computed once here rather than per viewport, so
   * an enemy standing in the dark is not drawn at all instead of being drawn and
   * then almost-hidden by the darkness layer.
   */
  private updateEnemyVisibility(): void {
    for (const e of this.enemies) e.visible = this.squadCanSee(e.x, e.y);
  }

  /**
   * Can anybody see this point right now? The renderer's own test, so "is that zombie
   * drawn" and "may a wave arrive there" can never answer it differently. Bound,
   * because the director holds it as a callback.
   */
  squadCanSee = (x: number, y: number): boolean => {
    for (const p of this.players) {
      const lit =
        inCone(p.eyeX, p.eyeY, p.facing, p.cone.halfAngle, p.cone.range, x, y) ||
        Math.hypot(p.eyeX - x, p.eyeY - y) < p.halo.range;
      if (!lit) continue;
      if (hasLineOfSight(this.map, p.eyeX, p.eyeY, x, y)) return true;
    }
    // Standing in a lamp's pool gives you away too — that is what lamps are for.
    if (this.players.length === 0) return false;
    for (const light of this.staticLights) {
      if (Math.hypot(light.x - x, light.y - y) > light.range) continue;
      if (hasLineOfSight(this.map, light.x, light.y, x, y)) return true;
    }
    return false;
  };

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

        // Anything a bullet can pass through but that does not survive the experience.
        // Glass is the only one today; the tile says what it leaves behind.
        const tx = Math.floor(b.x / TILE);
        const ty = Math.floor(b.y / TILE);
        if (this.map.inBounds(tx, ty)) {
          const hit = tileDef(this.map.tileAt(tx, ty));
          if (hit.breaksInto !== undefined) {
            this.map.setTile(tx, ty, hit.breaksInto);
            // Derived lists (what is walkable, where spawns are) change with the grid.
            this.map.refresh();
            // A smashed window is a new way in. The director should know about it,
            // and so should whatever the floor is currently walking toward.
            this.director.rebuild(this.map);
            this.refreshLure();
            this.particles.burst(b.x, b.y, 14, 190, "#cfe9f5", 0.5, 3);
            // Breaking a pane is nearly as loud as the shot that broke it.
            this.noise.emit(b.x, b.y, NOISE.glass, "break");
          }
        }

        if (this.map.blocksShotsAt(b.x, b.y)) {
          b.active = false;
          this.particles.burst(b.x, b.y, 4, 130, "#c8cede", 0.22, 2);
          // Whatever stopped it might have had an alarm in it.
          const sx = Math.floor(b.x / TILE);
          const sy = Math.floor(b.y / TILE);
          if (tileDef(this.map.tileAt(sx, sy)).alarm) this.triggerAlarm(sx, sy);
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
            this.hurtPlayer(p, b.damage);
            break;
          }
        }
      }
    }
  }

  /**
   * The one way anything hurts a player, so "who is down" is raised in one place.
   * Bound, because the zombie AI holds it as a callback.
   */
  private hurtPlayer = (p: Player, amount: number): void => {
    const wasDown = p.downed;
    damagePlayer(p, amount);
    if (p.downed && !wasDown) {
      this.events.push({ kind: "playerDown", x: p.x, y: p.y, text: `P${p.id + 1} down` });
    }
  };

  private killEnemy(e: Enemy, killerId: number): void {
    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);
    this.particles.burst(e.x, e.y, 16, 220, "#ff8b5c", 0.5, 4);
    const killer = this.players.find((p) => p.id === killerId);
    if (killer) killer.kills++;
    this.events.push({ kind: "kill", x: e.x, y: e.y });
  }

  /**
   * Re-sweep the squad's flow field. Downed players are not goals: a horde should
   * converge on whoever is still shooting, not pile onto the one already on the floor.
   * With nobody up, the field empties and hunting zombies fall back to wandering.
   */
  private updateFlow(dt: number): void {
    this.flowTimer -= dt;
    if (this.flowTimer > 0) return;
    this.flowTimer = FLOW_INTERVAL;
    this.squadFlow.rebuild(this.map, this.players.filter((p) => !p.downed));
  }

  /**
   * A live car alarm: a huge noise pulse every few tenths of a second, so every zombie
   * on the floor walks to the car whether or not the director is still feeding. The
   * pulse is what makes an alarm a place rather than an event.
   */
  private updateAlarm(dt: number): void {
    if (!this.alarm.active) return;
    this.alarm.timeLeft -= dt;
    this.alarm.pulse -= dt;
    if (this.alarm.pulse <= 0) {
      this.alarm.pulse = ALARM_PULSE;
      this.noise.emit(this.alarm.x, this.alarm.y, NOISE.alarm, "alarm");
      this.particles.burst(this.alarm.x, this.alarm.y, 4, 70, "#ff8a5c", 0.5, 3);
    }
    if (this.alarm.timeLeft <= 0) {
      this.alarm.active = false;
      // The car is done screaming; a flare burning on the roof takes the lure back.
      this.refreshLure();
    }
  }

  /**
   * A bullet found a car with a live alarm. Every door on the floor opens at once and
   * keeps opening for as long as it screams.
   *
   * The "only once" lives in the grid rather than in a flag beside it: the car's tiles
   * become ordinary wrecks, so a spent alarm survives a save, a reload and the map
   * refresh that a smashed window triggers, and cannot come back.
   */
  private triggerAlarm(tx: number, ty: number): void {
    const car = this.map.carAt(tx, ty);
    if (!car || !car.alarmed) return;

    for (const i of car.tiles) {
      const spent = tileDef(this.map.tiles[i]).alarmSpent;
      if (spent !== undefined) this.map.setTile(i % this.map.cols, Math.floor(i / this.map.cols), spent);
    }
    this.map.refresh();
    this.director.rebuild(this.map);

    this.alarm.active = true;
    this.alarm.x = car.x + car.w / 2;
    this.alarm.y = car.y + car.h / 2;
    this.alarm.timeLeft = ALARM_TIME;
    this.alarm.pulse = 0;
    // The goal is the open ring AROUND the car, not the car: nothing can stand inside
    // a wreck, and a horde should close on it from every side it can reach. The car
    // does not move, so this is swept once and read for the whole twenty seconds.
    this.lureFlow.rebuild(this.map, this.openRingAround(car));

    const released = this.director.panic(ALARM_TIME, this.directorDeps());
    this.particles.burst(this.alarm.x, this.alarm.y, 26, 240, "#ffb45c", 0.7, 4);
    this.events.push({
      kind: "alarm", x: this.alarm.x, y: this.alarm.y, count: released, text: "CAR ALARM",
    });
  }

  /** Every walkable tile touching a car — where a horde converging on it can stand. */
  private openRingAround(car: CarBody): { x: number; y: number }[] {
    const ring: { x: number; y: number }[] = [];
    const seen = new Set<number>();
    for (const i of car.tiles) {
      const tx = i % this.map.cols;
      const ty = Math.floor(i / this.map.cols);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (!this.map.inBounds(nx, ny) || this.map.isSolid(nx, ny)) continue;
        const ni = this.map.idx(nx, ny);
        if (seen.has(ni)) continue;
        seen.add(ni);
        ring.push(this.map.tileCenter(nx, ny));
      }
    }
    return ring;
  }

  /**
   * CORE 9 — the AI Director. The shape of the pressure lives in `director.ts`; this
   * is only the wiring, and the one rule the director must not own: a story map with
   * no spawn zones is a fixed encounter the author wrote, and nothing may be added to it.
   */
  private updateDirector(dt: number): void {
    const story = this.mode === "story";
    if (story && this.map.spawnZones.length === 0) return;
    this.director.update(dt, this.directorDeps());
  }

  private directorDeps(): DirectorDeps {
    return {
      map: this.map,
      players: this.players,
      enemies: this.enemies,
      squadCanSee: this.squadCanSee,
      allowFallback: this.mode !== "story",
      spawn: (x, y, hunting) => {
        this.enemies.push(createEnemy(this.nextEnemyId++, x, y, randomZombieKind(), hunting));
      },
      onWave: (x, y, count) => {
        this.events.push({ kind: "horde", x, y, count });
      },
    };
  }

  /**
   * Extraction. The whole LIVING squad has to be standing on the exit together for a
   * moment — downed players do not block it, so a wipe-in-progress can still be saved
   * by the last one standing reaching the safe room.
   *
   * On a floor with a signal flare the exit is shut until the finale says otherwise:
   * light the flare, hold the roof for two minutes, and board what turns up.
   */
  private updateObjective(dt: number): void {
    if (this.mode !== "story") return;
    this.updateExtraction(dt);

    // A pad with nothing on it is not an exit. While the finale is still running the
    // objective IS the finale, and standing on the helipad achieves nothing.
    const ex = this.extraction;
    if (ex.phase === "signal" || ex.phase === "holdout" || ex.phase === "inbound") {
      this.objective.kind = ex.phase;
      this.objective.timeLeft = ex.timeLeft;
      this.objective.progress = ex.phase === "signal"
        ? ex.lighting
        : ex.total > 0 ? 1 - ex.timeLeft / ex.total : 0;
      this.objective.onExit = 0;
      this.objective.needed = this.players.reduce((n, p) => n + (p.downed ? 0 : 1), 0);
      this.exitTimer = 0;
      return;
    }
    this.objective.timeLeft = 0;

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

  /**
   * CORE 17b — the extraction finale.
   *
   * A floor that carries a signal flare and an exit runs this instead of simply
   * ending at the exit:
   *
   *   signal   — the flare is out. One player standing on it lights it.
   *   holdout  — two minutes on the roof with the director winding up underneath you.
   *   inbound  — the helicopter is on its run in. Loud, and everything hears it.
   *   ready    — skids down. Now the exit is an exit, on the ordinary squad-dwell rule.
   *
   * A floor with a flare but no exit, or an exit but no flare, is `none` and behaves
   * exactly as it did before any of this existed.
   */
  private resetExtraction(): void {
    const ex = this.extraction;
    ex.lighting = 0;
    ex.timeLeft = 0;
    ex.total = 0;
    ex.called = 0;
    this.chopper.active = false;
    this.chopper.altitude = 1;
    this.chopper.pulse = 0;

    const beacon = this.map.signals[0];
    if (!beacon || this.map.exits.length === 0) {
      ex.phase = "none";
      return;
    }
    ex.phase = "signal";
    ex.x = beacon.x;
    ex.y = beacon.y;
    // The pad is the middle of the exit tiles: authored as a block, so its centre is
    // where a helicopter would sensibly put itself down.
    let px = 0;
    let py = 0;
    for (const e of this.map.exits) { px += e.x; py += e.y; }
    ex.padX = px / this.map.exits.length;
    ex.padY = py / this.map.exits.length;
  }

  private updateExtraction(dt: number): void {
    const ex = this.extraction;
    if (ex.phase === "none") return;

    if (ex.phase === "signal") {
      // One person is enough. Lighting a flare is not a thing a squad does together,
      // and asking four players to stand on one tile before anything can start would
      // be the least interesting minute of the mission.
      const onIt = this.players.some((p) => !p.downed && this.map.isSignalAt(p.x, p.y));
      ex.lighting = onIt
        ? Math.min(1, ex.lighting + dt / FLARE_DWELL)
        : Math.max(0, ex.lighting - dt / FLARE_DWELL);
      if (ex.lighting >= 1) this.lightFlare();
      return;
    }

    if (ex.phase === "holdout") {
      ex.timeLeft = Math.max(0, ex.timeLeft - dt);
      this.callTheTime();
      if (ex.timeLeft <= 0) this.callChopper();
      return;
    }

    this.updateChopper(dt);
  }

  /**
   * The flare goes up. Everything that follows hangs off this one moment, so it does
   * four things at once: it lights the roof, it tells the director to start winding
   * up, it becomes the thing every zombie on the floor walks toward, and it starts
   * the clock.
   *
   * Deliberately NOT written into the tile grid, unlike a spent car alarm. The grid is
   * the authored map, and a restart has to put the flare back out — a roof you can
   * re-enter with the beacon already burning is a roof with no finale left in it.
   */
  private lightFlare(): void {
    const ex = this.extraction;
    ex.phase = "holdout";
    ex.lighting = 1;
    ex.timeLeft = HOLDOUT_TIME;
    ex.total = HOLDOUT_TIME;

    // Every flare tile on the floor goes up together, so a beacon authored as more
    // than one tile behaves as one thing.
    for (const tile of this.map.signals) {
      const light = makeLight("#ff8a4a", Math.PI, FLARE_LIGHT, 0.9);
      light.x = tile.x;
      light.y = tile.y;
      computeVisibility(this.map, light);
      this.staticLights.push(light);
    }

    this.particles.burst(ex.x, ex.y, 30, 230, "#ffb45c", 0.9, 4);
    this.noise.emit(ex.x, ex.y, NOISE.flare, "flare");
    this.refreshLure();
    // The director keeps the pressure on right through the landing, so the worst of
    // it lands while the squad is trying to get on board.
    this.director.beginHoldout(HOLDOUT_TIME + CHOPPER_APPROACH);
    this.events.push({
      kind: "flareLit", x: ex.x, y: ex.y, text: `FLARE LIT — HOLD ${clockText(HOLDOUT_TIME)}`,
    });
  }

  /** Call the big round numbers as they go past, once each. */
  private callTheTime(): void {
    const ex = this.extraction;
    while (ex.called < HOLDOUT_CALLS.length && ex.timeLeft <= HOLDOUT_CALLS[ex.called]) {
      const seconds = HOLDOUT_CALLS[ex.called];
      ex.called++;
      this.events.push({ kind: "holdout", text: `${seconds} SECONDS` });
    }
  }

  /**
   * The countdown is done and the helicopter starts its run in. It comes from off the
   * map on a fixed bearing rather than from a clever choice of edge: the roof is not
   * where it came from, and a pickup that arrives from a different corner each run is
   * a pickup nobody learns to be ready for.
   */
  private callChopper(): void {
    const ex = this.extraction;
    ex.phase = "inbound";
    ex.timeLeft = CHOPPER_APPROACH;
    ex.total = CHOPPER_APPROACH;

    const c = this.chopper;
    c.active = true;
    c.fromX = ex.padX - CHOPPER_RUN_IN * 0.72;
    c.fromY = ex.padY - CHOPPER_RUN_IN * 0.7;
    c.x = c.fromX;
    c.y = c.fromY;
    c.angle = Math.atan2(ex.padY - c.y, ex.padX - c.x);
    c.altitude = 1;
    c.pulse = 0;
    this.events.push({
      kind: "chopperInbound", x: ex.padX, y: ex.padY, text: "HELICOPTER INBOUND",
    });
  }

  /**
   * The run in, and then the wait on the pad. The rotor pulses into the noise field
   * the whole time, which means the zombies hear it exactly as loudly as the player
   * does — the last thirty seconds are loud on purpose.
   */
  private updateChopper(dt: number): void {
    const ex = this.extraction;
    const c = this.chopper;

    if (ex.phase === "inbound") {
      ex.timeLeft = Math.max(0, ex.timeLeft - dt);
      const t = ex.total > 0 ? 1 - ex.timeLeft / ex.total : 1;
      // Smoothstep: it comes in fast and settles onto the pad rather than arriving
      // at full speed and stopping dead.
      const ease = t * t * (3 - 2 * t);
      c.x = lerp(c.fromX, ex.padX, ease);
      c.y = lerp(c.fromY, ex.padY, ease);
      c.altitude = 1 - ease;
      const dx = ex.padX - c.x;
      const dy = ex.padY - c.y;
      if (Math.hypot(dx, dy) > 8) c.angle = Math.atan2(dy, dx);
      if (ex.timeLeft <= 0) {
        ex.phase = "ready";
        c.x = ex.padX;
        c.y = ex.padY;
        c.altitude = 0;
        this.events.push({
          kind: "chopperDown", x: ex.padX, y: ex.padY, text: "BIRD IS DOWN — GET ON IT",
        });
      }
    }

    c.pulse -= dt;
    if (c.pulse <= 0) {
      c.pulse = ROTOR_PULSE;
      // Quieter while it is still a speck on the horizon, deafening once it is here.
      this.noise.emit(c.x, c.y, NOISE.rotor * (1 - c.altitude * 0.55), "rotor");
    }
    if (c.altitude < 0.35) {
      // Downwash: grit off the roof, thrown outward from under the rotor.
      this.particles.burst(c.x, c.y, 3, 260, "#d8d2bd", 0.4, 2);
    }
  }

  /**
   * What the floor walks toward when it cannot see anybody. A screaming car outranks
   * everything; failing that, a burning flare is the loudest, brightest thing on the
   * roof and the horde comes to it — which is what makes a holdout a place to defend
   * rather than a timer to run away from.
   */
  private refreshLure(): void {
    if (this.alarm.active) return;
    const ex = this.extraction;
    if (ex.phase === "holdout" || ex.phase === "inbound" || ex.phase === "ready") {
      const beacon = this.map.signals.length > 0
        ? this.map.signals
        : [{ x: ex.x, y: ex.y }];
      this.lureFlow.rebuild(this.map, beacon);
      return;
    }
    this.lureFlow.clear();
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

/** m:ss, for the countdown the HUD and the banners both show. */
export function clockText(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
