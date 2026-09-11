import { parseLevelText, type LevelData } from "../world/level";
import { generateLevel } from "../world/generator";
import { CORRIDORS } from "./corridors";
import { SHOWCASE } from "./showcase";
import { HAZARDS } from "./hazards";

/**
 * Built-in maps. Both forms below go through the same importer the drag-and-drop path
 * uses, so if a level loads here it loads from a file too.
 */
export interface BuiltinLevel {
  id: string;
  name: string;
  source: string;
}

export const BUILTIN_LEVELS: BuiltinLevel[] = [
  { id: "corridors", name: "Corridors", source: CORRIDORS },
  { id: "showcase", name: "Tile Showcase", source: SHOWCASE },
  { id: "hazards", name: "Deck Hazards", source: HAZARDS },
];

export const PROCEDURAL = "procedural";
/** Where the editor hands a map to the game. */
export const DRAFT_KEY = "topdown.level.draft";

/**
 * Resolve a level id from the URL or the editor handoff.
 * Returns null when the id is unknown, so the caller can fall back and say so.
 */
export function resolveLevel(id: string | null, seed = 1337): LevelData | null {
  if (!id || id === PROCEDURAL) return generateLevel(56, 42, seed);

  if (id === "draft") {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(DRAFT_KEY) : null;
    if (!stored) return null;
    return parseLevelText(stored, "editor draft").level;
  }

  const builtin = BUILTIN_LEVELS.find((l) => l.id === id);
  if (!builtin) return null;
  return parseLevelText(builtin.source, builtin.name).level;
}
