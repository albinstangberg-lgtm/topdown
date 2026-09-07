import { angleDelta, clamp, damp } from "../core/math";
import type { Viewport } from "./viewport";

/**
 * CORE 7 — Cameras.
 *
 * Two modes, because they are two different games:
 *
 *  - "rotating" (default): the camera pivots ON the player and turns to keep their
 *    facing pointing up the screen, with the player anchored low in the frame. You
 *    only ever see where you are going, which is where the claustrophobia comes from.
 *  - "fixed": north stays north and the camera merely follows with a look-ahead bias.
 *    Classic twin-stick, and the easier one to aim in.
 *
 * The mode changes how aiming has to work, so it is a camera property the input layer
 * reads — see `Game.resolveAim`.
 */
export type CameraMode = "rotating" | "fixed";

/** World units visible vertically. Fixed per mode so split screen is not a handicap. */
const VIEW_HEIGHT: Record<CameraMode, number> = { rotating: 380, fixed: 480 };
/** Where the player sits vertically in the viewport, 0 = top, 1 = bottom. */
const ANCHOR_Y: Record<CameraMode, number> = { rotating: 0.78, fixed: 0.5 };
/** Fixed mode has no rotation to give it screen space ahead, so it leans instead. */
const LOOK_AHEAD = 110;
/** How fast the view swings round to the player's facing. Too fast is nauseating. */
const TURN_DAMP = 9;

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  mode: CameraMode = "rotating";
  /** World direction currently pointing up the screen. Only used in rotating mode. */
  angle = -Math.PI / 2;

  private shake = 0;
  private shakeX = 0;
  private shakeY = 0;

  get anchorY(): number { return ANCHOR_Y[this.mode]; }

  /** Canvas rotation that puts `angle` at the top of the screen. Zero in fixed mode. */
  get rotation(): number {
    return this.mode === "rotating" ? -Math.PI / 2 - this.angle : 0;
  }

  snapTo(x: number, y: number, facing = this.angle): void {
    this.x = x;
    this.y = y;
    this.angle = facing;
  }

  addShake(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  follow(
    targetX: number, targetY: number, facing: number,
    vp: Viewport, worldW: number, worldH: number, dt: number,
  ): void {
    this.zoom = Math.max(0.55, vp.h / VIEW_HEIGHT[this.mode]);

    if (this.mode === "rotating") {
      // The pivot IS the player: no look-ahead offset, the low anchor does that job.
      this.x = damp(this.x, targetX, 12, dt);
      this.y = damp(this.y, targetY, 12, dt);
      // Damp along the shortest arc so crossing +/-PI does not spin the world.
      this.angle += angleDelta(this.angle, facing) * (1 - Math.exp(-TURN_DAMP * dt));
      // A rotating view shows the level from every side, so clamping to the world
      // rectangle would fight the rotation. Out of bounds is just dark.
    } else {
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
    }

    this.shake = Math.max(0, this.shake - dt * 2.6);
    const mag = this.shake * this.shake * 12;
    this.shakeX = (Math.random() * 2 - 1) * mag;
    this.shakeY = (Math.random() * 2 - 1) * mag;
  }

  /** Apply this camera to a context already clipped and translated to the viewport. */
  applyTransform(ctx: CanvasRenderingContext2D, vp: Viewport): void {
    ctx.translate(vp.w / 2, vp.h * this.anchorY);
    ctx.rotate(this.rotation);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x + this.shakeX, -this.y + this.shakeY);
  }

  /** Where the camera's focus point lands inside the canvas, in CSS pixels. */
  anchorScreen(vp: Viewport): { x: number; y: number } {
    return { x: vp.x + vp.w / 2, y: vp.y + vp.h * this.anchorY };
  }

  /** Canvas-space (CSS px) point to world space. Needed for mouse aiming. */
  screenToWorld(sx: number, sy: number, vp: Viewport): { x: number; y: number } {
    const anchor = this.anchorScreen(vp);
    const dx = (sx - anchor.x) / this.zoom;
    const dy = (sy - anchor.y) / this.zoom;
    const r = this.rotation;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    // Inverse of rotate(r) then translate(-cam): world = cam + R(-r) * screenOffset.
    return { x: this.x + dx * cos + dy * sin, y: this.y - dx * sin + dy * cos };
  }

  /**
   * World-space AABB currently visible, used to skip off-screen tiles. Under rotation
   * the visible region is a rotated rectangle, so this is the box around its corners.
   */
  visibleBounds(vp: Viewport, pad = 64): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const corners = [
      [vp.x, vp.y], [vp.x + vp.w, vp.y],
      [vp.x, vp.y + vp.h], [vp.x + vp.w, vp.y + vp.h],
    ];
    for (const [sx, sy] of corners) {
      const p = this.screenToWorld(sx, sy, vp);
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  }
}
