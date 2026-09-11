import type { Player } from "./entities";

/**
 * CORE 19 — The utility slot.
 *
 * One primary weapon, one utility item. That is the whole inventory, and the cap is the
 * design: with two slots every pickup is a decision made out loud ("drop the medkit for
 * the welder?") and nothing needs a grid, a cursor, or a pause. Add a third slot and
 * you have an inventory screen, which is a different game.
 *
 * The pattern matches `src/sim/devices.ts` on purpose: this table says what an item IS,
 * and the world says what using one DOES. The player module only ever runs the dwell
 * clock and asks to spend a charge — it has no idea what a flare lights or what a weld
 * seals, which is what keeps a new item from needing a change in five files.
 */

export type ItemKind = "medkit" | "adrenaline" | "flare" | "welder";

export interface ItemDef {
  key: ItemKind;
  name: string;
  /** Uses one pickup carries. Only the welder brings more than one. */
  charges: number;
  /**
   * Seconds of holding the item button before it takes effect. A medkit is deliberately
   * long: patching someone up is a thing you need the room to be quiet for, and that is
   * the whole reason a welded door and a thrown flare are worth carrying.
   */
  hold: number;
  /** Short line under the slot in the HUD. */
  hint: string;
  color: string;
}

/** Fraction of max health a medkit puts back. */
export const MEDKIT_HEAL = 0.7;
/** How close a teammate has to be for a medkit to reach them instead of you. */
export const MEDKIT_REACH = 70;
/** Seconds of adrenaline. Short — it is an escape, not a loadout. */
export const ADRENALINE_TIME = 8;
export const ADRENALINE_SPEED = 1.28;
export const ADRENALINE_RELOAD = 0.6;
/** How long a thrown flare burns, and how far it lights. */
export const HANDFLARE_BURN = 20;
export const HANDFLARE_LIGHT = 330;
/** How far a flare travels when thrown, in world units. */
export const HANDFLARE_THROW = 260;
/** How much punishment a welded bulkhead takes before it comes off its frame. */
export const WELD_INTEGRITY = 260;

export const ITEMS: Record<ItemKind, ItemDef> = {
  medkit: {
    key: "medkit", name: "Medkit", charges: 1, hold: 3,
    hint: "hold to patch up — you, or whoever is standing next to you",
    color: "#ff7a9a",
  },
  adrenaline: {
    key: "adrenaline", name: "Adrenaline", charges: 1, hold: 0,
    hint: "instant: faster, reloads quicker, and tears you out of a grip",
    color: "#ffe66b",
  },
  flare: {
    key: "flare", name: "Flare", charges: 1, hold: 0,
    hint: "throw: lights a room for twenty seconds, no flashlight needed",
    color: "#ff9a4a",
  },
  welder: {
    key: "welder", name: "Welding tool", charges: 3, hold: 1.2,
    hint: "hold in a bulkhead to seal it shut behind you",
    color: "#7ad2ff",
  },
};

export function itemDef(kind: ItemKind): ItemDef {
  return ITEMS[kind];
}

/**
 * Put an item in the utility slot, replacing whatever was there. Dropping the old one
 * on the floor would need a pickup entity and a "which one do I want" prompt; a straight
 * swap keeps the decision at the cache, where the player can see both options.
 */
export function giveItem(p: Player, kind: ItemKind): void {
  p.item = kind;
  p.itemCharges = ITEMS[kind].charges;
  p.itemHold = 0;
}

/** Spend one charge, and empty the slot when the last one goes. */
export function spendCharge(p: Player): void {
  p.itemCharges -= 1;
  p.itemHold = 0;
  if (p.itemCharges <= 0) {
    p.item = null;
    p.itemCharges = 0;
  }
}
