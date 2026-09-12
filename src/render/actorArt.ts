import { clamp, lerp, TAU } from "../core/math";
import type { WeaponArt } from "../sim/entities";

/**
 * CORE 11a — Actor art: a human seen from directly above, and what it is holding.
 *
 * Everything the renderer used to say about an actor was "a rotated rectangle with a
 * stub on the front". That reads as a direction and nothing else. This module draws the
 * same information as an actual body — shoulders, head, two arms, two legs, a weapon in
 * the hands — from the one camera angle this game ever uses: straight down.
 *
 * Three rules keep it cheap and keep it honest:
 *
 * 1. **Everything is authored for a radius-15 actor and scaled by `s = radius / 15`.**
 *    So the numbers below are readable as pixels, and a fatter zombie is one field.
 * 2. **The pose comes in, never out.** `drawActor` reads an `ActorPose` and draws it.
 *    It owns no state and no clocks, so two viewports drawing the same player in the
 *    same frame cannot disagree, and a replay of the same sim draws identically.
 * 3. **Limbs are solved, not keyframed.** Hands are placed by the weapon; the elbow
 *    falls out of two-bone IK. That is why one arm rig serves a pistol, an SMG, a
 *    shotgun, a crowbar and a zombie's outstretched reach without a frame of art.
 *
 * The gait is driven by *distance travelled* (`walkPhase`, accumulated in the sim), not
 * by time, so feet never skate: walk, sprint and a crawl all step at the pace they move.
 */

/** Local space after the rotate: +x is straight ahead, and -y is the actor's right. */
const RIGHT = -1;

const SKIN = "#d9ab84";
const METAL = "#2f343d";
const METAL_EDGE = "#586274";
const METAL_DARK = "#1d2128";
const GRIP = "#191c22";
const WOOD = "#6b4a31";
const STEEL = "#98a2ae";
const STEEL_DARK = "#5c6472";

/** What an actor is holding, and where that weapon is in its swing / kick / reload. */
export interface HandsPose {
  art: WeaponArt;
  /** 0 = weapon at rest across the body, 1 = shouldered and pointing down the facing. */
  up: number;
  /** 0..1, decays after each shot: the kick, the muzzle rise, the shotgun's pump. */
  recoil: number;
  /** 0..1 through a melee swing; 0 when not swinging. */
  swing: number;
  /** Which shoulder this swing comes over. Alternates, so a flurry is not a loop. */
  swingSide: number;
  /** 0..1 through a magazine change. */
  reload: number;
}

export interface ActorPose {
  x: number;
  y: number;
  facing: number;
  radius: number;
  /** Identity colour — the jacket. Trousers, hair and shading are derived from it. */
  body: string;
  outline: string;
  /** 0 upright, 1 flat on the floor. */
  prone: number;
  /** Gait cycle in radians, advanced by distance travelled. */
  walkPhase: number;
  /** 0 standing still, 1 a full stride. */
  walkAmount: number;
  /** What is in its hands, or null for something that carries nothing. */
  hands: HandsPose | null;
  /**
   * 0 a person, 1 a zombie: arms out in front, one leg dragging, head lolled over.
   * The same rig — a shambler is a posture, not a second character.
   */
  shamble: number;
}

/** One actor, from above. */
export function drawActor(ctx: CanvasRenderingContext2D, a: ActorPose): void {
  const s = a.radius / 15;
  const jacket = a.body;
  const jacketDark = shade(a.body, 0.72);
  const trousers = shade(a.body, 0.5);
  // Hair is the identity colour dragged most of the way to black, not lightened: four
  // players in four bright jackets need a head that reads AGAINST the jacket, and a
  // tint of a bright colour just clips to the same near-white for all of them.
  const hair = mix(a.body, 26, 26, 34, 0.62);
  const line = a.outline;

  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.rotate(a.facing);

  // Shadow first, and outside the prone squash so it stays a pool on the floor.
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(
    3 * s, 4 * s, 16 * s * (1 + 0.45 * a.prone), 15 * s * (1 - 0.22 * a.prone), 0, 0, TAU,
  );
  ctx.fill();

  // A body on the floor is foreshortened: longer along its facing, narrower across.
  ctx.scale(1 + 0.45 * a.prone, 1 - 0.26 * a.prone);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const gait = a.walkAmount * (1 - a.prone);
  const stride = Math.sin(a.walkPhase);
  // A shambler lurches: the body rolls over the dragging leg instead of staying level.
  const roll = Math.sin(a.walkPhase) * 1.6 * s * gait * a.shamble;

  drawLegs(ctx, s, gait, stride, a.prone, a.shamble, trousers, line);

  // Pelvis, over the top of the legs — it is what the thighs disappear into.
  ctx.fillStyle = shade(trousers, 0.85);
  ctx.strokeStyle = line;
  ctx.lineWidth = 1.8 * s;
  ctx.beginPath();
  ctx.ellipse(-7 * s, 0, 6 * s, 7.5 * s, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();

  // Torso: shoulders are wider than the chest is deep, which is the whole silhouette
  // from up here. The strap across it is what stops it reading as a bean.
  ctx.translate(0, roll);
  ctx.fillStyle = jacket;
  ctx.strokeStyle = line;
  ctx.lineWidth = 2.2 * s;
  ctx.beginPath();
  ctx.ellipse(-1 * s, 0, 8 * s, 10.8 * s, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = jacketDark;
  ctx.lineWidth = 3 * s;
  ctx.beginPath();
  ctx.moveTo(-5 * s, -9.5 * s);
  ctx.lineTo(3.5 * s, 9 * s);
  ctx.stroke();

  // Shoulder caps, which double as the sockets the arms swing from.
  for (const side of [-1, 1]) {
    ctx.fillStyle = jacketDark;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.6 * s;
    ctx.beginPath();
    ctx.ellipse(0.5 * s, side * 9.2 * s, 4.3 * s, 4.8 * s, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
  }

  drawArmsAndWeapon(ctx, a, s, jacketDark, line);

  // Head last: from directly above it is the highest thing on the body, so it sits on
  // top of everything except the weapon that reaches out past it.
  const loll = a.shamble * 0.35 + Math.sin(a.walkPhase * 0.5) * 0.1 * gait * a.shamble;
  ctx.save();
  ctx.translate(3.5 * s, 0);
  ctx.rotate(loll);
  ctx.fillStyle = hair;
  ctx.strokeStyle = line;
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.ellipse(0, 0, 6.6 * s, 6.2 * s, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();
  // A sliver of face at the leading edge, and a nose on it. Two ellipses, and suddenly
  // you can tell at a glance which way a body is looking as well as which way it moves.
  ctx.fillStyle = a.shamble > 0.5 ? mix(SKIN, 122, 134, 112, 0.55) : SKIN;
  ctx.beginPath();
  ctx.ellipse(3.8 * s, 0, 3.1 * s, 4.1 * s, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = shade(SKIN, 0.8);
  ctx.beginPath();
  ctx.ellipse(6.1 * s, 0, 1.6 * s, 1.6 * s, 0, 0, TAU);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

/**
 * Where the muzzle of a held weapon actually is, in world units from the body centre.
 * The flash, the smoke and the shell all come from the gun rather than from a guessed
 * offset in front of the player — which is what makes a lowered weapon flash low.
 */
export function muzzleOffset(h: HandsPose, radius: number): { x: number; y: number } {
  const s = radius / 15;
  const def = WEAPON_ART[h.art];
  const f = weaponFrame(h, def, s);
  return {
    x: f.gx + Math.cos(f.angle) * def.muzzle * s,
    y: f.gy + Math.sin(f.angle) * def.muzzle * s,
  };
}

/**
 * Legs. From above a stride is one leg reaching out in front of the hip while the other
 * trails behind it, so that is exactly what this draws — hip to foot, with a boot on the
 * end. Prone folds both of them straight back; a shambler drags one.
 */
function drawLegs(
  ctx: CanvasRenderingContext2D, s: number, gait: number, stride: number,
  prone: number, shamble: number, trousers: string, line: string,
): void {
  for (const side of [-1, 1]) {
    const phase = side === RIGHT ? stride : -stride;
    const drag = side === RIGHT ? 1 : 1 - 0.55 * shamble;
    const hipX = -8.5 * s;
    const hipY = side * 5.5 * s;
    /*
     * Seen from directly overhead a standing person's legs are genuinely hidden under
     * their own shoulders, and an actor with no legs at all is most of what was wrong
     * with drawing one as a box. So the hips sit at the back of the torso and both feet
     * trail clear behind it, one reaching further than the other through the stride:
     * two boots behind a body, which is what a walking figure looks like from a
     * helicopter. Prone folds them straight out the back instead.
     */
    const footX = hipX + lerp(-4.5 * s + phase * gait * drag * 5 * s, -10 * s, prone);
    const footY = hipY + side * (2.5 + 3 * shamble) * s + lerp(0, side * 3 * s, prone);

    ctx.strokeStyle = line;
    ctx.lineWidth = 9 * s;
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(footX, footY);
    ctx.stroke();
    ctx.strokeStyle = trousers;
    ctx.lineWidth = 6.5 * s;
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(footX, footY);
    ctx.stroke();

    // Boot: a dark cap on the end of the leg, turned the way the leg is going.
    const ang = Math.atan2(footY - hipY, footX - hipX);
    ctx.save();
    ctx.translate(footX, footY);
    ctx.rotate(ang);
    ctx.fillStyle = shade(trousers, 0.55);
    ctx.beginPath();
    ctx.ellipse(1.2 * s, 0, 4.2 * s, 3.2 * s, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

/**
 * Both arms, and whatever they are holding. The hands are placed by the weapon and the
 * elbows are solved, which is the whole reason this rig can hold anything.
 */
function drawArmsAndWeapon(
  ctx: CanvasRenderingContext2D, a: ActorPose, s: number,
  jacketDark: string, line: string,
): void {
  // Roughly human: shoulders ~45cm apart and an arm that reaches ~60cm, at the two
  // centimetres per world unit a radius-15 body works out to. Get this wrong and the
  // hands cannot reach a rifle's foregrip, which is exactly how a held weapon starts
  // looking like a weapon glued to a chest.
  const shoulderX = 0.5 * s;
  const domShoulder = { x: shoulderX, y: RIGHT * 9 * s };
  const offShoulder = { x: shoulderX, y: -RIGHT * 9 * s };
  const upper = 12 * s;
  const fore = 13 * s;
  const sleeve = 6 * s;

  if (a.hands === null) {
    // Carries nothing. A person lets their arms hang beside the body and swing against
    // the legs; a zombie holds them out in front, which is the entire read on a mob.
    const swingArm = Math.sin(a.walkPhase) * 7 * s * a.walkAmount * (1 - a.prone);
    for (const side of [-1, 1]) {
      const sh = side === RIGHT ? domShoulder : offShoulder;
      const reach = a.shamble;
      const hx = lerp(-4 * s + (side === RIGHT ? swingArm : -swingArm), 24 * s, reach);
      const hy = lerp(sh.y + 5 * s * side, sh.y - 4.5 * s * side, reach);
      const hand = drawArm(
        ctx, sh.x, sh.y, hx, hy, upper, fore, side * 0.85, jacketDark, line, sleeve, s,
      );
      drawGlove(ctx, hand.x, hand.y, s, line);
    }
    return;
  }

  const h = a.hands;
  const def = WEAPON_ART[h.art];
  const f = weaponFrame(h, def, s);
  const cos = Math.cos(f.angle);
  const sin = Math.sin(f.angle);
  const toBody = (fx: number, fy: number) => ({
    x: f.gx + fx * cos - fy * sin,
    y: f.gy + fx * sin + fy * cos,
  });

  // The off hand: on a foregrip if the weapon has one, on the magazine well during a
  // reload, and up in front of the chest as a guard when the weapon is one-handed.
  const support = def.grip2
    ? toBody(def.grip2[0] * s, def.grip2[1] * s * -RIGHT)
    : { x: 16 * s, y: -RIGHT * 10 * s };
  // A magazine change: the off hand leaves the foregrip, drops to the well under the
  // receiver and comes back, on a sine so it is one continuous move rather than a snap.
  const swap = def.grip2 === null ? 0 : Math.sin(Math.PI * h.reload);
  const offHand = swap > 0
    ? toBody(lerp(def.grip2![0], 0, swap) * s, (6 + 8 * swap) * s * -RIGHT)
    : support;

  // Off arm behind the weapon, dominant arm in front of it, so the grip hand reads as
  // wrapped round the weapon rather than buried under it.
  const offArm = drawArm(
    ctx, offShoulder.x, offShoulder.y, offHand.x, offHand.y,
    upper, fore, -RIGHT * 0.8, jacketDark, line, sleeve, s,
  );
  drawGlove(ctx, offArm.x, offArm.y, s, line);

  ctx.save();
  ctx.translate(f.gx, f.gy);
  ctx.rotate(f.angle);
  def.draw(ctx, s, h);
  ctx.restore();

  const domArm = drawArm(
    ctx, domShoulder.x, domShoulder.y, f.gx, f.gy,
    upper, fore, RIGHT * 0.6, jacketDark, line, sleeve, s,
  );
  drawGlove(ctx, domArm.x, domArm.y, s, line);
}

/**
 * One arm, as two bones. The hand goes where it was asked to go (pulled in if it is out
 * of reach) and the elbow is the circle intersection that gets it there, pushed to the
 * outside of the body — the pose a person actually makes holding something in front of
 * them. Returns where the hand ended up, so the glove can be drawn on it.
 *
 * `bend` carries the sign AND the strength: at ±1 it is the exact two-bone solution,
 * and below that the elbow is pulled back toward the straight line, because the honest
 * solution throws it so far out to the side that from above the actor grows shoulder
 * pads. Nothing draws the joint, so a slightly short arm is invisible.
 */
function drawArm(
  ctx: CanvasRenderingContext2D, sx: number, sy: number, hx: number, hy: number,
  upper: number, fore: number, bend: number, color: string, line: string, width: number,
  s: number,
): { x: number; y: number } {
  const dx = hx - sx;
  const dy = hy - sy;
  const reach = (upper + fore) * 0.995;
  let d = Math.hypot(dx, dy) || 0.0001;
  let tx = hx;
  let ty = hy;
  if (d > reach) {
    const k = reach / d;
    tx = sx + dx * k;
    ty = sy + dy * k;
    d = reach;
  }
  const ux = (tx - sx) / d;
  const uy = (ty - sy) / d;
  const mid = (upper * upper - fore * fore + d * d) / (2 * d);
  const out = Math.sqrt(Math.max(0, upper * upper - mid * mid));
  const ex = sx + ux * mid - uy * out * bend;
  const ey = sy + uy * mid + ux * out * bend;

  ctx.strokeStyle = line;
  ctx.lineWidth = width + 3 * s;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  return { x: tx, y: ty };
}

function drawGlove(
  ctx: CanvasRenderingContext2D, x: number, y: number, s: number, line: string,
): void {
  ctx.fillStyle = GRIP;
  ctx.strokeStyle = line;
  ctx.lineWidth = 1.2 * s;
  ctx.beginPath();
  ctx.ellipse(x, y, 3 * s, 2.8 * s, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();
}

/**
 * Where the weapon is and which way it points, as one transform: the grip position in
 * body space plus an angle off the facing. Every state a weapon can be in is a term in
 * here rather than a separate pose — lowered, shouldered, kicking, reloading, swinging.
 */
function weaponFrame(
  h: HandsPose, def: ArtDef, s: number,
): { gx: number; gy: number; angle: number } {
  if (def.melee) return meleeFrame(h, s);

  // Lowered, the weapon swings across the body on the dominant side and the hands come
  // back toward the chest; shouldered, it comes up onto the centreline and pushes out.
  const rest = 1 - h.up;
  const dip = Math.sin(Math.PI * h.reload) * 0.6;
  const angle = (rest * 0.85 + dip) * -RIGHT - h.recoil * 0.18 * -RIGHT;
  const push = (def.extend + 7 * h.up) * s - h.recoil * 4.5 * s;
  return {
    gx: push,
    gy: RIGHT * (7 - 5 * h.up) * s + dip * 4 * s * -RIGHT,
    angle,
  };
}

/**
 * The swing. A crowbar is cocked back over one shoulder whenever it is raised, so the
 * strike does not have to spend time getting there: it sweeps across the front fast,
 * then comes back to guard slowly. `MELEE_CONTACT` in `sim/player.ts` is the point in
 * that sweep where the bar is out in front — which is when the sim resolves the hit,
 * so what you see connecting is what connects.
 */
function meleeFrame(h: HandsPose, s: number): { gx: number; gy: number; angle: number } {
  const side = h.swingSide >= 0 ? 1 : -1;
  // Guard: at rest it hangs back by the hip, raised it comes up ready to come down.
  const guard = 2.55 - 0.5 * h.up;
  const t = h.swing;
  let ang = guard;
  let push = 0;
  if (t > 0) {
    if (t < 0.18) {
      // Anticipation: a short cock back past the guard.
      ang = guard + 0.35 * (t / 0.18);
    } else if (t < 0.5) {
      const e = easeOut((t - 0.18) / 0.32);
      ang = lerp(guard + 0.35, -0.7, e);
      push = Math.sin(Math.PI * e) * 7;
    } else {
      const e = (t - 0.5) / 0.5;
      ang = lerp(-0.7, guard, e * e);
      push = (1 - e) * 3;
    }
  }
  return {
    gx: (7 + 6 * h.up + push) * s,
    gy: side * (9 - 2 * h.up) * s,
    angle: ang * side,
  };
}

function easeOut(t: number): number {
  const x = clamp(t, 0, 1);
  return 1 - (1 - x) * (1 - x);
}

/**
 * The weapon table. One row per silhouette: where the hands go, where the muzzle is,
 * and how to draw it in frame space — grip at the origin, muzzle toward +x, authored
 * for a radius-15 actor and scaled by `s`.
 *
 * A new weapon is a row here plus an `art` field on its `WeaponDef`. Nothing else in
 * the renderer learns its name.
 */
interface ArtDef {
  /** Support hand, in frame units: [ahead of the grip, toward the off side]. */
  grip2: [number, number] | null;
  /** Grip to muzzle tip. What the flash and the smoke hang off. */
  muzzle: number;
  /** How far in front of the chest the grip sits with the weapon at rest. */
  extend: number;
  melee: boolean;
  draw: (ctx: CanvasRenderingContext2D, s: number, h: HandsPose) => void;
}

const WEAPON_ART: Record<WeaponArt, ArtDef> = {
  /** A sidearm: short slide, both hands together on the grip, almost no overhang. */
  pistol: {
    grip2: [2.5, 3.2], muzzle: 17, extend: 9, melee: false,
    draw(ctx, s) {
      ctx.fillStyle = GRIP;
      rrect(ctx, -6.5 * s, -3.4 * s, 6 * s, 6.8 * s, 1.6 * s);
      ctx.fill();
      ctx.fillStyle = METAL;
      ctx.strokeStyle = METAL_EDGE;
      ctx.lineWidth = 1 * s;
      rrect(ctx, -4 * s, -2.5 * s, 20 * s, 5 * s, 1.6 * s);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = METAL_DARK;
      rrect(ctx, 10 * s, -1.2 * s, 6 * s, 2.4 * s, 1 * s);
      ctx.fill();
    },
  },

  /** Compact automatic: stock, receiver, a handguard the off hand wraps, stubby mag. */
  smg: {
    grip2: [11, -0.5], muzzle: 24, extend: 9, melee: false,
    draw(ctx, s) {
      ctx.fillStyle = GRIP;
      rrect(ctx, -16 * s, -2.4 * s, 11 * s, 4.8 * s, 1.4 * s);
      ctx.fill();
      rrect(ctx, -1.5 * s, 2.2 * s, 5 * s, 7 * s, 1.2 * s);
      ctx.fill();
      ctx.fillStyle = METAL;
      ctx.strokeStyle = METAL_EDGE;
      ctx.lineWidth = 1 * s;
      rrect(ctx, -7 * s, -3.2 * s, 20 * s, 6.4 * s, 1.6 * s);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = METAL_DARK;
      rrect(ctx, 11 * s, -2.6 * s, 12 * s, 5.2 * s, 1.4 * s);
      ctx.fill();
      // Vents on the handguard. Two lines, and it stops being a grey bar.
      ctx.strokeStyle = "rgba(150,165,185,0.35)";
      ctx.lineWidth = 1 * s;
      ctx.beginPath();
      ctx.moveTo(13 * s, -1.2 * s);
      ctx.lineTo(21 * s, -1.2 * s);
      ctx.moveTo(13 * s, 1.2 * s);
      ctx.lineTo(21 * s, 1.2 * s);
      ctx.stroke();
    },
  },

  /**
   * Pump shotgun: the longest thing anyone carries, and the only one with a moving
   * part — the pump rides back on the kick and returns as the recoil decays, so a
   * shotgun visibly cycles between shots instead of just flashing.
   */
  shotgun: {
    grip2: [13, -0.5], muzzle: 36, extend: 9, melee: false,
    draw(ctx, s, h) {
      ctx.fillStyle = WOOD;
      ctx.strokeStyle = shade(WOOD, 0.55);
      ctx.lineWidth = 1 * s;
      rrect(ctx, -22 * s, -2.9 * s, 17 * s, 5.8 * s, 2.2 * s);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = METAL;
      ctx.strokeStyle = METAL_EDGE;
      rrect(ctx, -7 * s, -3.4 * s, 17 * s, 6.8 * s, 1.6 * s);
      ctx.fill();
      ctx.stroke();
      // Barrel, and the tube magazine offset under it to sell the depth.
      ctx.fillStyle = METAL;
      rrect(ctx, 9 * s, -2.3 * s, 27 * s, 4.6 * s, 1.4 * s);
      ctx.fill();
      ctx.fillStyle = METAL_DARK;
      rrect(ctx, 9 * s, 1.5 * s, 22 * s, 2.8 * s, 1.2 * s);
      ctx.fill();
      // The pump, back on the kick.
      const px = (13 - 6 * h.recoil) * s;
      ctx.fillStyle = shade(WOOD, 1.15);
      ctx.strokeStyle = shade(WOOD, 0.55);
      rrect(ctx, px, -3.6 * s, 9 * s, 7.2 * s, 2 * s);
      ctx.fill();
      ctx.stroke();
    },
  },

  /**
   * A crowbar: hex shaft, a goose-neck claw at the far end, a chisel at the near one.
   * Held one-handed — the off hand stays up as a guard, which is also what sells the
   * swing, because the guard hand is the thing the body rotates around.
   */
  crowbar: {
    grip2: null, muzzle: 33, extend: 5, melee: true,
    draw(ctx, s) {
      drawBar(ctx, s);
      ctx.strokeStyle = STEEL_DARK;
      ctx.lineWidth = 4.6 * s;
      ctx.beginPath();
      ctx.moveTo(24 * s, 0);
      ctx.quadraticCurveTo(33 * s, 0, 32 * s, -6.5 * s);
      ctx.lineTo(29.5 * s, -9 * s);
      ctx.stroke();
      ctx.strokeStyle = STEEL;
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.moveTo(24 * s, 0);
      ctx.quadraticCurveTo(32 * s, 0, 31 * s, -6 * s);
      ctx.stroke();
      // The chisel end, behind the hand.
      ctx.fillStyle = STEEL;
      ctx.beginPath();
      ctx.moveTo(-7 * s, -2.4 * s);
      ctx.lineTo(-12 * s, -3.4 * s);
      ctx.lineTo(-12 * s, 3.4 * s);
      ctx.lineTo(-7 * s, 2.4 * s);
      ctx.closePath();
      ctx.fill();
    },
  },

  /** A length of pipe. Same rig, blunter end, one coupling ring so it is not a crowbar. */
  pipe: {
    grip2: null, muzzle: 28, extend: 5, melee: true,
    draw(ctx, s) {
      drawBar(ctx, s, 28);
      ctx.fillStyle = STEEL_DARK;
      rrect(ctx, 19 * s, -3.6 * s, 5 * s, 7.2 * s, 1.2 * s);
      ctx.fill();
      ctx.fillStyle = "rgba(20,24,30,0.9)";
      ctx.beginPath();
      ctx.ellipse(27.5 * s, 0, 1.6 * s, 2.2 * s, 0, 0, TAU);
      ctx.fill();
    },
  },
};

/** The shaft both melee weapons share: dark steel with a lit core down the middle. */
function drawBar(ctx: CanvasRenderingContext2D, s: number, tip = 26): void {
  ctx.lineCap = "round";
  ctx.strokeStyle = STEEL_DARK;
  ctx.lineWidth = 4.8 * s;
  ctx.beginPath();
  ctx.moveTo(-8 * s, 0);
  ctx.lineTo(tip * s, 0);
  ctx.stroke();
  ctx.strokeStyle = STEEL;
  ctx.lineWidth = 2.2 * s;
  ctx.beginPath();
  ctx.moveTo(-6 * s, -0.3 * s);
  ctx.lineTo((tip - 2) * s, -0.3 * s);
  ctx.stroke();
}

/** A rounded rectangle path. Shared, because half the props in the game are one. */
export function rrect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Colour derivation. Both of these take `#rrggbb` and **return `#rrggbb`**, which is the
 * only reason they compose: the boots are a shade of the trousers, which are themselves
 * a shade of the identity colour, and a helper that returned `rgb(...)` would silently
 * fail to be re-read by the next one.
 */

/** Pull a hex colour `t` of the way toward an rgb triple. */
function mix(hex: string, r: number, g: number, b: number, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const m = (c: number, to: number) => clamp(Math.round(c + (to - c) * t), 0, 255);
  return hexOf(m((n >> 16) & 255, r), m((n >> 8) & 255, g), m(n & 255, b));
}

/** Multiply a hex colour. Everything an actor wears is derived from its identity colour. */
function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  return hexOf(
    clamp(Math.round(((n >> 16) & 255) * factor), 0, 255),
    clamp(Math.round(((n >> 8) & 255) * factor), 0, 255),
    clamp(Math.round((n & 255) * factor), 0, 255),
  );
}

function hexOf(r: number, g: number, b: number): string {
  const two = (v: number) => v.toString(16).padStart(2, "0");
  return `#${two(r)}${two(g)}${two(b)}`;
}
