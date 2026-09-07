# Levels: the tile-id format

A level is a 2D array of tile ids. That is the entire format. Every number in the grid
is defined once, in [`src/world/tiles.ts`](../src/world/tiles.ts), and the collision,
the vision, the renderer, the editor palette and the importer all read from that table.

## Tile ids

| id | glyph | name | solid | opaque | what it does |
| --- | --- | --- | --- | --- | --- |
| `0` | `.` | Floor | no | no | walkable |
| `1` | `#` | Wall | yes | yes | blocks movement and sight — this is what casts the shadows |
| `2` | `P` | Player spawn | no | no | players spawn here in grid order, cycling if there are more players than spawns |
| `3` | `E` | Enemy spawn | no | no | the director spawns enemies at these, and only when nobody is looking |
| `4` | `X` | Crate | yes | yes | cover; same rules as a wall, drawn as an object on the floor |
| `5` | `G` | Glass | yes | **no** | blocks the body, not the eye — see and shoot through it |
| `6` | `L` | Lamp | no | no | a static light; its visibility polygon is solved once at load, not per frame |

`solid` and `opaque` are separate flags on purpose. Collision asks "solid?", the vision
raycast asks "opaque?". Glass is the tile that proves the two are different questions;
a smoke or a one-way window would use the other combination.

**Adding a tile type is one row in `TILE_DEFS`.** Give it an id, a colour and a glyph,
set the two flags, and it appears in the editor palette, imports correctly, and behaves
in-game — no other file needs to change.

## Writing a map

Numeric rows, which is what you get copying out of a source file:

```
[1,1,1,1,1,1,1],
[1,0,0,0,0,0,1],
[1,2,0,0,0,3,1],
[1,0,0,4,0,0,1],
[1,1,1,1,1,1,1],
```

Or glyph art, which is easier to read at a glance:

```
#######
#.....#
#P...E#
#..X..#
#######
```

Or a level file, which is what the editor exports:

```json
{
  "format": "topdown-level",
  "version": 1,
  "name": "Corridors",
  "grid": [
    [1,1,1],
    [1,0,1],
    [1,1,1]
  ]
}
```

All three go through the same importer, `parseLevelText` in
[`src/world/level.ts`](../src/world/level.ts). It is deliberately forgiving, because the
common case is a person pasting something: rows of different lengths get padded to the
widest with floor, unknown ids fall back to floor, and both report a warning rather than
failing. It refuses only what it genuinely cannot use — no rows, no walkable tiles, or a
grid past the 3–256 size limits.

You do not need a border of walls: out of bounds already counts as solid and opaque.

## Getting a map into the game

| How | What to do |
| --- | --- |
| Built-in | `?level=corridors`, `?level=showcase`, `?level=procedural` |
| From the editor | Press **▶ Play this map** — it stores the level and opens `?level=draft` |
| From a file | Drag a `.json` / `.txt` onto the game window |
| From the clipboard | Focus the game and press `Ctrl+V` |
| In game | `[` and `]` cycle the built-in maps |
| From code | `window.game.loadLevelText(text)` or `window.game.loadLevel({ name, grid })` |

Loading a map does **not** rebuild the world. Players keep their device bindings, colours
and score and are simply re-placed on the new grid, which is what makes the editor's
Play button feel instant.

## The editor

`npm run dev` then open `/editor.html`.

- Palette on the right, or press `0`–`9`
- Tools: `B` paint, `R` rectangle, `F` flood fill, `I` pick (`Alt` of an eyedropper)
- Right-drag paints floor — the eraser
- `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo, wheel zooms, middle-drag pans
- **Download .json**, **Copy JSON**, or **Copy rows** to paste back into source
- Drop or paste a map onto the editor to load it

The editor holds no game code. It edits a grid of ids and hands it over, which is why it
cannot drift out of sync with the game — there is only one definition of what a `5` means.

## Spawn rules

- **Players**: authored `2` tiles first, one per player in grid order. With no `2` tiles,
  players spawn beside the squad, and the first player at the most open point on the map.
- **Enemies**: authored `3` tiles first, and only ones far enough from every player that
  nobody watches an enemy appear. With no `3` tiles, any floor tile that passes the same
  clearance test. On a small map the clearance shrinks rather than starving the level.
- **Restart** (`Shift+R`, or a squad wipe): an authored level restarts as itself; a
  procedural one rerolls, because there is nothing to be faithful to.
