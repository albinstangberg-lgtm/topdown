import type { InputState } from "../input/types";
import { lerp, randRange } from "../core/math";
import { TILE, type CarBody, type TileMap } from "../world/tilemap";
import { tileDef } from "../world/tiles";
import { buildTileMap, type LevelData } from "../world/level";
import { FlowField } from "../world/flow";
import { generateLevel } from "../world/generator";
import { makeLight } from "../vision/visibility";
import { circleOverlap, moveCircle, pointInWall } from "../world/collision";
import { computeVisibility, inCone, type VisionLight } from "../vision/visibility";
import { hasLineOfSight } from "../world/raycast";
import {
  ARC_BLIND_TIME, breakFree, createPlayer, damagePlayer, giveWeapon, syncLights,
  updatePlayer, updateRevives, type AimCommand,
} from "./player";
import { createEnemy, damageEnemy, updateEnemy } from "./enemy";
import { DeviceSystem, UNSEAL_TIME, type DeviceOutcome } from "./devices";
import { nextWeaponUp } from "./entities";
import {
  ADRENALINE_TIME, giveItem, HANDFLARE_BURN, HANDFLARE_LIGHT, HANDFLARE_THROW,
  MEDKIT_HEAL, MEDKIT_REACH, WELD_INTEGRITY,
} from "./items";
import { overhead, TENDRIL_SEVER_RADIUS } from "./mutants";
import {
  CELL_CHARGE, CHARGER_RATE, charge, HANDOVER_RANGE, spendPower, WELD_DRAW,
} from "./power";
import type { CarryKind } from "./entities";
import { randomZombieKind, zombieDef } from "./zombies";
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
/** How close a teammate stands to shove a Stalker off somebody. */
const SHOVE_RANGE = 66;
/** How close you have to be to pick something up off the deck. */
const PICKUP_RANGE = 44;
/** Seconds a depressurisation lasts before the emergency plating shuts it again. */
const BREACH_TIME = 10;
/**
 * How far the wind reaches, and how hard it pulls. The force is deliberately just under
 * a walking pace: out at the edge of the room you can walk away from it and it feels
 * like wading, close to the hole you lose ground, and a sprint always beats it. Set it
 * above WALK_SPEED and the mechanic stops being a struggle and becomes a death sentence
 * for anybody who was standing in the wrong place when somebody else pulled the lever.
 */
const BREACH_RADIUS = 340;
const SUCTION_FORCE = 195;
/** Damage per second to anything actually in the hole. You are half outside the ship. */
const BREACH_DAMAGE = 26;
/** How many fit in an airlock, and how long it takes to equalize. */
const AIRLOCK_CAPACITY = 2;
const AIRLOCK_CYCLE = 5;
/** Squad air per second while the hull is open, and how slowly it comes back. */
const OXYGEN_DRAIN = 0.085;
const OXYGEN_REGEN = 0.035;
/** Damage per second once the air is gone and the hull is still open. */
const VACUUM_DAMAGE = 14;
/** Damage per second to anything standing in live water. */
const ARC_DAMAGE = 55;
/** How long a discharge lasts, and how long that cable needs before it will do it again. */
const ARC_TIME = 2.4;
const CABLE_RECHARGE = 12;
/** How close you have to be to a discharge to lose your night vision to it. */
const ARC_BLIND_RANGE = 240;
/**
 * How close something in the ducts has to be to a grate to show through it — and, for
 * exactly the same number, to be shootable through it. Drawn and hit at one radius on
 * purpose: the rule the player learns is "shoot the shadow", and that only works if the
 * shadow is the hitbox.
 */
export const VENT_SHADOW = TILE * 1.2;
/** Integrity a single body takes off a weld per second. */
const WELD_CHEW = 16;
/** How hard a floor has to be leaning before the director will send a Stalker at all. */
const STALKER_PRESSURE = 1.4;
/** And how often it takes the chance when it has it. */
const STALKER_CHANCE = 0.12;
/** Seconds between rotor noise pulses while the helicopter is over the map. */
const ROTOR_PULSE = 0.5;
/** Seconds remaining at which the holdout calls the time. */
const HOLDOUT_CALLS = [60, 30, 10];

// --- the ship: power, the reactor and the bridge -----------------------------
//
// CORE 18b. The other objective chain, and the one the story campaign is built on:
// find the reactor, bring main power back, and use it to open a door. Where the
// extraction finale is a timer you defend, this is a state flag that changes the rest
// of the mission — see `src/sim/devices.ts` for the devices themselves.

/**
 * Seconds of siege the director runs from the moment the first fusion cell is seated.
 * The reactor floor is a search until then and a fight afterwards, and that switch is
 * the player's to throw.
 */
const REACTOR_SIEGE = 100;
/**
 * Seconds of "every door at once" when the squad first reaches the sealed bridge. The
 * pacing shift Act II asks for: the door does not open, and the ship notices you tried.
 */
const DOOR_KLAXON = 10;
/** How far the bridge klaxon carries. It is meant to wake the whole deck. */
const KLAXON_NOISE = 1500;
/** Seconds between siren whoops once main power is back and the ship is in alarm. */
const SIREN_INTERVAL = 4.5;

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
    // The utility slot, the hazards, and being got hold of.
    | "heal" | "item" | "weld" | "weldBroken" | "arc" | "grabbed" | "pinned" | "freed"
    | "carry" | "breach" | "airlock"
      | "floorCleared" | "missionComplete" | "missionFailed"
      | "flareLit" | "holdout" | "chopperInbound" | "chopperDown"
      // The ship arc: a crew log, a locker, the reactor and the bridge door.
      | "log" | "pickup" | "reactor" | "power" | "siren"
      | "doorSealed" | "unsealing" | "unsealed";
  x?: number;
  y?: number;
  text?: string;
  /** How many zombies a `horde` event released. */
  count?: number;
  /** `log` only: which of the floor's logs to show. The mission owns the text. */
  index?: number;
}

/**
 * A stable name for an airlock chamber: the lowest tile index in it. Survives the grid
 * rebuild that shutting its doors triggers, which an array position does not.
 */
function airlockKey(lock: { tiles: number[] }): number {
  let min = Infinity;
  for (const t of lock.tiles) min = Math.min(min, t);
  return min;
}

/** Distance from a point to a line segment, against a radius. Used to shoot a rope. */
function nearSegment(
  px: number, py: number, ax: number, ay: number, bx: number, by: number, radius: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const along = len2 <= 1e-6 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  const t = Math.max(0, Math.min(1, along));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy) <= radius;
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
  /**
   * Flares somebody has thrown. Unlike a lamp these come and go, so they are entities
   * with a clock rather than baked geometry — but they light the room, they count as
   * being able to SEE the room, and that is the whole reason to carry one: twenty
   * seconds of a corner nobody has to point a flashlight at.
   */
  readonly thrownFlares: { x: number; y: number; life: number; light: VisionLight }[] = [];
  /**
   * Puddles with a current going through them, by index into `map.puddles`. A cable
   * charges one for a few seconds and then it is dead water again — repeatable, so it
   * is a tool, with a recharge, so it is not a farm.
   */
  readonly liveWater = new Map<number, number>();
  /**
   * Heavy things lying on the deck. A carried object is not an inventory entry — it is
   * an object, and putting it down leaves it where you put it, which is what makes
   * "somebody watch this while I deal with that" a thing you can actually do.
   */
  readonly dropped: { kind: CarryKind; x: number; y: number; charge: number }[] = [];
  /**
   * A depressurisation in progress. There is only ever one — a second lever moves it
   * rather than stacking, the same rule the car alarm uses — and while it runs the room
   * is pulling everything loose toward `x, y`.
   */
  readonly breach = { active: false, x: 0, y: 0, timeLeft: 0, pulse: 0 };
  /**
   * The squad's air, 0..1. Shared, because the ship is: the whole point of a breach is
   * that the person who pulled the lever is not the only one paying for it. It comes
   * back slowly once the hull is shut again.
   */
  readonly oxygen = { level: 1 };
  /**
   * Airlock cycles in progress, by index into `map.airlocks`: seconds left, and who was
   * inside when the doors shut. A chamber holds two — the third person waits, and the
   * squad is a pair and a pair for the next five seconds whether they like it or not.
   */
  readonly cycling = new Map<number, { timeLeft: number; inside: number[] }>();
  /**
   * Chambers that have finished a cycle and not yet emptied. Without this a pair who
   * stand around in an airlock after it opens are sealed straight back in, forever —
   * the doors have to stay open until somebody actually walks out of it.
   */
  private equalized = new Set<number>();
  /** Seconds until each cable can be fired again, by "tx,ty". */
  private cableCooldown = new Map<string, number>();
  /** Player ids that were held last step, so a grab is announced exactly once. */
  private heldLast = new Set<number>();
  /**
   * Welded bulkheads and what is left of them, by "tx,ty". A weld buys the squad time
   * and nothing more: the things on the other side chew through it.
   */
  readonly welds = new Map<string, number>();

  /**
   * CORE 18 — terminals, lockers, fusion sockets and the bridge door. See
   * `src/sim/devices.ts`; this owns what any of it MEANS.
   */
  readonly devices = new DeviceSystem();
  /**
   * Main power. Deliberately **mission**-scoped rather than floor-scoped: it survives
   * a floor load with the squad, because the whole shape of the story arc is that the
   * ship is a different place on the way back up than it was on the way down.
   */
  readonly power = {
    on: false,
    /** Seconds since it came back. The renderer pulses the alarm off this. */
    time: 0,
    /** Counts down to the next siren whoop while the ship is in alarm. */
    siren: 0,
  };
  /**
   * This floor is unlit even by the standards of a game about a flashlight — the
   * reactor decks. Presentation only: the renderer reads it and nothing else does.
   * Set by the game shell from the mission's floor spec.
   */
  blackout = false;
  /**
   * Difficulty multiplier for the director, set per floor by the campaign so a mission
   * gets heavier as it goes. Kept here rather than inside the director because a floor
   * load resets the director and must not reset this.
   */
  private _difficulty = 1;
  get difficulty(): number { return this._difficulty; }
  set difficulty(next: number) {
    this._difficulty = next;
    this.director.setPressure(next);
  }

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
    kind: "none" as "none" | "exit" | "stairs" | "signal" | "holdout" | "inbound"
        | "reactor" | "sealed" | "unseal",
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
    this.devices.rebuild(this.map);
    this.resetExtraction();
  }

  /**
   * CORE 14b — swap the map without tearing the world down. Entities are kept (players
   * keep their device bindings, colours and score) and simply re-placed on the new grid,
   * which is what makes hot-loading a map from the editor feel instant.
   */
  loadLevel(level: LevelData, opts: { keepSquad?: boolean } = {}): void {
    this.map = buildTileMap(level);
    // Power is the one thing that crosses a floor boundary, and only within a mission:
    // keeping the squad means the same run, so the reactor stays on behind them.
    if (!opts.keepSquad) {
      this.power.on = false;
      this.power.time = 0;
      this.power.siren = 0;
    }
    this.bakeStaticLights();
    this.enemies.length = 0;
    // Everything below is keyed to the floor that is being thrown away. A weld and a
    // charged puddle are both indexed BY TILE, so carrying either across a floor load
    // would point them at whatever happens to be at those coordinates next — and a
    // flare on the deck you just left has nothing to light.
    this.welds.clear();
    this.liveWater.clear();
    this.cableCooldown.clear();
    this.thrownFlares.length = 0;
    this.dropped.length = 0;
    this.heldLast.clear();
    this.breach.active = false;
    this.breach.timeLeft = 0;
    this.cycling.clear();
    this.equalized.clear();
    // Air is per floor: a new deck is a sealed one, whatever the last one cost you.
    this.oxygen.level = 1;
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
    // A floor load resets the director, so the campaign's difficulty has to go back on.
    this.director.setPressure(this._difficulty);
    this.devices.rebuild(this.map);
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
      // Whatever had hold of somebody is on the floor below now. A restraint outlives
      // its owner here, and nothing left alive would ever release it.
      p.restraint = null;
      p.itemHold = 0;
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
      this.enemies.push(createEnemy(this.nextEnemyId++, spot.x, spot.y, spot.kind));
    }
  }

  /** Inside the no-spawn bubble around any of this floor's arrival tiles? */
  private nearPlayerSpawn(x: number, y: number): boolean {
    return this.map.playerSpawns.some(
      (p) => Math.hypot(p.x - x, p.y - y) < SPAWN_SAFE_RADIUS,
    );
  }

  /**
   * Lamp tiles never move, so solve their visibility polygons once instead of per frame.
   *
   * Re-run whenever the grid changes a light — priming a fusion socket makes it glow,
   * reading a terminal dims it — which means this has to be idempotent, and a flare
   * already burning has to survive it. Hence the second loop: the flare's light is not
   * in the grid (see `lightFlare`), so baking from the grid alone would put it out.
   */
  private bakeStaticLights(): void {
    this.staticLights.length = 0;
    for (const lamp of this.map.lamps) {
      const light = makeLight("#ffdca8", Math.PI, lamp.range, 0.8);
      light.x = lamp.x;
      light.y = lamp.y;
      computeVisibility(this.map, light);
      this.staticLights.push(light);
    }
    const phase = this.extraction?.phase;
    if (phase && phase !== "none" && phase !== "signal") this.bakeFlareLights();
  }

  /** The burning signal flare, as light. Split out because the bake has to redo it. */
  private bakeFlareLights(): void {
    for (const tile of this.map.signals) {
      const light = makeLight("#ff8a4a", Math.PI, FLARE_LIGHT, 0.9);
      light.x = tile.x;
      light.y = tile.y;
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
      swing: this.swingMelee,
      useItem: this.useItem,
      lit: this.litHere,
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
      lit: this.litHere,
    };
    for (const e of this.enemies) updateEnemy(e, enemyDeps, dt);

    this.updateBullets(dt);
    this.updateGrabs();
    this.updateShoves(dt, inputOf);
    this.updateCarry(dt, inputOf);
    this.updateBreach(dt);
    this.updateAirlocks(dt);
    this.updateFlares(dt);
    this.updateCurrent(dt);
    this.updateWelds(dt);
    this.particles.update(dt);
    // Noises age out after every listener has had a step to hear them.
    this.noise.update(dt);
    this.updateAlarm(dt);
    this.updateSiren(dt);
    this.updateDevices(dt, inputOf);
    this.updateDirector(dt);
    this.updateBleedout(dt);
    this.updateObjective(dt);

    // Vision is recomputed once per step and shared by all viewports. The fog lookup
    // happens here because the player module has no business reading the tile grid —
    // it is handed a thickness and decides what that does to its own lights.
    for (const p of this.players) {
      syncLights(p, this.map.fogAt(p.eyeX, p.eyeY));
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
    // Something up in the ceiling is not in the room, however bright the room is.
    for (const e of this.enemies) e.visible = !overhead(e) && this.squadCanSee(e.x, e.y);
  }

  /**
   * Can anybody see this point right now? The renderer's own test, so "is that zombie
   * drawn" and "may a wave arrive there" can never answer it differently. Bound,
   * because the director holds it as a callback.
   */
  squadCanSee = (x: number, y: number): boolean => {
    // Thick enough coolant and it does not matter whose light is on: nothing in there
    // is visible to anybody, which is the entire point of walking into a fog bank.
    if (this.map.fogAt(x, y) > 0.55) return false;

    for (const p of this.players) {
      const lit =
        inCone(p.eyeX, p.eyeY, p.facing, p.cone.halfAngle, p.cone.range, x, y) ||
        Math.hypot(p.eyeX - x, p.eyeY - y) < p.halo.range;
      if (!lit) continue;
      if (hasLineOfSight(this.map, p.eyeX, p.eyeY, x, y)) return true;
    }
    if (this.players.length === 0) return false;
    // Standing in a lamp's pool gives you away too — that is what lamps are for, and
    // it is why a thrown flare reveals a room nobody is pointing a flashlight at.
    for (const light of this.staticLights) {
      if (Math.hypot(light.x - x, light.y - y) > light.range) continue;
      if (hasLineOfSight(this.map, light.x, light.y, x, y)) return true;
    }
    for (const f of this.thrownFlares) {
      if (Math.hypot(f.x - x, f.y - y) > f.light.range) continue;
      if (hasLineOfSight(this.map, f.x, f.y, x, y)) return true;
    }
    return false;
  };

  /**
   * Is this point lit by something that is not a flashlight? Emergency lighting, a
   * lamp, a burning flare. Where this is true a player can leave their beam on without
   * announcing themselves — which is the whole of the light-and-aggro trade.
   */
  litHere = (x: number, y: number): boolean => {
    for (const light of this.staticLights) {
      if (Math.hypot(light.x - x, light.y - y) > light.range * 0.85) continue;
      if (hasLineOfSight(this.map, light.x, light.y, x, y)) return true;
    }
    for (const f of this.thrownFlares) {
      if (Math.hypot(f.x - x, f.y - y) > f.light.range * 0.85) continue;
      if (hasLineOfSight(this.map, f.x, f.y, x, y)) return true;
    }
    return false;
  };

  // === The utility slot ======================================================

  /**
   * Spend the item in a player's utility slot. Returns whether it was actually used —
   * a refusal keeps the charge, which matters because three of the four are one-shot
   * and losing one to a misplaced button press would be infuriating.
   *
   * Bound, because the player module holds it as a callback: it runs the dwell clock
   * and knows nothing about what a flare lights or what a weld seals.
   */
  private useItem = (p: Player): boolean => {
    switch (p.item) {
      case "medkit": return this.useMedkit(p);
      case "adrenaline": return this.useAdrenaline(p);
      case "flare": return this.throwFlare(p);
      case "welder": return this.useWelder(p);
      default: return false;
    }
  };

  /**
   * Patch somebody up. A teammate in arm's reach takes priority over yourself — if you
   * are standing next to the person who is nearly dead, that is what you meant.
   *
   * It will not touch a downed player, deliberately: picking somebody up off the floor
   * is the co-op moment the whole down-and-revive rule exists for, and a medkit that
   * short-circuits it would quietly delete the best thing about the game.
   */
  private useMedkit(p: Player): boolean {
    let target = p;
    let worst = p.downed ? p.maxHealth : p.health;
    for (const other of this.players) {
      if (other === p || other.downed) continue;
      if (Math.hypot(other.x - p.x, other.y - p.y) > MEDKIT_REACH) continue;
      if (other.health >= worst) continue;
      worst = other.health;
      target = other;
    }
    if (target.downed || target.health >= target.maxHealth) return false;

    target.health = Math.min(target.maxHealth, target.health + target.maxHealth * MEDKIT_HEAL);
    this.particles.burst(target.x, target.y, 14, 120, "#ff9ab4", 0.6, 3);
    this.events.push({
      kind: "heal", x: target.x, y: target.y,
      text: target === p ? `P${p.id + 1} patched up` : `P${p.id + 1} → P${target.id + 1}`,
    });
    return true;
  }

  /**
   * The shot. Instant, because the moment you need it is the moment you have no time —
   * and it tears you out of whatever has hold of you, which is the only self-rescue
   * from a grip in the game.
   */
  private useAdrenaline(p: Player): boolean {
    p.adrenaline = ADRENALINE_TIME;
    p.stamina = p.maxStamina;
    p.exhausted = false;
    if (breakFree(p)) this.particles.burst(p.x, p.y, 16, 240, "#ffe66b", 0.45, 3);
    else this.particles.burst(p.x, p.y, 10, 150, "#ffe66b", 0.4, 2);
    this.events.push({ kind: "item", x: p.x, y: p.y, text: `P${p.id + 1} adrenaline` });
    return true;
  }

  /**
   * Throw a flare. It flies where you are looking, stops at the first wall, and burns
   * for twenty seconds — during which the room is lit for EVERYONE, counts as seen by
   * the squad, and costs nobody their flashlight. The counter to both mutants is a lit
   * room, and this is how you make one on demand.
   */
  private throwFlare(p: Player): boolean {
    const cos = Math.cos(p.facing);
    const sin = Math.sin(p.facing);
    let dist = HANDFLARE_THROW;
    for (let d = 12; d <= HANDFLARE_THROW; d += 8) {
      if (!this.map.isSolidAt(p.eyeX + cos * d, p.eyeY + sin * d)) continue;
      dist = Math.max(12, d - 10);
      break;
    }
    const x = p.eyeX + cos * dist;
    const y = p.eyeY + sin * dist;
    const light = makeLight("#ff8a4a", Math.PI, HANDFLARE_LIGHT, 0.85);
    light.x = x;
    light.y = y;
    computeVisibility(this.map, light);
    this.thrownFlares.push({ x, y, life: HANDFLARE_BURN, light });
    this.particles.burst(x, y, 16, 200, "#ffb06a", 0.5, 3);
    // It fizzes. Loud enough to matter, which is the cost of lighting a room.
    this.noise.emit(x, y, 320, "flare");
    this.events.push({ kind: "item", x, y, text: "flare" });
    return true;
  }

  /**
   * Weld the bulkhead you are standing in. Costs a charge, turns the doorway solid, and
   * starts a clock you do not control: whatever is on the other side chews through it.
   * Buying the squad forty seconds to patch up is exactly what it is for, and buying
   * them a permanent wall is exactly what it is not.
   */
  private useWelder(p: Player): boolean {
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);
    const def = tileDef(this.map.tileAt(tx, ty));
    if (!def.bulkhead || def.weldsInto === undefined) return false;
    // Nothing gets welded into a wall with a body in the doorway.
    for (const e of this.enemies) {
      if (Math.hypot(e.x - p.x, e.y - p.y) < TILE * 0.8) return false;
    }
    // A weld is most of a magazine's worth of charge out of the same cell.
    if (!spendPower(p, WELD_DRAW)) return false;
    this.map.setTile(tx, ty, def.weldsInto);
    this.map.refresh();
    this.director.rebuild(this.map);
    this.welds.set(`${tx},${ty}`, WELD_INTEGRITY);
    this.particles.burst(p.x, p.y, 18, 160, "#ffd98a", 0.5, 3);
    this.noise.emit(p.x, p.y, 260, "impact");
    this.events.push({ kind: "weld", x: p.x, y: p.y, text: "bulkhead sealed" });
    return true;
  }

  /** Burn the thrown flares down, and drop the ones that have gone out. */
  private updateFlares(dt: number): void {
    for (let i = this.thrownFlares.length - 1; i >= 0; i--) {
      const f = this.thrownFlares[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.thrownFlares.splice(i, 1);
        continue;
      }
      // Guttering out: the last couple of seconds shrink rather than snap off.
      const fade = Math.min(1, f.life / 2.5);
      f.light.range = HANDFLARE_LIGHT * (0.75 + 0.25 * fade);
      f.light.intensity = 0.85 * fade;
    }
  }

  // === Being held ============================================================

  /**
   * Notice the moment somebody is taken, so the audio and the HUD have an event to hang
   * off. The restraint itself is set by whichever creature did it — this only watches
   * the edge, because "who has hold of whom" is state, and "somebody just got grabbed"
   * is news.
   */
  private updateGrabs(): void {
    for (const p of this.players) {
      const held = p.restraint !== null;
      const was = this.heldLast.has(p.id);
      if (held && !was) {
        this.heldLast.add(p.id);
        this.events.push({
          kind: p.restraint!.kind === "pin" ? "pinned" : "grabbed",
          x: p.x, y: p.y,
          text: p.restraint!.kind === "pin" ? `P${p.id + 1} pinned` : `P${p.id + 1} grabbed`,
        });
      } else if (!held && was) {
        this.heldLast.delete(p.id);
      }
    }
  }

  /**
   * Shoving a Stalker off a teammate. The same shape as a revive — stand close, hold
   * USE — because it is the same idea: the person in trouble cannot help themselves,
   * and somebody has to walk over there and do something about it.
   */
  private updateShoves(dt: number, inputOf: (p: Player) => InputState): void {
    for (const p of this.players) {
      const r = p.restraint;
      if (r === null || r.kind !== "pin") continue;
      let helping = false;
      for (const helper of this.players) {
        if (helper === p || helper.downed || helper.restraint !== null) continue;
        if (Math.hypot(helper.x - p.x, helper.y - p.y) > SHOVE_RANGE) continue;
        if (!inputOf(helper).interact) continue;
        helping = true;
        break;
      }
      r.shove = Math.max(0, r.shove + (helping ? dt : -dt * 0.8));
    }
  }

  // === Heavy things ==========================================================

  /**
   * Picking up, putting down, and what a charging point does. Everything heavy is an
   * object in the world rather than a slot on a player, which is the whole point: a
   * fusion core going to the reactor is a thing somebody is visibly holding, with both
   * hands, and cannot shoot while holding.
   */
  private updateCarry(dt: number, inputOf: (p: Player) => InputState): void {
    for (const p of this.players) {
      if (p.downed) {
        // You drop what you were holding where you fall. Somebody has to come for both.
        if (p.carrying !== null) this.putDown(p);
        continue;
      }

      // A charging point works by standing on it. No button, because the cost is the
      // seconds you spend in the open, and a hold would just be a second cost.
      if (this.map.isChargerAt(p.x, p.y)) {
        const taken = charge(p, CHARGER_RATE * dt);
        if (taken > 0 && Math.random() < dt * 8) {
          this.particles.burst(p.x, p.y, 2, 60, "#5affd2", 0.3, 2);
        }
      }

      const pressed = inputOf(p).interactPressed;

      if (p.carrying !== null) {
        if (pressed) this.deliverCarried(p);
        continue;
      }

      // Empty hands, standing on a rack: shoulder one.
      const rack = this.map.rackAt(p.x, p.y);
      if (rack && pressed) {
        p.carrying = rack.gives;
        p.carryCharge = rack.gives === "battery" ? 1 : 1;
        this.events.push({
          kind: "carry", x: p.x, y: p.y,
          text: `P${p.id + 1} has a ${rack.gives === "core" ? "fusion core" : "power cell"}`,
        });
        continue;
      }

      // Or something somebody left on the deck.
      if (!pressed) continue;
      for (let i = 0; i < this.dropped.length; i++) {
        const d = this.dropped[i];
        if (Math.hypot(d.x - p.x, d.y - p.y) > PICKUP_RANGE) continue;
        p.carrying = d.kind;
        p.carryCharge = d.charge;
        this.dropped.splice(i, 1);
        this.events.push({ kind: "carry", x: p.x, y: p.y, text: `P${p.id + 1} picked it up` });
        break;
      }
    }
  }

  /**
   * What pressing USE does with something in your hands. In order: seat a fusion core
   * in the socket you are standing on, hand a cell to the teammate who needs it more,
   * slot it into your own suit, or simply put the thing down.
   *
   * The teammate case is the one worth having. "Hot-swap" only means anything if it is
   * easier to give a cell away than to keep it, so a squadmate in arm's reach with less
   * charge than you takes priority over your own suit.
   */
  private deliverCarried(p: Player): void {
    if (p.carrying === "core") {
      const device = this.map.deviceAt(p.x, p.y);
      if (device?.kind === "socket") {
        // The core is the thing the socket wanted; seating it is the easy part.
        for (const o of this.devices.seatCore(this.map, device)) this.applyDevice(o);
        p.carrying = null;
        p.carryCharge = 0;
        this.events.push({ kind: "carry", x: p.x, y: p.y, text: "core seated" });
        return;
      }
      this.putDown(p);
      return;
    }

    // A power cell.
    let best: Player | null = null;
    for (const other of this.players) {
      if (other === p || other.downed) continue;
      if (Math.hypot(other.x - p.x, other.y - p.y) > HANDOVER_RANGE) continue;
      if (other.battery >= p.battery) continue;
      if (best === null || other.battery < best.battery) best = other;
    }
    const into = best ?? p;
    const taken = charge(into, CELL_CHARGE * p.carryCharge);
    if (taken <= 0) {
      this.putDown(p);
      return;
    }
    p.carrying = null;
    p.carryCharge = 0;
    this.particles.burst(into.x, into.y, 12, 110, "#7ad2ff", 0.4, 2);
    this.events.push({
      kind: "carry", x: into.x, y: into.y,
      text: into === p ? `P${p.id + 1} swapped a cell` : `P${p.id + 1} → P${into.id + 1} cell`,
    });
  }

  /** Put the carried object on the deck where the player is standing. */
  private putDown(p: Player): void {
    if (p.carrying === null) return;
    this.dropped.push({ kind: p.carrying, x: p.x, y: p.y, charge: p.carryCharge });
    p.carrying = null;
    p.carryCharge = 0;
  }

  // === Airlocks ==============================================================

  /**
   * A deck transition that costs the squad its shape.
   *
   * The chamber takes two. When the second person steps in, the doors shut and it takes
   * five seconds to equalize — which leaves the other half of the squad outside, in the
   * corridor they just cleared, listening. That is the whole mechanic: not the delay,
   * the split. Everything here exists to make sure the pair who went through and the
   * pair who did not are both somewhere they have to think about.
   *
   * Nobody is teleported and nothing is blocked from walking in or out once the doors
   * open again — the chamber is ordinary floor with two doors, and the cycle is the only
   * state. That keeps a half-cycled airlock from ever becoming a soft lock.
   */
  private updateAirlocks(dt: number): void {
    for (const lock of this.map.airlocks) {
      // Keyed by the chamber's lowest tile index, NOT by its position in the list.
      // Shutting a door calls `refresh`, which rebuilds that list — an index taken
      // before the doors closed can point at a different chamber, or at nothing, and
      // a cycle that loses its own entry never opens the doors again.
      const key = airlockKey(lock);
      const running = this.cycling.get(key);

      if (running) {
        running.timeLeft -= dt;
        if (running.timeLeft > 0) continue;
        this.cycling.delete(key);
        this.equalized.add(key);
        this.setAirlockDoors(lock, false);
        // No text: the doors sliding open is the message, and the HUD has been counting
        // the cycle down in front of whoever is inside. The event still fires so the
        // audio layer can put the clunk where the chamber is.
        this.events.push({ kind: "airlock", x: lock.x, y: lock.y });
        continue;
      }

      // Who is standing in it right now?
      const inside = this.players.filter(
        (p) => !p.downed && this.map.airlockAt(p.x, p.y) === lock,
      );
      // Empty again: the chamber is ready for the next pair.
      if (inside.length === 0) {
        this.equalized.delete(key);
        continue;
      }
      if (this.equalized.has(key)) continue;   // already cycled; walk out of it
      if (inside.length < AIRLOCK_CAPACITY) continue;
      // Full. The doors shut behind whoever got there first.
      this.cycling.set(key, {
        timeLeft: AIRLOCK_CYCLE,
        inside: inside.slice(0, AIRLOCK_CAPACITY).map((p) => p.id),
      });
      this.setAirlockDoors(lock, true);
      this.noise.emit(lock.x, lock.y, 420, "impact");
      this.events.push({
        kind: "airlock", x: lock.x, y: lock.y,
        text: this.players.length > AIRLOCK_CAPACITY ? "AIRLOCK CYCLING — HOLD THE DOOR" : "AIRLOCK CYCLING",
      });
    }
  }

  /** Shut or open every door around a chamber, by swapping the tiles. */
  private setAirlockDoors(lock: { doors: { tx: number; ty: number }[] }, shut: boolean): void {
    let changed = false;
    for (const d of lock.doors) {
      const def = tileDef(this.map.tileAt(d.tx, d.ty));
      const next = shut ? def.shutInto : def.opensInto;
      if (next === undefined) continue;
      this.map.setTile(d.tx, d.ty, next);
      changed = true;
    }
    if (!changed) return;
    this.map.refresh();
    // A door is geometry: the routes the horde walks and the doors a wave can use both
    // change when one shuts, so everything derived from the grid has to be told.
    this.director.rebuild(this.map);
    this.refreshLure();
  }

  /** Seconds left on the cycle this player is inside, or 0. For the HUD. */
  airlockCycleFor(p: Player): number {
    const lock = this.map.airlockAt(p.x, p.y);
    if (!lock) return 0;
    return this.cycling.get(airlockKey(lock))?.timeLeft ?? 0;
  }

  // === Vacuum ================================================================

  /**
   * Pull a lever and the room goes to vacuum through the nearest hull breach.
   *
   * Ten seconds, and every one of them costs something. Low-tier bodies go out of the
   * hole and off the ship — that is what you paid for. But the squad's air goes with
   * them, the noise brings whatever is next door, and anybody not holding on to
   * something bolted down is being dragged toward the same hole as the horde.
   */
  private openBreach(x: number, y: number): void {
    const hole = this.nearestBreach(x, y);
    if (!hole) {
      // A lever with no hull breach on the floor is a lever that does nothing, and it
      // should say so rather than quietly eating the pull.
      this.events.push({ kind: "breach", x, y, text: "NO BREACH ON THIS DECK" });
      return;
    }
    this.breach.active = true;
    this.breach.x = hole.x;
    this.breach.y = hole.y;
    this.breach.timeLeft = BREACH_TIME;
    this.breach.pulse = 0;
    // Deafening. A depressurisation is the loudest thing on the deck bar the rotor,
    // and everything that can hear it comes to look at what is left afterwards.
    this.noise.emit(hole.x, hole.y, NOISE.breach, "breach");
    this.events.push({ kind: "breach", x: hole.x, y: hole.y, text: "HULL BREACH — HOLD ON" });
  }

  private nearestBreach(x: number, y: number): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const b of this.map.breaches) {
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  private updateBreach(dt: number): void {
    if (!this.breach.active) {
      // Air comes back once the hull is shut, slowly enough that a second breach
      // inside a minute is a genuinely bad idea.
      if (this.oxygen.level < 1) {
        this.oxygen.level = Math.min(1, this.oxygen.level + OXYGEN_REGEN * dt);
      }
      return;
    }

    this.breach.pulse += dt;
    this.breach.timeLeft -= dt;
    if (this.breach.timeLeft <= 0) {
      this.breach.active = false;
      this.events.push({ kind: "breach", x: this.breach.x, y: this.breach.y, text: "HULL SEALED" });
      return;
    }

    // The air. Shared, and it does not care who pulled the lever.
    this.oxygen.level = Math.max(0, this.oxygen.level - OXYGEN_DRAIN * dt);

    /*
     * The pull. Applied as DISPLACEMENT rather than as velocity, which matters: both
     * the player step and the zombie step damp their own velocity toward what they are
     * trying to do, so a force added here would be quietly erased before anything moved.
     * Moving bodies through `moveCircle` also means the wind cannot push anything into
     * a wall, which a velocity nudge would happily do.
     *
     * Standing on something bolted down opts out of all of it — which is why the
     * railings are drawn on the floor where you can plan around them.
     */
    for (const p of this.players) {
      const pull = this.suctionAt(p.x, p.y);
      if (pull <= 0) continue;
      // Suffocating is not instant, but standing in a vacuum is not free either.
      if (this.oxygen.level <= 0 && !p.downed) this.hurtPlayer(p, VACUUM_DAMAGE * dt);
      if (this.map.isRailingAt(p.x, p.y)) continue;
      this.dragToward(p, SUCTION_FORCE * pull * dt);
      // Dragged all the way in: you are hanging half out of the hull, and it hurts
      // rather than kills — this has to be survivable by a teammate grabbing you.
      if (Math.hypot(this.breach.x - p.x, this.breach.y - p.y) < TILE * 0.7 && !p.downed) {
        this.hurtPlayer(p, BREACH_DAMAGE * dt);
      }
    }

    // And the horde. Anything light enough goes out of the hole and off the ship.
    for (const e of [...this.enemies]) {
      if (overhead(e)) continue;                    // in the ceiling, out of the wind
      const pull = this.suctionAt(e.x, e.y);
      if (pull <= 0) continue;
      const def = zombieDef(e.kind);
      // Heavy things brace. A Strangler has a post and a grip; a walker does not.
      const grip = def.tendril || def.pounce ? 0.3 : 1;
      this.dragToward(e, SUCTION_FORCE * pull * grip * dt);
      // Close enough to the hole and it simply leaves.
      const d = Math.hypot(this.breach.x - e.x, this.breach.y - e.y);
      if (d < TILE * 0.8 && grip === 1) {
        this.particles.burst(e.x, e.y, 14, 320, "#dfe6f2", 0.4, 3);
        this.killEnemy(e, -1);
      }
    }

    // Dropped objects go the same way, which is a reason not to leave a fusion core
    // lying on the floor of a room somebody is about to blow down.
    for (let i = this.dropped.length - 1; i >= 0; i--) {
      const d = this.dropped[i];
      const pull = this.suctionAt(d.x, d.y);
      if (pull <= 0) continue;
      const dx = this.breach.x - d.x;
      const dy = this.breach.y - d.y;
      const dist = Math.hypot(dx, dy) || 1;
      d.x += (dx / dist) * SUCTION_FORCE * pull * dt * 0.5;
      d.y += (dy / dist) * SUCTION_FORCE * pull * dt * 0.5;
      if (dist < TILE * 0.7) this.dropped.splice(i, 1);
    }

    if (Math.random() < dt * 40) {
      const a = Math.random() * Math.PI * 2;
      const r = TILE * (1 + Math.random() * 5);
      this.particles.burst(
        this.breach.x + Math.cos(a) * r, this.breach.y + Math.sin(a) * r,
        2, 40, "#cfe0f0", 0.35, 2,
      );
    }
  }

  /** Slide a body toward the hole, through geometry rather than into it. */
  private dragToward(body: { x: number; y: number; radius: number }, amount: number): void {
    const dx = this.breach.x - body.x;
    const dy = this.breach.y - body.y;
    const d = Math.hypot(dx, dy) || 1;
    const moved = moveCircle(
      this.map, body.x, body.y, body.radius, (dx / d) * amount, (dy / d) * amount,
    );
    body.x = moved.x;
    body.y = moved.y;
  }

  /**
   * How hard the air is pulling at a point, 0..1. Zero outside the radius, and zero
   * through a wall — a depressurisation empties the room it is in, not the deck.
   */
  suctionAt(x: number, y: number): number {
    if (!this.breach.active) return 0;
    const d = Math.hypot(this.breach.x - x, this.breach.y - y);
    if (d > BREACH_RADIUS) return 0;
    if (!hasLineOfSight(this.map, this.breach.x, this.breach.y, x, y)) return 0;
    return 1 - (d / BREACH_RADIUS) * 0.65;
  }

  // === Current, water and welds ==============================================

  /**
   * A live puddle. For the few seconds it is charged it cooks anything standing in it
   * and whites out the vision of anybody near it — including the player who shot the
   * cable, which is what stops this being a free button.
   */
  private updateCurrent(dt: number): void {
    for (const [key, left] of this.cableCooldown) {
      const next = left - dt;
      if (next <= 0) this.cableCooldown.delete(key);
      else this.cableCooldown.set(key, next);
    }
    if (this.liveWater.size === 0) return;

    for (const [index, left] of [...this.liveWater]) {
      const next = left - dt;
      if (next <= 0) {
        this.liveWater.delete(index);
        continue;
      }
      this.liveWater.set(index, next);
      const puddle = this.map.puddles[index];
      if (!puddle) continue;

      for (const e of [...this.enemies]) {
        if (overhead(e)) continue;
        if (!this.inPuddle(puddle, e.x, e.y)) continue;
        e.hurtFlash = 1;
        if (damageEnemy(e, ARC_DAMAGE * dt)) this.killEnemy(e, -1);
      }
      for (const p of this.players) {
        if (p.downed) continue;
        if (this.inPuddle(puddle, p.x, p.y)) this.hurtPlayer(p, ARC_DAMAGE * 0.35 * dt);
      }
      if (Math.random() < dt * 18) {
        const t = puddle.tiles[Math.floor(Math.random() * puddle.tiles.length)];
        const tx = (t % this.map.cols + 0.5) * TILE;
        const ty = (Math.floor(t / this.map.cols) + 0.5) * TILE;
        this.particles.burst(tx, ty, 3, 200, "#bfe9ff", 0.2, 2);
      }
    }
  }

  private inPuddle(puddle: { tiles: number[] }, x: number, y: number): boolean {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (!this.map.inBounds(tx, ty)) return false;
    return puddle.tiles.includes(this.map.idx(tx, ty));
  }

  /**
   * Put a current through the water a cable is standing in. Everything about the timing
   * is in `ARC_TIME` and `CABLE_RECHARGE`: long enough to clear a room, short enough
   * that you cannot hold a doorway with it.
   */
  private chargeCable(tx: number, ty: number): void {
    const key = `${tx},${ty}`;
    if (this.cableCooldown.has(key)) return;
    const center = this.map.tileCenter(tx, ty);
    let touched = false;
    for (let i = 0; i < this.map.puddles.length; i++) {
      const puddle = this.map.puddles[i];
      if (!puddle.cables.some((c) => c.x === center.x && c.y === center.y)) continue;
      this.liveWater.set(i, ARC_TIME);
      touched = true;
      // Anyone close enough to watch it happen loses their night vision for a moment.
      for (const p of this.players) {
        if (Math.hypot(p.x - puddle.x, p.y - puddle.y) < ARC_BLIND_RANGE) {
          p.blinded = ARC_BLIND_TIME;
        }
      }
      this.noise.emit(puddle.x, puddle.y, NOISE.arc, "arc");
      this.events.push({ kind: "arc", x: puddle.x, y: puddle.y, text: "live water" });
    }
    if (!touched) return;
    this.cableCooldown.set(key, CABLE_RECHARGE);
    this.particles.burst(center.x, center.y, 16, 260, "#eaf6ff", 0.4, 3);
  }

  /**
   * Welded bulkheads coming apart. Anything that wants through one leans on it, and a
   * weld that runs out of integrity drops back to an open doorway with a horde behind
   * it — which is the deal the welding tool actually offers: time, not safety.
   */
  private updateWelds(dt: number): void {
    if (this.welds.size === 0) return;
    for (const [key, left] of [...this.welds]) {
      const [tx, ty] = key.split(",").map(Number);
      const def = tileDef(this.map.tileAt(tx, ty));
      if (!def.welded) {
        this.welds.delete(key);
        continue;
      }
      const center = this.map.tileCenter(tx, ty);
      let attackers = 0;
      for (const e of this.enemies) {
        if (overhead(e)) continue;
        if (Math.hypot(e.x - center.x, e.y - center.y) > TILE * 1.1 + e.radius) continue;
        attackers++;
      }
      if (attackers === 0) continue;
      const next = left - attackers * WELD_CHEW * dt;
      if (Math.random() < dt * attackers * 3) {
        this.particles.burst(center.x, center.y, 3, 90, "#c9a23a", 0.3, 2);
      }
      if (next > 0) {
        this.welds.set(key, next);
        continue;
      }
      // Through it.
      this.welds.delete(key);
      this.map.setTile(tx, ty, def.weldFailsInto ?? 0);
      this.map.refresh();
      this.director.rebuild(this.map);
      this.particles.burst(center.x, center.y, 20, 240, "#c9a23a", 0.5, 4);
      this.noise.emit(center.x, center.y, NOISE.glass, "break");
      this.events.push({ kind: "weldBroken", x: center.x, y: center.y, text: "bulkhead breached" });
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
          // Whatever stopped it might have had an alarm — or a current — in it.
          const sx = Math.floor(b.x / TILE);
          const sy = Math.floor(b.y / TILE);
          const stopper = tileDef(this.map.tileAt(sx, sy));
          if (stopper.alarm) this.triggerAlarm(sx, sy);
          if (stopper.cable) this.chargeCable(sx, sy);
          break;
        }

        if (b.team === "player") {
          // A tendril first, and with a fat hit radius. Cutting the rope is meant to be
          // the thing a panicking teammate can manage across a dark room — far easier
          // than putting rounds into the body at the far end of it.
          if (this.severTendril(b.x, b.y, b.damage)) {
            b.active = false;
            break;
          }
          // A shot put through a grate reaches what is crawling above it. Nothing else
          // can touch a Stalker in the ducts, which is why the scraping matters.
          if (this.shootIntoVent(b.x, b.y, b.damage, b.ownerId)) {
            b.active = false;
            break;
          }
          for (const e of this.enemies) {
            if (e.health <= 0 || overhead(e)) continue;
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
   * A melee swing, resolved against everything in the arc at once. Bound, because the
   * player module holds it as a callback — a crowbar has no business importing an Enemy.
   *
   * The arc test is deliberately generous at the edges (the reach counts from body to
   * body, not centre to centre): a swing that visibly connects and does nothing is the
   * fastest way to make melee feel broken.
   */
  private swingMelee = (p: Player, reach: number, arc: number, damage: number): number => {
    let hits = 0;
    for (const e of [...this.enemies]) {
      if (e.health <= 0) continue;
      const dx = e.x - p.eyeX;
      const dy = e.y - p.eyeY;
      const dist = Math.hypot(dx, dy);
      if (dist > p.radius + reach + e.radius) continue;
      // Straight past a wall is not a hit, however close the thing on the other side is.
      if (!hasLineOfSight(this.map, p.eyeX, p.eyeY, e.x, e.y)) continue;
      let off = Math.abs(Math.atan2(dy, dx) - p.facing) % (Math.PI * 2);
      if (off > Math.PI) off = Math.PI * 2 - off;
      if (off > arc) continue;
      hits++;
      // A hit shoves the body back — the reason a crowbar can hold a doorway at all.
      const push = dist > 1 ? 150 / dist : 0;
      e.vx += dx * push;
      e.vy += dy * push;
      e.lastSeenX = p.x;
      e.lastSeenY = p.y;
      if (damageEnemy(e, damage)) this.killEnemy(e, p.id);
    }
    return hits;
  };

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

  /**
   * Is there a tendril across this point? Severing one frees whoever is on the end of
   * it instantly. Returns whether the shot was spent doing it, so a round that cuts a
   * tendril does not carry on into the thing that threw it — the trade is deliberate:
   * you save your teammate OR you hurt the Strangler, not both with one bullet.
   */
  private severTendril(x: number, y: number, damage: number): boolean {
    for (const e of this.enemies) {
      if (e.state !== "reel" || e.tendrilHealth <= 0) continue;
      const target = this.players.find((p) => p.id === e.tendrilTargetId);
      if (!target) continue;
      // The rope is only cuttable along its *span*. The stretch right at the Strangler
      // is excluded, or every round aimed at the body would be swallowed by the thing
      // it is holding — and "shoot the mutant" has to stay a real option.
      const dx = target.x - e.x;
      const dy = target.y - e.y;
      const len = Math.hypot(dx, dy) || 1;
      const skip = Math.min(0.45, (e.radius + TENDRIL_SEVER_RADIUS + 10) / len);
      const ax = e.x + dx * skip;
      const ay = e.y + dy * skip;
      if (!nearSegment(x, y, ax, ay, target.x, target.y, TENDRIL_SEVER_RADIUS)) continue;
      e.tendrilHealth -= damage;
      this.particles.burst(x, y, 8, 180, "#c78ad8", 0.35, 3);
      if (e.tendrilHealth > 0) return true;
      // Cut. The Strangler notices on its own next step; the player is free now.
      if (target.restraint?.byId === e.id) breakFree(target);
      this.particles.burst(x, y, 18, 260, "#b06ac0", 0.5, 3);
      this.events.push({ kind: "freed", x: target.x, y: target.y, text: `P${target.id + 1} cut loose` });
      return true;
    }
    return false;
  }

  /**
   * A round through a vent grate, at whatever is dragging itself along above it. The
   * shot has to be ON a grate — that is what keeps the ducts a safe road — but the
   * reach from the grate is generous, so putting rounds into the vent something is
   * scraping toward works, which is the counterplay the noise exists to set up.
   */
  private shootIntoVent(x: number, y: number, damage: number, ownerId: number): boolean {
    const vent = this.map.ventAt(x, y);
    if (!vent) return false;
    for (const e of this.enemies) {
      if (!overhead(e)) continue;
      // The same radius the renderer draws the shadow at, so the rule is exactly what
      // you can see: if something is crossing that grate, you can shoot it.
      if (Math.hypot(e.x - vent.x, e.y - vent.y) > VENT_SHADOW) continue;
      this.particles.burst(x, y, 8, 170, "#ffd0a0", 0.3, 3);
      e.hurtFlash = 1;
      if (damageEnemy(e, damage)) this.killEnemy(e, ownerId);
      return true;
    }
    return false;
  }

  private killEnemy(e: Enemy, killerId: number): void {
    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);
    // Whatever it had hold of, it does not any more. One place, so "kill the thing" is
    // a real answer to both mutants however it happens to die.
    for (const p of this.players) {
      if (p.restraint?.byId === e.id) {
        breakFree(p);
        this.events.push({ kind: "freed", x: p.x, y: p.y, text: `P${p.id + 1} free` });
      }
    }
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

  // --- the ship ---------------------------------------------------------------

  /**
   * CORE 18 — devices. The system itself only answers "what finished this step"; every
   * consequence is here, because a consequence is a game rule and game rules live in
   * the world.
   */
  private updateDevices(dt: number, inputOf: (p: Player) => InputState): void {
    const outcomes = this.devices.update(dt, {
      map: this.map, players: this.players, inputOf, powered: this.power.on,
    });
    for (const o of outcomes) this.applyDevice(o);
  }

  private applyDevice(o: DeviceOutcome): void {
    if (o.kind === "lever") {
      this.openBreach(o.x, o.y);
      return;
    }
    if (o.kind === "supply") {
      giveItem(o.player, o.item);
      this.events.push({
        kind: "item", x: o.x, y: o.y,
        text: `P${o.player.id + 1} took a ${o.item}`,
      });
      return;
    }
    switch (o.kind) {
      case "log":
        // Using a device rewrites its tile, and every one of these tiles carries a
        // light — so the static bake has to be redone or a read terminal keeps glowing
        // as brightly as an unread one.
        this.bakeStaticLights();
        // The world does not know what the log SAYS — the mission owns the text and the
        // shell looks it up. All the simulation has is which one was read and where.
        this.events.push({ kind: "log", x: o.x, y: o.y, index: o.index });
        break;

      case "locker": {
        this.bakeStaticLights();
        const next = nextWeaponUp(o.player.weapon);
        if (next) {
          giveWeapon(o.player, next);
          this.events.push({
            kind: "pickup", x: o.x, y: o.y,
            text: `P${o.player.id + 1} PICKED UP ${next.name.toUpperCase()}`,
          });
        } else {
          // Nothing better in the ship: a locker you cannot be upgraded by is still
          // worth opening, because it is full of ammunition for what you already carry.
          o.player.ammo = o.player.weapon.magazine;
          o.player.reloadTimer = 0;
          this.events.push({ kind: "pickup", x: o.x, y: o.y, text: "AMMO" });
        }
        break;
      }

      case "reactorStarted":
        // Seating the first cell is what turns the reactor deck from a search into a
        // fight. The siege has a known end, which is what `beginHoldout` is for.
        this.director.beginHoldout(REACTOR_SIEGE);
        this.events.push({ kind: "reactor", x: o.x, y: o.y, text: "AUXILIARY POWER PRIMING" });
        break;

      case "socket":
        this.bakeStaticLights();
        this.noise.emit(o.x, o.y, NOISE.flare, "impact");
        if (o.primed < o.total) {
          this.events.push({
            kind: "reactor", x: o.x, y: o.y, text: `FUSION CELL ${o.primed} / ${o.total}`,
          });
        }
        break;

      case "power":
        this.restorePower(o.x, o.y);
        break;

      case "doorSealed":
        // Act II's wall. The door does not open, and trying is loud: every door on the
        // deck opens at once for a few seconds, which is the pacing shift the act asks
        // for — from "walking through a dead ship" to "being hunted through one".
        this.noise.emit(o.x, o.y, KLAXON_NOISE, "alarm");
        this.director.panic(DOOR_KLAXON, this.directorDeps());
        this.events.push({
          kind: "doorSealed", x: o.x, y: o.y,
          text: "BRIDGE SEALED — MANUAL BYPASS AT MAIN REACTOR",
        });
        break;

      case "unsealing":
        // Ninety seconds of standing still on a catwalk, with the director aiming its
        // worst at the end of them. The same shape as the roof holdout, and for the
        // same reason: a phase loop is wrong for a fight you cannot walk away from.
        this.director.beginHoldout(UNSEAL_TIME);
        this.noise.emit(o.x, o.y, KLAXON_NOISE, "alarm");
        this.events.push({
          kind: "unsealing", x: o.x, y: o.y, text: `BLAST DOOR UNSEALING — ${clockText(UNSEAL_TIME)}`,
        });
        break;

      case "unsealed":
        // The door tiles are gone from the grid, so the exit behind them is simply an
        // exit now and the ordinary squad-dwell rule takes over.
        this.director.endHoldout();
        this.bakeStaticLights();
        this.squadFlow.rebuild(this.map, this.players.filter((p) => !p.downed));
        this.events.push({ kind: "unsealed", x: o.x, y: o.y, text: "BRIDGE OPEN" });
        break;
    }
  }

  /**
   * Main power comes back. One flag, and most of the game changes around it: the lights
   * are on, the ship is in alarm, the bridge door will work, and the director is handed
   * everything that is left. Act III ends on this line.
   */
  private restorePower(x: number, y: number): void {
    this.power.on = true;
    this.power.time = 0;
    this.power.siren = 0;
    this.director.endHoldout();
    // Every door at once, and then a floor that stays hard: the noise of a ship coming
    // back to life is the loudest thing that has happened to it in a long time.
    this.director.panic(DOOR_KLAXON * 1.5, this.directorDeps());
    this.noise.emit(x, y, KLAXON_NOISE, "alarm");
    this.particles.burst(x, y, 40, 260, "#8bff7a", 0.9, 4);
    this.bakeStaticLights();
    this.events.push({ kind: "power", x, y, text: "MAIN POWER RESTORED" });
  }

  /**
   * The alarm the ship runs once its power is back. Purely a sound and a colour: it
   * deliberately does NOT go into the noise field, because a siren the zombies could
   * hear would pull the whole deck onto one arbitrary speaker for the rest of the run.
   */
  private updateSiren(dt: number): void {
    if (!this.power.on) return;
    this.power.time += dt;
    this.power.siren -= dt;
    if (this.power.siren > 0) return;
    this.power.siren = SIREN_INTERVAL;
    this.events.push({ kind: "siren" });
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
        // Waves are walkers. Once a floor is leaning hard, one body in a while is a
        // Stalker instead — never more than one alive at a time, because two of them
        // working a split squad is not a difficulty curve, it is a coin flip.
        const kind = this.mayAddStalker() ? "stalker" : randomZombieKind();
        this.enemies.push(createEnemy(this.nextEnemyId++, x, y, kind, hunting));
      },
      onWave: (x, y, count) => {
        this.events.push({ kind: "horde", x, y, count });
      },
    };
  }

  /**
   * Should this wave slot be a Stalker? Only on a floor with the pressure for it, only
   * when there is not one already, and only some of the time — an ambusher you can
   * predict is just a zombie that takes longer.
   */
  private mayAddStalker(): boolean {
    if (this.difficulty < STALKER_PRESSURE) return false;
    if (this.enemies.some((e) => e.kind === "stalker")) return false;
    return Math.random() < STALKER_CHANCE;
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

    // The ship's objective chain outranks walking anywhere, in the order the arc runs:
    // an unprimed reactor is what the floor is FOR, and a sealed bridge is a wall you
    // do not get to walk past. Both fall through to the ordinary rules once done.
    if (this.updateShipObjective()) return;

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
   * The ship's half of the objective chain, in priority order. Returns true when it has
   * claimed the objective line, which means the ordinary stairs / exit rules do not run.
   *
   * The order is the story: you cannot leave the reactor deck with cells still out, and
   * you cannot walk onto the bridge through a door that is shut.
   */
  private updateShipObjective(): boolean {
    const cells = this.devices.sockets(this.map);
    if (cells.total > 0 && cells.primed < cells.total) {
      this.objective.kind = "reactor";
      this.objective.onExit = cells.primed;
      this.objective.needed = cells.total;
      this.objective.progress = cells.primed / cells.total;
      this.exitTimer = 0;
      return true;
    }

    const door = this.devices.door;
    // A door you cannot work is a wall, not an objective. While the ship has no power
    // the real objective of the bridge approach is the way DOWN — the one-off "BRIDGE
    // SEALED" banner says why, and an objective line insisting on a door that does
    // nothing would just be wrong. A floor with no stairs is the exception: there the
    // door is the only thing left to point at.
    if (door === "sealed" && (this.power.on || this.map.stairs.length === 0)) {
      this.objective.kind = "sealed";
      this.objective.onExit = 0;
      this.objective.needed = 0;
      this.objective.progress = this.devices.doorArming;
      this.exitTimer = 0;
      return true;
    }
    if (door === "unsealing") {
      this.objective.kind = "unseal";
      this.objective.onExit = 0;
      this.objective.needed = 0;
      this.objective.timeLeft = this.devices.doorTimer;
      this.objective.progress = 1 - this.devices.doorTimer / UNSEAL_TIME;
      this.exitTimer = 0;
      return true;
    }
    return false;
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
    this.bakeFlareLights();

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
        p.restraint = null;
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
