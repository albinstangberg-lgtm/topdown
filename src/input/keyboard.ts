import type { InputSource, InputState } from "./types";
import { clampMagnitude } from "../core/math";

/** Keyboard + mouse. Always player 1's default source on desktop. */
export class KeyboardMouseSource implements InputSource {
  readonly id = "kbm";
  readonly kind = "keyboard" as const;

  private keys = new Set<string>();
  private mouseDown = false;
  private px = 0;
  private py = 0;

  // Edge tracking lives in the source so the sim only ever sees clean booleans.
  private prevFire = false;
  private prevDash = false;
  private prevInteract = false;
  private prevStart = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    canvas.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
    // Stop the page scrolling out from under the game.
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent): void => { this.keys.delete(e.code); };
  private onBlur = (): void => { this.keys.clear(); this.mouseDown = false; };

  private onMouseMove = (e: MouseEvent): void => {
    const r = this.canvas.getBoundingClientRect();
    this.px = e.clientX - r.left;
    this.py = e.clientY - r.top;
  };
  private onMouseDown = (): void => { this.mouseDown = true; };
  private onMouseUp = (): void => { this.mouseDown = false; };

  isConnected(): boolean { return true; }

  /** Exposed so the debug overlay and the join prompt can read raw keys. */
  isDown(code: string): boolean { return this.keys.has(code); }

  sample(out: InputState): void {
    const k = this.keys;
    let mx = 0;
    let my = 0;
    if (k.has("KeyA") || k.has("ArrowLeft")) mx -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) mx += 1;
    if (k.has("KeyW") || k.has("ArrowUp")) my -= 1;
    if (k.has("KeyS") || k.has("ArrowDown")) my += 1;
    [out.moveX, out.moveY] = clampMagnitude(mx, my, 1);

    out.aimMode = "pointer";
    out.pointerX = this.px;
    out.pointerY = this.py;
    out.aimX = 0;
    out.aimY = 0;

    const fire = this.mouseDown || k.has("Space");
    const dash = k.has("ShiftLeft") || k.has("ShiftRight");
    const interact = k.has("KeyE");
    const start = k.has("Enter");

    out.fire = fire;
    out.firePressed = fire && !this.prevFire;
    out.dash = dash;
    out.dashPressed = dash && !this.prevDash;
    out.interact = interact;
    out.interactPressed = interact && !this.prevInteract;
    out.startPressed = start && !this.prevStart;

    this.prevFire = fire;
    this.prevDash = dash;
    this.prevInteract = interact;
    this.prevStart = start;
  }
}
