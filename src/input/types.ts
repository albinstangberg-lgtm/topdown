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
  /** Held. Costs stamina, moves you faster, and is the only thing that drains it. */
  sprint: boolean;
  /** Tapped. Commits you to a dive that ends on the floor. */
  divePressed: boolean;
  /** Tapped. Tops the magazine up early, rather than waiting to run dry. */
  reloadPressed: boolean;
  interact: boolean;
  interactPressed: boolean;
  /** Used only by the join flow (START / Enter). */
  startPressed: boolean;
  /** Back out: leave the lobby, un-ready, close a menu. Escape or B. */
  cancelPressed: boolean;
}

export function emptyInput(): InputState {
  return {
    moveX: 0, moveY: 0,
    aimMode: "stick",
    aimX: 1, aimY: 0,
    aimStrength: 0,
    pointerX: 0, pointerY: 0,
    fire: false, firePressed: false,
    sprint: false, divePressed: false, reloadPressed: false,
    interact: false,
    interactPressed: false,
    startPressed: false,
    cancelPressed: false,
  };
}

/** A source produces one player's input. Implement this for any new device. */
export interface InputSource {
  readonly id: string;
  readonly kind: "keyboard" | "gamepad";
  /** Human-readable name, shown in the lobby so people know which slot is theirs. */
  readonly label: string;
  /** Called once per simulation step. Must fill `out` completely. */
  sample(out: InputState): void;
  /** True while the device still exists (a gamepad can be unplugged). */
  isConnected(): boolean;
}
