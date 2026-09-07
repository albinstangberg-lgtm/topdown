import { TILE, type TileMap } from "./tilemap";

/**
 * CORE 3b — Collision.
 *
 * Actors are circles, the world is axis-aligned boxes. Movement is substepped so a
 * fast dash cannot tunnel through a wall, then overlaps are resolved by pushing the
 * circle out along the shortest axis. Good enough for a shooter, and cheap enough
 * that 4 players plus a few hundred enemies never shows up in a profile.
 */

export interface MoveResult { x: number; y: number; hitWall: boolean }

function resolveOverlap(map: TileMap, x: number, y: number, r: number): { x: number; y: number; hit: boolean } {
  let hit = false;
  // Two passes: the first push can create a new, shallower overlap on a corner.
  for (let pass = 0; pass < 2; pass++) {
    const minTx = Math.floor((x - r) / TILE);
    const maxTx = Math.floor((x + r) / TILE);
    const minTy = Math.floor((y - r) / TILE);
    const maxTy = Math.floor((y + r) / TILE);

    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        if (!map.isSolid(tx, ty)) continue;

        const left = tx * TILE;
        const top = ty * TILE;
        const closestX = Math.max(left, Math.min(x, left + TILE));
        const closestY = Math.max(top, Math.min(y, top + TILE));
        let dx = x - closestX;
        let dy = y - closestY;
        const distSq = dx * dx + dy * dy;

        if (distSq > r * r) continue;
        hit = true;

        if (distSq > 1e-6) {
          const dist = Math.sqrt(distSq);
          const push = r - dist;
          x += (dx / dist) * push;
          y += (dy / dist) * push;
        } else {
          // Centre is inside the tile: eject along the shallowest face.
          const cx = left + TILE / 2;
          const cy = top + TILE / 2;
          dx = x - cx;
          dy = y - cy;
          if (Math.abs(dx) > Math.abs(dy)) x = dx > 0 ? left + TILE + r : left - r;
          else y = dy > 0 ? top + TILE + r : top - r;
        }
      }
    }
  }
  return { x, y, hit };
}

export function moveCircle(
  map: TileMap, x: number, y: number, r: number, dx: number, dy: number,
): MoveResult {
  const dist = Math.hypot(dx, dy);
  const maxStep = r * 0.5;
  const steps = Math.max(1, Math.ceil(dist / maxStep));
  const sx = dx / steps;
  const sy = dy / steps;
  let hitWall = false;

  for (let i = 0; i < steps; i++) {
    // Axis-separated so sliding along a wall keeps the other axis' speed.
    const rx = resolveOverlap(map, x + sx, y, r);
    x = rx.x; y = rx.y; hitWall = hitWall || rx.hit;
    const ry = resolveOverlap(map, x, y + sy, r);
    x = ry.x; y = ry.y; hitWall = hitWall || ry.hit;
  }
  return { x, y, hitWall };
}

/** Point test — bullets are points, not circles. */
export function pointInWall(map: TileMap, x: number, y: number): boolean {
  return map.isSolidAt(x, y);
}

export function circleOverlap(
  ax: number, ay: number, ar: number, bx: number, by: number, br: number,
): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}
