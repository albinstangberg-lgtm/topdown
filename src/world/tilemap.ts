import { TILE_DEFS, TILE_FLOOR, tileDef } from "./tiles";

export const TILE = 48;

export interface Point { x: number; y: number }

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

  readonly playerSpawns: Point[] = [];
  /** Hand-placed enemies. One zombie each, put down once when the map loads. */
  readonly enemySpawns: Point[] = [];
  /** Zones the director draws from, so pressure comes from a different door each time. */
  readonly spawnZones: Point[] = [];
  /** Exit tiles. A map with none simply has no objective — that is survival. */
  readonly exits: Point[] = [];
  /** Stairs. A floor with these sends the squad up instead of ending the mission. */
  readonly stairs: Point[] = [];
  readonly lamps: { x: number; y: number; range: number }[] = [];
  /** Tile indices you can stand on, for random placement. */
  private walkable: number[] = [];

  name = "untitled";

  constructor(readonly cols: number, readonly rows: number, tiles?: ArrayLike<number>) {
    this.tiles = new Uint8Array(cols * rows);
    if (tiles) this.tiles.set(Array.from(tiles).slice(0, cols * rows));
    this.solidMask = new Uint8Array(cols * rows);
    this.opaqueMask = new Uint8Array(cols * rows);
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
    this.lamps.length = 0;
    this.walkable = [];

    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const i = this.idx(tx, ty);
        const def = tileDef(this.tiles[i]);
        this.solidMask[i] = def.solid ? 1 : 0;
        this.opaqueMask[i] = def.opaque ? 1 : 0;

        // A SOLID tile can still be a spawn point — a window is the case that matters.
        // Nothing can stand inside it, so the spawn lands on the open tile next to it.
        if (def.solid) {
          if (def.spawn === "zone") {
            const beside = this.firstOpenNeighbour(tx, ty);
            if (beside) this.spawnZones.push(beside);
          }
          if (def.light) {
            const c = this.tileCenter(tx, ty);
            this.lamps.push({ x: c.x, y: c.y, range: def.light });
          }
          continue;
        }

        this.walkable.push(i);
        const c = this.tileCenter(tx, ty);
        if (def.spawn === "player") this.playerSpawns.push(c);
        else if (def.spawn === "enemy") this.enemySpawns.push(c);
        else if (def.spawn === "zone") this.spawnZones.push(c);
        if (def.exit) this.exits.push(c);
        if (def.stairs) this.stairs.push(c);
        if (def.light) this.lamps.push({ x: c.x, y: c.y, range: def.light });
      }
    }
  }

  setTile(tx: number, ty: number, id: number): void {
    if (!this.inBounds(tx, ty)) return;
    this.tiles[this.idx(tx, ty)] = id;
    const def = tileDef(id);
    const i = this.idx(tx, ty);
    this.solidMask[i] = def.solid ? 1 : 0;
    this.opaqueMask[i] = def.opaque ? 1 : 0;
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

  isSolidAt(x: number, y: number): boolean {
    return this.isSolid(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  isExitAt(x: number, y: number): boolean {
    return tileDef(this.tileAt(Math.floor(x / TILE), Math.floor(y / TILE))).exit === true;
  }

  isStairsAt(x: number, y: number): boolean {
    return tileDef(this.tileAt(Math.floor(x / TILE), Math.floor(y / TILE))).stairs === true;
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
