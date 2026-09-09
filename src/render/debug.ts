import type { GameLoop } from "../core/loop";
import type { GameWorld } from "../sim/world";
import type { Camera } from "./camera";
import type { Viewport } from "./viewport";
import { TILE } from "../world/tilemap";
import { zombieDef } from "../sim/zombies";

/** One colour per AI state, so the machine is readable at a glance. */
const STATE_COLORS: Record<string, string> = {
  wander: "#4dff88",
  investigate: "#ffe14d",
  chase: "#ffaa4d",
  windup: "#ff4d4d",
  lunge: "#ff4dff",
  recover: "#8899aa",
};

/**
 * CORE 13 — Debug view.
 *
 * Build this on day one, not on the day you need it. F1 toggles.
 */
export class DebugOverlay {
  enabled = false;
  showCollision = false;

  toggle(): void { this.enabled = !this.enabled; }

  drawWorld(ctx: CanvasRenderingContext2D, world: GameWorld, cam: Camera, vp: Viewport): void {
    if (!this.enabled) return;
    ctx.save();
    cam.applyTransform(ctx, vp);

    if (this.showCollision) {
      const b = cam.visibleBounds(vp);
      ctx.strokeStyle = "rgba(0,255,255,0.25)";
      ctx.lineWidth = 1;
      for (let ty = Math.floor(b.y0 / TILE); ty <= Math.ceil(b.y1 / TILE); ty++) {
        for (let tx = Math.floor(b.x0 / TILE); tx <= Math.ceil(b.x1 / TILE); tx++) {
          if (world.map.isSolid(tx, ty)) ctx.strokeRect(tx * TILE, ty * TILE, TILE, TILE);
        }
      }
    }

    ctx.lineWidth = 1;
    for (const e of world.enemies) {
      ctx.strokeStyle = STATE_COLORS[e.state] ?? "#4dff88";
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius + 3, 0, Math.PI * 2);
      ctx.stroke();

      // The sense arc, which is the thing you actually want to see while tuning.
      const def = zombieDef(e.kind);
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.arc(e.x, e.y, def.senseRange, e.facing - def.senseHalf, e.facing + def.senseHalf);
      ctx.closePath();
      ctx.stroke();
      if (e.targetId >= 0) {
        ctx.beginPath();
        ctx.moveTo(e.x, e.y);
        ctx.lineTo(e.lastSeenX, e.lastSeenY);
        ctx.stroke();
      }
    }

    for (const p of world.players) {
      ctx.strokeStyle = "#00ffcc";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  drawStats(
    ctx: CanvasRenderingContext2D, loop: GameLoop, world: GameWorld, dpr: number,
  ): void {
    if (!this.enabled) return;
    const lines = [
      `fps ${loop.stats.fps.toFixed(0)}  steps ${loop.stats.stepsLastFrame}`,
      `sim ${loop.stats.updateMs.toFixed(2)}ms  draw ${loop.stats.renderMs.toFixed(2)}ms`,
      `players ${world.players.length}  enemies ${world.enemies.length}`,
      `bullets ${world.bullets.items.filter((b) => b.active).length}`,
      `vision pts ${world.players.reduce((n, p) => n + p.cone.poly.length / 2, 0).toFixed(0)}`,
      `t ${world.time.toFixed(1)}s   [F2] collision grid`,
    ];
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = "600 11px ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    const x = ctx.canvas.clientWidth - 12;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x - 220, 8, 216, lines.length * 14 + 8);
    ctx.fillStyle = "#8ef5d0";
    lines.forEach((line, i) => ctx.fillText(line, x - 8, 12 + i * 14));
    ctx.restore();
  }
}
