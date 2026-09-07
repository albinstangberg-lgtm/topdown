import { TileMap } from "./tilemap";
import { isKnownTile, tileByGlyph, TILE_FLOOR } from "./tiles";

/**
 * CORE 14 — The level format.
 *
 * A level is a 2D array of tile ids and a name. That is the whole format: it diffs
 * cleanly in git, you can type one by hand, and `TILE_DEFS` gives every number its
 * meaning. Everything else here is import tolerance — the parser accepts the shapes a
 * person actually pastes, not just the one shape a serializer emits.
 */

export const LEVEL_FORMAT = "topdown-level";
export const LEVEL_VERSION = 1;

export interface LevelData {
  name: string;
  grid: number[][];
}

export interface ParseResult {
  level: LevelData;
  warnings: string[];
}

const MIN_SIZE = 3;
const MAX_SIZE = 256;

/**
 * Accepts, in order of preference:
 *   1. a level file:   {"format":"topdown-level","name":"…","grid":[[…]]}
 *   2. a bare array:   [[1,1,1],[1,0,1]]
 *   3. pasted rows:    [1,1,1],\n[1,0,1],      ← what you get copying out of source
 *   4. loose numbers:  1 1 1\n1 0 1
 *   5. glyph art:      ###\n#.#      (see TILE_DEFS glyphs)
 * Throws an Error with a readable message when it cannot make a grid out of the input.
 */
export function parseLevelText(text: string, fallbackName = "imported"): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Nothing to import — the input is empty.");

  let name = fallbackName;
  let raw: unknown = null;

  const asJson = tryJson(trimmed);
  if (asJson && typeof asJson === "object" && !Array.isArray(asJson)) {
    const obj = asJson as Record<string, unknown>;
    raw = obj.grid ?? obj.tiles ?? obj.map ?? null;
    if (typeof obj.name === "string" && obj.name.trim()) name = obj.name.trim();
    if (raw === null) {
      throw new Error('That JSON has no "grid" (or "tiles"/"map") array in it.');
    }
  } else if (Array.isArray(asJson)) {
    raw = asJson;
  } else {
    // Rows pasted without the enclosing brackets, with or without trailing commas.
    const bracketed = tryJson(`[${trimmed.replace(/,\s*$/, "")}]`);
    if (Array.isArray(bracketed)) raw = bracketed;
  }

  const grid = raw !== null ? coerceGrid(raw) : parseLines(trimmed);
  if (!grid) {
    throw new Error(
      "Could not read that as a map. Expected rows of numbers, e.g. [1,1,1],[1,0,1] — " +
      "or a level file exported from the editor.",
    );
  }

  return normalize({ name, grid });
}

function tryJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function coerceGrid(raw: unknown): number[][] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const grid: number[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row)) return null;
    grid.push(row.map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0)));
  }
  return grid;
}

/** Line-oriented fallback: loose numbers, or glyph art. */
function parseLines(text: string): number[][] | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  const grid: number[][] = [];
  for (const line of lines) {
    const cleaned = line.replace(/^\[|\],?$|,$/g, "").trim();
    const numbers = cleaned.match(/-?\d+/g);
    if (numbers && numbers.length > 0 && /^[\s\d,[\]-]+$/.test(cleaned)) {
      grid.push(numbers.map((n) => parseInt(n, 10)));
      continue;
    }
    const glyphs = [...line];
    if (glyphs.every((g) => tileByGlyph(g) !== undefined)) {
      grid.push(glyphs.map((g) => tileByGlyph(g)!.id));
      continue;
    }
    return null;
  }
  return grid;
}

/** Square off the grid, clamp ids, and report anything the author probably wants to know. */
function normalize(level: LevelData): ParseResult {
  const warnings: string[] = [];
  const rows = level.grid.length;
  if (rows < MIN_SIZE) throw new Error(`A map needs at least ${MIN_SIZE} rows — got ${rows}.`);
  if (rows > MAX_SIZE) throw new Error(`A map can be at most ${MAX_SIZE} rows — got ${rows}.`);

  const cols = Math.max(...level.grid.map((r) => r.length));
  if (cols < MIN_SIZE) throw new Error(`A map needs at least ${MIN_SIZE} columns — got ${cols}.`);
  if (cols > MAX_SIZE) throw new Error(`A map can be at most ${MAX_SIZE} columns — got ${cols}.`);

  const ragged = level.grid.some((r) => r.length !== cols);
  const unknown = new Set<number>();

  const grid = level.grid.map((row) => {
    const out = new Array<number>(cols).fill(TILE_FLOOR);
    for (let x = 0; x < cols; x++) {
      const v = row[x];
      if (v === undefined) continue;
      if (!isKnownTile(v)) { unknown.add(v); out[x] = TILE_FLOOR; continue; }
      out[x] = v;
    }
    return out;
  });

  if (ragged) warnings.push(`Rows had different lengths — padded everything to ${cols} columns with floor.`);
  if (unknown.size > 0) {
    warnings.push(`Unknown tile id${unknown.size > 1 ? "s" : ""} ${[...unknown].join(", ")} treated as floor.`);
  }

  const flat = grid.flat();
  if (!flat.some((v) => v === 2)) {
    warnings.push("No player spawn (id 2) — players will start in the most open space.");
  }
  if (!flat.some((v) => v === 3)) {
    warnings.push("No enemy spawn (id 3) — enemies will spawn on any floor tile out of sight.");
  }
  if (!flat.some((v) => v === 0 || v === 2 || v === 3 || v === 6)) {
    throw new Error("That map has no walkable tiles.");
  }

  return { level: { name: level.name, grid }, warnings };
}

export function buildTileMap(level: LevelData): TileMap {
  const rows = level.grid.length;
  const cols = level.grid[0].length;
  const map = new TileMap(cols, rows, level.grid.flat());
  map.name = level.name;
  return map;
}

export function levelFromTileMap(map: TileMap): LevelData {
  return { name: map.name, grid: map.toGrid() };
}

/** One row per line — a level file should be readable and reviewable as text. */
export function serializeLevel(level: LevelData): string {
  const rows = level.grid.map((r) => `    [${r.join(",")}]`).join(",\n");
  return [
    "{",
    `  "format": "${LEVEL_FORMAT}",`,
    `  "version": ${LEVEL_VERSION},`,
    `  "name": ${JSON.stringify(level.name)},`,
    '  "grid": [',
    rows,
    "  ]",
    "}",
    "",
  ].join("\n");
}

/** The array literal form, for pasting straight back into source. */
export function levelToArrayLiteral(level: LevelData): string {
  return level.grid.map((r) => `[${r.join(",")}],`).join("\n");
}
