import { lerp, TAU } from "../core/math";
import { TILE } from "../world/tilemap";
import { tileDef } from "../world/tiles";
import { raycast } from "../world/raycast";
import { PLAYER_TUNING } from "../sim/player";
import type { Player } from "../sim/entities";
import type { GameWorld } from "../sim/world";
import type { VisionLight } from "../vision/visibility";
import type { Camera } from "./camera";
import type { Viewport } from "./viewport";

/**
 * CORE 11 — Renderer + lighting composite.
 *
 * Draw order per viewport, and the reason for it:
 *   1. floor            — fully lit, gets hidden again in step 4
 *   2. actors           — same, so anything in the dark simply never shows
 *   3. warm light       — additive pass that gives the cone its colour
 *   4. darkness mask    — one black layer with the visibility polygons punched out
 *   5. wall silhouettes — drawn last so blocks read as solid black everywhere
 *   6. HUD              — screen space, no camera transform
 *
 * All blocks, no art. Swap the draw* functions for sprites later; nothing else changes.
 */

const COLOR_FLOOR = "#cfc9b4";
const COLOR_WALL = "#07070c";
const AMBIENT_DARKNESS = 0.94; // 1 = pitch black outside the cones
/**
 * Flashlight strength. REVEAL is how much darkness the cone removes (1 = fully lit
 * floor), GLOW is the additive warmth on top. Deliberately well under 1: a blown-out
 * cone hides tracers, muzzle flashes and anything else drawn bright.
 */
const FLASHLIGHT_REVEAL = 0.55;
const FLASHLIGHT_GLOW = 0.15;
const HALO_REVEAL = 0.34;
const HALO_GLOW = 0.04;

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

/** Skip lights that cannot touch this viewport — the single biggest split-screen win. */
function lightVisible(light: VisionLight, b: Bounds): boolean {
  return light.x + light.range >= b.x0 && light.x - light.range <= b.x1 &&
         light.y + light.range >= b.y0 && light.y - light.range <= b.y1;
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  /**
   * Lights that are not owned by the world — the menu's roving spotlight today, a
   * flashbang or a muzzle flare later. Cleared by whoever sets them.
   */
  ambientLights: VisionLight[] = [];
  private lightCanvas: HTMLCanvasElement;
  private lightCtx: CanvasRenderingContext2D;
  dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.lightCanvas = document.createElement("canvas");
    const lctx = this.lightCanvas.getContext("2d");
    if (!lctx) throw new Error("2d context unavailable");
    this.lightCtx = lctx;
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(this.canvas.clientWidth);
    const h = Math.floor(this.canvas.clientHeight);
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.lightCanvas.width = this.canvas.width;
    this.lightCanvas.height = this.canvas.height;
  }

  get width(): number { return this.canvas.clientWidth; }
  get height(): number { return this.canvas.clientHeight; }

  beginFrame(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, this.width, this.height);
  }

  renderViewport(world: GameWorld, vp: Viewport, cam: Camera, alpha: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(vp.x, vp.y, vp.w, vp.h);
    ctx.clip();
    ctx.translate(vp.x, vp.y);

    ctx.save();
    cam.applyTransform(ctx, vp);

    const bounds = cam.visibleBounds(vp);
    this.drawFloor(ctx, bounds);
    this.drawLamps(ctx, world, bounds);
    this.drawParticles(ctx, world);
    this.drawActors(ctx, world, alpha);
    this.drawWarmLight(ctx, world, bounds);
    ctx.restore();

    this.drawDarkness(world, vp, cam, bounds);

    ctx.save();
    cam.applyTransform(ctx, vp);
    // Aim lasers and tracers sit ON TOP of the darkness: a bullet you cannot see is a
    // bullet you cannot learn from, and the whole point of a tracer is that it glows.
    this.drawAimLines(ctx, world);
    this.drawBullets(ctx, world);
    this.drawLightEdges(ctx, world);
    this.drawWalls(ctx, bounds, world);
    this.drawTeammateMarkers(ctx, world, vp);
    ctx.restore();

    ctx.restore();
  }

  // --- world -----------------------------------------------------------------

  private drawFloor(ctx: CanvasRenderingContext2D, b: Bounds): void {
    ctx.fillStyle = COLOR_FLOOR;
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);

    // Dotted tile pattern — pure texture, reads as scale under the light cone.
    const step = TILE / 2;
    const startX = Math.floor(b.x0 / step) * step;
    const startY = Math.floor(b.y0 / step) * step;
    ctx.fillStyle = "rgba(0,0,0,0.10)";
    for (let y = startY; y < b.y1; y += step) {
      for (let x = startX; x < b.x1; x += step) ctx.fillRect(x + step / 2 - 1.5, y + step / 2 - 1.5, 3, 3);
    }

    ctx.strokeStyle = "rgba(0,0,0,0.055)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(b.x0 / TILE) * TILE; x < b.x1; x += TILE) {
      ctx.moveTo(x, b.y0); ctx.lineTo(x, b.y1);
    }
    for (let y = Math.floor(b.y0 / TILE) * TILE; y < b.y1; y += TILE) {
      ctx.moveTo(b.x0, y); ctx.lineTo(b.x1, y);
    }
    ctx.stroke();
  }

  /**
   * Solid geometry, drawn from tile ids. Walls are pure black silhouettes; crates read
   * as objects sitting on the floor; glass is a pane you can see through, which is the
   * visible payoff of solid and opaque being separate flags.
   */
  private drawWalls(ctx: CanvasRenderingContext2D, b: Bounds, world: GameWorld): void {
    const map = world.map;
    // Deliberately NOT clamped to the map: out of bounds is solid, so filling it with
    // the same black keeps the level from having a visible silhouette against the void.
    const tx0 = Math.floor(b.x0 / TILE);
    const ty0 = Math.floor(b.y0 / TILE);
    const tx1 = Math.ceil(b.x1 / TILE);
    const ty1 = Math.ceil(b.y1 / TILE);

    const crates: number[] = [];
    const panes: number[] = [];

    ctx.fillStyle = COLOR_WALL;
    ctx.beginPath();
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!map.inBounds(tx, ty)) {
          ctx.rect(tx * TILE, ty * TILE, TILE + 0.5, TILE + 0.5);
          continue;
        }
        const def = tileDef(map.tileAt(tx, ty));
        if (!def.solid) continue;
        if (def.key === "crate") { crates.push(tx, ty); continue; }
        if (!def.opaque) { panes.push(tx, ty); continue; }
        ctx.rect(tx * TILE, ty * TILE, TILE + 0.5, TILE + 0.5);
      }
    }
    ctx.fill();

    for (let i = 0; i < crates.length; i += 2) {
      const x = crates[i] * TILE;
      const y = crates[i + 1] * TILE;
      ctx.fillStyle = "#0b0b10";
      ctx.fillRect(x, y, TILE + 0.5, TILE + 0.5);
      ctx.fillStyle = "#241c12";
      ctx.fillRect(x + 4, y + 4, TILE - 8, TILE - 8);
      ctx.strokeStyle = "rgba(190,150,90,0.35)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 4, y + 4, TILE - 8, TILE - 8);
    }

    for (let i = 0; i < panes.length; i += 2) {
      const x = panes[i] * TILE;
      const y = panes[i + 1] * TILE;
      ctx.fillStyle = "rgba(90,210,255,0.10)";
      ctx.fillRect(x, y, TILE, TILE);
      ctx.strokeStyle = "rgba(140,225,255,0.45)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 2, y + 2);
      ctx.lineTo(x + TILE - 2, y + TILE - 2);
      ctx.moveTo(x + TILE - 2, y + 2);
      ctx.lineTo(x + 2, y + TILE - 2);
      ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
      ctx.stroke();
    }
  }

  /** Lamps are part of the level, so they get a fixture drawn where the tile sits. */
  private drawLamps(ctx: CanvasRenderingContext2D, world: GameWorld, b: Bounds): void {
    for (const lamp of world.map.lamps) {
      if (lamp.x < b.x0 || lamp.x > b.x1 || lamp.y < b.y0 || lamp.y > b.y1) continue;
      ctx.fillStyle = "rgba(255,236,180,0.95)";
      ctx.fillRect(lamp.x - 7, lamp.y - 7, 14, 14);
      ctx.strokeStyle = "rgba(120,100,60,0.8)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(lamp.x - 7, lamp.y - 7, 14, 14);
    }
  }

  private drawActors(ctx: CanvasRenderingContext2D, world: GameWorld, alpha: number): void {
    for (const e of world.enemies) {
      // Nothing in the dark gets drawn — that is the whole point of the cone.
      if (!e.visible) continue;
      const x = lerp(e.prevX, e.x, alpha);
      const y = lerp(e.prevY, e.y, alpha);
      const hurt = e.hurtFlash;
      drawBlockActor(ctx, x, y, e.facing, e.radius, hurt > 0.1 ? "#ffffff" : "#7aa7c7", "#1d2b3a");

      // Health pip above damaged enemies.
      if (e.health < e.maxHealth) {
        const w = 26;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(x - w / 2, y - e.radius - 14, w, 4);
        ctx.fillStyle = "#ff6b6b";
        ctx.fillRect(x - w / 2, y - e.radius - 14, w * (e.health / e.maxHealth), 4);
      }
    }

    for (const p of world.players) {
      const x = lerp(p.prevX, p.x, alpha);
      const y = lerp(p.prevY, p.y, alpha);
      const body = p.downed ? "#6b6b6b" : (p.hurtFlash > 0.15 ? "#ffffff" : p.color);
      // The barrel extends as the weapon comes up and the body flattens as you go to
      // the floor — both stances are readable off the world, without UI.
      drawBlockActor(
        ctx, x, y, p.facing, p.radius, body, "#ffffff", true,
        0.45 + p.weaponUp * 0.55, proneAmount(p),
      );

      if (p.muzzleFlash > 0) {
        const mx = x + Math.cos(p.facing) * (p.radius + 14);
        const my = y + Math.sin(p.facing) * (p.radius + 14);
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = `rgba(255,232,160,${0.55 * p.muzzleFlash})`;
        ctx.beginPath();
        ctx.arc(mx, my, 16 * p.muzzleFlash, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }

      if (p.downed) {
        ctx.strokeStyle = "rgba(255,90,90,0.9)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, p.radius + 12, -Math.PI / 2, -Math.PI / 2 + TAU * (p.reviveProgress / 2.2));
        ctx.stroke();
      }
    }
  }

  private drawBullets(ctx: CanvasRenderingContext2D, world: GameWorld): void {
    ctx.lineCap = "round";
    ctx.lineWidth = 3;
    ctx.globalCompositeOperation = "lighter";
    for (const b of world.bullets.items) {
      if (!b.active) continue;
      const len = 14;
      const inv = 1 / (Math.hypot(b.vx, b.vy) || 1);
      ctx.strokeStyle = b.color;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - b.vx * inv * len, b.y - b.vy * inv * len);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawParticles(ctx: CanvasRenderingContext2D, world: GameWorld): void {
    for (const p of world.particles.items) {
      if (!p.active) continue;
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.max(0, t);
      ctx.fillStyle = p.color;
      const s = p.size * (0.4 + t * 0.6);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  // --- lighting ----------------------------------------------------------------

  /** Additive colour pass: the visible warmth of the cone, plus enemy beams. */
  private drawWarmLight(ctx: CanvasRenderingContext2D, world: GameWorld, b: Bounds): void {
    ctx.globalCompositeOperation = "lighter";
    for (const p of world.players) {
      if (lightVisible(p.cone, b)) fillLight(ctx, p.cone, FLASHLIGHT_GLOW * p.cone.intensity);
      if (lightVisible(p.halo, b)) fillLight(ctx, p.halo, HALO_GLOW);
    }
    for (const e of world.enemies) {
      if (lightVisible(e.cone, b)) fillLight(ctx, e.cone, 0.10 * e.cone.intensity);
    }
    for (const light of world.staticLights) {
      if (lightVisible(light, b)) fillLight(ctx, light, 0.22);
    }
    for (const light of this.ambientLights) {
      if (lightVisible(light, b)) fillLight(ctx, light, 0.16);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Darkness pass. One opaque layer over the viewport with every visibility polygon
   * erased out of it, so unlit floor and anything standing on it disappears.
   */
  private drawDarkness(world: GameWorld, vp: Viewport, cam: Camera, b: Bounds): void {
    const lctx = this.lightCtx;
    const dpr = this.dpr;

    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.globalCompositeOperation = "source-over";
    lctx.clearRect(0, 0, vp.w, vp.h);
    lctx.fillStyle = `rgba(10,8,18,${AMBIENT_DARKNESS})`;
    lctx.fillRect(0, 0, vp.w, vp.h);

    lctx.save();
    cam.applyTransform(lctx, vp);
    lctx.globalCompositeOperation = "destination-out";
    // Every player's vision is shared with the whole squad — you light rooms for
    // each other, which is the entire social point of co-op darkness.
    for (const p of world.players) {
      if (lightVisible(p.cone, b)) eraseLight(lctx, p.cone, FLASHLIGHT_REVEAL);
      if (lightVisible(p.halo, b)) eraseLight(lctx, p.halo, HALO_REVEAL);
    }
    for (const light of world.staticLights) {
      if (lightVisible(light, b)) eraseLight(lctx, light, 0.85);
    }
    for (const light of this.ambientLights) {
      if (lightVisible(light, b)) eraseLight(lctx, light, 0.8);
    }
    lctx.restore();

    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(vp.x, vp.y);
    ctx.drawImage(this.lightCanvas, 0, 0, vp.w * dpr, vp.h * dpr, 0, 0, vp.w, vp.h);
    ctx.restore();
  }

  /**
   * The aim laser. It only exists while the weapon is up, which is what makes the
   * weapon stance readable at a glance — and it stops where a bullet would stop, so
   * it tells the truth about glass and cover.
   */
  private drawAimLines(ctx: CanvasRenderingContext2D, world: GameWorld): void {
    ctx.globalCompositeOperation = "lighter";
    for (const p of world.players) {
      if (p.weaponUp <= 0.02 || p.downed) continue;

      const cos = Math.cos(p.facing);
      const sin = Math.sin(p.facing);
      const mx = p.x + cos * (p.radius + 10);
      const my = p.y + sin * (p.radius + 10);
      const dist = raycast(world.map, mx, my, cos, sin, p.weapon.range, "shot");
      const ex = mx + cos * dist;
      const ey = my + sin * dist;

      const strength = p.weaponUp * p.weaponUp;
      const beam = ctx.createLinearGradient(mx, my, ex, ey);
      beam.addColorStop(0, withAlpha(p.color, 0.5 * strength));
      beam.addColorStop(1, withAlpha(p.color, 0.06 * strength));
      ctx.strokeStyle = beam;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      // Reticle where the shot lands.
      ctx.strokeStyle = withAlpha(p.color, 0.7 * strength);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ex, ey, 5, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = withAlpha(p.color, 0.35 * strength);
      ctx.beginPath();
      ctx.arc(ex, ey, 2, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /** The bright rim where light meets a wall face. Cheap, and it sells the whole look. */
  private drawLightEdges(ctx: CanvasRenderingContext2D, world: GameWorld): void {
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 2.5;
    for (const p of world.players) {
      const poly = p.cone.poly;
      if (poly.length < 8) continue;
      // Skip the two apex segments: they converge on the player and would wash the
      // sprite out. Only the far boundary — the part that hugs walls — is stroked.
      // The stroke fades on the same curve as the light itself, otherwise the rim
      // keeps drawing walls at the far end of the cone where nothing is actually lit.
      ctx.strokeStyle = lightGradient(ctx, p.cone, "#fff0c8", 0.32);
      ctx.beginPath();
      ctx.moveTo(poly[2], poly[3]);
      for (let i = 4; i < poly.length; i += 2) ctx.lineTo(poly[i], poly[i + 1]);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /** Off-screen teammates get an arrow on the viewport edge, in their colour. */
  private drawTeammateMarkers(ctx: CanvasRenderingContext2D, world: GameWorld, vp: Viewport): void {
    const self = world.players[vp.playerIndex];
    if (!self) return;
    for (const other of world.players) {
      if (other === self) continue;
      const d = Math.hypot(other.x - self.x, other.y - self.y);
      if (d < 260) continue;
      const a = Math.atan2(other.y - self.y, other.x - self.x);
      const r = 190;
      const x = self.x + Math.cos(a) * r;
      const y = self.y + Math.sin(a) * r;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.fillStyle = other.color;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(9, 0); ctx.lineTo(-6, 6); ctx.lineTo(-6, -6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}

function tracePoly(ctx: CanvasRenderingContext2D, poly: number[]): boolean {
  if (poly.length < 6) return false;
  ctx.beginPath();
  ctx.moveTo(poly[0], poly[1]);
  for (let i = 2; i < poly.length; i += 2) ctx.lineTo(poly[i], poly[i + 1]);
  ctx.closePath();
  return true;
}

function lightGradient(
  ctx: CanvasRenderingContext2D, light: VisionLight, color: string, alpha: number,
): CanvasGradient {
  const g = ctx.createRadialGradient(light.x, light.y, 8, light.x, light.y, light.range);
  g.addColorStop(0, withAlpha(color, alpha * 0.45));
  g.addColorStop(0.32, withAlpha(color, alpha));
  g.addColorStop(0.75, withAlpha(color, alpha * 0.5));
  g.addColorStop(1, withAlpha(color, 0));
  return g;
}

function fillLight(ctx: CanvasRenderingContext2D, light: VisionLight, alpha: number): void {
  if (!tracePoly(ctx, light.poly)) return;
  ctx.fillStyle = lightGradient(ctx, light, light.color, alpha);
  ctx.fill();
}

function eraseLight(ctx: CanvasRenderingContext2D, light: VisionLight, strength: number): void {
  if (!tracePoly(ctx, light.poly)) return;
  // destination-out: the gradient's alpha is how much darkness gets removed.
  const g = ctx.createRadialGradient(light.x, light.y, 8, light.x, light.y, light.range);
  g.addColorStop(0, `rgba(0,0,0,${strength})`);
  g.addColorStop(0.62, `rgba(0,0,0,${strength * 0.92})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fill();
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** A blocky actor: body square, barrel stub, outline. Placeholder art, on purpose. */
/** 0 upright, 1 flat on the floor. Ramps through the dive and the scramble back up. */
function proneAmount(p: Player): number {
  const t = PLAYER_TUNING;
  switch (p.stance) {
    case "dive": return 1 - Math.min(1, Math.max(0, p.stanceTimer / t.DIVE_TIME));
    case "prone": return 1;
    case "standUp": return Math.min(1, Math.max(0, p.stanceTimer / t.STAND_TIME));
    default: return 0;
  }
}

function drawBlockActor(
  ctx: CanvasRenderingContext2D, x: number, y: number, facing: number,
  radius: number, body: string, outline: string, thickOutline = false, barrel = 1,
  prone = 0,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(facing);

  // A body on the floor reads from above as longer along its facing and narrower across.
  const halfLen = radius * (1 + 0.55 * prone);
  const halfWid = radius * (1 - 0.42 * prone);

  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(-halfLen + 3, -halfWid + 4, halfLen * 2, halfWid * 2);

  ctx.fillStyle = body;
  ctx.fillRect(-halfLen, -halfWid, halfLen * 2, halfWid * 2);
  ctx.strokeStyle = outline;
  ctx.lineWidth = thickOutline ? 2.5 : 1.5;
  ctx.strokeRect(-halfLen, -halfWid, halfLen * 2, halfWid * 2);

  // Barrel, always pointing along `facing` — the only readable direction cue on a block.
  ctx.fillStyle = outline;
  ctx.fillRect(halfLen - 2, -3, 16 * barrel, 6);
  ctx.restore();
}
