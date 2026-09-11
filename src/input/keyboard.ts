import type { InputSource, InputState } from "./types";
import { clampMagnitude } from "../core/math";

/** Keyboard + mouse. Always player 1's default source on desktop. */
export class KeyboardMouseSource implements InputSource {
  readonly id = "kbm";
  readonly kind = "keyboard" as const;
  readonly label = "Keyboard + Mouse";

  private keys = new Set<string>();
  /**
   * Keys that went down since the last sample, even if they are already back up.
   * Input is sampled at 60Hz but key events arrive whenever they arrive — without a
   * latch, a tap that starts and ends between two samples is silently dropped.
   */
  private tapped = new Set<string>();
  private mouseDown = false;
  private mouseTapped = false;
  private px = 0;
  private py = 0;

  // Edge tracking lives in the source so the sim only ever sees clean booleans.
  private prevFire = false;
  private prevDive = false;
  private prevReload = false;
  private prevInteract = false;
  private prevItem = false;
  private prevLight = false;
  private prevStart = false;
  private prevCancel = false;

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
    this.tapped.add(e.code);
    // Stop the page scrolling out from under the game.
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent): void => { this.keys.delete(e.code); };
  private onBlur = (): void => {
    this.keys.clear();
    this.tapped.clear();
    this.mouseDown = false;
    this.mouseTapped = false;
  };

  private onMouseMove = (e: MouseEvent): void => {
    const r = this.canvas.getBoundingClientRect();
    this.px = e.clientX - r.left;
    this.py = e.clientY - r.top;
  };
  private onMouseDown = (): void => { this.mouseDown = true; this.mouseTapped = true; };
  private onMouseUp = (): void => { this.mouseDown = false; };

  isConnected(): boolean { return true; }

  /** Exposed so the debug overlay and the join prompt can read raw keys. */
  isDown(code: string): boolean { return this.keys.has(code); }

  /** Held now, or tapped since the last sample. Use for anything edge-triggered. */
  private hit(code: string): boolean { return this.keys.has(code) || this.tapped.has(code); }

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
    // Deflection for a cursor is its distance from the player on screen, which needs
    // the camera — the game shell fills it in.
    out.aimStrength = 0;

    // Movement reads held keys only; everything edge-triggered reads the latch too.
    const fire = this.mouseDown || this.mouseTapped || this.hit("Space");
    const sprint = k.has("ShiftLeft") || k.has("ShiftRight");
    const dive = this.hit("ControlLeft") || this.hit("ControlRight") || this.hit("KeyC");
    // Shift+R restarts the level, so a shifted R is not a reload.
    const shifted = k.has("ShiftLeft") || k.has("ShiftRight");
    const reload = this.hit("KeyR") && !shifted;
    const interact = k.has("KeyF");
    const item = k.has("KeyG");
    const light = this.hit("KeyT");
    const lean = (k.has("KeyE") ? 1 : 0) - (k.has("KeyQ") ? 1 : 0);
    const start = this.hit("Enter") || this.hit("NumpadEnter");
    const cancel = this.hit("Escape") || this.hit("Backspace");

    out.fire = fire;
    out.firePressed = fire && !this.prevFire;
    out.sprint = sprint;
    out.divePressed = dive && !this.prevDive;
    out.reloadPressed = reload && !this.prevReload;
    out.lean = lean;
    out.interact = interact;
    out.interactPressed = interact && !this.prevInteract;
    out.item = item;
    out.itemPressed = item && !this.prevItem;
    out.lightPressed = light && !this.prevLight;
    out.startPressed = start && !this.prevStart;
    out.cancelPressed = cancel && !this.prevCancel;

    this.prevFire = fire;
    this.prevDive = dive;
    this.prevReload = reload;
    this.prevInteract = interact;
    this.prevItem = item;
    this.prevLight = light;
    this.prevStart = start;
    this.prevCancel = cancel;

    this.tapped.clear();
    this.mouseTapped = false;
  }
}
