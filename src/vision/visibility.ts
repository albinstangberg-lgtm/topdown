import { raycast } from "../world/raycast";
import type { TileMap } from "../world/tilemap";
import { TAU } from "../core/math";

/**
 * CORE 4 — Vision / line of sight.
 *
 * This is the feature that defines the look in the reference image: a cone of light
 * in front of the player, hard black shadows behind every block.
 *
 * The cone is a visibility polygon: fan out N rays across the cone, keep the point
 * where each one stops, and connect them. Where two neighbouring rays disagree a lot
 * there is a shadow edge, so we subdivide there — cheap adaptive refinement instead of
 * brute-forcing 1000 rays, which keeps corners crisp without the cost.
 *
 * The polygon is computed once per light per frame and reused by every viewport,
 * which matters a lot at 4-way split screen.
 */

const BASE_STEP = 0.018;      // radians between fan rays (~1 degree)
const REFINE_THRESHOLD = 12;  // world units of disagreement that counts as an edge
const MAX_REFINE_DEPTH = 4;

export interface VisionLight {
  x: number;
  y: number;
  facing: number;
  halfAngle: number;
  range: number;
  /** Flat [x0,y0,x1,y1,...] world-space polygon, rebuilt each frame. */
  poly: number[];
  color: string;
  intensity: number;
}

export function makeLight(color: string, halfAngle: number, range: number, intensity = 1): VisionLight {
  return { x: 0, y: 0, facing: 0, halfAngle, range, poly: [], color, intensity };
}

export function computeVisibility(map: TileMap, light: VisionLight): void {
  const { x, y, facing, halfAngle, range } = light;
  const poly = light.poly;
  poly.length = 0;

  const full = halfAngle >= Math.PI - 1e-3;
  // A cone is a pie slice, so it starts at the apex. A full circle has no apex vertex.
  if (!full) poly.push(x, y);

  const span = full ? TAU : halfAngle * 2;
  const steps = Math.max(8, Math.ceil(span / BASE_STEP));
  const start = full ? 0 : facing - halfAngle;
  const step = span / steps;

  let prevAngle = start;
  let prevDist = cast(map, x, y, prevAngle, range);
  pushPoint(poly, x, y, prevAngle, prevDist);

  for (let i = 1; i <= steps; i++) {
    const angle = start + step * i;
    const dist = cast(map, x, y, angle, range);
    refine(map, x, y, poly, prevAngle, prevDist, angle, dist, range, 0);
    pushPoint(poly, x, y, angle, dist);
    prevAngle = angle;
    prevDist = dist;
  }
}

function cast(map: TileMap, x: number, y: number, angle: number, range: number): number {
  return raycast(map, x, y, Math.cos(angle), Math.sin(angle), range);
}

function pushPoint(poly: number[], x: number, y: number, angle: number, dist: number): void {
  poly.push(x + Math.cos(angle) * dist, y + Math.sin(angle) * dist);
}

/** Bisect between two rays that hit very different depths — that gap is a shadow edge. */
function refine(
  map: TileMap, x: number, y: number, poly: number[],
  a0: number, d0: number, a1: number, d1: number, range: number, depth: number,
): void {
  if (depth >= MAX_REFINE_DEPTH || Math.abs(d1 - d0) < REFINE_THRESHOLD) return;
  const am = (a0 + a1) * 0.5;
  const dm = cast(map, x, y, am, range);
  refine(map, x, y, poly, a0, d0, am, dm, range, depth + 1);
  pushPoint(poly, x, y, am, dm);
  refine(map, x, y, poly, am, dm, a1, d1, range, depth + 1);
}

/** Cone membership test without a raycast — use it to reject before paying for line of sight. */
export function inCone(
  ox: number, oy: number, facing: number, halfAngle: number, range: number,
  tx: number, ty: number,
): boolean {
  const dx = tx - ox;
  const dy = ty - oy;
  if (dx * dx + dy * dy > range * range) return false;
  let d = Math.atan2(dy, dx) - facing;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return Math.abs(d) <= halfAngle;
}
