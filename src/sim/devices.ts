import { TILE, type DeviceTile, type TileMap } from "../world/tilemap";
import { tileDef } from "../world/tiles";
import type { InputState } from "../input/types";
import type { Player } from "./entities";

/**
 * What a cache can hold. The union is the one on `TileDef.supply` — the tile says what
 * is in the box, this system says that walking onto it empties the box, and the world
 * says what a medkit is worth. Three systems, one fact each.
 */
export type SupplyItem = "medkit" | "adrenaline" | "flare" | "welder";

/**
 * Does this floor make the squad fetch fusion cores by hand? True when somebody
 * authored a rack of them on it. One question, asked in one place, so "why will this
 * socket not take my dwell" always has the same answer.
 */
function coresRequired(map: TileMap): boolean {
  return map.racks.some((r) => r.gives === "core");
}

/**
 * CORE 18 — Devices, and the objective chain they make.
 *
 * Everything in the story arc that is not "walk to the exit" is one of four things you
 * hold a button on:
 *
 *   terminal  — a crew log. Narrative only; it gates nothing, which is exactly why it
 *               is worth putting somewhere awkward.
 *   locker    — an armoury locker. Walk onto it and it hands you the next weapon up.
 *   socket    — a fusion socket. Every socket on a floor primed brings main power back,
 *               and that one flag changes the rest of the mission.
 *   blastDoor — the bridge. Dead without power; with it, a ninety-second unseal you
 *               have to survive standing still.
 *
 * The pattern they share is the point of having one module for them: **a device is a
 * tile, its used state is a different tile, and the dwell is the only thing held in
 * memory.** Using one rewrites the grid, so a floor that reloads remembers what the
 * squad already did, and a mission that restarts puts it all back — the same trick a
 * spent car alarm uses.
 *
 * The system deliberately decides *nothing* about consequences. It answers "who is
 * holding what, and what just finished"; the world reads the outcomes and decides that
 * a primed socket lights the ship. That seam is what stops this becoming a second,
 * competing copy of the game rules.
 */

/** Seconds of holding USE to read a log off a terminal. */
export const TERMINAL_TIME = 1.4;
/**
 * Seconds of holding USE to pull a breach lever. Deliberately long enough to be a
 * decision and short enough to be a panic button: you will be doing this with something
 * coming at you, and the hold is the only part of it you control.
 */
export const LEVER_TIME = 1.1;
/** Seconds of holding USE to seat one fusion cell. Long enough to need cover. */
export const SOCKET_TIME = 7;
/** Seconds of holding USE beside the blast door before the unseal actually starts. */
export const UNSEAL_ARM_TIME = 1.5;
/** How long the bridge door takes to unseal once it has started. Act IV is this number. */
export const UNSEAL_TIME = 90;
/** How close to a blast door tile you have to be to work its panel. */
const DOOR_REACH = TILE * 1.15;
/** How close you have to be for the door to tell you it is sealed. */
const DOOR_NOTICE = TILE * 2.2;
/** Dwell decays this much faster than it builds, so letting go is a real cost. */
const DECAY_SCALE = 1.6;

export type DoorState = "none" | "sealed" | "unsealing" | "open";

/** What the device system finished this step. The world decides what any of it means. */
export type DeviceOutcome =
  /** A terminal was read. `index` is its position among the floor's terminals. */
  | { kind: "log"; index: number; x: number; y: number }
  /** A locker was emptied by this player. */
  | { kind: "locker"; player: Player; x: number; y: number }
  /** A supply cache was emptied. `item` is the key of what was in it. */
  | { kind: "supply"; player: Player; item: SupplyItem; x: number; y: number }
  /** Somebody pulled an emergency depressurisation lever. */
  | { kind: "lever"; player: Player; x: number; y: number }
  /**
   * One fusion cell is in. `primed` of `total` sockets are now live. `player` is null
   * when a core was carried in rather than dwelled in — the reactor does not care who,
   * and on a fetch floor the person who seated it is rarely the person who fetched it.
   */
  | { kind: "socket"; player: Player | null; x: number; y: number; primed: number; total: number }
  /** The first cell went in — the reactor floor is now a fight, not a search. */
  | { kind: "reactorStarted"; x: number; y: number }
  /** Every socket is primed. Main power is back. */
  | { kind: "power"; x: number; y: number }
  /** Somebody walked up to a sealed door with no power. Said once per floor. */
  | { kind: "doorSealed"; x: number; y: number }
  /** The unseal has started and is now running on its own. */
  | { kind: "unsealing"; x: number; y: number }
  /** The door is open. */
  | { kind: "unsealed"; x: number; y: number };

export interface DeviceDeps {
  map: TileMap;
  players: Player[];
  inputOf: (p: Player) => InputState;
  /** True once main power is back. Sockets are done and the blast door will work. */
  powered: boolean;
}

/** What one player should be told they can do right now, for the HUD. */
export interface DevicePrompt {
  text: string;
  /** 0..1, or -1 when the thing is not a dwell (a locked door has nothing to fill). */
  progress: number;
}

export class DeviceSystem {
  /** Dwell on each device, 0..1, indexed to `map.devices`. */
  private progress: number[] = [];
  /** What each player is being offered, by player id. Rebuilt every step. */
  private prompts = new Map<number, DevicePrompt>();

  door: DoorState = "none";
  /** Seconds left of the unseal. Zero unless the door is actually moving. */
  doorTimer = 0;
  /** Dwell on the door panel before the unseal starts, 0..1. */
  doorArming = 0;
  /** Where the door is, so the HUD and the director can point at it. */
  doorX = 0;
  doorY = 0;

  private sealedTold = false;

  /** Fresh floor. Called with the new map, after `loadLevel` has swapped it in. */
  rebuild(map: TileMap): void {
    this.progress = map.devices.map(() => 0);
    this.prompts.clear();
    this.sealedTold = false;
    this.doorArming = 0;
    this.doorTimer = 0;
    this.door = map.blastDoors.length > 0 ? "sealed" : "none";
    if (map.blastDoors.length > 0) {
      let x = 0;
      let y = 0;
      for (const d of map.blastDoors) { x += d.x; y += d.y; }
      this.doorX = x / map.blastDoors.length;
      this.doorY = y / map.blastDoors.length;
    }
  }

  /** How many of this floor's fusion sockets are live, and how many there are. */
  sockets(map: TileMap): { primed: number; total: number } {
    let primed = 0;
    let total = 0;
    for (const d of map.devices) {
      if (d.kind !== "socket") continue;
      total++;
      if (d.spent) primed++;
    }
    return { primed, total };
  }

  /** Dwell on the device this player is standing on, 0..1. Zero when they are not. */
  promptFor(id: number): DevicePrompt | null {
    return this.prompts.get(id) ?? null;
  }

  /**
   * One step. Returns everything that finished, in the order it finished — the world
   * drains it the same way it drains its own event list.
   */
  update(dt: number, deps: DeviceDeps): DeviceOutcome[] {
    const out: DeviceOutcome[] = [];
    this.prompts.clear();

    const held = new Set<number>();
    for (const p of deps.players) {
      if (p.downed) continue;
      const device = deps.map.deviceAt(p.x, p.y);
      const using = deps.inputOf(p).interact;

      if (device) {
        const index = deps.map.devices.indexOf(device);
        if (device.kind === "locker") {
          // A locker is not a dwell. Reaching an armoury at all was the hard part.
          this.spend(deps.map, index);
          out.push({ kind: "locker", player: p, x: device.x, y: device.y });
          continue;
        }

        if (device.kind === "supply") {
          // Same deal as a locker, and for the same reason. Taking the box is free;
          // deciding to drop what you were already carrying for it is not.
          const item = tileDef(deps.map.tileAt(device.tx, device.ty)).supply;
          if (item !== undefined) {
            this.spend(deps.map, index);
            out.push({ kind: "supply", player: p, item, x: device.x, y: device.y });
          }
          continue;
        }

        // A floor with a rack of fusion cores on it makes you FETCH one: the socket
        // will not take a dwell, only a core carried over in both hands. A floor with
        // no rack keeps the original behaviour, so this is additive rather than a
        // rewrite of every reactor deck ever authored.
        if (device.kind === "socket" && coresRequired(deps.map)) {
          this.prompts.set(p.id, {
            text: p.carrying === "core" ? "PRESS USE — SEAT THE CORE" : "FETCH A FUSION CORE",
            progress: -1,
          });
          continue;
        }

        const time = device.kind === "terminal" ? TERMINAL_TIME
          : device.kind === "lever" ? LEVER_TIME
          : SOCKET_TIME;
        if (using) {
          held.add(index);
          this.progress[index] = Math.min(1, (this.progress[index] ?? 0) + dt / time);
        }
        this.prompts.set(p.id, {
          text: device.kind === "terminal"
            ? (using ? "READING…" : "HOLD USE — READ LOG")
            : device.kind === "lever"
              ? (using ? "VENTING…" : "HOLD USE — BLOW THE ROOM")
              : (using ? "SEATING CELL…" : "HOLD USE — SEAT FUSION CELL"),
          progress: this.progress[index] ?? 0,
        });

        if ((this.progress[index] ?? 0) >= 1) {
          if (device.kind === "terminal") {
            this.spend(deps.map, index);
            out.push({ kind: "log", index: this.logIndexOf(deps.map, index), x: device.x, y: device.y });
          } else if (device.kind === "lever") {
            this.spend(deps.map, index);
            out.push({ kind: "lever", player: p, x: device.x, y: device.y });
          } else {
            out.push(...this.primeSocket(deps.map, index, p));
          }
        }
        continue;
      }

      // Not on a device: the blast door is the other thing you can be standing next to.
      this.offerDoor(p, using, deps, out);
    }

    // Anything nobody is holding bleeds back down. Walking away from a fusion socket
    // half-seated should cost something, or the socket is just a long corridor.
    for (let i = 0; i < this.progress.length; i++) {
      if (held.has(i) || this.progress[i] <= 0) continue;
      const time = deps.map.devices[i]?.kind === "terminal" ? TERMINAL_TIME : SOCKET_TIME;
      this.progress[i] = Math.max(0, this.progress[i] - (dt / time) * DECAY_SCALE);
    }

    this.updateDoor(dt, deps, out);
    return out;
  }

  /**
   * The bridge door, from the outside. Without power it is a wall that tells you so
   * once; with power it is a panel you hold, and then ninety seconds you survive.
   */
  private offerDoor(p: Player, using: boolean, deps: DeviceDeps, out: DeviceOutcome[]): void {
    if (this.door === "none" || this.door === "open") return;
    const near = deps.map.blastDoors.some(
      (d) => Math.hypot(d.x - p.x, d.y - p.y) < (deps.powered ? DOOR_REACH : DOOR_NOTICE),
    );
    if (!near) return;

    if (!deps.powered) {
      // The wall. It is worth saying out loud exactly once — after that the objective
      // line on the HUD carries it, and a banner every time you brush past is noise.
      if (!this.sealedTold) {
        this.sealedTold = true;
        out.push({ kind: "doorSealed", x: this.doorX, y: this.doorY });
      }
      this.prompts.set(p.id, { text: "SEALED — NO MAIN POWER", progress: -1 });
      return;
    }

    if (this.door === "unsealing") {
      this.prompts.set(p.id, { text: "UNSEALING — HOLD THE CATWALK", progress: -1 });
      return;
    }

    // The dwell itself is timed once, in `updateDoor` — leaning on the panel with four
    // people must not open the door four times as fast.
    //
    // The wording is deliberately not the objective line's. "Override the blast door" is
    // already on the HUD as the squad's objective; what this player needs to know is
    // that they are close enough for it to be their problem.
    this.prompts.set(p.id, {
      text: using ? "OVERRIDING…" : "AT THE PANEL — HOLD USE",
      progress: this.doorArming,
    });
  }

  private updateDoor(dt: number, deps: DeviceDeps, out: DeviceOutcome[]): void {
    if (this.door === "none" || this.door === "open") return;

    if (this.door === "sealed") {
      // The arming dwell is accumulated per player above at a nominal rate; do the real
      // timing here so it does not depend on how many people are leaning on the panel.
      const holding = deps.powered && deps.players.some((p) => !p.downed &&
        deps.inputOf(p).interact &&
        deps.map.blastDoors.some((d) => Math.hypot(d.x - p.x, d.y - p.y) < DOOR_REACH));
      this.doorArming = holding
        ? Math.min(1, this.doorArming + dt / UNSEAL_ARM_TIME)
        : Math.max(0, this.doorArming - dt / UNSEAL_ARM_TIME);
      if (this.doorArming >= 1) {
        this.door = "unsealing";
        this.doorTimer = UNSEAL_TIME;
        out.push({ kind: "unsealing", x: this.doorX, y: this.doorY });
      }
      return;
    }

    // Unsealing. Nobody has to stand there — the point of the ninety seconds is that
    // the squad is free to fight, and the door is the thing they are fighting for.
    this.doorTimer = Math.max(0, this.doorTimer - dt);
    if (this.doorTimer > 0) return;
    this.door = "open";
    for (const tile of [...deps.map.blastDoors]) {
      const tx = Math.floor(tile.x / TILE);
      const ty = Math.floor(tile.y / TILE);
      deps.map.setTile(tx, ty, 0);
    }
    deps.map.refresh();
    out.push({ kind: "unsealed", x: this.doorX, y: this.doorY });
  }

  /** Mark a device used, in the grid, which is what makes it survive a reload. */
  /**
   * Seat a fusion core carried in by hand. Same consequences as finishing the dwell —
   * which is the point of routing both through `primeSocket`: "the reactor has another
   * cell in it" has to mean one thing, however the cell got there.
   */
  seatCore(map: TileMap, device: DeviceTile): DeviceOutcome[] {
    const index = map.devices.indexOf(device);
    if (index < 0 || device.kind !== "socket") return [];
    return this.primeSocket(map, index, null);
  }

  /** One socket going live, and everything that follows from it. */
  private primeSocket(map: TileMap, index: number, player: Player | null): DeviceOutcome[] {
    const device = map.devices[index];
    if (!device) return [];
    const out: DeviceOutcome[] = [];
    const wasFirstCell = this.sockets(map).primed === 0;
    this.spend(map, index);
    if (wasFirstCell) out.push({ kind: "reactorStarted", x: device.x, y: device.y });
    const count = this.sockets(map);
    out.push({
      kind: "socket", player, x: device.x, y: device.y,
      primed: count.primed, total: count.total,
    });
    if (count.total > 0 && count.primed >= count.total) {
      out.push({ kind: "power", x: device.x, y: device.y });
    }
    return out;
  }

  private spend(map: TileMap, index: number): void {
    const device = map.devices[index];
    if (!device) return;
    const used = tileDef(map.tileAt(device.tx, device.ty)).usedInto;
    if (used === undefined) return;
    map.setTile(device.tx, device.ty, used);
    map.refresh();
    this.progress[index] = 0;
  }

  /**
   * A terminal's position among the floor's TERMINALS, which is what a mission's list
   * of logs is indexed by. Not its position among all devices — a level author who adds
   * a locker between two terminals should not silently reshuffle the story.
   */
  private logIndexOf(map: TileMap, deviceIndex: number): number {
    let n = 0;
    for (let i = 0; i < map.devices.length && i < deviceIndex; i++) {
      if (map.devices[i].kind === "terminal") n++;
    }
    return n;
  }
}
