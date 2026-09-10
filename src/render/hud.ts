import { clockText, type GameWorld } from "../sim/world";
import type { Player } from "../sim/entities";
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

  // Ammo / reload. A melee weapon has no magazine, so it says so by saying nothing —
  // an ammo counter reading 0/0 on a crowbar looks like a bug.
  ctx.fillStyle = "rgba(230,235,245,0.9)";
  const ammoText = p.weapon.magazine <= 0
    ? `${p.weapon.name}  —`
    : p.reloadTimer > 0
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

  // Extraction. Shown to everyone, because it is a squad condition, not a personal one.
  const obj = world.objective;
  if (obj.kind === "signal" || obj.kind === "holdout" || obj.kind === "inbound") {
    drawFinale(ctx, world, vp, p);
  } else if (obj.kind === "reactor" || obj.kind === "sealed" || obj.kind === "unseal") {
    drawShipObjective(ctx, world, vp);
  } else if (obj.needed > 0 && obj.kind !== "none") {
    const stairs = obj.kind === "stairs";
    const standing = stairs ? world.map.isStairsAt(p.x, p.y) : world.map.isExitAt(p.x, p.y);
    const all = obj.onExit === obj.needed;
    ctx.textAlign = "center";
    ctx.font = "700 13px ui-monospace, monospace";
    ctx.fillStyle = all ? "#8bff7a" : standing ? "#ffd257" : "rgba(200,210,228,0.75)";
    const boarding = world.extraction.phase === "ready";
    const waiting = stairs ? "AT THE STAIRS" : boarding ? "ON BOARD" : "AT THE EXIT";
    ctx.fillText(
      all
        ? (stairs ? "MOVING UP…" : boarding ? "LIFTING OFF…" : "EXTRACTING…")
        : `SQUAD ${waiting}  ${obj.onExit}/${obj.needed}`,
      vp.w / 2, vp.h * 0.14,
    );
    if (obj.progress > 0) {
      const barW = Math.min(180, vp.w * 0.3);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(vp.w / 2 - barW / 2, vp.h * 0.14 + 12, barW, 5);
      ctx.fillStyle = stairs ? "#5ad2ff" : "#8bff7a";
      ctx.fillRect(vp.w / 2 - barW / 2, vp.h * 0.14 + 12, barW * obj.progress, 5);
    }
    ctx.textAlign = "left";
  }

  if (p.downed) {
    ctx.textAlign = "center";
    ctx.font = "700 16px ui-monospace, monospace";
    ctx.fillStyle = "#ff7a7a";
    ctx.fillText("DOWNED", vp.w / 2, vp.h * 0.62);
    ctx.font = "600 12px ui-monospace, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText(
      `teammate: hold F / Y to revive   ·   ${Math.ceil(p.bleedout)}s`,
      vp.w / 2, vp.h * 0.62 + 22,
    );
    ctx.textAlign = "left";
  }

  // What this player can do right now, if anything: read the terminal they are stood
  // on, seat a cell, work the door. Drawn low and near them rather than with the squad
  // objective, because a prompt is personal — only one player is stood on that tile.
  const prompt = world.devices.promptFor(p.id);
  if (prompt) {
    ctx.textAlign = "center";
    ctx.font = "700 12px ui-monospace, monospace";
    ctx.fillStyle = prompt.progress > 0 ? "#7affd2" : "rgba(220,230,245,0.85)";
    ctx.fillText(prompt.text, vp.w / 2, vp.h * 0.72);
    if (prompt.progress > 0) {
      const w = Math.min(150, vp.w * 0.26);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(vp.w / 2 - w / 2, vp.h * 0.72 + 10, w, 4);
      ctx.fillStyle = "#7affd2";
      ctx.fillRect(vp.w / 2 - w / 2, vp.h * 0.72 + 10, w * prompt.progress, 4);
    }
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

/**
 * The finale, in one place: light it, hold it, watch it come in. Deliberately the
 * loudest thing on the HUD — for two minutes the countdown IS the objective, and a
 * player who has to work out how long is left is a player looking at the wrong thing.
 */
function drawFinale(
  ctx: CanvasRenderingContext2D, world: GameWorld, vp: Viewport, p: Player,
): void {
  const obj = world.objective;
  const y = vp.h * 0.13;
  ctx.textAlign = "center";

  if (obj.kind === "signal") {
    const standing = world.map.isSignalAt(p.x, p.y);
    ctx.font = "700 13px ui-monospace, monospace";
    ctx.fillStyle = standing ? "#ffb45c" : "rgba(200,210,228,0.75)";
    ctx.fillText(standing ? "LIGHTING THE FLARE…" : "LIGHT THE FLARE", vp.w / 2, y);
    if (obj.progress > 0) {
      const barW = Math.min(180, vp.w * 0.3);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(vp.w / 2 - barW / 2, y + 12, barW, 5);
      ctx.fillStyle = "#ff8a4a";
      ctx.fillRect(vp.w / 2 - barW / 2, y + 12, barW * obj.progress, 5);
    }
    ctx.textAlign = "left";
    return;
  }

  if (obj.kind === "inbound") {
    ctx.font = "700 13px ui-monospace, monospace";
    ctx.fillStyle = "#8bff7a";
    ctx.fillText("HELICOPTER INBOUND", vp.w / 2, y);
    ctx.font = "700 22px ui-monospace, monospace";
    ctx.fillText(`${Math.ceil(obj.timeLeft)}`, vp.w / 2, y + 16);
    ctx.textAlign = "left";
    return;
  }

  // Holding. Under ten seconds the clock goes red and starts to pulse, because that
  // is the stretch where the director is at its worst.
  const urgent = obj.timeLeft <= 10;
  const beat = urgent ? 0.6 + 0.4 * Math.abs(Math.sin(performance.now() * 0.006)) : 1;
  ctx.font = "700 12px ui-monospace, monospace";
  ctx.fillStyle = "rgba(200,210,228,0.75)";
  ctx.fillText("HOLD THE ROOF", vp.w / 2, y);
  ctx.font = "700 26px ui-monospace, monospace";
  ctx.fillStyle = urgent ? `rgba(255,120,110,${beat})` : "#ffd257";
  ctx.fillText(clockText(obj.timeLeft), vp.w / 2, y + 14);

  const barW = Math.min(220, vp.w * 0.34);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(vp.w / 2 - barW / 2, y + 46, barW, 5);
  ctx.fillStyle = urgent ? "#ff6b6b" : "#ff8a4a";
  ctx.fillRect(vp.w / 2 - barW / 2, y + 46, barW * obj.progress, 5);
  ctx.textAlign = "left";
}

/**
 * The ship's objective chain: the reactor, and the door it opens. Same slot on the HUD
 * as the extraction finale, because at any moment exactly one of them is what the squad
 * is doing.
 */
function drawShipObjective(
  ctx: CanvasRenderingContext2D, world: GameWorld, vp: Viewport,
): void {
  const obj = world.objective;
  const y = vp.h * 0.13;
  ctx.textAlign = "center";

  if (obj.kind === "reactor") {
    ctx.font = "700 13px ui-monospace, monospace";
    ctx.fillStyle = "#5ad2ff";
    ctx.fillText("PRIME THE REACTOR", vp.w / 2, y);
    ctx.font = "700 20px ui-monospace, monospace";
    ctx.fillStyle = obj.onExit > 0 ? "#8bff7a" : "rgba(200,210,228,0.8)";
    ctx.fillText(`${obj.onExit} / ${obj.needed} CELLS`, vp.w / 2, y + 16);
    ctx.textAlign = "left";
    return;
  }

  if (obj.kind === "sealed") {
    ctx.font = "700 13px ui-monospace, monospace";
    ctx.fillStyle = world.power.on ? "#ffd257" : "rgba(255,120,110,0.9)";
    ctx.fillText(
      world.power.on ? "HOLD USE — OVERRIDE THE BLAST DOOR" : "BRIDGE SEALED — NO MAIN POWER",
      vp.w / 2, y,
    );
    if (obj.progress > 0) {
      const w = Math.min(180, vp.w * 0.3);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(vp.w / 2 - w / 2, y + 12, w, 5);
      ctx.fillStyle = "#ffd257";
      ctx.fillRect(vp.w / 2 - w / 2, y + 12, w * obj.progress, 5);
    }
    ctx.textAlign = "left";
    return;
  }

  // Unsealing: ninety seconds you do not control, so the clock IS the objective.
  const urgent = obj.timeLeft <= 15;
  const beat = urgent ? 0.6 + 0.4 * Math.abs(Math.sin(performance.now() * 0.006)) : 1;
  ctx.font = "700 12px ui-monospace, monospace";
  ctx.fillStyle = "rgba(200,210,228,0.75)";
  ctx.fillText("HOLD THE CATWALK", vp.w / 2, y);
  ctx.font = "700 26px ui-monospace, monospace";
  ctx.fillStyle = urgent ? `rgba(255,120,110,${beat})` : "#ffd257";
  ctx.fillText(clockText(obj.timeLeft), vp.w / 2, y + 14);
  const w = Math.min(220, vp.w * 0.34);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(vp.w / 2 - w / 2, y + 46, w, 5);
  ctx.fillStyle = urgent ? "#ff6b6b" : "#ffa54a";
  ctx.fillRect(vp.w / 2 - w / 2, y + 46, w * obj.progress, 5);
  ctx.textAlign = "left";
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

/**
 * A crew log, drawn full width across the bottom of the screen rather than per viewport.
 * Deliberately the one exception to "nothing at the top of the screen": a log is a piece
 * of the story that the whole couch reads at once, and four copies of the same paragraph
 * in four quadrants is worse for everyone.
 */
export function drawLog(
  ctx: CanvasRenderingContext2D, text: string, alpha: number,
  width: number, height: number, dpr: number,
): void {
  if (alpha <= 0) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = Math.min(1, alpha);

  ctx.font = "500 13px ui-monospace, monospace";
  const maxW = Math.min(760, width - 80);
  const lines = wrap(ctx, text, maxW);
  const lineH = 19;
  const boxH = lines.length * lineH + 34;
  const x = (width - maxW) / 2 - 16;
  const y = height - boxH - 46;

  ctx.fillStyle = "rgba(6,10,12,0.86)";
  ctx.fillRect(x, y, maxW + 32, boxH);
  ctx.strokeStyle = "rgba(122,255,210,0.45)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 0.5, y + 0.5, maxW + 31, boxH - 1);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(122,255,210,0.75)";
  ctx.font = "700 11px ui-monospace, monospace";
  ctx.fillText("// CREW LOG", x + 16, y + 12);
  ctx.font = "500 13px ui-monospace, monospace";
  ctx.fillStyle = "rgba(214,232,228,0.95)";
  lines.forEach((line, i) => ctx.fillText(line, x + 16, y + 30 + i * lineH));
  ctx.restore();
}

/** Greedy word wrap against the measured width. Enough for a paragraph of log text. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
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
