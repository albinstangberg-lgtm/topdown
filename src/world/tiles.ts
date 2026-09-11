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
  /**
   * The extraction beacon. Stand on it to light it, which calls the helicopter and
   * starts the holdout — see the extraction section in `src/sim/world.ts`.
   */
  signal?: boolean;
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
  /**
   * A device you hold the interact button on. `terminal` reads a log, `socket` primes
   * the reactor, `locker` hands out the next weapon up. See `src/sim/devices.ts` — the
   * tile says what kind of thing it is, the device system says what using one does.
   */
  device?: "terminal" | "socket" | "locker" | "supply";
  /** True once a device has been used. Kept as a separate tile so a reload remembers. */
  spent?: boolean;
  /** What a device turns into once it has been used. */
  usedInto?: number;
  /**
   * A sealed blast door. Solid until the squad unseals it, which needs main power —
   * this is the wall Act II runs into and Act IV opens.
   */
  blastDoor?: boolean;
  /** Stairs that go DOWN rather than up. Purely how it is drawn and announced. */
  descends?: boolean;
  /**
   * A ceiling vent. The duct network is every vent on the floor, and a Stalker in it
   * is overhead rather than in the room — you hear it travelling, and a shot into the
   * grate is the only thing that can touch it up there. The tile itself is ordinary
   * floor: the vent is above you, not underfoot.
   */
  vent?: boolean;
  /**
   * Standing water. Touching flooded tiles gather into one puddle (the same way car
   * tiles gather into one car), and a puddle is what a cable electrifies.
   */
  flooded?: boolean;
  /** A live cable. Put a bullet in it and the puddle it touches goes live. */
  cable?: boolean;
  /** Leaks coolant: thick fog out to this radius in world units, through open floor. */
  coolant?: number;
  /** An open bulkhead. The welding tool turns it into `weldsInto`. */
  bulkhead?: boolean;
  /** What a welded bulkhead becomes. Solid, and the squad is behind it. */
  weldsInto?: number;
  /** A welded bulkhead: solid, and taking hits from whatever is on the other side. */
  welded?: boolean;
  /** What a welded bulkhead falls back to once it has been chewed open. */
  weldFailsInto?: number;
  /**
   * A supply cache. Walk onto it to take this utility item — the same walk-on device
   * a weapon locker is. Keys come from `ITEMS` in `src/sim/items.ts`; the union is
   * repeated here for the same reason `device` is, so this table imports nothing.
   */
  supply?: "medkit" | "adrenaline" | "flare" | "welder";
  /**
   * Which creature an enemy spawn puts down. Keys come from `ZOMBIE_DEFS` in
   * `src/sim/zombies.ts`; left out, a spawn tile places the default walker. This is
   * how the two mutants get onto a floor at all — neither is ever drawn at random,
   * because both of them are about the place they are standing.
   */
  enemyKind?: "walker" | "strangler" | "stalker";
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
  { id: 20, key: "signalFlare", name: "Signal flare", solid: false, opaque: false, signal: true,
    color: "#ff3b3b", glyph: "F",
    hint: "an unlit flare. Stand on it to light it, then hold the roof until the helicopter lands" },
  { id: 21, key: "terminal", name: "Terminal", solid: false, opaque: false,
    device: "terminal", usedInto: 22, light: 90,
    color: "#7affd2", glyph: "T",
    hint: "a crew terminal with a log still on it. Stand on it and hold USE to read it" },
  { id: 22, key: "terminalRead", name: "Terminal (read)", solid: false, opaque: false,
    device: "terminal", spent: true, light: 60,
    color: "#3f7a68", glyph: "t",
    hint: "a terminal whose log you have already read. Authored rarely — reading one makes it this" },
  { id: 23, key: "locker", name: "Weapon locker", solid: false, opaque: false,
    device: "locker", usedInto: 24, light: 80,
    color: "#ffb45c", glyph: "!",
    hint: "an armoury locker. Walk onto it to take the next weapon up from what you carry" },
  { id: 24, key: "lockerEmpty", name: "Weapon locker (empty)", solid: false, opaque: false,
    device: "locker", spent: true,
    color: "#6b5a3f", glyph: "i", hint: "a locker somebody has already emptied" },
  { id: 25, key: "socket", name: "Fusion socket", solid: false, opaque: false,
    device: "socket", usedInto: 26, light: 70,
    color: "#5ad2ff", glyph: "U",
    hint: "a reactor socket. Hold USE to seat a fusion cell — every socket on the floor primed brings main power back" },
  { id: 26, key: "socketPrimed", name: "Fusion socket (primed)", solid: false, opaque: false,
    device: "socket", spent: true, light: 200,
    color: "#8bff7a", glyph: "u", hint: "a socket with its cell seated and live" },
  { id: 27, key: "blastDoor", name: "Blast door", solid: true, opaque: true, blastDoor: true,
    color: "#c25a3a", glyph: "B",
    hint: "the bridge door. Dead without main power; with it, hold USE beside it and survive the unseal" },
  { id: 28, key: "stairsDown", name: "Stairs down", solid: false, opaque: false,
    stairs: true, descends: true,
    color: "#2f8fb8", glyph: "v",
    hint: "the way DOWN. Same rule as ^ — the whole squad on it moves to the next floor" },

  // --- The ship's own hazards, and the things that live in them ---------------

  { id: 29, key: "vent", name: "Ceiling vent", solid: false, opaque: false, vent: true,
    color: "#6f7c8c", glyph: "n",
    hint: "a duct grate overhead. Stalkers travel between vents; you hear one coming and can shoot it through the grate" },
  { id: 30, key: "water", name: "Flooded floor", solid: false, opaque: false, flooded: true,
    color: "#3d6b7a", glyph: "~",
    hint: "ankle-deep water. Touching tiles are one puddle — and a puddle is what a cable electrifies" },
  { id: 31, key: "cable", name: "Exposed cable", solid: true, opaque: false, blocksShots: true,
    cable: true,
    color: "#d8c24a", glyph: "=",
    hint: "a torn conduit. Shoot it and every flooded tile it touches goes live: cooks the horde, blinds anyone near it" },
  { id: 32, key: "coolant", name: "Coolant leak", solid: true, opaque: false, blocksShots: true,
    coolant: 190,
    color: "#9fe8d8", glyph: "%",
    hint: "a split coolant line. Fills the room with fog that kills vision cones dead — in there you navigate by sound" },
  { id: 33, key: "bulkhead", name: "Bulkhead door", solid: false, opaque: false, bulkhead: true,
    weldsInto: 34, prop: "door",
    color: "#8a8f9a", glyph: "H",
    hint: "an open bulkhead. Stand in it with a welding tool and hold USE to seal it behind you" },
  { id: 34, key: "bulkheadWelded", name: "Bulkhead (welded)", solid: true, opaque: true,
    welded: true, weldFailsInto: 33, prop: "door",
    color: "#c9a23a", glyph: "h",
    hint: "a bulkhead welded shut. Solid — but whatever is on the other side will chew through it eventually" },

  // --- Supply caches. One row per item; they all empty into the same box --------

  { id: 35, key: "medkitCache", name: "Medkit cache", solid: false, opaque: false,
    device: "supply", supply: "medkit", usedInto: 39, light: 60,
    color: "#ff7a9a", glyph: "+",
    hint: "a first-aid box. Walk onto it to take a medkit into your utility slot" },
  { id: 36, key: "adrenalineCache", name: "Adrenaline cache", solid: false, opaque: false,
    device: "supply", supply: "adrenaline", usedInto: 39, light: 60,
    color: "#ffe66b", glyph: "j",
    hint: "a stim locker. Walk onto it to take an adrenaline shot" },
  { id: 37, key: "flareCache", name: "Flare cache", solid: false, opaque: false,
    device: "supply", supply: "flare", usedInto: 39, light: 60,
    color: "#ff9a4a", glyph: "k",
    hint: "a box of hand flares. Walk onto it to take one you can throw" },
  { id: 38, key: "welderCache", name: "Welder cache", solid: false, opaque: false,
    device: "supply", supply: "welder", usedInto: 39, light: 60,
    color: "#7ad2ff", glyph: "y",
    hint: "a maintenance kit. Walk onto it to take a welding tool and its three charges" },
  { id: 39, key: "cacheEmpty", name: "Supply cache (empty)", solid: false, opaque: false,
    device: "supply", spent: true,
    color: "#5a5f68", glyph: "x", hint: "a cache somebody has already emptied" },

  // Placed mutants. Neither is ever drawn at random — see `weight: 0` in ZOMBIE_DEFS.
  { id: 40, key: "stranglerSpawn", name: "Strangler", solid: false, opaque: false,
    spawn: "enemy", enemyKind: "strangler",
    color: "#8f6f9a", glyph: "S",
    hint: "one Strangler, holding this exact spot. Put it in a dark corner with a long line down a corridor" },
  { id: 41, key: "stalkerSpawn", name: "Stalker", solid: false, opaque: false,
    spawn: "enemy", enemyKind: "stalker",
    color: "#5c6f7a", glyph: "s",
    hint: "one Stalker. It will take the ducts and come back at whoever is on their own" },
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
