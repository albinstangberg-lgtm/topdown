import { TILE, type Point, type TileMap } from "./tilemap";

/**
 * CORE 3d — Flow fields.
 *
 * A breadth-first sweep out from a set of goal tiles, giving every walkable tile its
 * distance to the nearest goal. Any number of zombies then steer by reading one tile —
 * downhill is the way — so a horde of forty costs one sweep, not forty path searches.
 *
 * A grid is what makes this cheap: 900-2400 tiles, four neighbours each, integer
 * distances, one flat queue and no allocation after the first build. Rebuilding it
 * several times a second is genuinely free next to the vision raycasts.
 *
 * It is deliberately *only* a heading. Zombies still collide, separate and slide with
 * the same code they always used; the field replaces "walk straight at it and hope",
 * which is the version that piles a wave into the outside of a corner forever.
 */

const UNREACHABLE = 0xffff;

/** The four orthogonal steps first, then the four diagonals. */
const STEPS: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export class FlowField {
  private dist = new Uint16Array(0);
  private queue = new Int32Array(0);
  private cols = 0;
  private rows = 0;
  /** How many goal tiles the last rebuild actually used. Zero means "no heading". */
  goalCount = 0;

  /**
   * Sweep out from `goals`. Points inside a wall are skipped rather than snapped —
   * a goal nothing can stand on is not a goal.
   */
  rebuild(map: TileMap, goals: readonly Point[]): void {
    if (this.cols !== map.cols || this.rows !== map.rows) {
      this.cols = map.cols;
      this.rows = map.rows;
      this.dist = new Uint16Array(map.cols * map.rows);
      this.queue = new Int32Array(map.cols * map.rows);
    }
    this.dist.fill(UNREACHABLE);

    let head = 0;
    let tail = 0;
    for (const g of goals) {
      const tx = Math.floor(g.x / TILE);
      const ty = Math.floor(g.y / TILE);
      if (!map.inBounds(tx, ty) || map.isSolid(tx, ty)) continue;
      const i = map.idx(tx, ty);
      if (this.dist[i] === 0) continue;
      this.dist[i] = 0;
      this.queue[tail++] = i;
    }
    this.goalCount = tail;

    while (head < tail) {
      const i = this.queue[head++];
      const d = this.dist[i] + 1;
      const tx = i % this.cols;
      const ty = (i / this.cols) | 0;
      // Four-neighbour flood: the diagonals come back at query time, where a corner
      // check can look at both sides of the step.
      for (let s = 0; s < 4; s++) {
        const nx = tx + STEPS[s][0];
        const ny = ty + STEPS[s][1];
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        if (map.isSolid(nx, ny)) continue;
        const ni = ny * this.cols + nx;
        if (this.dist[ni] <= d) continue;
        this.dist[ni] = d;
        this.queue[tail++] = ni;
      }
    }
  }

  /** Wipe it. A field with no goals steers nothing, which is what an idle lure wants. */
  clear(): void {
    this.goalCount = 0;
    this.dist.fill(UNREACHABLE);
  }

  /** Tiles to the nearest goal, or -1 where nothing can reach one. */
  distanceAt(x: number, y: number): number {
    const i = this.indexAt(x, y);
    if (i < 0 || this.dist[i] === UNREACHABLE) return -1;
    return this.dist[i];
  }

  /**
   * A unit vector pointing downhill, written into `out`. False when there is no
   * heading to give: no goals, standing in a wall, cut off from every goal, or
   * already on the goal tile — all of which the caller wants to handle itself.
   */
  steer(map: TileMap, x: number, y: number, out: { x: number; y: number }): boolean {
    if (this.goalCount === 0) return false;
    const i = this.indexAt(x, y);
    if (i < 0) return false;
    const here = this.dist[i];
    if (here === UNREACHABLE || here === 0) return false;

    const tx = i % this.cols;
    const ty = (i / this.cols) | 0;
    let best = here;
    let bestX = 0;
    let bestY = 0;
    for (const [dx, dy] of STEPS) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
      if (map.isSolid(nx, ny)) continue;
      // No cutting corners: a diagonal needs both tiles beside it open, or a body with
      // a radius clips the block it is squeezing past.
      if (dx !== 0 && dy !== 0 && (map.isSolid(tx + dx, ty) || map.isSolid(tx, ty + dy))) continue;
      const d = this.dist[ny * this.cols + nx];
      if (d >= best) continue;
      best = d;
      bestX = nx;
      bestY = ny;
    }
    if (best === here) return false;

    // Aim at the centre of the winning tile rather than along the raw step, so a body
    // crossing a wide room curves instead of walking a staircase.
    const cx = (bestX + 0.5) * TILE;
    const cy = (bestY + 0.5) * TILE;
    const len = Math.hypot(cx - x, cy - y) || 1;
    out.x = (cx - x) / len;
    out.y = (cy - y) / len;
    return true;
  }

  private indexAt(x: number, y: number): number {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return -1;
    return ty * this.cols + tx;
  }
}
