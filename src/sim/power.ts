import type { Player, WeaponDef } from "./entities";
import { WEAPONS } from "./entities";

/**
 * CORE 20 — One battery for the whole suit.
 *
 * Guns on this ship do not eat boxes of brass. They draw off the same cell that runs
 * your flashlight and your welding tool, and that single shared number is the point:
 * every question the deck asks you becomes a question about power.
 *
 *   - Reload a shotgun and you have spent a minute of light.
 *   - Walk with the beam on and you are spending the magazine you have not fired yet.
 *   - Fire, and for two seconds the cone dips as power diverts to the weapon — so the
 *     choice "shoot it yourself" versus "hold the light steady for whoever can" is a
 *     real one, made in the dark, out loud, at the worst moment.
 *
 * The design rule that keeps it from being miserable: **the crowbar and the halo are
 * free.** A flat suit is dark and dangerous, not unplayable — you still have a body,
 * a bar of metal, and just enough glow to see your own boots. Running out is a scene,
 * not a soft lock, and everything in here is arranged to protect that.
 */

/** Charge a full cell holds. Everything else is quoted against this. */
export const BATTERY_MAX = 100;
/**
 * Charge per second the flashlight costs. A fresh cell is about four and a half minutes
 * of pure light with no shooting — enough to cross a deck, not enough to search one
 * twice, which is why lamps and thrown flares are worth going out of your way for.
 */
export const LIGHT_DRAIN = 0.35;
/** Seconds of dimmed cone after a shot, and how far down it dips. */
export const DIP_TIME = 2;
export const DIP_FLOOR = 0.45;
/** What sealing a bulkhead costs. A welded door is most of a magazine. */
export const WELD_DRAW = 22;
/** What a charging point puts back per second while you stand on it. */
export const CHARGER_RATE = 14;
/** How much charge a carried battery cell holds when it is full. */
export const CELL_CHARGE = 70;
/** How close a teammate has to be to take a cell out of your hands. */
export const HANDOVER_RANGE = 62;

/**
 * The weapon a player can actually use right now.
 *
 * Three things put the primary away, and all of them leave the fallback melee: both
 * hands full, a magazine with nothing behind it, or a flat suit. This is the one place
 * that decides it, so the HUD, the firing code and the renderer can never disagree
 * about what is in somebody's hands.
 */
export function activeWeapon(p: Player): WeaponDef {
  if (p.carrying !== null) return p.sidearm;
  if (p.weapon.melee) return p.weapon;
  // A loaded magazine works on a dead suit — the charge went in when you reloaded.
  if (p.ammo > 0) return p.weapon;
  if (p.battery >= roundsWorth(p.weapon, 1)) return p.weapon;
  return p.sidearm;
}

/** Whether the primary is currently stowed, for the HUD to say so. */
export function primaryStowed(p: Player): boolean {
  return activeWeapon(p) !== p.weapon;
}

/** Charge `rounds` rounds of this weapon cost. Zero for anything that swings. */
export function roundsWorth(w: WeaponDef, rounds: number): number {
  return (w.draw ?? 0) * rounds;
}

/**
 * Fill a magazine out of the suit. Returns how many rounds actually went in, which is
 * what makes a nearly-flat battery feel the way it should: you get a short magazine and
 * you know exactly why.
 */
export function drawMagazine(p: Player): number {
  const w = p.weapon;
  if (w.magazine <= 0) return 0;
  const per = w.draw ?? 0;
  const wanted = w.magazine - p.ammo;
  if (wanted <= 0) return 0;
  if (per <= 0) {
    p.ammo = w.magazine;
    return wanted;
  }
  const affordable = Math.min(wanted, Math.floor(p.battery / per));
  if (affordable <= 0) return 0;
  p.battery = Math.max(0, p.battery - affordable * per);
  p.ammo += affordable;
  return affordable;
}

/** Put charge back in, capped. Returns what was actually accepted. */
export function charge(p: Player, amount: number): number {
  const room = p.maxBattery - p.battery;
  const taken = Math.min(room, amount);
  p.battery += taken;
  return taken;
}

/** Spend charge if there is enough of it. */
export function spendPower(p: Player, amount: number): boolean {
  if (p.battery < amount) return false;
  p.battery -= amount;
  return true;
}

/** The fallback every suit comes with. A crowbar in a bracket on the back. */
export function defaultSidearm(): WeaponDef {
  return WEAPONS.crowbar;
}
