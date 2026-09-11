import { stopsShots, TILE_DEFS, TILE_FLOOR, tileDef } from "./tiles";

export const TILE = 48;

export interface Point { x: number; y: number }

/**
 * One vehicle, not one tile. Cars are authored as blocks of `C` (or `A`) and the tiles
 * touching each other are gathered here into a single body with one outline, so the
 * renderer draws a car rather than four squares that happen to line up.
 */
export interface CarBody {
  /** Tile indices making up this car. */
  tiles: number[];
  /** Bounding box in world units. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** True while any of its tiles still carries a live alarm. */
  alarmed: boolean;
}

/**
 * One device tile: a terminal, a fusion socket or a weapon locker. Collected in
 * row-major order so a device's INDEX is stable whether or not it has been used —
 * which is what lets a mission hand a floor a list of logs and have terminal 2 keep
 * reading log 2 after terminal 1 has been read. See `src/sim/devices.ts`.
 */
export interface DeviceTile {
  kind: "terminal" | "socket" | "locker" | "supply";
  /** Tile coordinates, so using one can rewrite the grid. */
  tx: number;
  ty: number;
  /** Centre of the tile, in world units. */
  x: number;
  y: number;
  /** Already used. Still listed, because the index has to stay put. */
  spent: boolean;
}

/**
 * One puddle, not one tile — gathered exactly the way a car is, and for the same
 * reason: a current does not stop at a tile boundary. A cable put a bullet in
 * electrifies the whole connected body of water, which is what makes standing in one
 * a decision rather than a texture.
 */
export interface Puddle {
  /** Tile indices making up this body of water. */
  tiles: number[];
  /** Centre in world units, for the noise and the light the discharge throws. */
  x: number;
  y: number;
  /** Cable tiles touching it. No cable, no current, however deep the water is. */
  cables: Point[];
}

/** A hand-placed creature: where it stands, and which row of `ZOMBIE_DEFS` it is. */
export interface EnemySpawn extends Point {
  /** Undefined means the default walker — see `DEFAULT_ZOMBIE`. */
  kind?: string;
}

/** A ceiling vent: a grate over ordinary floor, and one node of the duct network. */
export interface VentTile {
  tx: number;
  ty: number;
  x: number;
  y: number;
}

/**
 * CORE 3a — The world grid.
 *
 * Static geometry is a grid of tile ids. A grid buys three things a polygon soup does
 * not: O(1) collision lookups, near-free DDA raycasts for the vision cone, and a level
 * format you can author as text or generate.
 *
 * The id grid is the source of truth. Collision, sight and spawn lists are all derived
 * from it in `refresh()`, so editing a tile at runtime stays consistent by construction.
 */
export class TileMap {
  /** Tile ids — the authored data. Everything below is derived from this. */
  readonly tiles: Uint8Array;
  private readonly solidMask: Uint8Array;
  private readonly opaqueMask: Uint8Array;
  private readonly shotMask: Uint8Array;

  readonly playerSpawns: Point[] = [];
  /**
   * Hand-placed enemies. One creature each, put down once when the map loads. `kind`
   * names the row in `ZOMBIE_DEFS` — the two mutants are only ever placed, never
   * rolled, so this is the only way either of them reaches a floor by hand.
   */
  readonly enemySpawns: EnemySpawn[] = [];
  /** Zones the director draws from, so pressure comes from a different door each time. */
  readonly spawnZones: Point[] = [];
  /** Exit tiles. A map with none simply has no objective — that is survival. */
  readonly exits: Point[] = [];
  /** Stairs. A floor with these sends the squad up instead of ending the mission. */
  readonly stairs: Point[] = [];
  /**
   * Signal flares. A floor with one of these and an exit is an extraction finale: the
   * exit stays shut until the flare is lit and the helicopter has come for you.
   */
  readonly signals: Point[] = [];
  /**
   * Terminals, fusion sockets and weapon lockers, in row-major order. Used and unused
   * alike — see `DeviceTile`.
   */
  readonly devices: DeviceTile[] = [];
  /** Sealed blast doors. Solid, and the reason a floor can have an exit you cannot use. */
  readonly blastDoors: Point[] = [];
  readonly lamps: { x: number; y: number; range: number }[] = [];
  /** Vehicles, gathered from touching car tiles. See `CarBody`. */
  readonly cars: CarBody[] = [];
  /** Ceiling vents. The duct network a Stalker travels is simply all of these. */
  readonly vents: VentTile[] = [];
  /** Bodies of standing water, gathered from touching flooded tiles. See `Puddle`. */
  readonly puddles: Puddle[] = [];
  /** Open bulkheads a welding tool can seal, and welded ones waiting to be chewed open. */
  readonly bulkheads: { tx: number; ty: number; x: number; y: number; welded: boolean }[] = [];
  /**
   * How thick the coolant fog is on each tile, 0..1. Baked at load from every leaking
   * pipe, because fog is authored geometry rather than anything that moves — and a
   * per-tile lookup is what lets the vision code ask "can I see in here" in O(1).
   */
  private fogMask: Float32Array;
  /** Tile indices you can stand on, for random placement. */
  private walkable: number[] = [];

  name = "untitled";

  constructor(readonly cols: number, readonly rows: number, tiles?: ArrayLike<number>) {
    this.tiles = new Uint8Array(cols * rows);
    if (tiles) this.tiles.set(Array.from(tiles).slice(0, cols * rows));
    this.solidMask = new Uint8Array(cols * rows);
    this.opaqueMask = new Uint8Array(cols * rows);
    this.shotMask = new Uint8Array(cols * rows);
    this.fogMask = new Float32Array(cols * rows);
    this.refresh();
  }

  get worldWidth(): number { return this.cols * TILE; }
  get worldHeight(): number { return this.rows * TILE; }

  idx(tx: number, ty: number): number { return ty * this.cols + tx; }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.cols && ty < this.rows;
  }

  tileAt(tx: number, ty: number): number {
    return this.inBounds(tx, ty) ? this.tiles[this.idx(tx, ty)] : TILE_FLOOR;
  }

  /** Rebuild every derived structure from the id grid. Cheap — call it after edits. */
  refresh(): void {
    this.playerSpawns.length = 0;
    this.enemySpawns.length = 0;
    this.spawnZones.length = 0;
    this.exits.length = 0;
    this.stairs.length = 0;
    this.signals.length = 0;
    this.devices.length = 0;
    this.blastDoors.length = 0;
    this.lamps.length = 0;
    this.cars.length = 0;
    this.vents.length = 0;
    this.puddles.length = 0;
    this.bulkheads.length = 0;
    this.walkable = [];

    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const i = this.idx(tx, ty);
        const def = tileDef(this.tiles[i]);
        this.solidMask[i] = def.solid ? 1 : 0;
        this.opaqueMask[i] = def.opaque ? 1 : 0;
        this.shotMask[i] = stopsShots(def) ? 1 : 0;

        // A SOLID tile can still be a spawn point — a window is the case that matters.
        // Nothing can stand inside it, so the spawn lands on the open tile next to it.
        if (def.solid) {
          // A blast door is solid, so it is collected here rather than below. It is
          // the one piece of geometry an objective can delete.
          if (def.blastDoor) this.blastDoors.push(this.tileCenter(tx, ty));
          if (def.spawn === "zone") {
            const beside = this.firstOpenNeighbour(tx, ty);
            if (beside) this.spawnZones.push(beside);
          }
          if (def.light) {
            const c = this.tileCenter(tx, ty);
            this.lamps.push({ x: c.x, y: c.y, range: def.light });
          }
          // A welded bulkhead is solid, so like a blast door it is collected up here.
          if (def.welded) {
            const c = this.tileCenter(tx, ty);
            this.bulkheads.push({ tx, ty, x: c.x, y: c.y, welded: true });
          }
          continue;
        }

        this.walkable.push(i);
        const c = this.tileCenter(tx, ty);
        if (def.spawn === "player") this.playerSpawns.push(c);
        else if (def.spawn === "enemy") this.enemySpawns.push({ ...c, kind: def.enemyKind });
        else if (def.spawn === "zone") this.spawnZones.push(c);
        if (def.exit) this.exits.push(c);
        if (def.stairs) this.stairs.push(c);
        if (def.signal) this.signals.push(c);
        if (def.device) {
          this.devices.push({ kind: def.device, tx, ty, x: c.x, y: c.y, spent: def.spent === true });
        }
        if (def.light) this.lamps.push({ x: c.x, y: c.y, range: def.light });
        if (def.vent) this.vents.push({ tx, ty, x: c.x, y: c.y });
        if (def.bulkhead) this.bulkheads.push({ tx, ty, x: c.x, y: c.y, welded: false });
      }
    }
    this.buildCars();
    this.buildPuddles();
    this.bakeFog();
  }

  /**
   * Gather touching flooded tiles into puddles, and note which cables reach each one.
   * Orthogonal neighbours only — the same rule cars use, so two pools either side of a
   * doorway are two pools, which is what an author drawing them means.
   */
  private buildPuddles(): void {
    const seen = new Set<number>();
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const i = this.idx(tx, ty);
        if (seen.has(i) || !tileDef(this.tiles[i]).flooded) continue;

        const tiles: number[] = [];
        const cables: Point[] = [];
        const queue: [number, number][] = [[tx, ty]];
        seen.add(i);
        let sumX = 0;
        let sumY = 0;
        while (queue.length > 0) {
          const [cx, cy] = queue.pop()!;
          tiles.push(this.idx(cx, cy));
          sumX += cx;
          sumY += cy;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (!this.inBounds(nx, ny)) continue;
            const ni = this.idx(nx, ny);
            const ndef = tileDef(this.tiles[ni]);
            // A cable beside the water is what makes the water dangerous. It is not
            // part of the puddle, so it is recorded rather than walked into.
            if (ndef.cable) {
              const c = this.tileCenter(nx, ny);
              if (!cables.some((p) => p.x === c.x && p.y === c.y)) cables.push(c);
              continue;
            }
            if (seen.has(ni) || !ndef.flooded) continue;
            seen.add(ni);
            queue.push([nx, ny]);
          }
        }
        this.puddles.push({
          tiles,
          x: (sumX / tiles.length + 0.5) * TILE,
          y: (sumY / tiles.length + 0.5) * TILE,
          cables,
        });
      }
    }
  }

  /**
   * Bake the coolant fog. Each leaking pipe fills the open floor around it, falling off
   * with distance and stopping at anything sight cannot pass — so fog fills a room
   * rather than seeping through its walls. Done once at load because a split pipe does
   * not move; if fog ever needs to spread, this is the one function that changes.
   */
  private bakeFog(): void {
    this.fogMask.fill(0);
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const range = tileDef(this.tiles[this.idx(tx, ty)]).coolant;
        if (!range) continue;
        const reach = Math.ceil(range / TILE);
        const src = this.tileCenter(tx, ty);
        for (let oy = -reach; oy <= reach; oy++) {
          for (let ox = -reach; ox <= reach; ox++) {
            const nx = tx + ox;
            const ny = ty + oy;
            if (!this.inBounds(nx, ny) || this.isOpaque(nx, ny)) continue;
            const c = this.tileCenter(nx, ny);
            const d = Math.hypot(c.x - src.x, c.y - src.y);
            if (d > range) continue;
            if (!this.clearLine(tx, ty, nx, ny)) continue;
            // Thickest at the pipe, thinning to nothing at the edge of the cloud.
            const thickness = Math.min(1, 1.15 * (1 - d / range));
            const i = this.idx(nx, ny);
            this.fogMask[i] = Math.max(this.fogMask[i], thickness);
          }
        }
      }
    }
  }

  /** Whether sight passes between two tile centres. A coarse Bresenham, for the bake. */
  private clearLine(x0: number, y0: number, x1: number, y1: number): boolean {
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let cx = x0;
    let cy = y0;
    for (let guard = 0; guard < 512; guard++) {
      if (cx === x1 && cy === y1) return true;
      if ((cx !== x0 || cy !== y0) && this.isOpaque(cx, cy)) return false;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; cx += sx; }
      if (e2 <= dx) { err += dx; cy += sy; }
    }
    return false;
  }

  /** How thick the fog is at a world point, 0 (clear) to 1 (you can see your hands). */
  fogAt(x: number, y: number): number {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (!this.inBounds(tx, ty)) return 0;
    return this.fogMask[this.idx(tx, ty)];
  }

  /** The puddle covering this world point, or null. */
  puddleAt(x: number, y: number): Puddle | null {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (!this.inBounds(tx, ty)) return null;
    const i = this.idx(tx, ty);
    return this.puddles.find((p) => p.tiles.includes(i)) ?? null;
  }

  /** Is this world point an open bulkhead a welding tool could seal? */
  isBulkheadAt(x: number, y: number): boolean {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    return tileDef(this.tileAt(tx, ty)).bulkhead === true;
  }

  /** The vent grate over this world point, or null. */
  ventAt(x: number, y: number): VentTile | null {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    return this.vents.find((v) => v.tx === tx && v.ty === ty) ?? null;
  }

  /**
   * Gather touching car tiles into vehicles. Orthogonal neighbours only: two cars
   * parked corner to corner are two cars, which is what an author drawing a car park
   * means by it.
   */
  private buildCars(): void {
    const seen = new Set<number>();
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const i = this.idx(tx, ty);
        if (seen.has(i) || tileDef(this.tiles[i]).prop !== "car") continue;

        const tiles: number[] = [];
        const queue = [[tx, ty]];
        seen.add(i);
        let minX = tx, minY = ty, maxX = tx, maxY = ty;
        let alarmed = false;
        while (queue.length > 0) {
          const [cx, cy] = queue.pop()!;
          const ci = this.idx(cx, cy);
          tiles.push(ci);
          if (tileDef(this.tiles[ci]).alarm) alarmed = true;
          minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (!this.inBounds(nx, ny)) continue;
            const ni = this.idx(nx, ny);
            if (seen.has(ni) || tileDef(this.tiles[ni]).prop !== "car") continue;
            seen.add(ni);
            queue.push([nx, ny]);
          }
        }
        this.cars.push({
          tiles,
          x: minX * TILE, y: minY * TILE,
          w: (maxX - minX + 1) * TILE, h: (maxY - minY + 1) * TILE,
          alarmed,
        });
      }
    }
  }

  /** The vehicle occupying this tile, if any. */
  carAt(tx: number, ty: number): CarBody | null {
    if (!this.inBounds(tx, ty)) return null;
    const i = this.idx(tx, ty);
    return this.cars.find((c) => c.tiles.includes(i)) ?? null;
  }

  setTile(tx: number, ty: number, id: number): void {
    if (!this.inBounds(tx, ty)) return;
    this.tiles[this.idx(tx, ty)] = id;
    const def = tileDef(id);
    const i = this.idx(tx, ty);
    this.solidMask[i] = def.solid ? 1 : 0;
    this.opaqueMask[i] = def.opaque ? 1 : 0;
    this.shotMask[i] = stopsShots(def) ? 1 : 0;
  }

  /** Out of bounds counts as solid AND opaque, so nothing walks or sees off the map. */
  isSolid(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true;
    return this.solidMask[this.idx(tx, ty)] === 1;
  }

  isOpaque(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true;
    return this.opaqueMask[this.idx(tx, ty)] === 1;
  }

  /** Stops a bullet. Not the same question as `isSolid` — see TILE_DEFS. */
  blocksShots(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true;
    return this.shotMask[this.idx(tx, ty)] === 1;
  }

  blocksShotsAt(x: number, y: number): boolean {
    return this.blocksShots(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  isSolidAt(x: number, y: number): boolean {
    return this.isSolid(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  isExitAt(x: number, y: number): boolean {
    return tileDef(this.tileAt(Math.floor(x / TILE), Math.floor(y / TILE))).exit === true;
  }

  isStairsAt(x: number, y: number): boolean {
    return tileDef(this.tileAt(Math.floor(x / TILE), Math.floor(y / TILE))).stairs === true;
  }

  isSignalAt(x: number, y: number): boolean {
    return tileDef(this.tileAt(Math.floor(x / TILE), Math.floor(y / TILE))).signal === true;
  }

  /** The unused device under this point, if any. A spent one answers null. */
  deviceAt(x: number, y: number): DeviceTile | null {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    return this.devices.find((d) => d.tx === tx && d.ty === ty && !d.spent) ?? null;
  }

  /** The first walkable tile orthogonally adjacent to this one, if any. */
  private firstOpenNeighbour(tx: number, ty: number): Point | null {
    const around = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of around) {
      if (!this.inBounds(tx + dx, ty + dy)) continue;
      if (!tileDef(this.tileAt(tx + dx, ty + dy)).solid) return this.tileCenter(tx + dx, ty + dy);
    }
    return null;
  }

  tileCenter(tx: number, ty: number): Point {
    return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
  }

  /** A random standable point. Used when a level declares no spawns of its own. */
  randomWalkable(rand: () => number = Math.random): Point | null {
    if (this.walkable.length === 0) return null;
    const i = this.walkable[Math.floor(rand() * this.walkable.length)];
    return this.tileCenter(i % this.cols, Math.floor(i / this.cols));
  }

  /** The open tile furthest from any wall — a sane default when a map has no spawns. */
  mostOpenPoint(): Point {
    let best = this.walkable[0] ?? 0;
    let bestScore = -1;
    for (const i of this.walkable) {
      const tx = i % this.cols;
      const ty = Math.floor(i / this.cols);
      let score = 0;
      for (let r = 1; r <= 4; r++) {
        if (this.isSolid(tx - r, ty) || this.isSolid(tx + r, ty) ||
            this.isSolid(tx, ty - r) || this.isSolid(tx, ty + r)) break;
        score = r;
      }
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return this.tileCenter(best % this.cols, Math.floor(best / this.cols));
  }

  /** Copy out as a plain 2D array — the shape a level file stores. */
  toGrid(): number[][] {
    const grid: number[][] = [];
    for (let ty = 0; ty < this.rows; ty++) {
      const row: number[] = [];
      for (let tx = 0; tx < this.cols; tx++) row.push(this.tiles[this.idx(tx, ty)]);
      grid.push(row);
    }
    return grid;
  }

  /** Tile ids actually used, for the editor's legend and for level stats. */
  usedTileIds(): number[] {
    const seen = new Set<number>();
    for (const id of this.tiles) seen.add(id);
    return TILE_DEFS.filter((d) => seen.has(d.id)).map((d) => d.id);
  }
}
