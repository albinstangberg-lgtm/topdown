import type { InputManager } from "../input/manager";
import { PLAYER_COLORS } from "../sim/player";

/**
 * CORE 16 — The lobby.
 *
 * The join flow for local co-op, and the one screen that has to work before anybody
 * has agreed which controller they are holding. The rules are deliberately the ones
 * every couch game already taught people:
 *
 *   press START / ENTER on an unclaimed device  -> you take the next free slot
 *   press it again                              -> you are ready
 *   press B / ESCAPE                            -> un-ready, then leave
 *   everyone in the lobby is ready              -> the match starts
 *
 * It knows nothing about the simulation: it hands back a list of device ids and the
 * game shell binds them to players. That is the same seam drop-in join uses mid-match.
 */

export const MAX_PLAYERS = 4;

export interface LobbySlot {
  sourceId: string;
  label: string;
  kind: "keyboard" | "gamepad";
  ready: boolean;
}

export class Lobby {
  readonly slots: LobbySlot[] = [];

  reset(): void {
    this.slots.length = 0;
  }

  /** Returns true on the step the match should begin. */
  update(input: InputManager): boolean {
    for (const src of input.list()) {
      const state = input.get(src.id);
      const index = this.slots.findIndex((s) => s.sourceId === src.id);

      // A pad pulled out of the machine should not hold a slot hostage.
      if (!src.isConnected()) {
        if (index >= 0) this.slots.splice(index, 1);
        continue;
      }

      if (index < 0) {
        if (state.startPressed && this.slots.length < MAX_PLAYERS) {
          this.slots.push({ sourceId: src.id, label: src.label, kind: src.kind, ready: false });
        }
        continue;
      }

      const slot = this.slots[index];
      if (state.startPressed) slot.ready = !slot.ready;
      else if (state.cancelPressed) {
        // One press un-readies, a second one leaves. Nobody drops out by accident.
        if (slot.ready) slot.ready = false;
        else this.slots.splice(index, 1);
      }
    }

    return this.slots.length > 0 && this.slots.every((s) => s.ready);
  }

  draw(
    ctx: CanvasRenderingContext2D, width: number, height: number, dpr: number,
    levelName: string, cameraMode: string,
  ): void {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Scrim, so the level drifting behind stays atmosphere and not noise. A little
    // darker through the middle band, where all the text lives.
    ctx.fillStyle = "rgba(6,7,12,0.74)";
    ctx.fillRect(0, 0, width, height);
    const veil = ctx.createLinearGradient(0, 0, 0, height);
    veil.addColorStop(0, "rgba(6,7,12,0)");
    veil.addColorStop(0.28, "rgba(6,7,12,0.55)");
    veil.addColorStop(0.75, "rgba(6,7,12,0.55)");
    veil.addColorStop(1, "rgba(6,7,12,0)");
    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, width, height);

    const pulse = 0.55 + 0.45 * Math.sin(performance.now() * 0.005);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const titleSize = Math.min(72, Math.max(34, width * 0.062));
    ctx.font = `700 ${titleSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    setSpacing(ctx, "0.22em");
    ctx.fillStyle = "#f2f4f8";
    ctx.fillText("TOPDOWN", width / 2, height * 0.2);
    setSpacing(ctx, "0.08em");

    ctx.font = "600 13px ui-monospace, monospace";
    ctx.fillStyle = "#79839c";
    ctx.fillText("co-op in the dark  ·  1-4 players", width / 2, height * 0.2 + titleSize * 0.78);

    // --- slots ---------------------------------------------------------------
    const cardW = Math.min(210, (width - 80) / MAX_PLAYERS - 14);
    const cardH = Math.min(150, height * 0.24);
    const gap = 14;
    const totalW = cardW * MAX_PLAYERS + gap * (MAX_PLAYERS - 1);
    const x0 = (width - totalW) / 2;
    const y0 = height * 0.44;
    // Only the first empty slot advertises itself, so four cards do not all shout.
    const nextEmpty = this.slots.length;

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const x = x0 + i * (cardW + gap);
      const slot = this.slots[i];
      const color = PLAYER_COLORS[i % PLAYER_COLORS.length];

      ctx.save();
      roundRect(ctx, x, y0, cardW, cardH, 10);
      ctx.fillStyle = slot ? "rgba(255,255,255,0.045)" : "rgba(255,255,255,0.02)";
      ctx.fill();
      ctx.lineWidth = 2;
      if (slot) ctx.strokeStyle = slot.ready ? color : `${color}88`;
      else ctx.strokeStyle = i === nextEmpty ? `rgba(140,150,175,${0.3 + pulse * 0.5})` : "rgba(255,255,255,0.07)";
      if (!slot) ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.restore();

      const cx = x + cardW / 2;
      ctx.font = "700 20px ui-monospace, monospace";
      ctx.fillStyle = slot ? color : "rgba(120,130,150,0.5)";
      ctx.fillText(`P${i + 1}`, cx, y0 + cardH * 0.24);

      if (slot) {
        ctx.font = "600 11px ui-monospace, monospace";
        ctx.fillStyle = "rgba(216,222,235,0.85)";
        ctx.fillText(slot.label, cx, y0 + cardH * 0.52);

        ctx.font = "700 12px ui-monospace, monospace";
        if (slot.ready) {
          ctx.fillStyle = "#8bff7a";
          ctx.fillText("READY", cx, y0 + cardH * 0.76);
        } else {
          ctx.fillStyle = `rgba(230,236,248,${0.35 + pulse * 0.45})`;
          ctx.fillText(startLabel(slot.kind), cx, y0 + cardH * 0.76);
          ctx.font = "600 10px ui-monospace, monospace";
          ctx.fillStyle = "rgba(120,130,150,0.7)";
          ctx.fillText("to ready up", cx, y0 + cardH * 0.9);
        }
      } else {
        ctx.font = "600 11px ui-monospace, monospace";
        ctx.fillStyle = i === nextEmpty
          ? `rgba(216,222,235,${0.35 + pulse * 0.5})`
          : "rgba(120,130,150,0.35)";
        ctx.fillText("PRESS START", cx, y0 + cardH * 0.55);
        ctx.font = "600 10px ui-monospace, monospace";
        ctx.fillStyle = "rgba(120,130,150,0.5)";
        ctx.fillText("or ENTER", cx, y0 + cardH * 0.72);
      }
    }

    // --- footer --------------------------------------------------------------
    const footY = y0 + cardH + 46;
    ctx.font = "600 12px ui-monospace, monospace";
    if (this.slots.length === 0) {
      ctx.fillStyle = `rgba(230,236,248,${0.45 + pulse * 0.4})`;
      ctx.fillText("PRESS START ON A CONTROLLER, OR ENTER ON THE KEYBOARD", width / 2, footY);
    } else if (this.slots.every((s) => s.ready)) {
      ctx.fillStyle = "#8bff7a";
      ctx.fillText("STARTING…", width / 2, footY);
    } else {
      ctx.fillStyle = "rgba(150,160,180,0.85)";
      const waiting = this.slots.filter((s) => !s.ready).length;
      ctx.fillText(
        `WAITING ON ${waiting} PLAYER${waiting === 1 ? "" : "S"}  ·  MORE CAN STILL JOIN`,
        width / 2, footY,
      );
    }

    ctx.font = "600 11px ui-monospace, monospace";
    ctx.fillStyle = "rgba(105,114,135,0.9)";
    ctx.fillText(
      `[ ]  map: ${levelName}     C  camera: ${cameraMode}     B / ESC  back out`,
      width / 2, footY + 26,
    );

    ctx.restore();
  }
}

function startLabel(kind: "keyboard" | "gamepad"): string {
  return kind === "keyboard" ? "PRESS ENTER" : "PRESS START";
}

/** letterSpacing is Chromium-only and silently ignored elsewhere — worth it, not required. */
function setSpacing(ctx: CanvasRenderingContext2D, value: string): void {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ("letterSpacing" in c) c.letterSpacing = value;
}

function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}
