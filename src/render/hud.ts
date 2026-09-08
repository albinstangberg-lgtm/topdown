import type { GameWorld } from "../sim/world";
import type { Viewport } from "./viewport";

/**
 * CORE 12 — HUD, per viewport.
 *
 * In split screen every HUD element belongs to a specific quarter of the screen.
 * Anything drawn "at the top of the screen" is a bug waiting for player 3.
 */

export function drawHud(
  ctx: CanvasRenderingContext2D, world: GameWorld, vp: Viewport, dpr: number,
): void {
  const p = world.players[vp.playerIndex];
  if (!p) return;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.beginPath();
  ctx.rect(vp.x, vp.y, vp.w, vp.h);
  ctx.clip();
  ctx.translate(vp.x, vp.y);

  const pad = 14;
  const barW = Math.min(210, vp.w * 0.32);

  ctx.font = "600 12px ui-monospace, monospace";
  ctx.textBaseline = "top";

  ctx.fillStyle = p.color;
  ctx.fillText(`P${p.id + 1}`, pad, pad);

  // Health
  const hx = pad + 26;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(hx, pad, barW, 10);
  ctx.fillStyle = p.downed ? "#ff5a5a" : "#8bff7a";
  ctx.fillRect(hx, pad, barW * (p.health / p.maxHealth), 10);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.strokeRect(hx + 0.5, pad + 0.5, barW, 10);

  // Ammo / reload
  ctx.fillStyle = "rgba(230,235,245,0.9)";
  const ammoText = p.reloadTimer > 0
    ? `${p.weapon.name}  RELOADING`
    : `${p.weapon.name}  ${p.ammo}/${p.weapon.magazine}`;
  ctx.fillText(ammoText, pad, pad + 18);

  if (p.reloadTimer > 0) {
    const t = 1 - p.reloadTimer / p.weapon.reloadTime;
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(pad, pad + 34, barW * t, 3);
  }

  // Stamina. Goes amber while draining and red once you have run yourself out.
  const staminaW = barW * 0.72;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(pad, pad + 42, staminaW, 5);
  ctx.fillStyle = p.exhausted
    ? "rgba(255,110,110,0.9)"
    : p.stamina < p.maxStamina ? "rgba(255,206,110,0.9)" : "rgba(120,200,255,0.8)";
  ctx.fillRect(pad, pad + 42, staminaW * (p.stamina / p.maxStamina), 5);

  if (Math.abs(p.lean) > 0.05) {
    ctx.fillStyle = "rgba(150,200,255,0.9)";
    ctx.fillText(p.lean < 0 ? "< LEAN" : "LEAN >", pad + 100, pad + 54);
  }

  if (p.stance !== "stand") {
    ctx.fillStyle = "rgba(255,206,110,0.9)";
    ctx.fillText(p.stance === "standUp" ? "GETTING UP" : "PRONE", pad, pad + 54);
  }

  ctx.fillStyle = "rgba(150,158,175,0.75)";
  ctx.fillText(`kills ${p.kills}`, pad, vp.h - pad - 14);

  if (p.downed) {
    ctx.textAlign = "center";
    ctx.font = "700 16px ui-monospace, monospace";
    ctx.fillStyle = "#ff7a7a";
    ctx.fillText("DOWNED", vp.w / 2, vp.h * 0.62);
    ctx.font = "600 12px ui-monospace, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText(
      `teammate: hold E / X to revive   ·   ${Math.ceil(p.bleedout)}s`,
      vp.w / 2, vp.h * 0.62 + 22,
    );
    ctx.textAlign = "left";
  }

  // Someone else needs help — tell this player where, since they may be off-screen.
  for (const other of world.players) {
    if (other === p || !other.downed) continue;
    const d = Math.hypot(other.x - p.x, other.y - p.y);
    ctx.fillStyle = other.color;
    ctx.fillText(`P${other.id + 1} DOWN  ${Math.round(d / 10)}m`, pad, pad + 56);
    break;
  }

  ctx.restore();
}

/** Thin dividers so four viewports do not bleed into one another. */
export function drawSplitBorders(
  ctx: CanvasRenderingContext2D, views: Viewport[], world: GameWorld, dpr: number,
): void {
  if (views.length < 2) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const vp of views) {
    const p = world.players[vp.playerIndex];
    ctx.strokeStyle = p ? `${p.color}55` : "rgba(255,255,255,0.15)";
    ctx.lineWidth = 2;
    ctx.strokeRect(vp.x + 1, vp.y + 1, vp.w - 2, vp.h - 2);
  }
  ctx.restore();
}

export function drawBanner(
  ctx: CanvasRenderingContext2D, text: string, alpha: number,
  width: number, height: number, dpr: number,
): void {
  if (alpha <= 0) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.textAlign = "center";
  ctx.font = "700 28px ui-monospace, monospace";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, width / 2, height * 0.42);
  ctx.restore();
}
