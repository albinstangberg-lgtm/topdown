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
  device?: "terminal" | "socket" | "locker" | "supply" | "lever" | "hack";
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
   * A rack of something heavy. Walk onto it with empty hands and you pick one up in
   * both of them — see `CarryKind` in `src/sim/entities.ts`. Racks are not spent: the
   * scarcity of a fusion core is the walk back across the deck with it, not the supply.
   */
  dispense?: "core" | "battery";
  /** Stand on it to put charge back into your suit. */
  charger?: boolean;
  /**
   * An emergency depressurisation lever. Pull it and the room blows down through the
   * nearest breach for a few seconds — see the breach system in `src/sim/world.ts`.
   * Once per lever: it becomes `usedInto` afterwards, like every other spent device.
   */
  breachLever?: boolean;
  /**
   * Where the air goes. A hole in the hull: the thing a depressurisation drags
   * everything toward, and the thing that throws a walker off the ship entirely.
   */
  breach?: boolean;
  /**
   * Floor inside an airlock chamber. Touching airlock tiles gather into one chamber
   * the way flooded tiles gather into one puddle, and the chamber is what cycles.
   */
  airlock?: boolean;
  /**
   * An airlock door. Open as authored; the chamber makes it solid for the length of a
   * cycle and opens it again afterwards, by swapping to `shutInto` and back.
   */
  airlockDoor?: boolean;
  /** What an airlock door becomes while it is shut, and what that becomes when it opens. */
  shutInto?: number;
  opensInto?: number;
  /**
   * Something bolted down hard enough to hold on to. Standing on one anchors you
   * against a depressurisation — which is what makes a breach a plan rather than a
   * coin flip, because the railings are drawn on the map and you can see them.
   */
  railing?: boolean;
  /**
   * What a hack console opens when somebody beats it. `door` throws every mag-lock on
   * the floor; `turret` kills the power to every turret on it. Floor-wide on purpose —
   * the same rule a fusion socket uses — because a console wired to one door across the
   * deck is a wiring diagram the player cannot see.
   */
  hack?: "door" | "turret";
  /**
   * A mag-locked door. Solid and opaque until a console says otherwise, at which point
   * it becomes `unlocksInto` — in the grid, so a floor that reloads stays open.
   */
  magLock?: boolean;
  unlocksInto?: number;
  /**
   * An automated floor turret. It sweeps, it sights, and then it fires — and it does
   * not care which side you are on, which is the only reason shooting one is ever the
   * wrong answer. `deadInto` is what it becomes once the power is cut.
   */
  turret?: boolean;
  deadInto?: number;
  /**
   * Which creature an enemy spawn puts down. Keys come from `ZOMBIE_DEFS` in
   * `src/sim/zombies.ts`; left out, a spawn tile places the default walker. This is
   * how the two mutants get onto a floor at all — neither is ever drawn at random,
   * because both of them are about the place they are standing.
   */
  enemyKind?: "walker" | "strangler" | "stalker" | "lurker";
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

  // Heavy things, and the wall socket that pays for the rest of it ----------------

  { id: 42, key: "coreRack", name: "Fusion core rack", solid: false, opaque: false,
    dispense: "core", light: 70,
    color: "#8bff7a", glyph: "O",
    hint: "a rack of fusion cores. Walk on with empty hands to shoulder one — both hands, so your rifle goes away" },
  { id: 43, key: "batteryRack", name: "Battery rack", solid: false, opaque: false,
    dispense: "battery", light: 70,
    color: "#7ad2ff", glyph: "b",
    hint: "spare suit cells. Carry one to a teammate and hold USE beside them to swap it in" },
  { id: 44, key: "charger", name: "Charging point", solid: false, opaque: false,
    charger: true, light: 110,
    color: "#5affd2", glyph: "e",
    hint: "a live socket. Stand on it to put charge back into your suit — slowly, and in the open" },

  // Vacuum. A lever, a hole, and something to hold on to -------------------------

  { id: 45, key: "breachLever", name: "Breach lever", solid: false, opaque: false,
    device: "lever", breachLever: true, usedInto: 46, light: 80,
    color: "#ffd257", glyph: "Y",
    hint: "emergency depressurisation. Hold USE to blow the room down through the nearest hull breach — once" },
  { id: 46, key: "breachLeverSpent", name: "Breach lever (pulled)", solid: false, opaque: false,
    device: "lever", spent: true,
    color: "#6b5a3f", glyph: "\\",
    hint: "a lever somebody has already pulled" },
  { id: 47, key: "breach", name: "Hull breach", solid: false, opaque: false, breach: true,
    color: "#1a1f3a", glyph: "@",
    hint: "a hole in the hull, plated over. A lever opens it: everything loose in the room goes that way" },
  { id: 48, key: "railing", name: "Railing", solid: false, opaque: false, railing: true,
    color: "#9aa3ae", glyph: "|",
    hint: "bolted down. Stand on it and a depressurisation cannot drag you off your feet" },

  // Airlocks. Two at a time, five seconds, and the rest of you waiting outside --------

  { id: 49, key: "airlock", name: "Airlock chamber", solid: false, opaque: false,
    airlock: true,
    color: "#6f8fae", glyph: ":",
    hint: "chamber floor. Two people fit; a third stays outside while it equalizes. Wall it with airlock doors" },
  { id: 50, key: "airlockDoor", name: "Airlock door", solid: false, opaque: false,
    airlockDoor: true, shutInto: 51, prop: "door",
    color: "#8fb6d8", glyph: "]",
    hint: "an airlock door, open. The chamber shuts both of them for the length of a cycle" },
  { id: 51, key: "airlockShut", name: "Airlock door (shut)", solid: true, opaque: true,
    airlockDoor: true, opensInto: 50, prop: "door",
    color: "#41627f", glyph: "[",
    hint: "an airlock door mid-cycle. Rarely authored — the chamber makes these" },

  // Consoles, mag-locks and the guns the ship points at its own corridors ------------

  { id: 53, key: "hackConsole", name: "Hack console", solid: false, opaque: false,
    device: "hack", hack: "door", usedInto: 55, light: 90,
    color: "#63e0ff", glyph: "*",
    hint: "a door override. Hold USE to sit down at it — and go completely blind for as long as you are in it" },
  { id: 54, key: "turretConsole", name: "Turret console", solid: false, opaque: false,
    device: "hack", hack: "turret", usedInto: 55, light: 90,
    color: "#ffa9f0", glyph: "&",
    hint: "fire-control for every turret on the deck. Same deal: you are in the screen, and blind in the room" },
  { id: 55, key: "hackConsoleSpent", name: "Console (bypassed)", solid: false, opaque: false,
    device: "hack", spent: true,
    color: "#4a5a63", glyph: ",",
    hint: "a console somebody has already beaten" },
  { id: 56, key: "magLock", name: "Mag-locked door", solid: true, opaque: true,
    magLock: true, unlocksInto: 57, prop: "door",
    color: "#3f7fa8", glyph: "M",
    hint: "sealed by the deck's lock system. No amount of shooting opens it — find the console" },
  { id: 57, key: "magLockOpen", name: "Mag-lock (released)", solid: false, opaque: false,
    prop: "door",
    color: "#7fd4ff", glyph: "m",
    hint: "a mag-lock that has been thrown. Rarely authored — a console makes these" },
  { id: 58, key: "turret", name: "Floor turret", solid: true, opaque: false, blocksShots: false,
    turret: true, deadInto: 59, light: 40,
    color: "#ff6b5c", glyph: "Q",
    hint: "an automated gun on a post. It sweeps, it sights you, then it fires — cut its power at a turret console" },
  { id: 59, key: "turretDead", name: "Floor turret (dead)", solid: true, opaque: false, blocksShots: false,
    color: "#5a4a48", glyph: "q",
    hint: "a turret with its power cut. Cover now, and nothing else" },

  // Placed mutants. Neither is ever drawn at random — see `weight: 0` in ZOMBIE_DEFS.
  { id: 40, key: "stranglerSpawn", name: "Strangler", solid: false, opaque: false,
    spawn: "enemy", enemyKind: "strangler",
    color: "#8f6f9a", glyph: "S",
    hint: "one Strangler, holding this exact spot. Put it in a dark corner with a long line down a corridor" },
  { id: 41, key: "stalkerSpawn", name: "Stalker", solid: false, opaque: false,
    spawn: "enemy", enemyKind: "stalker",
    color: "#5c6f7a", glyph: "s",
    hint: "one Stalker. It will take the ducts and come back at whoever is on their own" },
  { id: 52, key: "lurkerSpawn", name: "Ceiling Lurker", solid: false, opaque: false,
    spawn: "enemy", enemyKind: "lurker",
    color: "#6a5c7a", glyph: "l",
    hint: "one Ceiling Lurker. Needs vents to live in — it drops on anyone who stands still under an unlit grate" },
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
