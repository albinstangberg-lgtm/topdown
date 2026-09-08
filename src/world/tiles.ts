/**
 * CORE 3c — The tile registry.
 *
 * Every number in a level grid is looked up here. Adding a new tile type to the game
 * is ONE entry in this table: the collision, the vision, the renderer, the editor
 * palette and the level validator all read from it, so nothing else has to change.
 *
 * `solid` and `opaque` are deliberately separate. Glass blocks movement but not sight;
 * a future smoke tile would block sight but not movement. Collapsing them into one
 * "blocking" flag is the kind of shortcut that costs a refactor later.
 */

export type SpawnKind = "player" | "enemy" | "zone";

export interface TileDef {
  id: number;
  /** Stable string key — what a level file uses if it prefers names over numbers. */
  key: string;
  name: string;
  solid: boolean;
  opaque: boolean;
  spawn?: SpawnKind;
  /** Emits a static light at the centre of the tile, with this radius in world units. */
  light?: number;
  /** Standing on this with the whole squad completes a story mission. */
  exit?: boolean;
  /** Editor palette colour. */
  color: string;
  /** Single character for the compact text form of a level. */
  glyph: string;
  hint: string;
}

export const TILE_DEFS: readonly TileDef[] = [
  { id: 0, key: "floor", name: "Floor", solid: false, opaque: false,
    color: "#cfc9b4", glyph: ".", hint: "walkable, lit by whatever reaches it" },
  { id: 1, key: "wall", name: "Wall", solid: true, opaque: true,
    color: "#15161f", glyph: "#", hint: "blocks movement and sight — casts shadows" },
  { id: 2, key: "player", name: "Player spawn", solid: false, opaque: false, spawn: "player",
    color: "#ffd257", glyph: "P", hint: "players spawn here in order; falls back to open floor" },
  { id: 3, key: "enemy", name: "Zombie", solid: false, opaque: false, spawn: "enemy",
    color: "#ff6b6b", glyph: "E", hint: "one zombie, placed here at map start. Never respawns" },
  { id: 4, key: "crate", name: "Crate", solid: true, opaque: true,
    color: "#6b5334", glyph: "X", hint: "cover — same rules as a wall, drawn as a block" },
  { id: 5, key: "glass", name: "Glass", solid: true, opaque: false,
    color: "#5ad2ff", glyph: "G", hint: "blocks movement, NOT sight — you can see (and shoot past) through it" },
  { id: 6, key: "lamp", name: "Lamp", solid: false, opaque: false, light: 250,
    color: "#ffe9b0", glyph: "L", hint: "static light — permanently lit area, computed once on load" },
  { id: 7, key: "exit", name: "Exit", solid: false, opaque: false, exit: true,
    color: "#8bff7a", glyph: ">", hint: "the safe room. Get the whole squad standing on it to finish the mission" },
  { id: 8, key: "spawnZone", name: "Spawn zone", solid: false, opaque: false, spawn: "zone",
    color: "#9a5ad2", glyph: "Z", hint: "the director draws from these, picking a different one each time and never in sight" },
];

export const TILE_FLOOR = 0;
export const TILE_WALL = 1;

const BY_ID = new Map(TILE_DEFS.map((t) => [t.id, t]));
const BY_KEY = new Map(TILE_DEFS.map((t) => [t.key, t]));
const BY_GLYPH = new Map(TILE_DEFS.map((t) => [t.glyph, t]));

/** Unknown ids fall back to floor rather than throwing — a typo should not brick a level. */
export function tileDef(id: number): TileDef {
  return BY_ID.get(id) ?? TILE_DEFS[TILE_FLOOR];
}

export function isKnownTile(id: number): boolean {
  return BY_ID.has(id);
}

export function tileByKey(key: string): TileDef | undefined {
  return BY_KEY.get(key);
}

export function tileByGlyph(glyph: string): TileDef | undefined {
  return BY_GLYPH.get(glyph);
}
