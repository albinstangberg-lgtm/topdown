/**
 * CORE 3c — The tile registry.
 *
 * Every number in a level grid is looked up here. Adding a new tile type to the game
 * is ONE entry in this table: the collision, the vision, the renderer, the editor
 * palette and the level validator all read from it, so nothing else has to change.
 *
 * `solid`, `opaque` and `blocksShots` are deliberately separate, because they are three
 * different questions: can a body pass, can a look pass, can a bullet pass. Glass blocks
 * movement but not sight; a gap in the floor blocks movement but neither sight nor
 * shots; smoke would block sight but neither of the others. Collapsing them into one
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
  /** Stops bullets and ends the aim laser. Defaults to `solid` when left out. */
  blocksShots?: boolean;
  /** Tile id this turns into when a bullet passes through it. Glass shatters. */
  breaksInto?: number;
  spawn?: SpawnKind;
  /** Emits a static light at the centre of the tile, with this radius in world units. */
  light?: number;
  /** Standing on this with the whole squad completes a story mission. */
  exit?: boolean;
  /** Standing on this with the whole squad moves the mission to its next floor. */
  stairs?: boolean;
  /** Purely visual variant — the renderer draws it as furniture, not as a wall face. */
  prop?: "car" | "reception" | "cubicle" | "door";
  /**
   * Shooting this sets off a car alarm: a wave from every door and twenty seconds of
   * noise pulling the floor toward it. Once per car — the tile is spent afterwards and
   * becomes whatever `alarmSpent` names.
   */
  alarm?: boolean;
  /** What an alarm tile turns into once it has gone off. */
  alarmSpent?: number;
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
  { id: 5, key: "glass", name: "Glass", solid: true, opaque: false, blocksShots: false, breaksInto: 17,
    color: "#5ad2ff", glyph: "G",
    hint: "see and shoot straight through it, but you cannot walk through — until a bullet shatters it" },
  { id: 6, key: "lamp", name: "Lamp", solid: false, opaque: false, light: 250,
    color: "#ffe9b0", glyph: "L", hint: "static light — permanently lit area, computed once on load" },
  { id: 7, key: "exit", name: "Exit", solid: false, opaque: false, exit: true,
    color: "#8bff7a", glyph: ">", hint: "the safe room. Get the whole squad standing on it to finish the mission" },
  { id: 8, key: "spawnZone", name: "Spawn zone", solid: false, opaque: false, spawn: "zone",
    color: "#9a5ad2", glyph: "Z", hint: "the director draws from these, picking a different one each time and never in sight" },
  { id: 9, key: "stairs", name: "Stairs / next floor", solid: false, opaque: false, stairs: true,
    color: "#5ad2ff", glyph: "^", hint: "the way up. Get the whole squad on it to move to the next floor" },
  { id: 10, key: "car", name: "Car", solid: true, opaque: true, prop: "car",
    color: "#7a4a4a", glyph: "C", hint: "a wreck. Blocks movement and sight, so it is cover" },
  { id: 11, key: "window", name: "Window", solid: true, opaque: false, blocksShots: false,
    breaksInto: 18, spawn: "zone", prop: "door",
    color: "#5ad2ff", glyph: "W",
    hint: "see and shoot through, nobody walks through — until a bullet smashes it. Zombies climb in here either way" },
  { id: 12, key: "reception", name: "Reception desk", solid: true, opaque: false, prop: "reception",
    color: "#8a6a3a", glyph: "R", hint: "waist-high counter: blocks bodies, you see and shoot over it" },
  { id: 13, key: "cubicle", name: "Cubicle wall", solid: true, opaque: true, prop: "cubicle",
    color: "#4a5a4a", glyph: "c", hint: "office partition. Blocks movement and sight (note: lowercase c)" },
  { id: 14, key: "flare", name: "Flare", solid: false, opaque: false, light: 300,
    color: "#ff7a4a", glyph: "f", hint: "a burning flare — a big red static light you can stand on" },
  { id: 15, key: "elevator", name: "Elevator door", solid: true, opaque: true, prop: "door",
    color: "#3a4a5a", glyph: "D", hint: "closed lift doors. Scenery — use ^ for the floor you can actually take" },
  { id: 16, key: "blocked", name: "Blocked floor", solid: true, opaque: false, blocksShots: false,
    color: "#8f8a78", glyph: "_",
    hint: "looks like floor and lit like it, but nobody walks on it. Sight and bullets pass straight over — shape rooms with it" },
  { id: 17, key: "brokenGlass", name: "Broken glass", solid: false, opaque: false,
    color: "#9fd8ea", glyph: "g",
    hint: "what glass leaves behind: an open hole you can walk through. Rarely authored by hand" },
  { id: 18, key: "brokenWindow", name: "Broken window", solid: false, opaque: false, spawn: "zone",
    color: "#7fc4dd", glyph: "w",
    hint: "a smashed window: walk straight through it, and it is STILL a way in for the director" },
  { id: 19, key: "alarmCar", name: "Alarmed car", solid: true, opaque: true, prop: "car",
    alarm: true, alarmSpent: 10,
    color: "#c25a3a", glyph: "A",
    hint: "a wreck with a live alarm. Put a bullet in it and every door on the floor opens at once — once" },
];

export const TILE_FLOOR = 0;
export const TILE_WALL = 1;

/** Bullets follow `blocksShots`, which falls back to `solid` for every ordinary tile. */
export function stopsShots(def: TileDef): boolean {
  return def.blocksShots ?? def.solid;
}

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
