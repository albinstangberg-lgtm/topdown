import { mulberry32 } from "../core/math";
import { tileByKey } from "./tiles";
import type { LevelData } from "./level";

interface Rect { x: number; y: number; w: number; h: number }

/** Tile ids by name, so this file never has to hard-code a number from the registry. */
function id(key: string): number {
  const def = tileByKey(key);
  if (!def) throw new Error(`generator: no tile named "${key}"`);
  return def.id;
}

/**
 * Placeholder level generator. It emits the same thing a hand-authored level is — a
 * grid of tile ids — so the game has exactly one way to load a map and no special
 * case for "generated" versus "designed".
 *
 * Rooms, corridors and spawns first; then a **dressing pass** that puts the ship's own
 * furniture into them, because survival mode has no authored decks and without it none
 * of the vents, hazards, power fittings or ambush mutants would ever appear in it. See
 * `dressShip` for the one rule that keeps that safe.
 */
export function generateLevel(cols: number, rows: number, seed = 1337): LevelData {
  const grid: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(1));
  const rand = mulberry32(seed);
  const ri = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));
  const set = (x: number, y: number, tile: number): void => {
    if (x >= 0 && y >= 0 && x < cols && y < rows) grid[y][x] = tile;
  };

  const roomList: Rect[] = [];
  for (let i = 0; i < 90 && roomList.length < 16; i++) {
    const w = ri(5, 11);
    const h = ri(5, 10);
    const x = ri(1, cols - w - 2);
    const y = ri(1, rows - h - 2);
    const candidate: Rect = { x, y, w, h };
    const overlaps = roomList.some(
      (r) => candidate.x < r.x + r.w + 1 && candidate.x + candidate.w + 1 > r.x &&
             candidate.y < r.y + r.h + 1 && candidate.y + candidate.h + 1 > r.y,
    );
    if (overlaps) continue;
    for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) set(tx, ty, 0);
    roomList.push(candidate);
  }

  for (let i = 1; i < roomList.length; i++) {
    const a = roomList[i - 1];
    const b = roomList[i];
    const ax = Math.floor(a.x + a.w / 2);
    const ay = Math.floor(a.y + a.h / 2);
    const bx = Math.floor(b.x + b.w / 2);
    const by = Math.floor(b.y + b.h / 2);
    const hall = (x0: number, x1: number, y: number): void => {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) { set(x, y, 0); set(x, y + 1, 0); }
    };
    const shaft = (y0: number, y1: number, x: number): void => {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) { set(x, y, 0); set(x + 1, y, 0); }
    };
    if (rand() < 0.5) { hall(ax, bx, ay); shaft(ay, by, bx); }
    else { shaft(ay, by, ax); hall(ax, bx, by); }
  }

  // Pillars and crates: the geometry that makes the vision cone read as a cone.
  for (const r of roomList) {
    if (r.w < 7 || r.h < 7 || rand() < 0.35) continue;
    const px = r.x + 2 + Math.floor(rand() * (r.w - 4));
    const py = r.y + 2 + Math.floor(rand() * (r.h - 4));
    set(px, py, rand() < 0.4 ? 4 : 1);
    if (rand() < 0.5) set(px + 1, py, 1);
  }

  // Spawns: the squad in the first room, enemies everywhere else.
  const first = roomList[0];
  if (first) {
    for (let i = 0; i < 4; i++) {
      set(first.x + 1 + (i % 2) * 2, first.y + 1 + Math.floor(i / 2) * 2, 2);
    }
  }
  for (let i = 1; i < roomList.length; i++) {
    const r = roomList[i];
    // A starting population of zombies, plus zones the director draws from later.
    const count = 1 + Math.floor(rand() * 2);
    for (let n = 0; n < count; n++) {
      set(r.x + 1 + Math.floor(rand() * (r.w - 2)), r.y + 1 + Math.floor(rand() * (r.h - 2)), 3);
    }
    set(r.x + 1 + Math.floor(rand() * (r.w - 2)), r.y + 1 + Math.floor(rand() * (r.h - 2)), 8);
    if (rand() < 0.4) {
      set(r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2), 6);
    }
  }

  dressShip(grid, roomList, rand, cols, rows);

  return { name: `procedural #${seed}`, grid, generated: true };
}

/**
 * The ship's furniture, scattered through rooms that already exist.
 *
 * One rule makes the whole pass safe, and it is worth stating before anything else:
 * **a solid tile only ever replaces a wall, and a walkable one only ever replaces plain
 * floor.** Connectivity therefore cannot change, so no amount of dressing can wall off
 * a room, strand a spawn, or produce a map that cannot be finished — which is the thing
 * that makes a generator worth trusting. Everything placed here is also checked against
 * plain floor or plain wall, so two features can never land on the same tile and a
 * spawn is never overwritten.
 *
 * What it deliberately does NOT place:
 *
 * - **Airlocks.** A chamber has to be a walled throat with a door at each end, and a
 *   chamber you can walk round is a broken one. Corridors here are two tiles wide, so
 *   there is nothing to guarantee that with. Airlocks stay an authored beat.
 * - **Fusion core racks.** A core is only worth carrying to a socket, and survival has
 *   no objective chain to put a socket in. Battery racks and charging points do matter,
 *   because the suit battery is live in every mode.
 */
function dressShip(
  grid: number[][], rooms: Rect[], rand: () => number, cols: number, rows: number,
): void {
  if (rooms.length < 2) return;

  const FLOOR = id("floor");
  const WALL = id("wall");
  const at = (x: number, y: number): number =>
    x >= 0 && y >= 0 && x < cols && y < rows ? grid[y][x] : WALL;
  const isFloor = (x: number, y: number): boolean => at(x, y) === FLOOR;
  const isWall = (x: number, y: number): boolean => at(x, y) === WALL;
  const put = (x: number, y: number, tile: number): void => { grid[y][x] = tile; };
  const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  const floorsAround = (x: number, y: number): number =>
    NEIGHBOURS.filter(([dx, dy]) => isFloor(x + dx, y + dy)).length;

  /** A random plain-floor tile inside a room, or null if the room is full of furniture. */
  const spotIn = (r: Rect, want: (x: number, y: number) => boolean = () => true) => {
    for (let tries = 0; tries < 40; tries++) {
      const x = r.x + Math.floor(rand() * r.w);
      const y = r.y + Math.floor(rand() * r.h);
      if (isFloor(x, y) && want(x, y)) return { x, y };
    }
    return null;
  };
  /** Rooms other than the squad's, in a shuffled order, so no feature owns a room. */
  const elsewhere = rooms.slice(1);
  for (let i = elsewhere.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [elsewhere[i], elsewhere[j]] = [elsewhere[j], elsewhere[i]];
  }
  let next = 0;
  const room = (): Rect => elsewhere[next++ % elsewhere.length];
  /**
   * The same, but willing to walk the whole deck for a spot — the squad's own room last,
   * and only if nowhere else will have it. Used for the things there should be exactly
   * one of: losing the hull breach because the room the shuffle happened to pick was
   * full of furniture is a worse outcome than it being somewhere less interesting.
   */
  const spotAnywhere = (want: (x: number, y: number) => boolean) => {
    for (const r of [...elsewhere, rooms[0]]) {
      const spot = spotIn(r, want);
      if (spot) return { spot, room: r };
    }
    return null;
  };

  // --- Vents. At least two, or the things that travel by duct have nowhere to go, and
  //     in open floor rather than in a corner, so the grate is somewhere you might
  //     plausibly stop under.
  let vents = 0;
  for (let i = 0; i < 3; i++) {
    const spot = spotIn(room(), (x, y) => floorsAround(x, y) >= 3);
    if (!spot) continue;
    put(spot.x, spot.y, id("vent"));
    vents++;
  }

  // --- Standing water, and a torn conduit beside it. The cable goes on a WALL tile
  //     touching the pool: it is solid, and a solid thing in a doorway is how a
  //     generator makes a map nobody can finish.
  const found = spotAnywhere((x, y) => NEIGHBOURS.some(([dx, dy]) => isWall(x + dx, y + dy)));
  const pool = found?.spot ?? null;
  if (pool) {
    const water: { x: number; y: number }[] = [pool];
    put(pool.x, pool.y, id("water"));
    const size = 3 + Math.floor(rand() * 4);
    for (let tries = 0; water.length < size && tries < 30; tries++) {
      const from = water[Math.floor(rand() * water.length)];
      const [dx, dy] = NEIGHBOURS[Math.floor(rand() * 4)];
      const nx = from.x + dx;
      const ny = from.y + dy;
      if (!isFloor(nx, ny)) continue;      // that way is furniture or a wall; try another
      put(nx, ny, id("water"));
      water.push({ x: nx, y: ny });
    }
    for (const w of water) {
      const wall = NEIGHBOURS.find(([dx, dy]) => isWall(w.x + dx, w.y + dy));
      if (!wall) continue;
      put(w.x + wall[0], w.y + wall[1], id("cable"));
      break;
    }
  }

  // --- A split coolant line, also on a wall tile, for the same reason. The fog it
  //     spreads is baked at load and reaches into the room on its own.
  const fog = spotAnywhere((x, y) => NEIGHBOURS.some(([dx, dy]) => isWall(x + dx, y + dy)));
  if (fog) {
    const wall = NEIGHBOURS.find(([dx, dy]) => isWall(fog.spot.x + dx, fog.spot.y + dy))!;
    put(fog.spot.x + wall[0], fog.spot.y + wall[1], id("coolant"));
  }

  // --- A bulkhead, and only where it seals something. Corridors are two tiles wide, so
  //     a single door would be half a doorway: welding it shut would leave the gap
  //     beside it open, which is worse than having no door at all. So both tiles of a
  //     mouth are laid, or neither is.
  bulkhead: for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const pairAcross = isFloor(x, y) && isFloor(x + 1, y) && isWall(x - 1, y) && isWall(x + 2, y)
        && isFloor(x, y - 1) && isFloor(x + 1, y - 1) && isFloor(x, y + 1) && isFloor(x + 1, y + 1);
      if (pairAcross) {
        put(x, y, id("bulkhead"));
        put(x + 1, y, id("bulkhead"));
        break bulkhead;
      }
      const pairDown = isFloor(x, y) && isFloor(x, y + 1) && isWall(x, y - 1) && isWall(x, y + 2)
        && isFloor(x - 1, y) && isFloor(x - 1, y + 1) && isFloor(x + 1, y) && isFloor(x + 1, y + 1);
      if (pairDown) {
        put(x, y, id("bulkhead"));
        put(x, y + 1, id("bulkhead"));
        break bulkhead;
      }
    }
  }

  // --- Supplies and power. The charging point may be in the squad's own room: it is the
  //     one fitting that is purely a kindness, and it wants to be somewhere they will
  //     come back to.
  const caches = ["medkitCache", "adrenalineCache", "flareCache", "welderCache"];
  for (let i = 0; i < 2; i++) {
    const spot = spotIn(room());
    if (spot) put(spot.x, spot.y, id(caches[Math.floor(rand() * caches.length)]));
  }
  const charger = spotIn(rooms[Math.floor(rand() * rooms.length)]);
  if (charger) put(charger.x, charger.y, id("charger"));
  const cells = spotIn(room());
  if (cells) put(cells.x, cells.y, id("batteryRack"));

  // --- A hull breach, its lever, and something to hold on to. All three go in one room
  //     so the trade is legible from where you are standing: the hole against a wall,
  //     the lever across the room, and railings in between for the people who have to
  //     keep shooting while the deck empties.
  const hull = spotAnywhere((x, y) => NEIGHBOURS.some(([dx, dy]) => isWall(x + dx, y + dy)));
  if (hull) {
    const hole = hull.spot;
    const hullRoom = hull.room;
    put(hole.x, hole.y, id("breach"));
    const lever = spotIn(hullRoom, (x, y) => Math.abs(x - hole.x) + Math.abs(y - hole.y) >= 3);
    if (lever) put(lever.x, lever.y, id("breachLever"));
    for (let i = 0; i < 3; i++) {
      const rail = spotIn(
        hullRoom,
        (x, y) => {
          const d = Math.abs(x - hole.x) + Math.abs(y - hole.y);
          return d >= 2 && d <= 5;
        },
      );
      if (rail) put(rail.x, rail.y, id("railing"));
    }
  }

  // --- And the three things that are not walkers. None of them is ever drawn at random
  //     by the director (`weight: 0`), so without this pass survival never meets one.
  //     The Lurker is conditional: it lives in the ceiling, and a deck with no grates
  //     has nowhere to put it.
  for (const key of ["stranglerSpawn", "stalkerSpawn"]) {
    const spot = spotIn(room());
    if (spot) put(spot.x, spot.y, id(key));
  }
  if (vents >= 2) {
    const spot = spotIn(room());
    if (spot) put(spot.x, spot.y, id("lurkerSpawn"));
  }
}
