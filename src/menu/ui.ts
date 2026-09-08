/** Shared bits of menu chrome, so every screen looks like the same game. */

/** Darkens the level drifting behind a menu, more through the middle band. */
export function drawScrim(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.fillStyle = "rgba(6,7,12,0.74)";
  ctx.fillRect(0, 0, width, height);
  const veil = ctx.createLinearGradient(0, 0, 0, height);
  veil.addColorStop(0, "rgba(6,7,12,0)");
  veil.addColorStop(0.28, "rgba(6,7,12,0.55)");
  veil.addColorStop(0.75, "rgba(6,7,12,0.55)");
  veil.addColorStop(1, "rgba(6,7,12,0)");
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, width, height);
}

/** 0..1 breathing value, for anything that should look like it wants pressing. */
export function pulse(speed = 0.005): number {
  return 0.55 + 0.45 * Math.sin(performance.now() * speed);
}

export function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** letterSpacing is Chromium-only and silently ignored elsewhere — worth it, not required. */
export function setSpacing(ctx: CanvasRenderingContext2D, value: string): void {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ("letterSpacing" in c) c.letterSpacing = value;
}

export function title(
  ctx: CanvasRenderingContext2D, text: string, sub: string, width: number, y: number,
): void {
  const size = Math.min(56, Math.max(28, width * 0.045));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  setSpacing(ctx, "0.2em");
  ctx.fillStyle = "#f2f4f8";
  ctx.fillText(text, width / 2, y);
  setSpacing(ctx, "0.08em");
  ctx.font = "600 12px ui-monospace, monospace";
  ctx.fillStyle = "#79839c";
  ctx.fillText(sub, width / 2, y + size * 0.8);
}

export function footer(
  ctx: CanvasRenderingContext2D, text: string, width: number, y: number,
): void {
  ctx.textAlign = "center";
  ctx.font = "600 11px ui-monospace, monospace";
  ctx.fillStyle = "rgba(105,114,135,0.9)";
  ctx.fillText(text, width / 2, y);
}

/**
 * Turns an analog stick or WASD into discrete menu steps: one immediately, then a
 * slower repeat while held. Without this a menu is unusable on a stick.
 */
export class MenuCursor {
  private cooldown = 0;
  private lastX = 0;
  private lastY = 0;

  step(x: number, y: number, dt: number): { x: number; y: number } {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const dx = Math.abs(x) > 0.55 ? Math.sign(x) : 0;
    const dy = Math.abs(y) > 0.55 ? Math.sign(y) : 0;

    if (dx === 0 && dy === 0) {
      this.lastX = 0;
      this.lastY = 0;
      this.cooldown = 0;
      return { x: 0, y: 0 };
    }
    if (dx !== this.lastX || dy !== this.lastY) {
      this.lastX = dx;
      this.lastY = dy;
      this.cooldown = 0.34;                 // initial delay before it starts repeating
      return { x: dx, y: dy };
    }
    if (this.cooldown <= 0) {
      this.cooldown = 0.15;                 // repeat rate while held
      return { x: dx, y: dy };
    }
    return { x: 0, y: 0 };
  }
}
