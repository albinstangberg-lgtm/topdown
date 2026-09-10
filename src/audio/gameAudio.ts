import { AudioBus, CENTRE, EARSHOT, type Placement } from "./bus";
import type { GameEvent, GameWorld } from "../sim/world";
import type { Noise } from "../sim/noise";

/**
 * CORE 15b — What the game sounds like.
 *
 * An observer, not a system: it reads the world after the step and turns what it finds
 * into voices. Nothing in `src/sim` imports it, and deleting it would change nothing
 * about how the game plays — which is the property that lets the sim stay plain data.
 *
 * Three sources feed it:
 *
 * - **The noise field.** Every emission a zombie can hear is also a sound the player
 *   hears, through one hook on `NoiseField`. This is the important one: the game now
 *   has a mechanic where a shotgun blast pulls a room, and a player who cannot hear
 *   their own gun has no way to learn it. Loudness on screen is the same number the
 *   AI uses, so what you hear is literally what they heard.
 * - **World events.** Kills, downs, revives, waves, alarms — the channel the screen
 *   shake already reads.
 * - **The zombies themselves**, scanned for state changes. A windup gets its own
 *   screech, because a telegraph you can only see is no use when it is behind you.
 */

/** Seconds between ambient growls when a single zombie is nearby. Crowds are busier. */
const GROWL_BASE = 1.5;

export class GameAudio {
  readonly bus = new AudioBus();
  /** Set by the game: true when the camera turns with the player. Affects panning. */
  cameraRotates = true;

  private growlTimer = 1;
  /** Last seen AI state per zombie id, for spotting transitions. */
  private states = new Map<number, string>();
  /** Last seen health per player id, so a hit makes a sound without a new event. */
  private health = new Map<number, number>();
  private reloading = new Map<number, boolean>();
  private listeners: { x: number; y: number; facing: number }[] = [];

  /** Attach to a world's noise field. Called again whenever the world is replaced. */
  listenTo(world: GameWorld): void {
    world.noise.onEmit = (n) => this.onNoise(n);
  }

  /** Any input at all: browsers will not start audio before the person touches the page. */
  wake(): void {
    this.bus.resume();
  }

  toggleMute(): boolean {
    return this.bus.toggleMute();
  }

  /** Once per frame, after the sim has stepped. */
  update(world: GameWorld, dt: number): void {
    this.bus.beginFrame();

    this.listeners.length = 0;
    for (const p of world.players) {
      if (!p.downed) this.listeners.push({ x: p.eyeX, y: p.eyeY, facing: p.facing });
    }
    // Everyone down is not silence: the last thing you hear should be what is on you.
    if (this.listeners.length === 0) {
      for (const p of world.players) this.listeners.push({ x: p.x, y: p.y, facing: p.facing });
    }

    this.watchPlayers(world);
    this.watchZombies(world);
    this.ambientGrowl(world, dt);
  }

  /** Drain the world's event list. Called with the same events the game shell reads. */
  handle(events: readonly GameEvent[]): void {
    for (const ev of events) {
      const at = ev.x !== undefined && ev.y !== undefined
        ? this.at(ev.x, ev.y)
        : CENTRE;
      switch (ev.kind) {
        case "kill":
          // A body dropping: a wet thud and the tail of a groan.
          this.bus.noise("kill", at, { freq: 320, q: 0.7, decay: 0.16, level: 0.5 });
          this.bus.tone("killGroan", at, { freq: 150, to: 60, type: "sawtooth", decay: 0.28, level: 0.22 });
          break;
        case "playerDown":
          this.bus.tone("down", CENTRE, { freq: 220, to: 70, type: "triangle", decay: 0.7, level: 0.5 });
          this.bus.noise("downThud", at, { freq: 200, q: 0.6, decay: 0.3, level: 0.6 });
          break;
        case "revive":
          this.bus.tone("revive", CENTRE, { freq: 380, to: 620, type: "triangle", decay: 0.35, level: 0.35 });
          break;
        case "horde":
          // The moan of a door opening somewhere. Placed, so you can hear WHICH door.
          this.bus.tone("horde", at, { freq: 90, to: 62, type: "sawtooth", attack: 0.25, decay: 1.1, level: 0.5 });
          break;
        case "alarm":
          this.bus.noise("alarmHit", at, { freq: 900, q: 0.8, decay: 0.5, level: 0.9, sweepTo: 200 });
          break;
        case "flareLit":
          // The pop of the cap and then the hiss it settles into.
          this.bus.noise("flarePop", at, { freq: 1200, q: 0.8, decay: 0.18, level: 0.7, sweepTo: 400 });
          this.bus.noise("flareHiss", at, { freq: 4200, q: 0.5, decay: 1.4, level: 0.35 });
          break;
        case "holdout":
          // The clock being called. Dry and mechanical — it is information, not drama.
          this.bus.tone("holdoutCall", CENTRE, { freq: 660, to: 660, type: "square", decay: 0.14, level: 0.3 });
          break;
        case "chopperInbound":
          this.bus.tone("radio", CENTRE, { freq: 520, to: 780, type: "square", decay: 0.3, level: 0.3 });
          break;
        case "chopperDown":
          this.bus.tone("touchdown", at, { freq: 120, to: 70, type: "sawtooth", decay: 0.6, level: 0.5 });
          break;
        case "floorCleared":
        case "missionComplete":
          this.bus.tone("objective", CENTRE, { freq: 440, to: 880, type: "triangle", decay: 0.5, level: 0.4 });
          break;
        case "missionFailed":
        case "wipe":
          this.bus.tone("fail", CENTRE, { freq: 300, to: 60, type: "sawtooth", decay: 1.4, level: 0.5 });
          break;
        default:
          break;
      }
    }
  }

  /**
   * A noise the AI can hear. The radius the director uses is the loudness the player
   * gets, so the two never drift: a shotgun is louder than an SMG on screen for the
   * same reason it pulls a bigger room.
   */
  private onNoise(n: Noise): void {
    const at = this.at(n.x, n.y);
    switch (n.kind) {
      case "shot": {
        // Bigger radius, deeper and louder report. 600 is a pistol, 850 a shotgun.
        const heft = Math.min(1, Math.max(0, (n.radius - 550) / 320));
        this.bus.noise("shot", at, {
          freq: 1700 - heft * 900, q: 0.7, decay: 0.09 + heft * 0.13,
          level: 0.55 + heft * 0.35, sweepTo: 220 - heft * 90,
        });
        this.bus.tone("shotBody", at, {
          freq: 150 - heft * 50, to: 45, type: "square", decay: 0.1 + heft * 0.1,
          level: 0.3 + heft * 0.25,
        });
        break;
      }
      case "break":
        // Two bursts: the crack, then the shards.
        this.bus.noise("glass", at, { freq: 5200, q: 1.6, decay: 0.11, level: 0.55 });
        this.bus.noise("glassTail", at, { freq: 3200, q: 0.8, decay: 0.42, level: 0.3, sweepTo: 6500 });
        break;
      case "step":
        this.bus.noise("step", at, { freq: 210, q: 1.2, decay: 0.07, level: 0.28 });
        break;
      case "impact":
        this.bus.noise("dive", at, { freq: 150, q: 0.7, decay: 0.26, level: 0.6 });
        break;
      case "flare":
        // The bang that lights it, heard as far as the zombies hear it.
        this.bus.noise("flareBang", at, { freq: 700, q: 0.7, decay: 0.35, level: 0.7, sweepTo: 180 });
        break;
      case "rotor":
        // One beat of the rotor per pulse: the thump, plus the air it moves. Alternating
        // pitch gives it the two-stroke chop a single tone never has.
        this.rotorUp = !this.rotorUp;
        this.bus.tone("rotor", at, {
          freq: this.rotorUp ? 62 : 54, to: 40, type: "square",
          attack: 0.01, decay: 0.3, level: 0.42,
        });
        this.bus.noise("rotorWash", at, { freq: 320, q: 0.5, decay: 0.28, level: 0.3 });
        break;
      case "alarm":
        // A two-tone whoop, alternating on each pulse.
        this.alarmUp = !this.alarmUp;
        this.bus.tone("alarm", at, {
          freq: this.alarmUp ? 620 : 480, to: this.alarmUp ? 900 : 640,
          type: "square", attack: 0.02, decay: 0.42, level: 0.32,
        });
        break;
    }
  }

  private alarmUp = false;
  private rotorUp = false;

  /** Damage and reloads, spotted by watching the numbers rather than adding events. */
  private watchPlayers(world: GameWorld): void {
    for (const p of world.players) {
      const before = this.health.get(p.id);
      if (before !== undefined && p.health < before - 0.5 && !p.downed) {
        this.bus.noise("playerHurt", CENTRE, { freq: 420, q: 0.6, decay: 0.2, level: 0.5, sweepTo: 120 });
      }
      this.health.set(p.id, p.health);

      const isReloading = p.reloadTimer > 0;
      if (isReloading && !this.reloading.get(p.id)) {
        this.bus.noise("reload", CENTRE, { freq: 2600, q: 3, decay: 0.05, level: 0.3 });
      }
      this.reloading.set(p.id, isReloading);
    }
  }

  /**
   * The windup screech and the leap. Both are gameplay tells, and a tell you can only
   * see is no use at all when the thing is behind you.
   */
  private watchZombies(world: GameWorld): void {
    const alive = new Set<number>();
    for (const e of world.enemies) {
      alive.add(e.id);
      const before = this.states.get(e.id);
      this.states.set(e.id, e.state);
      if (before === e.state) continue;
      const at = this.at(e.x, e.y);
      if (e.state === "windup") {
        this.bus.tone("screech", at, {
          freq: 260, to: 780, type: "sawtooth", attack: 0.02, decay: 0.3, level: 0.4,
        });
      } else if (e.state === "lunge") {
        this.bus.noise("leap", at, { freq: 900, q: 0.8, decay: 0.18, level: 0.4, sweepTo: 300 });
      }
    }
    // Forget the dead, or the map grows for the whole run.
    if (this.states.size > alive.size) {
      for (const id of this.states.keys()) if (!alive.has(id)) this.states.delete(id);
    }
  }

  /**
   * The crowd. One growl at a time from a random zombie in earshot, more often the
   * more of them there are — so a horde sounds like a horde without forty voices.
   */
  private ambientGrowl(world: GameWorld, dt: number): void {
    this.growlTimer -= dt;
    if (this.growlTimer > 0) return;

    const near = world.enemies.filter((e) =>
      this.listeners.some((l) => Math.hypot(l.x - e.x, l.y - e.y) < EARSHOT));
    if (near.length === 0) {
      this.growlTimer = 0.5;
      return;
    }
    this.growlTimer = Math.max(0.12, GROWL_BASE / Math.sqrt(near.length)) * (0.6 + Math.random() * 0.8);

    const e = near[Math.floor(Math.random() * near.length)];
    const at = this.at(e.x, e.y);
    const hunting = e.state === "chase" || e.state === "hunt";
    this.bus.tone("growl", at, {
      freq: (hunting ? 130 : 95) * (0.85 + Math.random() * 0.3),
      to: hunting ? 90 : 62,
      type: "sawtooth",
      attack: 0.06,
      decay: 0.3 + Math.random() * 0.3,
      level: hunting ? 0.24 : 0.16,
      detune: Math.random() * 40 - 20,
    });
  }

  private at(x: number, y: number): Placement {
    return this.bus.place(x, y, this.listeners, this.cameraRotates);
  }
}
