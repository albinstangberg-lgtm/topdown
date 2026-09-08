import type { InputSource, InputState } from "./types";
import { clampMagnitude } from "../core/math";

const DEADZONE = 0.22;

function applyDeadzone(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y);
  if (len < DEADZONE) return [0, 0];
  // Rescale so the stick ramps from 0 at the deadzone edge instead of snapping to 0.22.
  const s = (len - DEADZONE) / (1 - DEADZONE) / len;
  return clampMagnitude(x * s, y * s, 1);
}

/** One gamepad = one player. Standard mapping: left stick move, right stick aim, RT fire. */
export class GamepadSource implements InputSource {
  readonly kind = "gamepad" as const;
  readonly id: string;
  readonly label: string;

  private prevFire = false;
  private prevDive = false;
  private prevReload = false;
  private prevInteract = false;
  private prevStart = false;
  private prevCancel = false;

  constructor(readonly index: number) {
    this.id = `pad${index}`;
    this.label = `Gamepad ${index + 1}`;
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    return pads[this.index] ?? null;
  }

  isConnected(): boolean {
    return this.pad() !== null;
  }

  sample(out: InputState): void {
    const gp = this.pad();
    if (!gp) {
      out.moveX = 0; out.moveY = 0;
      out.aimStrength = 0;
      out.fire = false; out.firePressed = false;
      out.sprint = false; out.divePressed = false; out.reloadPressed = false;
      out.lean = 0;
      out.interact = false; out.interactPressed = false;
      out.startPressed = false; out.cancelPressed = false;
      return;
    }

    const ax = gp.axes;
    [out.moveX, out.moveY] = applyDeadzone(ax[0] ?? 0, ax[1] ?? 0);

    // D-pad falls back into the movement vector when the stick is centred, so it works
    // for menus and for walking without either of them needing to know about it.
    if (out.moveX === 0 && out.moveY === 0) {
      const pad = gp.buttons;
      const dx = (pad[15]?.pressed ? 1 : 0) - (pad[14]?.pressed ? 1 : 0);
      const dy = (pad[13]?.pressed ? 1 : 0) - (pad[12]?.pressed ? 1 : 0);
      if (dx !== 0 || dy !== 0) [out.moveX, out.moveY] = clampMagnitude(dx, dy, 1);
    }

    const [rx, ry] = applyDeadzone(ax[2] ?? 0, ax[3] ?? 0);
    out.aimMode = "stick";
    if (rx !== 0 || ry !== 0) {
      // Direction and deflection are reported separately: the deflection is what makes
      // turning proportional, and normalising the vector would throw it away.
      const len = Math.hypot(rx, ry);
      out.aimX = rx / len;
      out.aimY = ry / len;
      out.aimStrength = Math.min(1, len);
    } else {
      out.aimX = 0;
      out.aimY = 0; // caller keeps the previous facing
      out.aimStrength = 0;
    }

    const btn = (i: number): boolean => gp.buttons[i]?.pressed ?? false;
    const rightTrigger = gp.buttons[7]?.value ?? 0;

    // LB and RB are the lean, so fire and sprint keep off the shoulders. Fire is the
    // trigger alone, which frees A for sprint.
    const fire = rightTrigger > 0.35;
    const sprint = btn(0) || btn(10);         // A or L3, held
    const dive = btn(1) || btn(6);            // B or LT, tapped
    const reload = btn(2);                    // X / square
    const interact = btn(3);                  // Y / triangle, held to revive
    const lean = (btn(5) ? 1 : 0) - (btn(4) ? 1 : 0);
    const start = btn(9) || btn(8);
    const cancel = btn(1);                    // B / circle

    out.fire = fire;
    out.firePressed = fire && !this.prevFire;
    out.sprint = sprint;
    out.divePressed = dive && !this.prevDive;
    out.reloadPressed = reload && !this.prevReload;
    out.lean = lean;
    out.interact = interact;
    out.interactPressed = interact && !this.prevInteract;
    out.startPressed = start && !this.prevStart;
    out.cancelPressed = cancel && !this.prevCancel;

    this.prevFire = fire;
    this.prevDive = dive;
    this.prevReload = reload;
    this.prevInteract = interact;
    this.prevStart = start;
    this.prevCancel = cancel;
  }
}
