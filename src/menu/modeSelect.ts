import type { GameMode } from "../sim/world";
import { drawScrim, footer, MenuCursor, pulse, roundRect, title } from "./ui";

/**
 * Pick a mode. Two cards, because there are exactly two things this game is: an
 * authored campaign you work through, and an endless procedural one you survive.
 */
export interface ModeOption {
  mode: GameMode;
  name: string;
  blurb: string;
  detail: string;
  color: string;
}

export const MODES: ModeOption[] = [
  {
    mode: "story",
    name: "STORY",
    blurb: "Hand-made missions",
    detail: "Placed zombies, spawn zones, and a safe room to reach. Finish one to unlock the next.",
    color: "#8bff7a",
  },
  {
    mode: "survival",
    name: "SURVIVAL",
    blurb: "Endless, procedural",
    detail: "A new layout every run and a director that never stops. Last as long as you can.",
    color: "#ffd257",
  },
];

export class ModeSelect {
  index = 0;
  private cursor = new MenuCursor();

  reset(): void {
    this.index = 0;
  }

  /** Returns the chosen mode on the step it is confirmed. */
  update(moveX: number, confirm: boolean, dt: number): GameMode | null {
    const step = this.cursor.step(moveX, 0, dt);
    if (step.x !== 0) {
      this.index = (this.index + step.x + MODES.length) % MODES.length;
    }
    return confirm ? MODES[this.index].mode : null;
  }

  draw(
    ctx: CanvasRenderingContext2D, width: number, height: number, dpr: number,
    playerCount: number,
  ): void {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScrim(ctx, width, height);
    const p = pulse();

    title(
      ctx, "CHOOSE A MODE",
      `${playerCount} player${playerCount === 1 ? "" : "s"} ready`,
      width, height * 0.2,
    );

    const cardW = Math.min(320, (width - 120) / 2);
    const cardH = Math.min(230, height * 0.36);
    const gap = 26;
    const x0 = (width - (cardW * 2 + gap)) / 2;
    const y0 = height * 0.4;

    MODES.forEach((option, i) => {
      const x = x0 + i * (cardW + gap);
      const selected = i === this.index;

      roundRect(ctx, x, y0, cardW, cardH, 12);
      ctx.fillStyle = selected ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.02)";
      ctx.fill();
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.strokeStyle = selected ? option.color : "rgba(255,255,255,0.09)";
      ctx.stroke();

      const cx = x + cardW / 2;
      ctx.textAlign = "center";
      ctx.font = "700 26px ui-monospace, monospace";
      ctx.fillStyle = selected ? option.color : "rgba(150,160,180,0.55)";
      ctx.fillText(option.name, cx, y0 + cardH * 0.26);

      ctx.font = "600 12px ui-monospace, monospace";
      ctx.fillStyle = selected ? "rgba(225,232,245,0.9)" : "rgba(120,130,150,0.5)";
      ctx.fillText(option.blurb, cx, y0 + cardH * 0.44);

      ctx.font = "500 11px ui-monospace, monospace";
      ctx.fillStyle = selected ? "rgba(150,160,180,0.9)" : "rgba(110,120,140,0.4)";
      wrap(ctx, option.detail, cx, y0 + cardH * 0.62, cardW - 40, 15);

      if (selected) {
        ctx.font = "700 11px ui-monospace, monospace";
        ctx.fillStyle = `rgba(230,236,248,${0.4 + p * 0.5})`;
        ctx.fillText("PRESS START", cx, y0 + cardH - 22);
      }
    });

    footer(ctx, "MOVE  choose     START / ENTER  confirm     B / ESC  back to lobby",
      width, y0 + cardH + 44);
    ctx.restore();
  }
}

/** Tiny centred word-wrap — enough for two lines of blurb, not a text engine. */
function wrap(
  ctx: CanvasRenderingContext2D, text: string, cx: number, y: number,
  maxWidth: number, lineHeight: number,
): void {
  const words = text.split(" ");
  let line = "";
  let row = 0;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      ctx.fillText(line, cx, y + row * lineHeight);
      line = word;
      row++;
    } else {
      line = next;
    }
  }
  if (line) ctx.fillText(line, cx, y + row * lineHeight);
}
