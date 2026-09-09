# Cores to build, and why

Answering the actual question: *what should I build first for a top-down twin-stick
shooter that becomes 4-player split-screen co-op?*

The short version: **build the four-player assumption into the foundation now.**
Retrofitting split screen onto a game that assumed one camera, one HUD and one input
device is the single most expensive mistake available in this genre. Almost everything
below is cheap on day one and brutal on day two hundred.

Each core below maps to a file in `src/`, and each has a `CORE n` comment at the top of
that file.

---

## The load-bearing eight

### 1. Fixed-timestep loop — `src/core/loop.ts`

Simulate in fixed slices, render with interpolation. Not for physics purity: it is the
precondition for the same game running identically at 60Hz and 144Hz, for replays, and
for any netcode you might want later. Retrofitting this once movement, cooldowns and AI
all read a variable `dt` means touching every system you own.

### 2. Device-agnostic input — `src/input/`

The most important boundary in a local co-op game. A player consumes an `InputState`
struct — move vector, aim, fire, dash. It does not know whether that came from a mouse
or a stick. `InputSource` is the interface; keyboard and gamepad are two implementations.

Consequences you get for free:
- adding player 2 is binding a second source, not writing a second control path
- drop-in join is a device asking to be claimed (`pendingJoins`)
- rebinding, replays and AI-driven "players" all plug into the same seam

One detail worth copying: aim direction and aim *deflection* are separate fields. It is
tempting to normalise a stick to a unit vector and be done, but that throws away the
magnitude — and with a rotating camera the magnitude is the turn rate, which is the
difference between scanning a room and spinning on the spot. Keep both.

Headless browsers cannot produce gamepad input, so the smoke suite stands up a virtual
standard-mapping pad by stubbing `navigator.getGamepads`. That proves the source logic —
discovery, deadzone, join, steering, buttons — but not that any particular controller
reports those button numbers. Real hardware is still the only test for that.

The one place presentation leaks into the sim is mouse aiming, because a cursor is a
screen position that needs a camera to become a world angle. That conversion is isolated
in `Game.resolveAim` and nowhere else.

### 3. World grid + collision + a tile registry — `src/world/`

A tile grid, not a polygon soup. It buys O(1) collision lookups, near-free raycasts for
the vision cone, and a level format you can generate or edit as text. Actors are circles,
walls are boxes, movement is substepped so a dash cannot tunnel.

The grid stores **tile ids**, and every id is defined once in `TILE_DEFS`
(`src/world/tiles.ts`). Collision, vision, rendering, the editor palette and the level
validator all read that one table, so a new tile type is one row of data rather than a
change in five files. Keep `solid` and `opaque` as separate flags from the start: glass
stops a body but not a look, and collapsing them into one "blocking" bit is a refactor
you will pay for the first time you want a window, smoke, or a grate.

The generator emits the same thing a hand-authored level does — a grid of ids — so the
game has exactly one way to load a map and no special case for "generated".

### 4. Vision / line of sight — `src/vision/visibility.ts`

The cone is the game. It is a visibility polygon: fan rays across the cone, keep where
each stops, connect them. Neighbouring rays that disagree wildly mark a shadow edge, so
we subdivide there instead of brute-forcing thousands of rays.

Build it as a **shared primitive from the start**, because at least four things want it:
the player's light, the darkness mask, enemy perception, and later AI cover-finding and
stealth. Compute each light once per frame and reuse it across viewports — with four
players that is a 4× saving that costs nothing to design in and is annoying to add later.

### 5. Entities and pools — `src/sim/entities.ts`, `src/sim/pools.ts`

Plain data in flat per-kind arrays. Not an ECS — at this size an ECS costs more than it
returns. The rule that keeps the door open: systems hold ids, never cross-frame object
references. Bullets and particles are fixed-capacity pools so the per-frame churn never
allocates.

### 6. Co-op state, not player state — `src/sim/player.ts`, `src/sim/world.ts`

Decide early that "dead" is a *shared* problem. Here: a player at zero health goes
**downed**, crawls, and a teammate revives them by standing close and holding a button;
bleed out with someone still up and you respawn at the squad; the whole squad down is a
run reset. Every one of those rules is about the group, and they are much harder to add
once "player dies, player respawns" is baked into a dozen systems.

### 7. Cameras and viewports — `src/render/camera.ts`, `src/render/viewport.ts`

**Nothing may assume one screen.** Every draw call takes a viewport. The layout is
derived from the live player count (full → side by side → quadrants). Each viewport gets
its own camera, its own rotation and its own anchor.

The subtle one: viewports show a **fixed world height**, not a fixed zoom. A player in a
quarter of the screen must not see a quarter of the world — that turns split screen into
a handicap.

Two camera modes, because they are two different games:

- **rotating** — the camera pivots on the player, turns to keep their facing up the
  screen, and anchors them low in the frame. Claustrophobic by construction: you can
  only see where you are going.
- **fixed** — north stays north, the camera follows with a look-ahead lean. Classic
  twin-stick, and far easier to aim in.

The mode is not just presentation, and this is the trap worth knowing about before you
build it: **a rotating camera and absolute aiming cannot coexist.** The camera follows
your facing, so a fixed world point you are aiming at rotates with the view, the error
never closes, and you spin forever. So under rotation, aiming becomes a *steering*
command — the offset of the cursor or stick from straight-up on screen is a turn rate,
and it settles when you point dead ahead. Movement has to be rotated into world space for
the same reason, or holding forward walks you sideways.

Both conversions live in `Game.inputOf` and `Game.resolveAim`. The simulation still only
ever receives world-space vectors and an aim command, and knows nothing about cameras.

### 8. Renderer + lighting composite — `src/render/renderer.ts`

Draw order is the whole trick:

1. floor, fully lit
2. actors, fully lit — an enemy in the dark is skipped entirely, not drawn-then-hidden
3. additive warm pass: what makes the cone read as light rather than as a hole
4. darkness: one opaque layer with every visibility polygon punched out of it
5. wall silhouettes on top, so blocks stay pure black everywhere
6. HUD, in screen space, per viewport

**Vision is shared across the squad.** Every viewport composites every player's light, so
you light rooms for each other. That single decision is most of what makes co-op darkness
social rather than four people playing alone next to each other.

---

### 9. The level format — `src/world/level.ts`, `src/levels/`

A level is a 2D array of tile ids and a name. It diffs cleanly, you can type one by hand,
and the tile registry gives every number its meaning. Everything else in that file is
import tolerance, which is the part that matters in practice: the parser accepts a level
file, a bare array, rows pasted out of source, loose numbers or glyph art, pads ragged
rows, and downgrades unknown ids to floor with a warning. A level importer that rejects
what a person actually pastes is a level importer nobody uses.

Loading a map does not rebuild the world — entities are kept and re-placed, so players
keep their device bindings, colours and score across a hot swap.

### 10. The editor — `src/editor/`

A second page that reads and writes the same format the game imports, using the same tile
registry for its palette. It contains no game code: it edits a grid of ids and hands it
over through `localStorage`. That separation is why the editor cannot drift out of sync
with the game.

## The supporting cores

- **AI perception on the same primitive** (`src/sim/enemy.ts`) — a zombie sees you when
  you are in its arc *and* it has line of sight. Symmetry with the player's vision is
  what makes a light-and-shadow shooter fair and readable: if a wall stops you seeing
  it, it cannot see you.
- **Flow-field pathing** (`src/world/flow.ts`) — one breadth-first sweep out from the
  squad gives every tile its distance to the nearest player, and any number of zombies
  steer by reading one tile. Forty zombies cost one sweep, not forty path searches, and
  the grid is what makes it that cheap: integer distances, four neighbours, a flat queue
  and no allocation after the first build. Diagonals are recovered at query time, where
  a corner check can see both sides of the step. A second field, aimed at whatever is
  screaming, is how a car alarm actually pulls a floor. Measured at 160 zombies and four
  split-screen viewports: 0.6ms of simulation against 9ms of drawing — the AI is not
  where the frame goes.
- **Hearing that ignores walls** (`src/sim/noise.ts`) — the second sense, and the one
  that makes a gunshot a decision. Noises are points with a radius and a half-second
  life; anything with ears inside one walks to it. Deliberately *not* gated on line of
  sight — blocking sound on walls would make firing from cover free, which is backwards.
- **One table per enemy kind** (`src/sim/zombies.ts`) — the same trick as `TILE_DEFS`.
  Health, pace, senses, hearing and the whole leap are rows in `ZOMBIE_DEFS`, and the
  state machine reads them by key. A runner is a walker with a bigger `chaseSpeed`; a
  brute is one with more health and a fatter `lunge.damage`. Adding a kind touches no
  other file.
- **A director, not a spawn table** (`src/sim/director.ts`) — modelled on Left 4 Dead's.
  Four phases in a loop — buildup, peak, fade, relax — driven by a survivor-intensity
  metric rather than a timetable, because a constant drip is something you stop noticing
  after ninety seconds. Waves come out of one *door* at a time (touching zone tiles are
  clustered into doors), never the same door twice running and never one the squad can
  see; a guaranteed quiet stretch follows every peak. Population scales with the number
  of players: difficulty in a drop-in co-op game has to be a function of squad size from
  the first line of it. A car alarm overrides the loop entirely — every door at once, for
  as long as it screams — and its "only once" is stored in the tile grid rather than in a
  flag beside it, so a spent alarm survives a reload and cannot come back.
- **HUD per viewport** (`src/render/hud.ts`) — anything drawn "at the top of the screen"
  is a bug waiting for player 3. Off-screen teammate markers and downed alerts matter
  more than health bars once the squad splits up.
- **The campaign** (`src/campaign/campaign.ts`, `src/menu/missionSelect.ts`) — a mission
  is a map plus two things the map cannot know: where its node sits on the select screen
  and which missions must be finished first. Unlocks are *requirements*, not an ordered
  list, so the campaign is a graph: one mission can open two, and a later one can wait
  for both. Progress is a set of completed ids in localStorage. Menu navigation scores
  nodes by direction rather than using a fixed order, so adding a mission needs no menu
  changes at all.
- **Floors** (`Mission.floors`, `Game.advanceFloor`) — a mission is a stack of maps, and
  the objective system decides which end it is: a floor with stairs sends the squad up,
  a floor with only an exit ends the mission. That is one branch, not a level-streaming
  system, because the maps are small enough to just load. The squad's condition is
  carried across the load and its position is not — reusing "spawn near the squad" for
  a map load put players outside the new map entirely, which is worth remembering as
  the shape of bug that hides in a fallback.
- **Modes** (`GameMode` in `src/sim/world.ts`) — survival and story differ in exactly two
  places: what the director is allowed to do, and whether there is an objective. Every
  other system is untouched by the distinction, which is the test of whether a "mode" is
  really a mode or a second game.
- **The lobby** (`src/menu/lobby.ts`) — the join flow, and the one screen that has to
  work before anybody has agreed which controller they are holding. START/ENTER claims
  a slot, again readies, B/ESC backs out, everyone ready starts the match. It knows
  nothing about the simulation: it hands back a list of device ids and the shell binds
  them to players, which is the same seam drop-in join uses mid-match. The shell is a
  two-state machine (`menu` / `playing`) and that is the only thing it branches on.
- **Movement stance** (`updateStanceAndStamina` in `src/sim/player.ts`) — a four-state
  machine (`stand` / `dive` / `prone` / `standUp`) plus a stamina meter. Every rule that
  matters hangs off the stance: what you can fire, how fast you turn, whether you move
  at all. Keeping it as one enum rather than a pile of booleans is what stops "can I
  shoot right now?" from becoming five separate conditions scattered across the file.
- **Weapon stance** (`updateWeaponStance` in `src/sim/player.ts`) — one float, `weaponUp`,
  driven by the same aim deflection that steers. It gates firing, sets the barrel length
  and gates the aim laser, so stance is readable from the world rather than from UI. The
  timing is asymmetric on purpose: fast up, slow down.
- **Debug view on day one** (`src/render/debug.ts`) — `F1`. Frame timings, entity counts,
  AI states, collision grid. Build it before you need it.
- **A headless smoke test** (`scripts/smoke.mjs`) — drives the real build in a browser and
  asserts systems talk to each other. Cheap insurance for a codebase where everything is
  coupled through one world object.

---

## What is deliberately not here yet

In rough order of when it starts hurting:

1. **Audio** — positional audio in split screen is its own design problem: four
   listeners, one output. Decide early whether audio is per-player panned or a single
   listener at the squad centroid.
2. **The rest of the menus** — the join lobby exists; what is missing is pause (that
   does not stop the other three players), colour and loadout picking, and a way back
   to the lobby from a match.
3. **Level content** — the format and the editor exist; what is missing is maps worth
   playing, plus level-scoped rules (objectives, doors, keyed spawns, waves).
4. **Weapons as data** — `WEAPONS` is already a table; make it content, add pickups,
   ammo economy, and per-player loadouts.
5. **Spatial hash** — the enemy/bullet loops are O(n·m). Fine at these counts, and the
   day it isn't, a uniform grid over `TILE` slots in behind the same call sites.
6. **Netcode** — the fixed timestep and plain-data world are the two prerequisites, which
   is why they are cores 1 and 5. Swap `Math.random` for the seeded `mulberry32` in
   `core/math.ts` first: determinism is a habit, not a refactor.

## Tuning knobs worth knowing

| What | Where |
| --- | --- |
| Tile types, and what each id means | `TILE_DEFS` in `src/world/tiles.ts` |
| Cone angle, range, player speed, dash, revive rules | `src/sim/player.ts` (top of file) |
| How dark the dark is | `AMBIENT_DARKNESS` in `src/render/renderer.ts` |
| Flashlight brightness | `FLASHLIGHT_REVEAL` / `FLASHLIGHT_GLOW` in `src/render/renderer.ts` |
| How hard you must push to raise the weapon | `WEAPON_RAISE_THRESHOLD` in `src/sim/player.ts` |
| Vision ray density and shadow-edge sharpness | `BASE_STEP`, `REFINE_THRESHOLD` in `src/vision/visibility.ts` |
| World size, room count, enemies per player | `src/world/tilemap.ts`, `src/sim/world.ts` |
| Zoom / world height per viewport | `VIEW_HEIGHT` in `src/render/camera.ts` |
