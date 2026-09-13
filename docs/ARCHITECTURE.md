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

Rooms and corridors first, then a **dressing pass** (`dressShip`) that puts the ship's
own furniture into them: vents, a pool with a torn conduit beside it, a coolant leak, a
bulkhead, supply caches, a charging point and a battery rack, a hull breach with its
lever and railings, and one each of the three ambush mutants. Without it none of that
exists in survival, because survival has no authored decks and the mutants carry
`weight: 0` so the director never draws them.

One rule makes the pass safe, and it is the only thing to preserve if it ever grows:
**a solid tile only ever replaces a wall, and a walkable one only ever replaces plain
floor.** Connectivity therefore cannot change, so no amount of dressing can seal a room
off or strand a spawn — the property that makes a generator worth trusting, and the one
the smoke suite checks by flood-filling the finished deck. Two things are deliberately
*not* generated: airlocks, because a chamber has to be a walled throat with a door at
each end and a two-wide corridor cannot promise one, and core racks, because a core is
only worth carrying to a socket and survival has no objective chain to put one in.

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

### 8a. Actor art — `src/render/actorArt.ts`

Actors used to be rotated rectangles with a stub on the nose, which conveys a facing and
nothing else. They are now drawn as bodies seen from the one camera angle this game has:
straight down. Shoulders, a head, two arms, two legs, and the weapon in the hands.

Three decisions are the whole module, and they are the ones worth keeping if the art is
ever replaced with sprites:

- **The pose goes in, never out.** `drawActor` takes an `ActorPose` and draws it. It owns
  no clocks and no state, so the same player drawn into four viewports in one frame
  cannot disagree with itself, and replaying a simulation redraws it exactly.
- **Animation state lives in the simulation.** `walkPhase`, `swingTimer`, `recoil` are
  fields on the actor like any other. The renderer reads them; nothing in the sim reads
  them back. That is what keeps a purely cosmetic gait out of the way of netcode later.
- **Limbs are solved, not keyframed.** Hands are placed by the weapon and the elbow falls
  out of two-bone IK, so one rig holds a pistol, an SMG, a shotgun, a crowbar and a
  zombie's outstretched reach without a frame of authored animation.

The gait is advanced by **distance travelled**, not by time — `walkPhase += dist / STRIDE
* PI` — which is why feet never skate whether you are walking, sprinting or crawling.

A weapon's silhouette is one row in `WEAPON_ART` plus one `art` field on its `WeaponDef`.
That field is the *only* thing presentation reads off a weapon, so a new gun is a row of
stats and a row of art, and neither table has to know about the other.

The melee swing is the one place where art and simulation are deliberately coupled: the
bar is already cocked whenever the weapon is raised, the sweep crosses the front of the
body a third of the way through it, and `MELEE_CONTACT` in `src/sim/player.ts` resolves
the damage at exactly that point. The alternative — hit on the button press, animate
afterwards — is what makes melee in a lot of games feel like it is describing something
that already happened.

### 8b. The story arc — `src/campaign/campaign.ts`, `src/sim/devices.ts`

The nine-deck ship mission is the thing the objective chain was built to carry, and it is
worth reading as a worked example of what the pieces above buy you. Four acts, and each
one is a different *rule* rather than a different set of assets:

1. no gun at all, so a floor is quiet and melee is a decision;
2. a door that will not open, so the objective is somewhere else entirely;
3. three dwells in the dark that flip one flag;
4. the first three decks again, with that flag set.

None of it needed a scripting system. An act is a floor spec, a tile, and one branch in
the objective chain.

### 8c. The mutants — `src/sim/mutants.ts`

Three creatures that do something a walker cannot: a ranged grab that drags a player
away, a leap that pins one to the floor, and one that never touches the floor at all.
Each is one row in `ZOMBIE_DEFS` with an ability block on it (`tendril`, `pounce`,
`drop`), so the registry rule still holds — but their *state machines* live in their own
file rather than as more branches inside `updateEnemy`, because an ambusher, a pouncer
and a thing in the ceiling have nothing in common except a body and a health bar.

The seam that makes this cheap: each entry point **takes only the frames its own
behaviour owns and hands the rest back**. A Stalker with nobody isolated, or a Strangler
that has been forced into a melee, falls through to the shared machine and behaves like
the unusually unpleasant zombie it still is.

One trap worth knowing about, because it cost a debugging session: `updateEnemy` runs
`stateTimer` down *before* it delegates. An ability that decrements it again halves every
windup it owns, and the symptom is not an error — it is a pounce that lands short.

The Ceiling Lurker is the one that needed a new axis rather than a new ability. It is
never in the room: `overhead(e)` is true for its `roost` and `vent` states, and that one
predicate is what the visibility pass, the suction and the melee reach all read, so
"in the ceiling" is decided in one place instead of being re-derived by everything that
could otherwise hit it. Two things fell out of writing it that are worth keeping in mind
for the next creature:

- It needed its **own** roosting state. The obvious move was to reuse `lurk`, which the
  Strangler already had — but the Strangler lurks *on the floor*, and folding the two
  together would have made it untouchable.
- A dwell that is nearly finished must **hold its own clock**. `updateEnemy` runs the
  hop timer down in the background, so the drop code re-arms `stateTimer` every frame it
  has a mark; without that it wanders off a fraction before committing, which reads as
  the creature being broken rather than as a timer being shared.

All three creatures grab players through one shared type, `Restraint` (`sim/entities.ts`).
Everything downstream — the weapon, the movement, the HUD, what a teammate can do about
it — reads the restraint rather than asking which creature caused it. `gripOf(e)` is the
matching seam on the other side: the pin code wants damage, chew rate and shove
resistance, and it reads whichever ability block the creature happens to carry rather
than assuming a pounce. The creature
refreshes the anchor on it every step, which is what lets the player module be dragged
toward something without ever learning what an `Enemy` is; the same seam that keeps melee
and revives out of the player's business.

### 8d. Sound you can see — `src/sim/noise.ts`, the ripple pass in the renderer

The noise field was always the game's *attention* system rather than literally sound:
"what pulls the dead toward a point". Two things now ride it that are not sounds at all,
and both are honest about it — a lit flashlight in a dead-dark room (`beam`) and, going
the other way, a shambler's footfall, which is a sound that the dead deliberately
**cannot hear**.

That last one is the load-bearing flag. `byDead` marks a noise as made by something
already dead: `loudestAt` skips those, so a crowd never walks toward its own shuffling —
but the renderer draws every one of them as an expanding ring. That is what makes a
coolant bank playable rather than a blindfold: your eyes are gone, and the floor is
still telling you where things are.

---

### 8e. One battery for the whole suit — `src/sim/power.ts`

CORE 20 is a single number on the player and a handful of rules about who may spend it.
The flashlight, the magazine and the welding tool all draw off `p.battery`, which is what
makes the light a resource decision rather than a toggle you set once on load.

The module exists so that **one function decides what is in somebody's hands**.
`activeWeapon(p)` answers it — both hands full, an empty magazine with a flat suit behind
it, or a melee loadout all resolve to the sidearm — and the trigger, the HUD, the melee
code and the renderer all call it rather than each working it out from `p.weapon`. The
bug this prevents is not subtle: a HUD that says "Pistol" while the swing code swings a
crowbar is a game that lies about the only thing the player is looking at.

The design rule written at the top of the file is load-bearing and worth restating here:
**the crowbar and the halo are free.** A flat cell is dark and dangerous, never a soft
lock. Everything in the module is arranged to protect that — which is also why a partial
magazine is a first-class outcome (`drawMagazine` returns what actually went in) instead
of a refusal.

### 8f. Sound that geometry can stop — `src/world/raycast.ts`, `src/audio/`

Vision asks a yes/no question and a raycast answers it. Sound is not yes/no, so
`wallsBetween` walks the same DDA and returns **how many** opaque tiles a line crosses,
capped. That one number drives everything: the listener is chosen by the best line
(distance only breaks the tie), what is left of the line sets a gain cut and a low-pass,
and — the part that is a mechanic rather than a mix — it **raises the audibility floor**.
Behind a wall a quiet sound is not attenuated, it is never played.

That threshold is the whole point. With plain 2D distance you hear a shambler through a
bulkhead as clearly as one in the room, which silently deletes every ambush the game has,
because the player always knows. The audibility rule lives in one module-level function
(`audibleAt`) used by both the public `audible()` test and the private gate inside
`begin()`, so the promise the design makes — "a footstep next door is gone, a shotgun
next door is a thump" — cannot drift away from what the bus actually does. It is also
why the rule is *assertable*: the smoke suite checks it rather than somebody putting an
ear to the screen.

### 8g. Vacuum, airlocks and the flood-fill that makes them cheap

Both of the deck hazards this round are the same trick the cars and the puddles use:
**touching tiles flood-fill into one body**, so an author draws a shape and the sim gets
an object. An airlock chamber is a group of `airlock` tiles plus the doors that touch it;
shutting it swaps every door tile for its solid twin, which is why "the doors are shut"
needs no per-door state at all.

Two things in here were learned the hard way and are cheap to get wrong again:

- **Never key live state by array index.** The airlock cycle was originally keyed by the
  index into `map.airlocks`, and shutting the doors calls `refresh()`, which rebuilds
  that list — so a running cycle lost its own entry and the doors never opened again.
  Cycles are keyed by `airlockKey(lock)` (the lowest tile index in the chamber), which
  survives the rebuild.
- **Wind has to move bodies positionally.** Both the player step and the enemy step damp
  their own velocity toward what they are trying to do, so a force added by the breach
  was erased before anything moved. `dragToward` displaces through `moveCircle` instead,
  which also means the wind can never push somebody into a wall.

The suction is deliberately tuned to just under walk speed: a depressurisation you cannot
walk out of is a cutscene, and one that does not hurt at the hole is a free horde delete.
Everything else about it is honest cost — shared oxygen, a lever that works once, and
railings drawn on the floor where the squad can plan around them.

---

### 8h. The console, and the player who is not in the room — `src/sim/hacking.ts`, `src/render/terminal.ts`

CORE 21 is the only mechanic in the game that takes a player *out* of it, and it is the
one that proves CORE 10 was worth the trouble. **Nothing may assume there is one screen**
— so when somebody sits down at a console, one quarter of the glass becomes a terminal
and the other three keep showing the deck. The player in it genuinely cannot see what is
happening to them; their squad genuinely can. With a single camera this mechanic does
not exist.

The split is the usual one, and it is worth restating because this feature could so
easily have been written the other way round:

- `sim/hacking.ts` is **plain data and a step function**. A session is tumblers, an
  index and a fault count; `updateHack` advances the sweep and returns what happened.
  It draws nothing, plays nothing, and does not know what a door is.
- `sim/world.ts` owns every consequence: who may start one, what beating one opens, and
  every way out of it.
- `render/terminal.ts` reads the session and draws a screen. It is the only file that
  knows the thing looks like a 1980s terminal.
- `sim/player.ts` reads **one boolean**. `p.hacking` is the whole of what the rest of the
  simulation needs to know, and `updatePlayer` returns early on it rather than disabling
  movement, aim, fire and light one at a time — a list of exceptions is a list of things
  somebody will forget to add to.

Two rules carry the design, and both are one line of code each:

- **Anything that touches you throws you out.** `hurtPlayer` ends the session before it
  applies the damage. That single line is what turns "one of us hacks" into "three of us
  hold a perimeter", because it means the hack cannot outlive the cordon.
- **One at a time.** `beginHack` refuses while a session exists. Two players in screens
  is exactly the failure the mechanic is built to prevent, so it is refused at the door
  rather than balanced against.

The one piece of fiddliness worth knowing about is the **latch**. You enter by holding
USE and leave by tapping it — and the button is still held on the frame you leave, so
without `hackLatch` the console's dwell refills and drags you straight back in. A player
must release USE before a console will take them again.

### 8i. Turrets — `src/sim/turret.ts`

CORE 22 exists to make the console worth the risk: something on the deck that cannot be
solved by shooting it or by running away. It is deliberately **not** an `Enemy`. Putting
it in that list would hand it a flow field, an ear for noise, an alertness and a lunge,
none of which a bolted-down gun has any use for — and every one of which would have to be
special-cased back off it.

What it does have is a state machine with a tell in the middle of it: sweep → sight →
fire → cool. The sight window is the whole of its fairness, and it is drawn as a laser
that brightens as it fills. It fires out of the **same bullet pool players use**, with
`team: "enemy"`, so its rounds are dodgeable, stopped by cover and already understood by
every system that touches bullets. The alternative — hitscan damage — would have been
fewer lines and a worse game.

Its default bearing is worked out from the map: eight rays, and it faces down the longest
open one. Drop one in a corridor and it covers the corridor without the author having to
say so, which is the same courtesy the car renderer does with its bounding box.

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
- **Sound as an observer, not a system** (`src/audio/`) — everything is synthesised, so
  there is no asset pipeline and nothing to load. Nothing in `src/sim` imports it: the
  audio layer reads the world after the step, the same way the renderer does, and
  deleting it would change nothing about how the game plays. The one hook is `onEmit` on
  the noise field, which is what guarantees the player hears exactly what the zombies
  heard rather than a second, drifting copy of the same table. The bus is written so it
  can always fail: no device, no context, no gesture yet — it counts the request and
  makes no sound.
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
- **Devices, and objectives as a chain** (`src/sim/devices.ts`) — a terminal, a weapon
  locker, a fusion socket and a blast door are one system, because they are one idea:
  *hold a button on a tile, and the tile changes into the used version of itself.* The
  used state lives in the grid rather than beside it — the same trick as a spent car
  alarm — so a floor that reloads remembers what the squad did and a mission restart puts
  it all back, with no save format and no flags to keep in sync. Only the dwell in
  progress is held in memory. The system answers "who is holding what, and what just
  finished"; every consequence is in `world.ts`, and that seam is what stops it becoming
  a second, competing copy of the game rules.
  The objectives it produces are a *priority chain* rather than a state machine: an
  unprimed reactor outranks a sealed door outranks stairs outranks an exit. Adding a beat
  to a mission is adding a row to that order, and a floor with none of it plays exactly
  as floors did before any of it existed. The one rule worth copying: **a door the squad
  cannot work is not an objective**, it is a wall — an objective line that insists on
  something inert is worse than no objective line.
- **One state flag can be the whole second half of a game** (`GameWorld.power`) — main
  power is mission-scoped, not floor-scoped: it survives every subsequent floor load. The
  lights come up, the ship goes into alarm, the blast doors work, and the director is
  handed more. That is what pays for reusing maps — the walk back up is visibly and
  mechanically a different place from the walk down, at the cost of one boolean and a
  handful of reads. Reusing a map with nothing changed is padding; reusing one whose
  rules moved underneath it is a second level for free.
- **Melee as a weapon row, not a weapon system** (`WeaponDef.melee` in
  `src/sim/entities.ts`) — a crowbar is an entry in the same table as the SMG with
  `magazine: 0`, a reach and an arc. Everything downstream reads `magazine <= 0` rather
  than `melee`, so the reload path, the HUD and the locker all did the right thing
  without knowing melee exists. The swing is resolved by a callback the world supplies,
  for the same reason the zombie AI is handed `hurtPlayer`: the player module has no
  business importing an `Enemy`.
- **Difficulty as pressure, separate from tuning** (`Director.pressure`) — tuning is what
  a *mode* is; pressure is where you have got to *within* one. The campaign turns it up
  floor by floor, so the same map later in a mission is a harder map. Keeping them apart
  matters because a floor load resets the director and must not reset the campaign's
  curve — which it did, until `loadLevel` learned to put it back.
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
| How long a terminal, a fusion socket and the bridge door take | `src/sim/devices.ts` (top of file) |
| Melee reach, arc and damage | `WEAPONS` in `src/sim/entities.ts` |
| Tendril range, reel speed and how much cuts it | `tendril` on the Strangler row in `src/sim/zombies.ts` |
| Pounce range, the skitter, the blind and the shove | `pounce` on the Stalker row in `src/sim/zombies.ts` |
| What each utility item is worth | `src/sim/items.ts` (top of file) |
| Current damage, discharge length, cable recharge | `ARC_DAMAGE` / `ARC_TIME` / `CABLE_RECHARGE` in `src/sim/world.ts` |
| How much a weld takes before it comes off | `WELD_INTEGRITY` in `src/sim/items.ts`, `WELD_CHEW` in `src/sim/world.ts` |
| How thick coolant fog is, and how far it spreads | `coolant` on the tile, `bakeFog` in `src/world/tilemap.ts` |
| How often a lit beam in the dark calls something | `LIGHT_TELL_INTERVAL` in `src/sim/player.ts` |
| What light, a weld and a magazine cost the suit | `LIGHT_DRAIN` / `WELD_DRAW` / `draw` on the weapon, in `src/sim/power.ts` |
| How far the cone dips after a shot, and for how long | `DIP_FLOOR` / `DIP_TIME` in `src/sim/power.ts` |
| Charging rate, cell size and handover reach | `CHARGER_RATE` / `CELL_CHARGE` / `HANDOVER_RANGE` in `src/sim/power.ts` |
| How long a breach runs, how hard it pulls, what the air costs | `BREACH_TIME` / `SUCTION_FORCE` / `OXYGEN_DRAIN` in `src/sim/world.ts` |
| How many fit in an airlock and how long a cycle takes | `AIRLOCK_CAPACITY` / `AIRLOCK_CYCLE` in `src/sim/world.ts` |
| How much a wall takes off a sound, and what it silences | `OCCLUDED_GAIN` / `OCCLUDED_CUTOFF` / `OCCLUDED_FLOOR` in `src/audio/bus.ts` |
| How many walls count as "behind a bulkhead" | `GameAudio.OCCLUSION_CAP` in `src/audio/gameAudio.ts` |
| The Lurker's dwell, reach and how often it moves grate | `drop` on the Lurker row in `src/sim/zombies.ts` |
| How many interlocks a console asks for, and how tight they are | `TUMBLERS` / `BAND_WIDTH` / `BASE_SPEED` in `src/sim/hacking.ts` |
| What a fumbled interlock costs | `FAULT_SPEEDUP` / `RESYNC_TIME` / `FAULT_NOISE` in `src/sim/hacking.ts` |
| How long you stand at a console before it takes you | `HACK_ARM_TIME` in `src/sim/devices.ts` |
| Turret range, sight window, burst and damage | `src/sim/turret.ts` (top of file) |
| How long a swing takes, and when in it the bar connects | `SWING_TIME` / `MELEE_CONTACT` in `src/sim/player.ts` |
| Stride length — how far the body walks per footfall | `STRIDE` in `src/sim/player.ts`, `ZOMBIE_STRIDE` in `src/sim/enemy.ts` |
| Body proportions, and what each weapon looks like | `drawActor` / `WEAPON_ART` in `src/render/actorArt.ts` |
| How hard a floor leans | `pressure` on the mission's floor spec |
| How dark a blackout deck is, and how lit a powered ship is | `BLACKOUT_DARKNESS` / `POWERED_DARKNESS` in `src/render/renderer.ts` |
| Zoom / world height per viewport | `VIEW_HEIGHT` in `src/render/camera.ts` |
