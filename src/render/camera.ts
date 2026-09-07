import { clamp, damp } from "../core/math";
import type { Viewport } from "./viewport";

/** World units visible vertically. Fixed so a split-screen player is not disadvantaged. */
const VIEW_HEIGHT = 660;
const LOOK_AHEAD = 110;

/**
 * One camera per viewport. Follows its player with a bias toward where they are
 * aiming, so the vision cone gets the screen space instead of the wall behind them.
 */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  private shake = 0;
  private shakeX = 0;
  private shakeY = 0;

  snapTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  addShake(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  follow(
    targetX: number, targetY: number, facing: number,
    vp: Viewport, worldW: number, worldH: number, dt: number,
  ): void {
    this.zoom = Math.max(0.55, vp.h / VIEW_HEIGHT);

    const desiredX = targetX + Math.cos(facing) * LOOK_AHEAD;
    const desiredY = targetY + Math.sin(facing) * LOOK_AHEAD;
    this.x = damp(this.x, desiredX, 7, dt);
    this.y = damp(this.y, desiredY, 7, dt);

    // Don't show the void outside the level.
    const halfW = vp.w / 2 / this.zoom;
    const halfH = vp.h / 2 / this.zoom;
    if (worldW > halfW * 2) this.x = clamp(this.x, halfW, worldW - halfW);
    else this.x = worldW / 2;
    if (worldH > halfH * 2) this.y = clamp(this.y, halfH, worldH - halfH);
    else this.y = worldH / 2;

    this.shake = Math.max(0, this.shake - dt * 2.6);
    const mag = this.shake * this.shake * 12;
    this.shakeX = (Math.random() * 2 - 1) * mag;
    this.shakeY = (Math.random() * 2 - 1) * mag;
  }

  /** Apply this camera to a context already clipped and translated to the viewport. */
  applyTransform(ctx: CanvasRenderingContext2D, vp: Viewport): void {
    ctx.translate(vp.w / 2, vp.h / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x + this.shakeX, -this.y + this.shakeY);
  }

  /** Canvas-space (CSS px) point to world space. Needed for mouse aiming. */
  screenToWorld(sx: number, sy: number, vp: Viewport): { x: number; y: number } {
    return {
      x: (sx - vp.x - vp.w / 2) / this.zoom + this.x,
      y: (sy - vp.y - vp.h / 2) / this.zoom + this.y,
    };
  }

  /** World-space rect currently visible, used to skip off-screen tiles. */
  visibleBounds(vp: Viewport, pad = 64): { x0: number; y0: number; x1: number; y1: number } {
    const halfW = vp.w / 2 / this.zoom + pad;
    const halfH = vp.h / 2 / this.zoom + pad;
    return { x0: this.x - halfW, y0: this.y - halfH, x1: this.x + halfW, y1: this.y + halfH };
  }
}
