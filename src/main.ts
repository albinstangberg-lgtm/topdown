import { GameLoop } from "./core/loop";
import { InputManager } from "./input/manager";
import type { InputState } from "./input/types";
import { GameWorld } from "./sim/world";
import { parseLevelText, type LevelData } from "./world/level";
import { BUILTIN_LEVELS, PROCEDURAL, resolveLevel } from "./levels";
import type { Player } from "./sim/entities";
import { STEER_RATE, TURN_RATE, type AimCommand } from "./sim/player";
import { emptyInput } from "./input/types";
import { Camera, type CameraMode } from "./render/camera";
import { Renderer } from "./render/renderer";
import { layoutViewports, type Viewport } from "./render/viewport";
import { drawBanner, drawHud, drawSplitBorders } from "./render/hud";
import { DebugOverlay } from "./render/debug";

/**
 * Game shell: owns the loop, the input manager, the world, and one camera per player.
 * This is the only file that is allowed to know about all of them at once.
 */
export class Game {
  private readonly renderer: Renderer;
  private readonly input: InputManager;
  readonly world = new GameWorld();
  private readonly debug = new DebugOverlay();
  /** Public for the debug console and the smoke tests — one camera per viewport. */
  cameras: Camera[] = [];
  views: Viewport[] = [];
  private claimed = new Set<string>();
  private banner = { text: "", time: 0 };
  private levelIndex = 0;
  private cameraMode: CameraMode = "rotating";
  /** Reusable per-player command buffer — the sim sees this, not the raw device. */
  private readonly commands = new Map<number, InputState>();
  private readonly loop: GameLoop;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.input = new InputManager(canvas);

    // Level selection: ?level=corridors | showcase | procedural | draft (from the editor).
    const params = new URLSearchParams(location.search);
    const requestedLevel = params.get("level");
    let level: LevelData | null = null;
    try {
      level = resolveLevel(requestedLevel);
    } catch (err) {
      console.error(err);
    }
    if (!level && requestedLevel) {
      this.setBanner(`unknown level "${requestedLevel}" — loaded procedural`);
    }
    this.world = new GameWorld(level ?? undefined);
    const mode = params.get("camera");
    if (mode === "fixed" || mode === "rotating") this.cameraMode = mode;
    this.levelIndex = Math.max(0, BUILTIN_LEVELS.findIndex((l) => l.id === requestedLevel));

    this.addPlayerFor("kbm");

    // Dev affordance: ?players=4 fills the remaining slots with idle players so the
    // split-screen layout can be worked on without four pads plugged in.
    const requested = Number(params.get("players") ?? "1");
    for (let i = 1; i < Math.min(4, Math.max(1, requested)); i++) this.addPlayerFor(`dummy${i}`);

    window.addEventListener("resize", this.onResize);
    this.installLevelImport(canvas);
    window.addEventListener("keydown", (e) => {
      if (e.code === "F1") { e.preventDefault(); this.debug.toggle(); }
      if (e.code === "F2") { e.preventDefault(); this.debug.showCollision = !this.debug.showCollision; }
      if (e.code === "KeyR" && e.shiftKey) this.world.restart();
      if (e.code === "BracketLeft") this.cycleLevel(-1);
      if (e.code === "BracketRight") this.cycleLevel(1);
      if (e.code === "KeyC" && !e.ctrlKey && !e.metaKey) this.toggleCameraMode();
    });
    this.onResize();

    this.loop = new GameLoop({
      update: (dt) => this.update(dt),
      render: (alpha, frameDt) => this.render(alpha, frameDt),
    });
    this.loop.start();
  }

  /**
   * CORE 14c — getting a map into the game.
   *
   * Three ways in, all landing on the same importer: a URL parameter, a file dropped
   * on the window, or a grid pasted from the clipboard. The editor uses the first via
   * localStorage; a person with a map in a text file uses the other two.
   */
  private installLevelImport(canvas: HTMLCanvasElement): void {
    const stop = (e: Event): void => { e.preventDefault(); e.stopPropagation(); };

    window.addEventListener("dragover", stop);
    window.addEventListener("drop", (e) => {
      stop(e);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      file.text()
        .then((text) => this.loadLevelText(text, file.name.replace(/\.[^.]+$/, "")))
        .catch((err) => this.setBanner(`could not read ${file.name}: ${err}`));
    });

    window.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text");
      if (!text || !/[\[\d#.]/.test(text)) return;
      this.loadLevelText(text, "pasted");
    });

    canvas.title = "Drop or paste a map to load it";
  }

  /** Parse and hot-load a map. Returns the warnings so callers can surface them. */
  loadLevelText(text: string, name = "imported"): string[] {
    try {
      const { level, warnings } = parseLevelText(text, name);
      this.loadLevel(level);
      if (warnings.length > 0) {
        console.warn(`[level] ${level.name}:`, ...warnings);
        this.setBanner(`${level.name} — ${warnings[0]}`);
      }
      return warnings;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setBanner(message);
      console.error("[level]", err);
      return [message];
    }
  }

  loadLevel(level: LevelData): void {
    this.world.loadLevel(level);
    this.relayout();
  }

  /** `[` and `]` walk the built-in maps, with procedural as the last stop. */
  private cycleLevel(dir: number): void {
    const count = BUILTIN_LEVELS.length + 1;
    this.levelIndex = (this.levelIndex + dir + count) % count;
    const builtin = BUILTIN_LEVELS[this.levelIndex];
    const level = resolveLevel(builtin ? builtin.id : PROCEDURAL, (Date.now() & 0xffff) + 1);
    if (level) this.loadLevel(level);
  }

  private onResize = (): void => {
    this.renderer.resize();
    this.relayout();
  };

  private relayout(): void {
    this.views = layoutViewports(this.world.players.length, this.renderer.width, this.renderer.height);
    while (this.cameras.length < this.views.length) this.cameras.push(new Camera());
    this.cameras.length = Math.max(this.cameras.length, this.views.length);
    for (let i = 0; i < this.views.length; i++) {
      this.cameras[i].mode = this.cameraMode;
      const p = this.world.players[i];
      if (p) this.cameras[i].snapTo(p.x, p.y, p.facing);
    }
  }

  private addPlayerFor(sourceId: string): void {
    if (this.world.players.length >= 4) return;
    this.claimed.add(sourceId);
    this.world.addPlayer(sourceId);
    this.relayout();
  }

  private toggleCameraMode(): void {
    this.cameraMode = this.cameraMode === "rotating" ? "fixed" : "rotating";
    for (let i = 0; i < this.cameras.length; i++) {
      this.cameras[i].mode = this.cameraMode;
      const p = this.world.players[i];
      if (p) this.cameras[i].snapTo(p.x, p.y, p.facing);
    }
    this.setBanner(`camera: ${this.cameraMode}`);
  }

  private cameraFor(p: Player): { cam: Camera; vp: Viewport } | null {
    const index = this.world.players.indexOf(p);
    const vp = this.views[index];
    const cam = this.cameras[index];
    return vp && cam ? { cam, vp } : null;
  }

  /**
   * Movement is expressed in whatever direction the player is looking AT THE SCREEN.
   * With a fixed camera that is world space and nothing happens here; with a rotating
   * camera "up" means "the way the camera is facing", so the stick has to be rotated
   * into world space before the simulation sees it. Getting this wrong is the classic
   * rotating-camera bug where holding forward walks you sideways.
   */
  private inputOf = (p: Player): InputState => {
    const raw = this.input.get(p.sourceId);
    if (this.cameraMode !== "rotating") return raw;

    const view = this.cameraFor(p);
    if (!view) return raw;

    let cmd = this.commands.get(p.id);
    if (!cmd) { cmd = emptyInput(); this.commands.set(p.id, cmd); }
    Object.assign(cmd, raw);

    // Screen up is the camera's forward direction F; screen right is F turned 90.
    // moveY is positive DOWN the screen, hence the minus in front of it.
    const cos = Math.cos(view.cam.angle);
    const sin = Math.sin(view.cam.angle);
    cmd.moveX = -raw.moveX * sin - raw.moveY * cos;
    cmd.moveY = raw.moveX * cos - raw.moveY * sin;
    return cmd;
  };

  /**
   * The one place where presentation feeds back into the simulation.
   *
   * With a FIXED camera, aiming is absolute: the cursor or stick names a world
   * direction and the player snaps to it. That is only possible because the screen
   * never turns.
   *
   * With a ROTATING camera it cannot be: the camera follows your facing, so pointing
   * at a fixed world spot would move the spot, and you would spin forever. So aiming
   * becomes STEERING — the cursor's (or stick's) offset from straight-up on screen is
   * a turn command, and the camera converges when you point it dead ahead.
   */
  private resolveAim = (p: Player, input: InputState): AimCommand | null => {
    const view = this.cameraFor(p);

    if (this.cameraMode === "rotating") {
      if (!view) return null;
      const screenAngle = this.screenAimAngle(input, view.cam, view.vp);
      if (screenAngle === null) return { angle: p.facing, turnRate: STEER_RATE };
      // Screen angle is measured from straight up; the camera's angle is that direction.
      return { angle: view.cam.angle + screenAngle, turnRate: STEER_RATE };
    }

    if (input.aimMode === "stick") {
      if (input.aimX === 0 && input.aimY === 0) return null;
      return { angle: Math.atan2(input.aimY, input.aimX), turnRate: TURN_RATE };
    }
    if (!view) return null;
    const world = view.cam.screenToWorld(input.pointerX, input.pointerY, view.vp);
    const dx = world.x - p.x;
    const dy = world.y - p.y;
    if (dx * dx + dy * dy < 4) return null;
    return { angle: Math.atan2(dy, dx), turnRate: TURN_RATE };
  };

  /**
   * How far off straight-up the aim input is pointing, in radians. Both devices answer
   * the same question: a stick by its deflection, a mouse by where the cursor sits
   * relative to the player's anchor on screen. Null means "no input, hold this heading".
   */
  private screenAimAngle(input: InputState, cam: Camera, vp: Viewport): number | null {
    if (input.aimMode === "stick") {
      if (input.aimX === 0 && input.aimY === 0) return null;
      return Math.atan2(input.aimY, input.aimX) + Math.PI / 2;
    }
    const anchor = cam.anchorScreen(vp);
    const dx = input.pointerX - anchor.x;
    const dy = input.pointerY - anchor.y;
    // A dead zone around the player, or the cursor sitting on them spins the view.
    if (dx * dx + dy * dy < 40 * 40) return null;
    return Math.atan2(dy, dx) + Math.PI / 2;
  }

  private update(dt: number): void {
    this.input.update();

    // Drop-in co-op: any unclaimed pad that presses START/fire becomes a player.
    for (const src of this.input.pendingJoins(this.claimed)) {
      if (this.world.players.length >= 4) break;
      this.addPlayerFor(src.id);
    }

    this.world.update(dt, this.inputOf, this.resolveAim);
    this.drainEvents();
    if (this.banner.time > 0) this.banner.time -= dt;
  }

  private drainEvents(): void {
    for (const ev of this.world.events) {
      if (ev.kind === "kill" && ev.x !== undefined && ev.y !== undefined) {
        this.shakeNear(ev.x, ev.y, 0.35, 520);
      } else if (ev.kind === "playerDown") {
        this.shakeAll(0.6);
        if (ev.text) this.setBanner(ev.text);
      } else if (ev.kind === "wipe") {
        this.shakeAll(1);
        if (ev.text) this.setBanner(ev.text);
        this.relayout();
      } else if (ev.kind === "level" && ev.text) {
        this.setBanner(ev.text);
      } else if (ev.text) {
        this.setBanner(ev.text);
      }
    }
    this.world.events.length = 0;
  }

  private setBanner(text: string): void {
    this.banner.text = text;
    this.banner.time = 2.2;
  }

  private shakeAll(amount: number): void {
    for (const cam of this.cameras) cam.addShake(amount);
  }

  private shakeNear(x: number, y: number, amount: number, radius: number): void {
    for (let i = 0; i < this.views.length; i++) {
      const p = this.world.players[i];
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < radius) this.cameras[i].addShake(amount * (1 - d / radius));
    }
  }

  private render(alpha: number, frameDt: number): void {
    const { world, renderer } = this;
    if (this.views.length !== Math.max(1, world.players.length)) this.relayout();

    for (let i = 0; i < this.views.length; i++) {
      const vp = this.views[i];
      const p = world.players[vp.playerIndex];
      if (!p) continue;
      this.cameras[i].follow(
        p.x, p.y, p.facing, vp, world.map.worldWidth, world.map.worldHeight, frameDt,
      );
    }

    renderer.beginFrame();
    for (let i = 0; i < this.views.length; i++) {
      const vp = this.views[i];
      if (!world.players[vp.playerIndex]) continue;
      renderer.renderViewport(world, vp, this.cameras[i], alpha);
      this.debug.drawWorld(renderer.ctx, world, this.cameras[i], vp);
      drawHud(renderer.ctx, world, vp, renderer.dpr);
    }
    drawSplitBorders(renderer.ctx, this.views, world, renderer.dpr);

    if (this.banner.time > 0) {
      drawBanner(
        renderer.ctx, this.banner.text, Math.min(1, this.banner.time),
        renderer.width, renderer.height, renderer.dpr,
      );
    }
    this.debug.drawStats(renderer.ctx, this.loop, world, renderer.dpr);
  }
}

declare global {
  interface Window {
    /** Dev hook: poke at the live simulation from the console or a test script. */
    game: Game;
  }
}

const canvas = document.getElementById("game");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("#game canvas missing");
window.game = new Game(canvas);
