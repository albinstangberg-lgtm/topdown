/**
 * CORE 2 — Device-agnostic input.
 *
 * Nothing in the simulation is allowed to know about keyboards, mice or gamepads.
 * A player consumes an `InputState`; where it came from is the input layer's problem.
 * This is what makes local co-op cheap: adding a player is binding a second source.
 */

export type AimMode = "pointer" | "stick";

export interface InputState {
  /** Movement vector, magnitude clamped to 1. */
  moveX: number;
  moveY: number;

  aimMode: AimMode;
  /** Stick aim: unit direction. Zero when the stick is centred. */
  aimX: number;
  aimY: number;
  /**
   * How far the aim device is deflected, 0..1, AFTER the deadzone rescale. Direction
   * and deflection are separate because a rotating camera turns at a rate rather than
   * snapping to an angle — a nudged stick should scan, a slammed one should spin.
   *
   * Pointer sources leave this at 0: their deflection is the cursor's distance from the
   * player on screen, which only the camera can answer, so the game shell fills it in.
   */
  aimStrength: number;
  /** Pointer aim: position in CSS pixels relative to the canvas. */
  pointerX: number;
  pointerY: number;

  fire: boolean;
  firePressed: boolean;
  dash: boolean;
  dashPressed: boolean;
  interact: boolean;
  interactPressed: boolean;
  /** Used only by the join flow (START / Enter). */
  startPressed: boolean;
}

export function emptyInput(): InputState {
  return {
    moveX: 0, moveY: 0,
    aimMode: "stick",
    aimX: 1, aimY: 0,
    aimStrength: 0,
    pointerX: 0, pointerY: 0,
    fire: false, firePressed: false,
    dash: false, dashPressed: false,
    interact: false,
    interactPressed: false,
    startPressed: false,
  };
}

/** A source produces one player's input. Implement this for any new device. */
export interface InputSource {
  readonly id: string;
  readonly kind: "keyboard" | "gamepad";
  /** Called once per simulation step. Must fill `out` completely. */
  sample(out: InputState): void;
  /** True while the device still exists (a gamepad can be unplugged). */
  isConnected(): boolean;
}
