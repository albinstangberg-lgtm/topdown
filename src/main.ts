import { GameLoop } from "./core/loop";
import { InputManager } from "./input/manager";
import type { InputState } from "./input/types";
import { GameWorld } from "./sim/world";
import { parseLevelText, type LevelData } from "./world/level";
import { BUILTIN_LEVELS, PROCEDURAL, resolveLevel } from "./levels";
import type { Player } from "./sim/entities";
import { STEER_RATE, TURN_RATE, WEAPON_RAISE_THRESHOLD, type AimCommand } from "./sim/player";
import { clamp, damp } from "./core/math";
import { emptyInput } from "./input/types";
import { Camera, type CameraMode } from "./render/camera";
import { Renderer } from "./render/renderer";
import { layoutViewports, type Viewport } from "./render/viewport";
import { drawBanner, drawHud, drawSplitBorders } from "./render/hud";
import { DebugOverlay } from "./render/debug";
import { Lobby, MAX_PLAYERS } from "./menu/lobby";
import { ModeSelect } from "./menu/modeSelect";
import { MissionSelect } from "./menu/missionSelect";
import {
  CAMPAIGN, floorCount, loadProgress, missionLevel, saveProgress, type Mission,
} from "./campaign/campaign";
import type { GameMode } from "./sim/world";
import { computeVisibility, makeLight } from "./vision/visibility";

/** Cursor distance from the player, in CSS pixels, below which steering is neutral. */
const POINTER_DEADZONE = 40;
/** Cursor distance at which steering is at full rate, as a fraction of viewport height. */
const POINTER_FULL_FRACTION = 0.35;
/**
 * Response curve on deflection. 1 is linear; above 1 gives finer control near centre,
 * which is what you want when the same stick has to both scan a room and spin you round.
 */
const STEER_RESPONSE = 1.5;

/** How long the menu backdrop lingers on one part of the level before moving on. */
const MENU_PAN_SECONDS = 9;
/** World units visible vertically behind the menu — wider than gameplay, on purpose. */
const MENU_VIEW_HEIGHT = 900;

/**
 * Where the shell is. Everything it does branches on exactly this:
 *   lobby    — devices claim slots and ready up
 *   mode     — story or survival
 *   missions — the campaign map, returned to after every mission
 *   playing  — a match is running
 */
export type Phase = "lobby" | "mode" | "missions" | "playing";

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
  private banner = { text: "", time: 0 };
  private levelIndex = 0;
  private cameraMode: CameraMode = "rotating";
  /** Reusable per-player command buffer — the sim sees this, not the raw device. */
  private readonly commands = new Map<number, InputState>();
  private readonly loop: GameLoop;

  /** Public so the smoke tests and the debug console can see where the shell is. */
  phase: Phase = "lobby";
  readonly lobby = new Lobby();
  readonly modeSelect = new ModeSelect();
  readonly missionSelect = new MissionSelect(CAMPAIGN);
  /** Device ids that came out of the lobby, in slot order. */
  private roster: string[] = [];
  readonly completed = loadProgress(CAMPAIGN);
  private activeMission: Mission | null = null;
  /** Which floor of the active mission is loaded, 0-based. */
  private activeFloor = 0;
  private readonly menuCam = new Camera();
  private readonly menuLight = makeLight("#ffe0a8", Math.PI, 760, 0.9);
  private readonly menuFocus = { x: 0, y: 0 };
  private readonly menuDest = { x: 0, y: 0 };
  private menuPanTimer = 0;

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

    // Dev affordance: ?players=N skips the lobby and starts with N players, the extra
    // ones idle. Keeps split-screen work (and the tests) from going through the menu.
    const requestedPlayers = params.get("players");
    if (requestedPlayers !== null) {
      const n = clamp(Number(requestedPlayers) || 1, 1, MAX_PLAYERS);
      this.roster = ["kbm"];
      for (let i = 1; i < n; i++) this.roster.push(`dummy${i}`);

      const missionId = params.get("mission");
      const mission = missionId
        ? CAMPAIGN.missions.find((m) => m.id === missionId) ?? null
        : null;
      if (mission) this.launchMission(mission);
      else this.beginMatch(level ?? undefined, "survival");
    } else {
      this.relayout();
    }

    window.addEventListener("resize", this.onResize);
    this.installLevelImport(canvas);
    window.addEventListener("keydown", (e) => {
      if (e.code === "F1") { e.preventDefault(); this.debug.toggle(); }
      if (e.code === "F2") { e.preventDefault(); this.debug.showCollision = !this.debug.showCollision; }
      if (e.code === "F3") { e.preventDefault(); this.debug.showFlow = !this.debug.showFlow; }
      if (e.code === "KeyR" && e.shiftKey) this.world.restart();
      const cycleAllowed = this.phase === "lobby" ||
        (this.phase === "playing" && this.world.mode === "survival");
      if (e.code === "BracketLeft" && cycleAllowed) this.cycleLevel(-1);
      if (e.code === "BracketRight" && cycleAllowed) this.cycleLevel(1);
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
    if (!level) return;
    this.loadLevel(level);
    // The old pan target belongs to the old map.
    this.menuFocus.x = 0; this.menuFocus.y = 0;
    this.menuDest.x = 0; this.menuDest.y = 0;
    this.menuPanTimer = 0;
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
    if (this.world.players.length >= MAX_PLAYERS) return;
    this.world.addPlayer(sourceId);
    this.relayout();
  }

  /** Players are created once, on the first match, then reused across missions. */
  private ensurePlayers(): void {
    if (this.world.players.length > 0) return;
    for (const id of this.roster) this.addPlayerFor(id);
  }

  private beginMatch(level: LevelData | undefined, mode: GameMode): void {
    this.world.mode = mode;
    this.ensurePlayers();
    if (level) this.loadLevel(level);
    else this.world.restart();
    this.phase = "playing";
    this.relayout();
    this.renderer.ambientLights = [];
    const hint = document.getElementById("boot");
    if (hint) { hint.hidden = false; hint.classList.add("show"); }
  }

  private launchMission(mission: Mission): void {
    this.activeMission = mission;
    this.activeFloor = 0;
    this.beginMatch(missionLevel(mission, 0), "story");
    if (floorCount(mission) > 1) this.setBanner(`FLOOR 1 / ${floorCount(mission)}`);
  }

  /**
   * Up a floor. The squad carries its health, ammo and stamina with it — a building is
   * one continuous run, so the stairs are a checkpoint in tension, not in condition.
   */
  private advanceFloor(): void {
    const mission = this.activeMission;
    if (!mission) return;
    this.activeFloor++;
    if (this.activeFloor >= floorCount(mission)) {
      this.completeMission();
      return;
    }
    this.world.loadLevel(missionLevel(mission, this.activeFloor), { keepSquad: true });
    this.relayout();
    this.setBanner(`FLOOR ${this.activeFloor + 1} / ${floorCount(mission)}`);
  }

  private completeMission(): void {
    if (this.activeMission) {
      this.completed.add(this.activeMission.id);
      saveProgress(CAMPAIGN, this.completed);
    }
    this.returnToMissions("MISSION COMPLETE");
  }

  /** Back to the campaign map after a mission ends, won or lost. */
  private returnToMissions(notice: string): void {
    this.missionSelect.setNotice(notice);
    this.missionSelect.focusNext(this.completed);
    this.activeMission = null;
    this.activeFloor = 0;
    this.phase = "missions";
  }

  /**
   * Menus are driven by everyone in the roster, not just player one — on a couch that
   * is what people expect, and it means a keyboard-less player can still navigate.
   */
  private menuInput(): { x: number; y: number; confirm: boolean; cancel: boolean } {
    let x = 0;
    let y = 0;
    let confirm = false;
    let cancel = false;
    const ids = this.roster.length > 0 ? this.roster : ["kbm"];
    for (const id of ids) {
      const state = this.input.get(id);
      if (Math.abs(state.moveX) > Math.abs(x)) x = state.moveX;
      if (Math.abs(state.moveY) > Math.abs(y)) y = state.moveY;
      if (state.startPressed) confirm = true;
      if (state.cancelPressed) cancel = true;
    }
    return { x, y, confirm, cancel };
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
      const aim = this.screenAim(input, view.cam, view.vp);
      // No deflection: hold this heading rather than drifting, weapon at rest.
      if (aim === null) return { angle: p.facing, turnRate: 0, raise: false };
      // Screen angle is measured from straight up; the camera's angle is that direction.
      // Turn rate scales with deflection, so a nudge scans and a full push spins, and
      // the same deflection decides whether the weapon comes up.
      return {
        angle: view.cam.angle + aim.angle,
        turnRate: STEER_RATE * Math.pow(aim.strength, STEER_RESPONSE),
        raise: aim.strength >= WEAPON_RAISE_THRESHOLD,
      };
    }

    // Fixed camera keeps absolute aiming, which is a permanently shouldered weapon.
    if (input.aimMode === "stick") {
      if (input.aimX === 0 && input.aimY === 0) return null;
      return { angle: Math.atan2(input.aimY, input.aimX), turnRate: TURN_RATE, raise: true };
    }
    if (!view) return null;
    const world = view.cam.screenToWorld(input.pointerX, input.pointerY, view.vp);
    const dx = world.x - p.x;
    const dy = world.y - p.y;
    if (dx * dx + dy * dy < 4) return null;
    return { angle: Math.atan2(dy, dx), turnRate: TURN_RATE, raise: true };
  };

  /**
   * The aim input as a steering command: which way off straight-up it points, and how
   * hard it is pushed. Both devices answer the same two questions — a stick by its
   * angle and deflection, a mouse by where the cursor sits relative to the player's
   * anchor and how far away it is. Null means "no input, hold this heading".
   */
  private screenAim(
    input: InputState, cam: Camera, vp: Viewport,
  ): { angle: number; strength: number } | null {
    if (input.aimMode === "stick") {
      if (input.aimStrength <= 0) return null;
      return {
        angle: Math.atan2(input.aimY, input.aimX) + Math.PI / 2,
        strength: Math.min(1, input.aimStrength),
      };
    }

    const anchor = cam.anchorScreen(vp);
    const dx = input.pointerX - anchor.x;
    const dy = input.pointerY - anchor.y;
    const dist = Math.hypot(dx, dy);
    // A dead zone around the player: the cursor sitting on them would spin the view.
    if (dist < POINTER_DEADZONE) return null;
    // Distance from the player is the mouse's equivalent of stick deflection, scaled to
    // the viewport so a quarter-screen player is not forced into a smaller range.
    const full = POINTER_DEADZONE + vp.h * POINTER_FULL_FRACTION;
    return {
      angle: Math.atan2(dy, dx) + Math.PI / 2,
      strength: clamp((dist - POINTER_DEADZONE) / (full - POINTER_DEADZONE), 0, 1),
    };
  }

  private update(dt: number): void {
    this.input.update();

    if (this.phase !== "playing") {
      this.updateMenus(dt);
      if (this.banner.time > 0) this.banner.time -= dt;
      return;
    }

    this.world.update(dt, this.inputOf, this.resolveAim);
    this.drainEvents();
    if (this.banner.time > 0) this.banner.time -= dt;
  }

  private updateMenus(dt: number): void {
    const menu = this.menuInput();

    if (this.phase === "lobby") {
      if (this.lobby.update(this.input)) {
        this.roster = this.lobby.slots.map((s) => s.sourceId);
        this.modeSelect.reset();
        this.phase = "mode";
      }
      return;
    }

    if (this.phase === "mode") {
      if (menu.cancel) { this.phase = "lobby"; return; }
      const chosen = this.modeSelect.update(menu.x, menu.confirm, dt);
      if (chosen === "survival") this.beginMatch(undefined, "survival");
      else if (chosen === "story") {
        this.missionSelect.focusNext(this.completed);
        this.phase = "missions";
      }
      return;
    }

    if (this.phase === "missions") {
      if (menu.cancel) { this.modeSelect.reset(); this.phase = "mode"; return; }
      const aspect = this.renderer.width / Math.max(1, this.renderer.height);
      const mission = this.missionSelect.update(
        menu.x, menu.y, menu.confirm, dt, this.completed, aspect,
      );
      if (mission) this.launchMission(mission);
    }
  }

  private drainEvents(): void {
    for (const ev of this.world.events) {
      if (ev.kind === "kill" && ev.x !== undefined && ev.y !== undefined) {
        this.shakeNear(ev.x, ev.y, 0.35, 520);
      } else if (ev.kind === "alarm") {
        // This one you DO get told about: it is a mistake with consequences, and the
        // player has to be able to connect the bang to the twenty seconds that follow.
        this.shakeAll(0.8);
        if (ev.text) this.setBanner(ev.text);
      } else if (ev.kind === "horde") {
        // No banner: a wave should be something you hear and feel, not read.
        this.shakeAll(0.35);
      } else if (ev.kind === "playerDown") {
        this.shakeAll(0.6);
        if (ev.text) this.setBanner(ev.text);
      } else if (ev.kind === "wipe") {
        this.shakeAll(1);
        if (ev.text) this.setBanner(ev.text);
        this.relayout();
      } else if (ev.kind === "floorCleared") {
        this.advanceFloor();
      } else if (ev.kind === "missionComplete") {
        this.completeMission();
      } else if (ev.kind === "missionFailed") {
        this.returnToMissions("MISSION FAILED");
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

  /**
   * The menu backdrop: the level itself, seen from a slowly roving spotlight. It costs
   * one extra visibility polygon per frame and means the first thing anyone sees is the
   * game's actual lighting rather than a title card.
   */
  private renderMenu(frameDt: number): void {
    const { world, renderer } = this;
    const vp: Viewport = { x: 0, y: 0, w: renderer.width, h: renderer.height, playerIndex: 0 };

    this.menuPanTimer -= frameDt;
    if (this.menuPanTimer <= 0 || (this.menuDest.x === 0 && this.menuDest.y === 0)) {
      const spot = world.map.randomWalkable() ?? world.map.mostOpenPoint();
      this.menuDest.x = spot.x;
      this.menuDest.y = spot.y;
      this.menuPanTimer = MENU_PAN_SECONDS;
      if (this.menuFocus.x === 0 && this.menuFocus.y === 0) {
        this.menuFocus.x = spot.x;
        this.menuFocus.y = spot.y;
        this.menuCam.snapTo(spot.x, spot.y, 0);
      }
    }
    // Glide the target rather than the camera, so the pan never stops or snaps.
    this.menuFocus.x = damp(this.menuFocus.x, this.menuDest.x, 0.32, frameDt);
    this.menuFocus.y = damp(this.menuFocus.y, this.menuDest.y, 0.32, frameDt);

    this.menuCam.mode = "fixed";
    this.menuCam.follow(
      this.menuFocus.x, this.menuFocus.y, 0, vp,
      world.map.worldWidth, world.map.worldHeight, frameDt,
    );
    // follow() sizes zoom for gameplay; the menu wants to show more of the room.
    this.menuCam.zoom = Math.max(0.35, vp.h / MENU_VIEW_HEIGHT);

    this.menuLight.x = this.menuCam.x;
    this.menuLight.y = this.menuCam.y;
    computeVisibility(world.map, this.menuLight);
    renderer.ambientLights = [this.menuLight];

    renderer.beginFrame();
    renderer.renderViewport(world, vp, this.menuCam, 0);
    const { ctx, width: w, height: h, dpr } = renderer;
    if (this.phase === "lobby") {
      this.lobby.draw(ctx, w, h, dpr, world.map.name, this.cameraMode);
    } else if (this.phase === "mode") {
      this.modeSelect.draw(ctx, w, h, dpr, this.roster.length);
    } else {
      this.missionSelect.draw(ctx, w, h, dpr, this.completed);
    }
  }

  private render(alpha: number, frameDt: number): void {
    const { world, renderer } = this;
    if (this.phase !== "playing") { this.renderMenu(frameDt); return; }
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
