import { mulberry32 } from "../core/math";

export const TILE = 48;

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * CORE 3a — The world grid.
 *
 * Static geometry is a grid of solid/empty cells. A grid buys you three things a
 * polygon soup does not: O(1) collision lookups, trivially fast DDA raycasts for the
 * vision cone, and a level format you can edit as text or generate.
 */
export class TileMap {
  readonly solid: Uint8Array;
  readonly rooms: Rect[] = [];

  constructor(readonly cols: number, readonly rows: number) {
    this.solid = new Uint8Array(cols * rows).fill(1);
  }

  get worldWidth(): number { return this.cols * TILE; }
  get worldHeight(): number { return this.rows * TILE; }

  idx(tx: number, ty: number): number { return ty * this.cols + tx; }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.cols && ty < this.rows;
  }

  /** Out-of-bounds counts as solid so nothing can walk or see off the map. */
  isSolid(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true;
    return this.solid[this.idx(tx, ty)] === 1;
  }

  isSolidAt(x: number, y: number): boolean {
    return this.isSolid(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  set(tx: number, ty: number, value: 0 | 1): void {
    if (this.inBounds(tx, ty)) this.solid[this.idx(tx, ty)] = value;
  }

  carve(r: Rect): void {
    for (let ty = r.y; ty < r.y + r.h; ty++) {
      for (let tx = r.x; tx < r.x + r.w; tx++) this.set(tx, ty, 0);
    }
  }

  centerOf(r: Rect): { x: number; y: number } {
    return { x: (r.x + r.w / 2) * TILE, y: (r.y + r.h / 2) * TILE };
  }
}

/**
 * Placeholder level generator: random rooms, L-shaped corridors, a few pillars.
 * Replace with a real level format later — nothing outside this function knows
 * how the grid got its shape.
 */
export function generateLevel(cols: number, rows: number, seed = 1337): TileMap {
  const map = new TileMap(cols, rows);
  const rand = mulberry32(seed);
  const ri = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

  const attempts = 90;
  for (let i = 0; i < attempts && map.rooms.length < 16; i++) {
    const w = ri(5, 11);
    const h = ri(5, 10);
    const x = ri(1, cols - w - 2);
    const y = ri(1, rows - h - 2);
    const candidate: Rect = { x, y, w, h };

    const overlaps = map.rooms.some(
      (r) => candidate.x < r.x + r.w + 1 && candidate.x + candidate.w + 1 > r.x &&
             candidate.y < r.y + r.h + 1 && candidate.y + candidate.h + 1 > r.y,
    );
    if (overlaps) continue;

    map.carve(candidate);
    map.rooms.push(candidate);
  }

  // Connect each room to the previous one with an L corridor.
  for (let i = 1; i < map.rooms.length; i++) {
    const a = map.rooms[i - 1];
    const b = map.rooms[i];
    const ax = Math.floor(a.x + a.w / 2);
    const ay = Math.floor(a.y + a.h / 2);
    const bx = Math.floor(b.x + b.w / 2);
    const by = Math.floor(b.y + b.h / 2);
    const horizontalFirst = rand() < 0.5;

    const hall = (x0: number, x1: number, y: number): void => {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        map.set(x, y, 0);
        map.set(x, y + 1, 0); // 2 tiles wide so two players can pass each other
      }
    };
    const shaft = (y0: number, y1: number, x: number): void => {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        map.set(x, y, 0);
        map.set(x + 1, y, 0);
      }
    };

    if (horizontalFirst) { hall(ax, bx, ay); shaft(ay, by, bx); }
    else { shaft(ay, by, ax); hall(ax, bx, by); }
  }

  // Pillars: cheap, and they are what makes the vision cone read as a cone.
  for (const r of map.rooms) {
    if (r.w < 7 || r.h < 7 || rand() < 0.35) continue;
    const px = r.x + 2 + Math.floor(rand() * (r.w - 4));
    const py = r.y + 2 + Math.floor(rand() * (r.h - 4));
    map.set(px, py, 1);
    if (rand() < 0.5) map.set(px + 1, py, 1);
  }

  return map;
}
