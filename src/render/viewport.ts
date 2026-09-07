/**
 * CORE 10 — Viewports / split screen.
 *
 * The single most important rule for a game that wants 4-player local co-op:
 * NOTHING assumes there is one screen or one camera. Everything that draws takes a
 * viewport, and the layout is derived from the number of players at runtime.
 */

export interface Viewport {
  /** Rect in CSS pixels, relative to the canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
  playerIndex: number;
}

/** 1 = fullscreen, 2 = side by side, 3-4 = quadrants. */
export function layoutViewports(count: number, width: number, height: number): Viewport[] {
  const n = Math.max(1, Math.min(4, count));
  const out: Viewport[] = [];

  if (n === 1) {
    out.push({ x: 0, y: 0, w: width, h: height, playerIndex: 0 });
  } else if (n === 2) {
    // Split along the long axis so each half stays as close to square as possible.
    if (width >= height) {
      const w = width / 2;
      out.push({ x: 0, y: 0, w, h: height, playerIndex: 0 });
      out.push({ x: w, y: 0, w, h: height, playerIndex: 1 });
    } else {
      const h = height / 2;
      out.push({ x: 0, y: 0, w: width, h, playerIndex: 0 });
      out.push({ x: 0, y: h, w: width, h, playerIndex: 1 });
    }
  } else {
    const w = width / 2;
    const h = height / 2;
    for (let i = 0; i < n; i++) {
      out.push({ x: (i % 2) * w, y: Math.floor(i / 2) * h, w, h, playerIndex: i });
    }
  }
  return out;
}

export function viewportAt(views: Viewport[], x: number, y: number): Viewport | null {
  for (const v of views) {
    if (x >= v.x && x < v.x + v.w && y >= v.y && y < v.y + v.h) return v;
  }
  return null;
}
