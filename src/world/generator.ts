import { mulberry32 } from "../core/math";
import type { LevelData } from "./level";

interface Rect { x: number; y: number; w: number; h: number }

/**
 * Placeholder level generator. It emits the same thing a hand-authored level is — a
 * grid of tile ids — so the game has exactly one way to load a map and no special
 * case for "generated" versus "designed".
 */
export function generateLevel(cols: number, rows: number, seed = 1337): LevelData {
  const grid: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(1));
  const rand = mulberry32(seed);
  const ri = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));
  const set = (x: number, y: number, id: number): void => {
    if (x >= 0 && y >= 0 && x < cols && y < rows) grid[y][x] = id;
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
    const count = 1 + Math.floor(rand() * 2);
    for (let n = 0; n < count; n++) {
      set(r.x + 1 + Math.floor(rand() * (r.w - 2)), r.y + 1 + Math.floor(rand() * (r.h - 2)), 3);
    }
    if (rand() < 0.4) {
      set(r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2), 6);
    }
  }

  return { name: `procedural #${seed}`, grid };
}
