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
| `5` | `G` | Glass | yes | **no** | see and shoot straight through, but you cannot walk through — until a bullet shatters it |
| `6` | `L` | Lamp | no | no | a static light; its visibility polygon is solved once at load, not per frame |
| `7` | `>` | Exit | no | no | the safe room. Get the whole living squad standing on it to finish a story mission |
| `8` | `Z` | Spawn zone | no | no | the director draws from these, picking a different one each time and never in sight |
| `9` | `^` | Stairs | no | no | the way up. The whole squad standing on it loads the mission's next floor |
| `10` | `C` | Car | yes | yes | a wreck. Cover you cannot see through — author them as blocks, any size |
| `11` | `W` | Window | yes | **no** | see and shoot through, nobody walks through — until a bullet smashes it. A zombie entry point either way |
| `12` | `R` | Reception desk | yes | **no** | waist-high counter: blocks bodies, you shoot over it |
| `13` | `c` | Cubicle wall | yes | yes | office partition. **Lowercase c** — `C` is a car |
| `14` | `f` | Flare | no | no | a big red static light you can stand on |
| `15` | `D` | Elevator door | yes | yes | closed lift doors. Scenery — use `^` for a floor you can actually take |
| `16` | `_` | Blocked floor | yes | no | looks and lights like floor, but nobody walks on it. Sight **and bullets** pass over — shape rooms with it |
| `17` | `g` | Broken glass | no | no | what glass leaves behind: an open hole with shards on the floor. You rarely author this by hand |
| `18` | `w` | Broken window | no | no | a smashed window: walk straight through, and **still** a way in for the director |
| `19` | `A` | Alarmed car | yes | yes | a wreck with a live alarm. Shoot it and every door on the floor opens at once — once |

`solid`, `opaque` and `blocksShots` are separate flags on purpose, because they are three
different questions: **can a body pass, can a look pass, can a bullet pass.** Collision
asks solid, the vision raycast asks opaque, bullets and the aim laser ask blocksShots
(which falls back to `solid` when a tile does not say otherwise). Glass proves the first
two are different; blocked floor proves the third is too.

**Glass and windows break.** A bullet passes straight through and shatters what it
crosses: glass (`5`) becomes broken glass (`17`), a window (`11`) becomes a broken
window (`18`). Both are walkable, so shooting out a pane is how you make a shortcut, and
a glass wall is cover that only lasts until someone opens fire. Any bullet does it,
yours or theirs, and a single shot crossing several panes takes out every one it touches.

They break into *different* tiles on purpose. A window is also a spawn zone, and if it
broke into ordinary broken glass the director would silently lose that way in — so
shooting out your own windows would make you safer, which is backwards. Broken window
keeps the zone.

`breaksInto` on the tile is what drives all of this: point any tile at another and it
becomes breakable.

**Cars are one object, not a pile of tiles.** Touching `C` and `A` tiles (orthogonally —
corner to corner is two cars) are gathered into a single vehicle with one outline, a roof
panel down its long axis and a windscreen across the short one, so a 2×3 block reads as a
car pointing north rather than as six squares. Draw them any size and any shape; the
renderer works out which way the thing is facing from its bounding box.

**Car alarms.** An `A` is a car with a live alarm, drawn in warning colours with hazard
lights on its corners so you can tell it from an ordinary wreck. Put a bullet in it and
the director drops whatever it was doing: a wave comes out of *every* door at once, and
the car screams for twenty seconds, emitting a noise loud enough to pull every zombie on
the floor toward it while more keep coming. Then it stops.

It can only happen once per car, and the "once" is stored in the grid rather than beside
it: the car's tiles become ordinary `C`, so a spent alarm survives a save, a reload and
any refresh, and cannot come back. Use them sparingly — one or two on a floor is a trap
worth respecting; a car park full of them is just a minefield.

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
  This is the part of an encounter a player can learn. **A `3` within 300 units (about
  six tiles) of a `2` is skipped**, and the director adds nothing at all for the first
  six seconds of a floor — arriving somewhere should give you a moment to read the room.
  Put your welcoming party a little further back than feels right.
- **Spawn zones (`8`)**: where reinforcements come from, in waves rather than a drip.
  **Zone tiles that touch each other are one door.** A row of twelve along a wall is a
  single way in, not twelve, and a wave comes out of one door at a time — never the same
  door twice running, and never one the squad can see. So paint zones in *groups*, and
  put the groups in different places: three or four separated doors is what makes a map
  play differently each run. In a **story** map those are the *only* places an enemy may
  appear — a map with no zones is a fixed encounter and stops spawning once the placed
  zombies are dead. **Survival** falls back to open floor when a map declares no zones.
  See the director section in the [README](../README.md#the-director).
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
