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
| `20` | `F` | Signal flare | no | no | the extraction beacon. Stand on it to light it, then hold the floor until the helicopter lands |
| `21` | `T` | Terminal | no | no | a crew log. Stand on it and hold USE to read it — see [devices](#devices-and-the-objective-chain) |
| `22` | `t` | Terminal (read) | no | no | what a terminal becomes once its log is read. You rarely author this |
| `23` | `!` | Weapon locker | no | no | walk onto it and it hands you the next gun up from what you carry |
| `24` | `i` | Weapon locker (empty) | no | no | a locker somebody already emptied |
| `25` | `U` | Fusion socket | no | no | hold USE to seat a cell. **Every** socket on the floor primed brings main power back |
| `26` | `u` | Fusion socket (primed) | no | no | a socket with its cell in, glowing. Rarely authored |
| `27` | `B` | Blast door | yes | yes | dead without main power; with it, hold USE beside it and survive the 90s unseal |
| `28` | `v` | Stairs down | no | no | the same rule as `^`, drawn and announced as a descent |
| `29` | `n` | Ceiling vent | no | no | a duct grate overhead. Stalkers travel between vents; a shot through the grate is the only thing that reaches one up there |
| `30` | `~` | Flooded floor | no | no | standing water. Touching tiles are **one puddle**, and a puddle is what a cable electrifies |
| `31` | `=` | Exposed cable | yes | **no** | shoot it and every flooded tile it touches goes live for a few seconds. Blinds anyone near it, including you |
| `32` | `%` | Coolant leak | yes | **no** | a split pipe. Fills the room with fog that kills vision cones dead — in there you navigate by sound ripples |
| `33` | `H` | Bulkhead | no | no | an open doorway. Stand in it with a welding tool and hold the item button to seal it |
| `34` | `h` | Bulkhead (welded) | yes | yes | sealed shut, and taking hits from whatever is on the far side. Rarely authored by hand |
| `35` | `+` | Medkit cache | no | no | walk onto it to take a medkit |
| `36` | `j` | Adrenaline cache | no | no | walk onto it to take an adrenaline shot |
| `37` | `k` | Flare cache | no | no | walk onto it to take a hand flare |
| `38` | `y` | Welder cache | no | no | walk onto it to take a welding tool and its three charges |
| `39` | `x` | Supply cache (empty) | no | no | a cache somebody already emptied |
| `40` | `S` | Strangler | no | no | one Strangler, holding this exact spot. Put it in a dark corner with a long line down a corridor |
| `41` | `s` | Stalker | no | no | one Stalker. It takes the ducts and comes back at whoever is on their own |

### Authoring the new tiles

Three of them only work in combination, so they are worth a note:

- **A cable does nothing without water.** `=` electrifies the puddle it *touches*
  orthogonally, and touching `~` tiles are gathered into one puddle. Draw the pool, then
  put the cable on a wall beside it.
- **Vents want at least two.** A Stalker travels between grates, so a floor with one
  vent has nowhere to go. Put them in open floor, not embedded in a wall run — the tile
  is ordinary floor with a grate above it, and a walled-in grate is unreachable.
- **Bulkheads are for retreating through.** A `H` is only worth authoring where the
  squad will want to shut a door behind them: a corridor between a fight and a place to
  patch up.

`S` and `s` are the only way either mutant reaches a floor by hand — neither is ever
drawn at random, because both of them are about the place they are standing.

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
- **Signal flares (`20`)**: see the extraction finale below. One per floor; on a floor
  with an exit it is what that exit is waiting for.
- **Stairs (`9`)**: the same rule, but it loads the mission's next floor instead of
  ending it. Stairs take priority over exits, so a floor with both is never the last
  one — put exits only on the top floor.

## Devices and the objective chain

Four tiles turn a map into something other than "walk to the exit". They all work the
same way — **stand on it, hold USE (`F` / `Y`)** — and they all share one trick: *using
one rewrites the grid.* A read terminal becomes tile `22`, a primed socket becomes `26`,
an emptied locker becomes `24`. So a floor that reloads remembers what the squad already
did, and a mission that restarts puts every one of them back, exactly the way a spent car
alarm works. The dwell in progress is the only thing held in memory.

The logic lives in [`src/sim/devices.ts`](../src/sim/devices.ts); what any of it *means*
lives in `src/sim/world.ts`, which is the seam that keeps the device system from turning
into a second copy of the game rules.

### Terminals (`T`)

1.4 seconds of holding USE and a crew log comes up across the bottom of the screen. They
gate nothing at all, which is the point — the story is a detour you choose to take.

The **text is not on the tile**, because a tile id cannot carry a paragraph. It is on the
mission's floor spec, as a list of strings, and terminal *n* on the floor reads log *n*
counting top to bottom, left to right. That index is stable whether or not a terminal has
been read, so reading the first one does not reshuffle the rest.

### Weapon lockers (`!`)

Not a dwell — walk onto it and it opens. It hands out the **next gun up** from whatever
that player is carrying: pistol → SMG → shotgun. Melee weapons are deliberately not on
that ladder, so the first locker found by a squad that woke up with a crowbar hands out a
real gun rather than a second crowbar. A locker that cannot upgrade you reloads you
instead.

### Fusion sockets (`U`)

Seven seconds of holding USE, each, and they are the one device that is a squad problem:
**every socket on the floor** has to be primed before anything happens. Seating the first
cell tells the director to start a siege, so the floor turns from a search into a fight
the moment the squad commits.

When the last one goes in, **main power comes back** — and that is a mission-scoped flag,
not a floor-scoped one. It survives every subsequent floor load: the lights come up, the
ship goes into alarm, and any blast door on any later floor will now work. That single
bit is what makes the second half of a mission a different place from the first.

### Blast doors (`B`)

Solid and opaque, and the only piece of geometry an objective can delete.

- **Without main power** it is a wall. Walking up to one says so once, loudly — it also
  opens every door on the floor at once for a few seconds — and then the floor's real
  objective goes back to being whatever else is on it. A door you cannot work is not an
  objective, so the HUD does not pretend it is.
- **With main power**, holding USE beside it for a moment starts a **ninety-second
  unseal**. Nobody has to stand there for it: the director runs a holdout for the whole
  countdown, aiming its worst at the end, and the squad is free to fight. When it
  finishes, the door tiles become floor and whatever is behind them — usually an exit —
  is simply reachable.

A floor with a blast door and no stairs makes the door the objective even unpowered,
which is the escape hatch for a map that has nothing else to point at.

## Floors that know more than their grid

A mission's `floors` array takes a bare map string, or a `FloorSpec` when the floor needs
to say something a grid of ids cannot:

```ts
{
  name: "Reactor Core",
  pressure: 1.6,      // director difficulty, as a multiple of the mode's tuning
  blackout: true,     // unlit even by this game's standards
  logs: ["ENG-09 // no date. Cells are seated…"],
  map: `…glyph art…`,
}
```

`pressure` is the campaign's difficulty curve. It multiplies wave size, the live cap and
the ambient population, and it is re-applied after every floor load — so the same map
played later in a mission is a harder map, which is what makes walking a deck twice worth
doing. A mission can also declare a `loadout`, which is what the squad starts it holding;
the ship campaign uses that to start you with a crowbar and no gun.

## The extraction finale

Put a signal flare (`F`) on a floor that also has an exit and the floor stops being
"walk to the safe room". It becomes four beats:

1. **Light it.** One player standing on the flare for 1.5s sets it off. One, not the
   squad: lighting a flare is not a thing four people do together, and the exit tiles
   are inert until they do.
2. **Hold.** Two minutes on the clock. The director drops its phase loop and runs a
   **holdout** instead: the gap between waves closes from 8s to 3s and the live cap
   climbs as the clock runs down, so the worst of it lands on the pickup rather than
   somewhere in the middle. The burning flare is also a lure — every zombie that
   cannot see a player walks toward it — which is what makes the roof a place to hold
   rather than a timer to run away from.
3. **The run in.** Nine seconds of helicopter, coming in from off the map. The rotor
   pulses into the noise field the whole way, so it is exactly as loud to the horde as
   it is to you.
4. **Board.** The skids touch the pad and the exit tiles are an exit again, on the
   ordinary rule: the whole living squad on them together for 0.8s.

Authoring one is two glyphs. The exit tiles are the pad — draw a block of them big
enough for the squad, because the helicopter lands at their centre — and one `F` is
the beacon. Give the floor several separated zone groups: a holdout with one door is a
corridor shoot, and the director rotates doors on purpose.

A floor with a flare but no exit, or an exit but no flare, is an ordinary floor. And
the ignition is world state rather than a tile edit, so a restart puts the flare back
out and the finale is there to play again.

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
