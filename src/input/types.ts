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
