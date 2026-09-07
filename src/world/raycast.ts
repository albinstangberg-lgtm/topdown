import { TILE, type TileMap } from "./tilemap";

/**
 * Grid DDA raycast (Amanatides & Woo). Steps tile boundary to tile boundary, so cost
 * is proportional to the number of tiles crossed, not to a step size. The vision cone
 * fires a few hundred of these per player per frame — this is the hot path.
 *
 * Returns the distance to the first solid tile, or `maxDist` if nothing was hit.
 */
export function raycast(
  map: TileMap, ox: number, oy: number, dx: number, dy: number, maxDist: number,
): number {
  let tx = Math.floor(ox / TILE);
  let ty = Math.floor(oy / TILE);
  if (map.isSolid(tx, ty)) return 0;

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;

  const invDx = dx !== 0 ? 1 / dx : Infinity;
  const invDy = dy !== 0 ? 1 / dy : Infinity;

  const tDeltaX = dx !== 0 ? Math.abs(TILE * invDx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(TILE * invDy) : Infinity;

  let tMaxX = dx !== 0
    ? ((dx > 0 ? (tx + 1) * TILE - ox : ox - tx * TILE)) * Math.abs(invDx)
    : Infinity;
  let tMaxY = dy !== 0
    ? ((dy > 0 ? (ty + 1) * TILE - oy : oy - ty * TILE)) * Math.abs(invDy)
    : Infinity;

  for (let guard = 0; guard < 512; guard++) {
    if (tMaxX < tMaxY) {
      if (tMaxX > maxDist) return maxDist;
      tx += stepX;
      if (map.isSolid(tx, ty)) return tMaxX;
      tMaxX += tDeltaX;
    } else {
      if (tMaxY > maxDist) return maxDist;
      ty += stepY;
      if (map.isSolid(tx, ty)) return tMaxY;
      tMaxY += tDeltaY;
    }
  }
  return maxDist;
}

/** True when nothing solid sits between the two points. Used for AI perception and hit checks. */
export function hasLineOfSight(
  map: TileMap, x0: number, y0: number, x1: number, y1: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-4) return true;
  return raycast(map, x0, y0, dx / dist, dy / dist, dist) >= dist - 1e-3;
}
