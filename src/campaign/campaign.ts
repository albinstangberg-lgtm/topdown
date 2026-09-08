import { parseLevelText, type LevelData } from "../world/level";

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
 */

export interface Mission {
  id: string;
  name: string;
  brief: string;
  /** Position on the mission select screen, normalised 0..1. */
  node: { x: number; y: number };
  /** Mission ids that must be complete first. Empty means available from the start. */
  requires: string[];
  /**
   * The floors of the mission, bottom first. Most missions are one floor; a building
   * is several, joined by stairs tiles, played as one continuous run.
   */
  floors: string[];
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
      brief: "Six floors, bottom to roof. Light the flare and wait for the pickup.",
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
##################################
#Z...........Z..........Z.......Z#
#................................#
#..CC....CC.......CC.......CC....#
#..CC....CC.......CC.......CC....#
#.......E........................#
#....CC.......CC.......CC........#
#....CC.......CC.......CC........#
#..........E.....................#
^................................#
^..............E.................#
#................................#
#....CC.......CC.......CC...PP...#
#....CC.......CC.......CC...PP...#
#........E.......................#
#..CC....CC.......CC.......CC....#
#..CC....CC.......CC.......CC....#
#............E...................#
#Z...........Z..........Z.......Z#
##################################
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
############
#....Z.....#
#..........#
#.....E....#
#..........#
#...>>>....#
#...>f>....#
#...>>>....#
#..........#
#Z...E....Z#
#..........#
#..........#
#....E.....#
#..........#
#..........#
#.........E#
#....PP....#
#....Z.....#
############
`,
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

export function missionLevel(mission: Mission, floor = 0): LevelData {
  const index = Math.max(0, Math.min(floor, mission.floors.length - 1));
  const name = mission.floors.length > 1
    ? `${mission.name} · Floor ${index + 1}`
    : mission.name;
  return parseLevelText(mission.floors[index], name).level;
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
