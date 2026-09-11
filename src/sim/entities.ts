import type { VisionLight } from "../vision/visibility";
import type { ItemKind } from "./items";

/**
 * CORE 5 — Entities.
 *
 * Deliberately plain data in flat per-kind arrays instead of a full ECS. At this size
 * that is faster to read, faster to run, and trivial to serialise. The rule that keeps
 * the door open for an ECS later: systems never store references to entities across
 * frames, they only ever hold ids.
 */

export type Team = "player" | "enemy";

/**
 * The movement state machine. A dive is a commitment: you launch, you land on the
 * floor, and you have to get up again. That commitment is the tactical cost that
 * makes it a decision rather than a dodge you spam.
 */
export type Stance = "stand" | "dive" | "prone" | "standUp";

/**
 * Something has hold of you. Both mutants that can grab a player produce one of these,
 * and everything downstream — the weapon, the movement, the HUD, what a teammate can do
 * about it — reads the restraint rather than asking which creature caused it.
 *
 * The rule both share: **a held player cannot shoot.** That is what turns a grab into a
 * squad problem instead of a personal one, and it is why the counterplay for both is
 * somebody else's flashlight finding you in time.
 */
export interface Restraint {
  /** `tendril` drags you toward it; `pin` puts you on the floor under it. */
  kind: "tendril" | "pin";
  /** Which enemy has you. Killing it, or cutting what it has hold of, frees you. */
  byId: number;
  /** Seconds it has held you. Drives the damage ramp and the HUD. */
  time: number;
  /** 0..1 of a teammate's shove. Only a pin can be shoved off. */
  shove: number;
  /**
   * Where the thing holding you is. The creature refreshes this every step so the
   * player module can be dragged toward it without ever learning what an Enemy is —
   * the same seam that keeps melee and revives out of the player's business.
   */
  anchorX: number;
  anchorY: number;
  /** World units per second it drags you at. Zero for a pin: that one just sits on you. */
  pull: number;
}

/**
 * Which silhouette the renderer puts in the actor's hands. One of these per row in
 * `WEAPON_ART` (`src/render/actorArt.ts`) — the *only* thing presentation reads off a
 * weapon, so the stats below stay free of art and a reskin never touches a number.
 */
export type WeaponArt = "pistol" | "smg" | "shotgun" | "crowbar" | "pipe";

export interface WeaponDef {
  name: string;
  /** What it looks like in the hands. See `WEAPON_ART`. */
  art: WeaponArt;
  /** Shots per second. */
  fireRate: number;
  bulletSpeed: number;
  damage: number;
  /** Half-spread in radians. */
  spread: number;
  pellets: number;
  magazine: number;
  reloadTime: number;
  /** Radians of kick added to facing per shot. */
  recoil: number;
  auto: boolean;
  range: number;
  /** How far the report carries, in world units. What the dead hear. */
  noise: number;
  /**
   * A melee weapon swings instead of firing. No bullets, no magazine, and quiet
   * enough that clearing a room with one does not call the next one — which is the
   * entire reason the first act of the ship has no gun in it.
   */
  melee?: boolean;
  /** Melee only: how far past the body the swing reaches, in world units. */
  reach?: number;
  /** Melee only: half-angle of the arc it sweeps, in radians. */
  arc?: number;
}

export const WEAPONS: Record<string, WeaponDef> = {
  /**
   * Melee. `magazine: 0` is what marks a weapon as ammo-less everywhere else — the
   * reload path, the HUD and the locker all read it rather than checking `melee`.
   */
  crowbar: {
    name: "Crowbar", art: "crowbar", fireRate: 1.8, bulletSpeed: 0, damage: 48, spread: 0,
    pellets: 0, magazine: 0, reloadTime: 0, recoil: 0, auto: false, range: 0,
    noise: 130, melee: true, reach: 46, arc: 0.85,
  },
  pipe: {
    name: "Pipe", art: "pipe", fireRate: 2.3, bulletSpeed: 0, damage: 34, spread: 0,
    pellets: 0, magazine: 0, reloadTime: 0, recoil: 0, auto: false, range: 0,
    noise: 110, melee: true, reach: 40, arc: 0.95,
  },
  smg: {
    name: "SMG", art: "smg", fireRate: 9, bulletSpeed: 900, damage: 12, spread: 0.055,
    pellets: 1, magazine: 30, reloadTime: 1.3, recoil: 0.02, auto: true, range: 900,
    noise: 650,
  },
  shotgun: {
    name: "Shotgun", art: "shotgun", fireRate: 1.6, bulletSpeed: 780, damage: 9, spread: 0.16,
    pellets: 7, magazine: 6, reloadTime: 1.9, recoil: 0.09, auto: false, range: 500,
    noise: 850,
  },
  pistol: {
    name: "Pistol", art: "pistol", fireRate: 5, bulletSpeed: 820, damage: 10, spread: 0.03,
    pellets: 1, magazine: 14, reloadTime: 1.0, recoil: 0.03, auto: false, range: 800,
    noise: 600,
  },
};

/**
 * What a weapon locker hands out: the next gun up from whatever you are carrying.
 *
 * Deliberately guns only. Melee weapons are a *loadout* — what a mission decides you
 * woke up holding — not a rung on this ladder, so anything not on the list counts as
 * below all of it. That is what makes the first locker on the ship hand an unarmed
 * squad a pistol rather than a second crowbar, and it is why the ladder does not have
 * to know which melee weapons exist.
 */
export const WEAPON_LADDER = ["pistol", "smg", "shotgun"] as const;

/**
 * The next gun up, or null when you are already carrying the best thing on the ship.
 * A locker that cannot upgrade you tops your magazine up instead — see `src/sim/devices.ts`.
 */
export function nextWeaponUp(current: WeaponDef): WeaponDef | null {
  const at = WEAPON_LADDER.findIndex((key) => WEAPONS[key] === current);
  if (at < 0) return WEAPONS[WEAPON_LADDER[0]];
  const next = WEAPON_LADDER[at + 1];
  return next ? WEAPONS[next] : null;
}

export interface Player {
  id: number;
  /** Input device driving this player. The only link between sim and hardware. */
  sourceId: string;
  color: string;
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  radius: number;
  facing: number;
  prevFacing: number;
  health: number;
  maxHealth: number;
  /** Co-op down-and-revive rather than instant death. */
  downed: boolean;
  bleedout: number;
  reviveProgress: number;
  weapon: WeaponDef;
  ammo: number;
  fireCooldown: number;
  reloadTimer: number;
  /** Where the body is: upright, mid-dive, on the floor, or getting back up. */
  stance: Stance;
  /** Seconds left in the current stance. Unused while standing. */
  stanceTimer: number;
  diveDirX: number;
  diveDirY: number;
  diveCooldown: number;
  /** Current lean, -1 left to +1 right, damped toward the input. */
  lean: number;
  /**
   * Where the player looks and shoots from. Equals the body position when upright and
   * slides sideways when leaning — the collision circle never moves, which is what
   * lets you peek round a corner without stepping into it.
   */
  eyeX: number;
  eyeY: number;
  stamina: number;
  maxStamina: number;
  /** Counts down before stamina starts coming back, so tapping sprint is not free. */
  staminaDelay: number;
  /** Ran the tank dry — sprint stays locked out until stamina recovers past a floor. */
  exhausted: boolean;
  /** Counts down to the next sprinting footfall. Only sprinting makes noise. */
  stepNoise: number;
  muzzleFlash: number;
  hurtFlash: number;
  kills: number;
  /** 0 = weapon at rest, 1 = shouldered and ready. Only a raised weapon can fire. */
  weaponUp: number;
  /** Keeps the weapon up through brief lulls, so small aim corrections do not bob it. */
  weaponHold: number;
  /**
   * Gait cycle, in radians. Advanced by *distance travelled* rather than by time, which
   * is what keeps the feet from skating: walking, sprinting and crawling all step at
   * the pace they actually move at. Presentation reads it; nothing else does.
   */
  walkPhase: number;
  /**
   * The melee swing, in seconds remaining out of `swingTime`. The animation and the
   * hit are the same event — the sim resolves the damage partway through this timer
   * (`MELEE_CONTACT`), so the bar connects when you can see it connect.
   */
  swingTimer: number;
  swingTime: number;
  /** Which shoulder the current swing comes over: +1 or -1, alternating. */
  swingSide: number;
  /** Whether this swing has already resolved its damage. */
  swingHit: boolean;
  /** 0..1, spikes on every shot and decays: the kick, and the shotgun's pump cycle. */
  recoil: number;

  // --- The utility slot. See `src/sim/items.ts`. ------------------------------
  /** What is in the one utility slot, or null. */
  item: ItemKind | null;
  /** Uses left on it. Only the welder ever has more than one. */
  itemCharges: number;
  /** Seconds of holding the item button so far, for the ones that are a dwell. */
  itemHold: number;
  /** Seconds of adrenaline left: faster, reloads quicker, and immune to the next grip. */
  adrenaline: number;

  // --- Light, and what has hold of you. --------------------------------------
  /**
   * Is the flashlight on? Off, you are nearly blind but nearly invisible; on, you can
   * see and every dead thing in the dark can see where you are looking from.
   */
  lightOn: boolean;
  /** Counts down to the next "there is a beam on in here" tell the dark can hear. */
  lightTell: number;
  /** Seconds of washed-out vision from an arc flash. Shrinks the cone to nothing. */
  blinded: number;
  /** What has hold of you, or null. See `Restraint`. */
  restraint: Restraint | null;

  cone: VisionLight;
  halo: VisionLight;
}

/**
 * A hostile. Today every one of them is a zombie — `kind` names the row in
 * `ZOMBIE_DEFS` it takes its numbers from, which is how a second kind arrives without
 * a second entity type. `Enemy` stays the faction word, `kind` is what it actually is.
 */
export interface Enemy {
  id: number;
  /** Key into ZOMBIE_DEFS. Stats are looked up, never copied, so a def edit is live. */
  kind: string;
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  radius: number;
  facing: number;
  health: number;
  maxHealth: number;
  /**
   * The zombie state machine.
   * - `hunt` — knows roughly where the squad is and is walking there, by flow field
   * - `wander` — shambling with no idea you exist
   * - `investigate` — walking to a noise or to where you last were
   * - `chase` — has you in sight and is closing
   * - `windup` — planted, telegraphing the leap. This is the window you dodge in
   * - `lunge` — committed to a direction, damage on contact
   * - `recover` — face down, cannot move or turn, takes extra damage
   *
   * And three more that only the mutants with an ability ever enter:
   * - `lurk`     — a Strangler holding its post in the dark, waiting for a line on you
   * - `reel`     — its tendril is in someone and it is pulling them in
   * - `stalk`    — a Stalker creeping the shadows toward somebody on their own
   * - `pounce`   — committed to the leap that ends on top of a player
   * - `pin`      — sitting on one, chewing, until it is shoved off or shot off
   * - `vent`     — up in the ducts, between two grates. Cannot be touched from the floor
   */
  state:
    | "wander" | "hunt" | "investigate" | "chase" | "windup" | "lunge" | "recover"
    | "lurk" | "reel" | "stalk" | "pounce" | "pin" | "vent";
  /**
   * Came in with a wave, so it has a heading. A horde that spawns and then mills about
   * is not a horde. Ambient wanderers do not get this — being oblivious is their job.
   */
  hunting: boolean;
  /** Seconds left in windup / lunge / recover. Unused in the other states. */
  stateTimer: number;
  /** Locked in at the end of the windup: a lunge does not steer. */
  lungeDirX: number;
  lungeDirY: number;
  /** Player id this zombie is currently interested in, or -1. */
  targetId: number;
  /** Where it is walking to when it cannot see you: last sighting, or a noise. */
  lastSeenX: number;
  lastSeenY: number;
  alertness: number;
  /** Seconds before it may wind up another leap. */
  attackCooldown: number;
  wanderAngle: number;
  /** Gait cycle, in radians, advanced by distance travelled. Presentation only. */
  walkPhase: number;
  /** Which stride of the gait last made a footfall, so one step is one noise. */
  lastStride: number;
  hurtFlash: number;

  // --- Strangler. Only a kind with a `tendril` def ever uses these. -----------
  /** How far the tendril is out, 0..1. Drives the draw and says whether one is flying. */
  tendrilOut: number;
  /** Player the tendril is in, or -1. */
  tendrilTargetId: number;
  /**
   * What is left of the tendril itself. It is deliberately soft: severing one is meant
   * to be the panicked answer a teammate can manage across a dark room, so it takes far
   * less than killing the thing on the other end of it.
   */
  tendrilHealth: number;
  /** Where it anchors its post, so a Strangler holds a corner instead of wandering off. */
  postX: number;
  postY: number;

  // --- Stalker. Only a kind with a `pounce` def ever uses these. --------------
  /** Player it is pinning, or -1. */
  pinTargetId: number;
  /** Seconds of flashlight blindness left. It cannot leap, and it moves badly. */
  blind: number;
  /** How long a beam has been held on it. Reaching `pounce.blind` blinds it. */
  litFor: number;
  /** Seconds left in the ducts. While this is running it is overhead, not in the room. */
  ventTimer: number;
  /** Where it climbed in, and the grate it is heading for. */
  ventFromX: number;
  ventFromY: number;
  ventToX: number;
  ventToY: number;
  /** Recomputed each step: is this enemy inside any player's vision right now? */
  visible: boolean;
}

export interface Bullet {
  active: boolean;
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  life: number;
  damage: number;
  team: Team;
  ownerId: number;
  color: string;
}

export interface Particle {
  active: boolean;
  x: number; y: number;
  vx: number; vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}
