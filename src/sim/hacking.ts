/**
 * CORE 21 — The console mini-game.
 *
 * A hack is the only thing in this game that takes a player *out* of it. For five to ten
 * seconds they are looking at a screen instead of a room: no movement, no aim, no
 * trigger, no flashlight. The other three are what stands between them and the deck.
 *
 * That is the whole design, and it dictates everything here:
 *
 * - **It has to be short.** Ten seconds of a player being absent is a long time in a
 *   game where a Stalker crosses a room in two. Three tumblers for a door, four for the
 *   turret grid, and a clean run is about five seconds.
 * - **It has to be beatable while frightened.** One button, one rhythm, no reading. You
 *   stop a sweep inside a band, four times, while somebody shouts at you about the vent.
 * - **Failure costs the room, not the run.** A miss does not fail the hack — it makes a
 *   noise the whole deck can hear and slows you down, which is a cost the people holding
 *   the perimeter pay. Spamming the button is the wrong answer for a reason you can hear.
 *
 * The module is plain data and a step function. It draws nothing, it plays nothing, and
 * it does not know what a door is: it reports what happened this step and the world
 * decides what that means — the same seam `devices.ts` uses.
 */

/** What a console is wired to. Floor-wide, both of them: see `hack` in `tiles.ts`. */
export type HackKind = "door" | "turret";

export interface Tumbler {
  /** Where the sweep is, 0..1, ping-ponging between the ends. */
  cursor: number;
  /** Which way it is going. */
  dir: 1 | -1;
  /** Sweeps per second. Later tumblers are faster, and a fault makes them faster still. */
  speed: number;
  /** Centre of the band you have to stop it in, and its half-width. Both 0..1. */
  band: number;
  width: number;
  locked: boolean;
}

export interface HackSession {
  playerId: number;
  kind: HackKind;
  /** Index into `map.devices`, so the world can spend the tile when this is won. */
  deviceIndex: number;
  x: number;
  y: number;
  tumblers: Tumbler[];
  /** Which tumbler is live. Equal to `tumblers.length` once they are all down. */
  index: number;
  faults: number;
  elapsed: number;
  /** Seconds left of the post-fault lockout, during which the button does nothing. */
  resync: number;
  state: "running" | "won" | "quit";
  /** Lines for the screen. The renderer prints them; nothing reads them back. */
  feed: string[];
  /** Free-running counter that gives the screen something that moves. */
  noise: number;
}

/** What just happened, for the world to turn into sound, noise and consequences. */
export type HackEvent =
  | { kind: "lock"; index: number }
  | { kind: "fault" }
  | { kind: "won" };

/** How many tumblers each kind of console asks for. */
const TUMBLERS: Record<HackKind, number> = { door: 3, turret: 4 };
/** The first tumbler's band half-width. Every one after it is tighter. */
const BAND_WIDTH = 0.15;
const BAND_TIGHTEN = 0.022;
/** Sweeps per second, the same way. */
const BASE_SPEED = 0.55;
const SPEED_STEP = 0.14;
/** What one miss adds to every remaining sweep, and how long the console sulks for. */
const FAULT_SPEEDUP = 0.12;
const RESYNC_TIME = 0.4;
/** Faults never fail a hack — but they do make this much noise, in world units. */
export const FAULT_NOISE = 620;

export function startHack(
  playerId: number, kind: HackKind, deviceIndex: number, x: number, y: number,
): HackSession {
  const count = TUMBLERS[kind];
  const tumblers: Tumbler[] = [];
  for (let i = 0; i < count; i++) {
    tumblers.push({
      // Starting position is random so the rhythm cannot be learned by heart, and the
      // band is kept off the ends where a sweep dawdles as it turns around.
      cursor: Math.random(),
      dir: Math.random() < 0.5 ? -1 : 1,
      speed: BASE_SPEED + i * SPEED_STEP,
      band: 0.2 + Math.random() * 0.6,
      width: Math.max(0.06, BAND_WIDTH - i * BAND_TIGHTEN),
      locked: false,
    });
  }
  return {
    playerId, kind, deviceIndex, x, y, tumblers,
    index: 0, faults: 0, elapsed: 0, resync: 0, state: "running",
    noise: 0,
    feed: [
      kind === "door" ? "DECK LOCK CONTROLLER" : "FIRE CONTROL — TURRET GRID",
      "handshake … ok",
      `bypass ${count} interlocks`,
    ],
  };
}

/**
 * One step of the game. `pressed` is the fire button's rising edge only — holding it
 * does nothing, so panic-mashing is a series of misses rather than a solve.
 */
export function updateHack(h: HackSession, dt: number, pressed: boolean): HackEvent[] {
  const out: HackEvent[] = [];
  if (h.state !== "running") return out;

  h.elapsed += dt;
  h.noise += dt;
  if (h.resync > 0) h.resync = Math.max(0, h.resync - dt);

  const live = h.tumblers[h.index];
  if (!live) return out;

  // The sweep. Ping-pong rather than wrap: the turn at each end is the part that makes
  // the timing readable, and a wrapping cursor teleports past the band.
  live.cursor += live.dir * live.speed * dt * 2;
  if (live.cursor > 1) { live.cursor = 1 - (live.cursor - 1); live.dir = -1; }
  if (live.cursor < 0) { live.cursor = -live.cursor; live.dir = 1; }

  if (!pressed || h.resync > 0) return out;

  if (Math.abs(live.cursor - live.band) <= live.width) {
    live.locked = true;
    h.index++;
    h.feed.push(`interlock ${h.index} … open`);
    out.push({ kind: "lock", index: h.index - 1 });
    if (h.index >= h.tumblers.length) {
      h.state = "won";
      h.feed.push(h.kind === "door" ? "LOCKS RELEASED" : "TURRET GRID OFFLINE");
      out.push({ kind: "won" });
    }
    return out;
  }

  // A miss. The tumbler stays where it is and everything left speeds up — and the
  // console shrieks, which is the part the rest of the squad has to deal with.
  h.faults++;
  h.resync = RESYNC_TIME;
  h.feed.push("!! desync — retrying");
  for (let i = h.index; i < h.tumblers.length; i++) h.tumblers[i].speed += FAULT_SPEEDUP;
  out.push({ kind: "fault" });
  return out;
}

/** 0..1, for the progress bar the rest of the squad sees over the hacker's head. */
export function hackProgress(h: HackSession): number {
  return h.tumblers.length === 0 ? 1 : h.index / h.tumblers.length;
}
