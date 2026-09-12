import { parseLevelText, type LevelData } from "../world/level";
import { WEAPONS, type WeaponDef } from "../sim/entities";

/**
 * CORE 17 — The campaign.
 *
 * A mission is a hand-made map plus two things the map itself does not know: where it
 * sits on the mission select screen, and what you must have finished before it opens.
 * Unlocks are expressed as requirements rather than a linear list, so the campaign is a
 * graph — one mission can open two, and a later one can wait for both.
 *
 * The maps are glyph art on purpose. It is the same importer the editor and the game
 * use, so anything you paint in the editor can be pasted straight in here.
 *
 *   # wall   . floor      P player spawn   E zombie (placed)   Z spawn zone
 *   X crate  G glass      L lamp           > exit                ^ stairs / next floor
 *   C car    W window     R reception      c cubicle (lowercase)  f flare   D lift door
 *   F signal flare (the extraction beacon — see the finale in `src/sim/world.ts`)
 *   T terminal (a log)    ! weapon locker  U fusion socket        B blast door
 *   v stairs DOWN — the same rule as ^, drawn and announced as a descent
 *
 * A floor can be a bare map string, or a `FloorSpec` when it needs the two things a
 * grid of tile ids cannot say: how hard the director should lean on it, and what the
 * terminals on it say. That is the same split the mission itself is built on — the map
 * is the map, and everything the map cannot know sits beside it.
 */

/**
 * A floor with something to say beyond its geometry. Every field is optional: a floor
 * that needs none of them is written as a bare map string and behaves exactly as floors
 * always did.
 */
export interface FloorSpec {
  /** The map itself — anything `parseLevelText` accepts, usually glyph art. */
  map: string;
  /** Overrides the default "Mission · Floor N" name. */
  name?: string;
  /**
   * How hard the director leans here, as a multiple of the mode's tuning. This is the
   * campaign's difficulty curve: a mission gets heavier floor by floor, which is what
   * makes the second walk through a reused map a different fight from the first.
   */
  pressure?: number;
  /** Unlit even by this game's standards — the reactor decks. Presentation only. */
  blackout?: boolean;
  /**
   * Crew logs, one per terminal on the floor in reading order (top to bottom, left to
   * right). Kept here rather than on the tile because a tile id cannot carry a
   * paragraph, and because the story belongs to the mission, not to the grid.
   */
  logs?: string[];
}

export type Floor = string | FloorSpec;

export interface Mission {
  id: string;
  name: string;
  brief: string;
  /** Position on the mission select screen, normalised 0..1. */
  node: { x: number; y: number };
  /** Mission ids that must be complete first. Empty means available from the start. */
  requires: string[];
  /**
   * The floors of the mission, in the order they are played. Most missions are one
   * floor; a building or a ship is several, joined by stairs tiles, played as one
   * continuous run. "Bottom first" is only a convention — `v` tiles go down.
   */
  floors: Floor[];
  /**
   * What the squad starts the mission carrying. Missions that do not say get the
   * default SMG, which is what every mission written before loadouts existed expects.
   * A mission that hands out a crowbar is a mission about finding a gun.
   */
  loadout?: WeaponDef;
}

export interface Campaign {
  id: string;
  name: string;
  missions: Mission[];
}

export const CAMPAIGN: Campaign = {
  id: "sector-7",
  name: "Sector 7",
  missions: [
    {
      id: "tower",
      name: "Vertical Slice",
      brief: "Six floors, bottom to roof. Light the flare, then hold it for two minutes.",
      node: { x: 0.1, y: 0.5 },
      requires: [],
      floors: [
`
#############
#...........#
#....E......#
#..........Z#
#...........#
#.....E.....#
#...........#
#....X......#
#...........#
#......PP...#
#......PP...#
#...........#
#....E....X.#
#.###.......#
#.##^.......#
#.###.......#
#...........#
#Z....E.....#
#...........#
#..X.......Z#
#############
`,
`
#############
#......#..PP#
#..E...#..PP#
#...........#
#......#....#
#..Z...#..E.#
########....#
#......#....#
#...E..#..Z.#
#...........#
#......#....#
#..X...#..E.#
########....#
#......#....#
#..Z...#.X..#
#...E..#....#
##.##.##....#
#...........#
#.....E.....#
#^.........Z#
#############
`,
`
_________ZZZZZZZZZZZZ_____________
_________............_____________
_________............_____________
#########...CC.......#############
________#...CC.......#......#..PP#
________#...CC.......#......#..PP#
________#........AA..#...........#
________#........AA.............Z#
________#........AA..#......#...Z#
________#............#......#....#
________#............########....#
________#............#......#....#
________^............#...........#
________^........................#
________#............#......#....#
________#............#......#....#
________#............#......#....#
________#............########....#
________#...AA...................#
________#...AA.......#...........#
________#...AA.......#......#...Z#
________#............#......#...Z#
________#.......CC...#......#....#
#########.......CC...#############
________........CC....____________
________..............____________
_________ZZZZZZZZZZZZ_____________
`,
`
#####^##^#####
#............#
#..E.........#
####.........#
#..#......E..#
#..#.........#
#..#.........#
####....E....#
#........R...#
WZ.......RPPZW
WZ.......RPPZW
#........R...#
####.........#
#..#.........#
#..#...E.....#
#..#.........#
#..#.........#
####.........#
#............#
#.....ZZ..E..#
######WW######
`,
`
#####D##D#####
#c..........c#
#c....E.....c#
#c..c....c..c#
#cccc....cccc#
WZ..........ZW
WZ....E.....ZW
#..cc....cc..#
#...c....c...#
#...c..E.c...#
#cccc....cccc#
WZ..........ZW
WZ...E......ZW
WZ..........ZW
#cccc.......ZW
#...c.....ccc#
#...c..E..c.c#
#..cc.....c.c#
#...........c#
#.....E.....c#
####WW^^WW####
`,
`
######################
#...ZZZ........ZZZ...#
#....................#
#..##.....>>>.....##.#
#..##.....>>>.....##.#
#....E....>F>....E...#
#....................#
#Z...X.........X....Z#
#Z...X....E....X....Z#
#Z..................Z#
#....................#
#...L....E.....L.....#
#....................#
#..X..............X..#
#..X..............X..#
#....................#
#....................#
#..###..####...#.##..#
#..#..PP..#...#..#...#
#..#..PP..#...#..#...#
#..#ZZ....#...#ZZ#...#
######################
`,
      ],
    },
    {
      id: "derelict",
      name: "Dead in Space",
      brief:
        "Cryo-sleep sickness, a dead ship and a crowbar. Reach the bridge, and everything " +
        "between you and it.",
      node: { x: 0.1, y: 0.17 },
      requires: [],
      // The one mission that starts you with no gun. The armoury on the guard station is
      // the first one on the ship, and finding it is the whole of the first act.
      loadout: WEAPONS.crowbar,
      floors: [
      {
        // Act I. Melee only, and the ship is a black room you woke up in.
        name: "Cryo Bay",
        pressure: 0.5,
        logs: [
          "MED-03 // DAY 611. Third revival cycle aborted. Post-cryo amnesia is normal at eighteen months. At forty it is not. Nobody in Bay 2 could name the ship. Sedated four, restrained two. The Chief says hold course. — Ndiaye, Medical",
        ],
        map: `
##############################
#..............#.............#
#.XX..XX..XX...#..XX..XX..XX.#
#.XX..XX..XX...#..XX..XXE.XX.#
#..............#.............#
#...PP.........#......+......#
#...PP.....E...#.........T...#
#...e..........#.............#
#####.##########H#####.#######
#............................#
#...E........................#
#...................E........#
#............................#
###.####.##########.##########
#.....#..........#...........#
#..Z..#...^^.....#.....ZZ....#
#..Z..#...^^.....#...E.......#
#..n..#..........#...........#
#.....#..........#...........#
##############################
`,
      },
      {
        // Act I. The armoury: the first gun on the ship, and the security desk log.
        name: "Guard Station",
        pressure: 0.75,
        logs: [
          "SEC-01 // DAY 640, recovered from a corrupted daily. Muster failed: thirty-one of forty-four. Deck 4 reports crew climbing into the vents to get away from the light. I have issued weapons against standing orders. This is not a virus. It is not behaving like one. — Vasquez, Security",
        ],
        map: `
##############################
#........#..........#........#
#..PP....#....E.....#....Z...#
#..PP....#...RR.....#....Z...#
#........G...RR.....G........#
#........G..........G........#
#........#..........#........#
####.#######......#######.####
#............................#
#....E..................E....#
#Z..............E............#
#Z........................S..#
####.#########.##########.####
#.......#...........#........#
#.!.....#...........#...k....#
#.!.....#...........#....E...#
#.b.....#...E.......#........#
#....T..#...........#....^^..#
#.......#...ZZ......#....^^..#
##############################
`,
      },
      {
        // Act II. Cabins and vents, on the way up to the bridge.
        name: "Residential Deck",
        pressure: 1.0,
        logs: [
          "PERS-17 // DAY 658. They stopped talking on Tuesday. Not stopped — changed. Something underneath the words. Adeyemi went down to Engineering and came back wrong, and taller. I am locking my cabin. If you find this: do not open a door to be polite. — unsigned",
        ],
        map: `
##############################
#.ZZ..#.....#.....#..ZZ.#....#
#.....#.....#.....#..X..#.E..#
#..X..#..n..#.....#.....#....W
W.....#.....#..E..#.....#..T.#
#.....#..X..#..l..#.....#....#
#.....#.....#..n..#.....#....#
###.#####.#####.#####.####.###
#............................#
WPP......E................^^.W
WPP.................E.....^^.W
#............................#
#.####.#####.#####.#####.#####
#..#.....#.....#.....#.....###
#..#.....#..s..#.E...#.....###
#..#..E..#.....#.....#.....##W
W..#..n..#.....#..X..#..E..###
#..#.....#.....#.....#.....###
#..#.....#....ZZ.....#.....###
##############################
`,
      },
      {
        // Act II. The wall. The blast door is dead, the only way on is down, and the
        // way down is a two-person airlock: the squad arrives at the approach in pairs.
        name: "Bridge Approach",
        pressure: 1.2,
        map: `
##############################
##############################
##############################
##############################
############BBBBBB############
#Z.......###......###.......Z#
#Z..E....###......###.......Z#
#............................#
#........###......###........#
#........###..E...###....E...#
#........#####]]#####........#
##############::##############
#.vv..........]].............#
#.vv..........y.........T....#
#.....E......................#
#.....................E......#
#.........E..................#
#............PP..............#
#.ZZ.........PP...........ZZ.#
##############################
`,
      },
      {
        // Act III. Blackout, and the long walk down.
        name: "Engineering",
        pressure: 1.35,
        blackout: true,
        logs: [
          "ENG-08 // DAY 663. I killed the mains myself. It listens for the light — every deck we lit, we lost. The batteries will hold the cryo bay for maybe three years. Whoever wakes up: the reactor takes three cells, by hand, one at a time. I am sorry about what that will bring up out of the dark. — Sokolov, Chief Engineer",
        ],
        map: `
##############################
#............PP..............#
#......E.....PP..............#
#...XXX....XXX....XXX....XXX.#
#...XXX....XXX....XXX....XXX.#
#...XXX....XXX....XXX....XXX.#
#Z...........................#
#Z...................E.......#
#............................#
###.##########.##########.####
#.b............#....%%.......#
#.e...E........#............Z#
#.T.......j.................Z#
#...XXX....XXX.#..XXX....XXX.#
#...XXX....XXX.#..XXX....XXX.#
#...XXX....XXX.#..XXX....XXX.#
#..............#.......E.....#
#..........E.vv#.............#
#............vv#....ZZ.......#
##############################
`,
      },
      {
        // Act III. Three cells, in the dark, with the director winding up from the first one.
        name: "Reactor Core",
        pressure: 1.6,
        blackout: true,
        logs: [
          "ENG-09 // no date. Cells are seated. I could not do it alone; you need somebody watching the door. It is louder down here than it was. I think it has been waiting for the lights as long as we have. — Sokolov",
        ],
        map: `
##############################
#Z............PP...ZZ.......Z#
#Z....XXX.....PP.....XXX....Z#
#.....XXXE...........XXX.....#
#...T.XXX....e.......XXX...E.#
#...................E........#
#.E..~~~=....................#
#...........XXXXXX...........#
#...........X____X...........#
#..U........X____X........U..#
#...........X____X...........#
#...........X____X...........#
#...........XXXXXX...........#
#..............O.............#
#...E........................#
#.....XXX......U.....XXX.E...#
#.....XXX...E........XXX.....#
#Z....XXX.....^^..E..XXX....Z#
#Z.......ZZ...^^............Z#
##############################
`,
      },
      {
        // Act IV. The same deck with the lights on, two of its three ways through shut, and everything awake.
        name: "Engineering · Alarm",
        pressure: 1.9,
        map: `
##############################
#Z...........PP.............Z#
#Z...E.......PP.......E.....Z#
#...XXX....XXX....XXX....XXX.#
#...XXX....XXX....XXX....XXX.#
#...XXX....XXX....XXX....XXX.#
w............................#
w.......E...........E........#
#............................#
##############.###############
#............Z.#Z............#
#....E.........#............@#
#...................E.Y.|||..#
#...XXX....XXX.#..XXX....XXX.#
#...XXX....XXX.#..XXX....XXX.#
#...XXX....XXX.#..XXX....XXX.#
#........E.....#.............w
#Z...........^^#..........E.Zw
#Z...........^^#............Z#
##############################
`,
      },
      {
        // Act IV. Cabins sealed, vents broken open, and a great deal more in them.
        name: "Residential Deck · Alarm",
        pressure: 2.1,
        map: `
##############################
#.ZZ..#######.....#..ZZ.#....#
#...E.#######.....#..X..#.E..#
#..X..#######.....#.....#....W
W.....#######..E..#.....#..T.#
#.....#######.....#.....#E...#
#Z....#######.....#.....#....#
###.###########.#####.####.###
w............................w
WPP......E....E........E..^^.W
WPP.................E.....^^.W
w............................w
#.####.#####.###########.#####
#..#.....#.....#######.....###
#.E#.....#.....#######.....###
#..#..E..#..E..#######.....##W
W..#.E...#.....#######..E..###
#..#.....#.....#######.....###
#..#.....#....ZZ######...ZZ###
##############################
`,
      },
      {
        // Act IV. Override the blast door, hold the catwalk for ninety seconds, take the bridge.
        name: "The Bridge",
        pressure: 2.4,
        map: `
##############################
######.......>>>>.......######
######..L....>>>>....L..######
######..................######
############BBBBBB############
#Z.......###......###.......Z#
#Z..E....###......###.....E.Z#
#............................#
#........###......###........#
#..E.....###..E...###....E...#
#........###.e..E.###........#
############......############
#.............ZZ.............#
#.......E....................#
#.....E......................#
#.....................E......#
#.........E.......E..........#
#............PP..............#
#.ZZ.........PP...........ZZ.#
##############################
`,
      },
      ],
    },
    {
      id: "outpost",
      name: "Cold Start",
      brief: "Power's out. Cross the outpost and reach the safe room.",
      node: { x: 0.34, y: 0.5 },
      requires: ["tower"],
      floors: [`
########################
#....#........#........#
#.PP.#...E....#....Z...#
#.PP.#........#........#
#....####.#####...X....#
#......L...............#
#....####.#####........#
#....#........#...E....#
#..X.#...Z....#........#
#....#........####.#####
#....#...E....#........#
#....##########...>>...#
#.................>>...#
########################
`],
    },
    {
      id: "substation",
      name: "The Substation",
      brief: "Two ways through. Neither is quiet.",
      node: { x: 0.55, y: 0.26 },
      requires: ["outpost"],
      floors: [`
##########################
#.PP...#........#.......Z#
#.PP...#...E....#........#
#......G........G...X....#
#......#...L....#...X....#
####.###########.####.####
#........................#
#...E.....X.......E......#
#.........X..............#
####.###########.#####.###
#Z.....#...E....#........#
#......#........#...>>...#
#...L..G........G...>>...#
##########################
`],
    },
    {
      id: "glasshouse",
      name: "Glasshouse",
      brief: "You can see them coming. That is not the same as being safe.",
      node: { x: 0.55, y: 0.74 },
      requires: ["outpost"],
      floors: [`
########################
#.PP.#GGGGGGGGGG#....Z.#
#.PP.#..........#......#
#....G....E.....G......#
#....G..........G...E..#
#..L.#....X.....#......#
#....#..........#......#
####GG####GG#####GGG####
#......................#
#Z...E......L......E..Z#
#......................#
#####GG#############GG##
#........#....#...>>...#
#...E....#..L.#...>>...#
########################
`],
    },
    {
      id: "vault",
      name: "The Vault",
      brief: "Everything left in the sector is in here with you.",
      node: { x: 0.78, y: 0.5 },
      requires: ["substation", "glasshouse"],
      floors: [`
############################
#.PP......#Z......Z#.......#
#.PP......#........#..E....#
#.........#...E....#.......#
#....X....G........G...X...#
#....X....#........#...X...#
######.####........####.####
#..........L....L..........#
#Z...E................E...Z#
#..........L....L..........#
######.#################.###
#......#....E......#.......#
#..E...G...........G...>>..#
#......#....X......#...>>..#
############################
`],
    },
  ],
};

/** A floor as a spec, whether it was written as one or as a bare map string. */
export function floorSpec(mission: Mission, floor = 0): FloorSpec {
  const index = Math.max(0, Math.min(floor, mission.floors.length - 1));
  const entry = mission.floors[index];
  return typeof entry === "string" ? { map: entry } : entry;
}

export function missionLevel(mission: Mission, floor = 0): LevelData {
  const index = Math.max(0, Math.min(floor, mission.floors.length - 1));
  const spec = floorSpec(mission, index);
  const name = spec.name
    ?? (mission.floors.length > 1 ? `${mission.name} · Floor ${index + 1}` : mission.name);
  return parseLevelText(spec.map, name).level;
}

export function floorCount(mission: Mission): number {
  return mission.floors.length;
}

/** Available means every requirement is already ticked off. */
export function isUnlocked(mission: Mission, completed: ReadonlySet<string>): boolean {
  return mission.requires.every((id) => completed.has(id));
}

// --- progress ----------------------------------------------------------------

const STORAGE_PREFIX = "topdown.campaign.";

/**
 * Progress is a set of completed mission ids in localStorage. Deliberately the
 * smallest thing that works: no save slots, no per-player state, and losing it costs
 * a player nothing but the unlocks.
 */
export function loadProgress(campaign: Campaign): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + campaign.id);
    if (!raw) return new Set();
    const ids = JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveProgress(campaign: Campaign, completed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + campaign.id, JSON.stringify([...completed]));
  } catch {
    // Private browsing, blocked storage — progress just does not persist.
  }
}

export function resetProgress(campaign: Campaign): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + campaign.id);
  } catch {
    // ignore
  }
}
