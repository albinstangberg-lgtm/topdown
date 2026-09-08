import { KeyboardMouseSource } from "./keyboard";
import { GamepadSource } from "./gamepad";
import { emptyInput, type InputSource, type InputState } from "./types";

/**
 * Owns every input device, samples them once per simulation step and hands out
 * immutable-ish snapshots by source id. Also runs device discovery, which is how
 * players 2-4 drop in: plug a pad, press START.
 */
export class InputManager {
  readonly keyboard: KeyboardMouseSource;
  private sources = new Map<string, InputSource>();
  private states = new Map<string, InputState>();

  constructor(canvas: HTMLCanvasElement) {
    this.keyboard = new KeyboardMouseSource(canvas);
    this.add(this.keyboard);
    window.addEventListener("gamepadconnected", this.discoverGamepads);
    window.addEventListener("gamepaddisconnected", this.discoverGamepads);
    this.discoverGamepads();
  }

  private add(src: InputSource): void {
    this.sources.set(src.id, src);
    this.states.set(src.id, emptyInput());
  }

  private discoverGamepads = (): void => {
    const pads = navigator.getGamepads?.() ?? [];
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad) continue;
      const id = `pad${i}`;
      if (!this.sources.has(id)) this.add(new GamepadSource(i));
    }
  };

  /** Call once per simulation step, before anything reads input. */
  update(): void {
    this.discoverGamepads();
    for (const [id, src] of this.sources) {
      const state = this.states.get(id)!;
      src.sample(state);
    }
  }

  get(id: string): InputState {
    return this.states.get(id) ?? emptyInput();
  }

  list(): InputSource[] {
    return [...this.sources.values()];
  }
}
