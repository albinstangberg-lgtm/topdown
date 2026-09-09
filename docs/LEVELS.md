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
| `7` | `>` | Exit | no | no | the safe room. Get the whole living squad standing on it to finish a story mission |
| `8` | `Z` | Spawn zone | no | no | the director draws from these, picking a different one each time and never in sight |
| `9` | `^` | Stairs | no | no | the way up. The whole squad standing on it loads the mission's next floor |
| `10` | `C` | Car | yes | yes | a wreck. Cover you cannot see through — author them as 2×2 blocks |
| `11` | `W` | Window | yes | **no** | see and shoot through, nobody walks through — and the director can put a zombie there, climbing in |
| `12` | `R` | Reception desk | yes | **no** | waist-high counter: blocks bodies, you shoot over it |
| `13` | `c` | Cubicle wall | yes | yes | office partition. **Lowercase c** — `C` is a car |
| `14` | `f` | Flare | no | no | a big red static light you can stand on |
| `15` | `D` | Elevator door | yes | yes | closed lift doors. Scenery — use `^` for a floor you can actually take |
| `16` | `_` | Blocked floor | yes | no | looks and lights like floor, but nobody walks on it. Sight **and bullets** pass over — shape rooms with it |

`solid`, `opaque` and `blocksShots` are separate flags on purpose, because they are three
different questions: **can a body pass, can a look pass, can a bullet pass.** Collision
asks solid, the vision raycast asks opaque, bullets and the aim laser ask blocksShots
(which falls back to `solid` when a tile does not say otherwise). Glass proves the first
two are different; blocked floor proves the third is too.

Blocked floor (`16`) is the one for shaping a level's look. It is lit like floor and you
can see and shoot straight across it, so it reads as ground rather than as architecture —
use it for a pool, a pit, a planter, rubble, or just to give a room a shape that walls
would make ugly. It is drawn hatched and outlined rather than identical to walkable
floor, deliberately: an invisible wall is the worst thing a level can have.

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
- **Zombies (`3`)**: one enemy per tile, placed when the map loads, never replaced.
  This is the part of an encounter a player can learn.
- **Spawn zones (`8`)**: where reinforcements come from. The director shuffles them and
  only uses one that nobody can currently see, so pressure arrives from a different door
  each time. In a **story** map those are the *only* places an enemy may appear — a map
  with no zones is a fixed encounter and stops spawning once the placed zombies are
  dead. **Survival** falls back to any floor tile when no zone is clear.
- **Exits (`7`)**: a story mission ends when every living player stands on an exit tile
  together for 0.8s. Downed players do not block it. A map with no exit has no
  objective, which is exactly what survival is.
- **Stairs (`9`)**: the same rule, but it loads the mission's next floor instead of
  ending it. Stairs take priority over exits, so a floor with both is never the last
  one — put exits only on the top floor.

## Multi-floor missions

A mission carries a list of floors, bottom first:

```ts
{
  id: "tower",
  name: "Vertical Slice",
  floors: [groundFloor, secondFloor, /* … */ roof],
}
```

Floors are ordinary maps. The only thing joining them is that all but the last have
stairs (`^`) and the last has an exit (`>`). The squad **carries its health, ammo and
stamina up**, which is what makes a building one continuous run rather than several
missions in a row; anyone downed comes up at 35% health rather than being left behind.
A wipe restarts the mission from the ground floor.

Each floor places players at its own `P` tiles. A floor with none drops the squad at its
most open point — but authoring the arrival deliberately is much better, because the
player should arrive where they would have come out.
- **Restart** (`Shift+R`, or a squad wipe): an authored level restarts as itself; a
  procedural one rerolls, because there is nothing to be faithful to.
