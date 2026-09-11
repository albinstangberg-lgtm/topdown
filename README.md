# topdown

A top-down twin-stick shooter prototype in TypeScript + Canvas2D. Everything is
blocks on purpose — the point of this build is the systems underneath, not the art.

The look it is aiming for: close overhead camera, hard black geometry, and a cone of
light in front of the player that carves the visible world out of the dark.

Built so that going from 1 player to 4-player split-screen co-op is a layout change,
not a rewrite. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the core systems
and the order to build them in, and [docs/LEVELS.md](docs/LEVELS.md) for the map format.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

The map editor is a second page on the same dev server: <http://localhost:5173/editor.html>.

```bash
npm run build        # typecheck + production build into dist/
npm run preview      # serve the build
npm run typecheck
npm run smoke        # headless playthrough assertions (needs `npm run preview` running)
```

## Controls

| Action | Keyboard + mouse | Gamepad |
| --- | --- | --- |
| Move | `WASD` (relative to the screen) | Left stick |
| Steer / aim | Mouse (rate scales with distance) | Right stick (rate scales with push) |
| Fire | Left click / `Space` | RT |
| Sprint (hold) | `Shift` | A / L3 |
| Dive (tap) | `Ctrl` / `C` | B / LT |
| Lean left / right | `Q` / `E` | LB / RB |
| Reload | `R` | X |
| Revive teammate | Hold `F` | Hold Y |
| Use a device (terminal, fusion socket, blast door) | Hold `F` | Hold Y |
| Join the game | `ENTER` in the lobby | `START` in the lobby |
| Menus | `WASD` / arrows, `ENTER`, `ESC` | stick or D-pad, `START`, `B` |

Debug: `F1` overlay, `F2` collision grid, `Shift+R` restart, `[` / `]` change map,
`C` switch camera.

## Camera

Two modes, toggled with `C` or `?camera=rotating|fixed`.

**Rotating** (default) is the claustrophobic one: the camera pivots *on the player*,
turns to keep their facing pointing up the screen, and anchors them at 78% down the
frame, so almost everything you can see is ahead of you.

That changes how aiming has to work. A rotating camera follows your facing, so pointing
at a fixed spot in the world would move the spot — you would spin forever. So aiming
becomes **steering**: how far the cursor (or the right stick) sits off straight-up is a
turn command, and you settle onto a heading by pointing dead ahead. There is a dead zone
around the player so a parked cursor holds your heading. `WASD` and the left stick are
screen-relative in this mode: forward is wherever the camera is looking.

Steering is **proportional**: the turn *rate* comes from how hard the device is pushed —
stick deflection, or the cursor's distance from the player — so a nudge scans a room
slowly and a full push spins you round. The response curve favours fine control near
centre (`STEER_RESPONSE` in `src/main.ts`).

## Movement

Paced for something slower and more tactical than a bullet-hell twin-stick.

| | speed | notes |
| --- | --- | --- |
| Walk | 165 u/s | the default. 70% of the old baseline |
| Sprint | 259 u/s | 110% of the old baseline, costs stamina |

**Stamina** (100, drains 26/s, regenerates 20/s after a 0.7s pause) is drained by
sprinting and nothing else. Run it to zero and sprint locks out entirely until it
recovers past 25 — so over-sprinting leaves you walking at the worst possible moment.

**Dive** is a commitment, not a dodge. You launch in your movement direction, land
**prone**, and have to get back up: 0.3s of flight, 1.5s on the floor, 0.45s standing —
about 2.3 seconds in total. You can shoot lying down, and turn (slowly), but you cannot
move, and you cannot shoot mid-flight or while scrambling up. Diving into a wall still
puts you on the floor; you just do not get the distance.

A dive also costs 25 stamina. That coupling was my call rather than yours — a free dive
next to a metered sprint makes diving the obvious way to travel. Set
`DIVE_STAMINA_COST` to 0 in `src/sim/player.ts` to decouple them.

All of it is named constants at the top of `src/sim/player.ts`: `WALK_SPEED`,
`SPRINT_SPEED`, `SPRINT_DRAIN`, `STAMINA_REGEN`, `EXHAUST_FLOOR`, `DIVE_SPEED`,
`DIVE_TIME`, `PRONE_TIME`, `STAND_TIME`, `DIVE_COOLDOWN`.

## Leaning

`Q` / `E` (or `LB` / `RB`) slide **where you look and shoot** about half a tile
sideways, without moving your collision body — so you can clear a corner before you
step into it. The vision cone, the aim laser and the bullets all leave from that
leaned "eye"; the hitbox stays put. Leaning into geometry is clamped, so you can peek
past a corner but never see through the wall itself.

Worth knowing: because the hitbox does not move, leaning is currently a free advantage —
you gain sight and a firing angle without exposing yourself. The two conventional ways
to price it are to move the hitbox with the eye, or to block sprint and slow movement
while leaning. Neither is in yet.

## Reloading

`R` (or `X`) tops up a partial magazine. It is refused when the magazine is already
full, and while you are mid-dive or getting up — but it works fine lying prone. Running
dry still reloads automatically, so the manual button is for reloading *before* you need
to, which is the decision worth having in a firefight. A reload in progress keeps
running through a dive rather than being cancelled.

## Weapon up / down

The same deflection decides whether the gun is up. Push the aim stick (or move the
cursor away from yourself) past `WEAPON_RAISE_THRESHOLD` and the weapon shoulders in
0.16s, the barrel extends, and an **aim laser** projects to exactly where a bullet would
stop — through glass it does not, because bullets do not either. Let go and it lowers
after a short grace, taking the laser with it.

**A lowered weapon cannot fire**, but the trigger raises it rather than eating the
input, so a shot fired from rest lands as soon as the gun is up. The fixed camera keeps
the weapon permanently shouldered, since absolute aiming has no deflection to read.

**Fixed** is the classic twin-stick camera: north stays north, aiming is absolute — the
cursor or stick names a world direction and you snap to it.

## Characters, and what they are holding

Everyone on screen is drawn as a **body seen from directly above** — shoulders, head, two
arms, two legs, and a weapon held in the hands — rather than as a box with a stub on the
front. It is all vector drawing, no sprite sheets, and the poses come straight off the
simulation:

- **The gait** is driven by *distance travelled*, not by time, so feet never skate: a walk
  steps, a sprint strides, a crawl drags. Legs trail behind the body, because from a
  helicopter that is what a walking person looks like.
- **The weapon** is held where it should be. It swings across the body when lowered, comes
  up onto the centreline and pushes out when you shoulder it, kicks back on every shot,
  and dips while the off hand goes to the magazine during a reload.
- **Five silhouettes.** A pistol is a slide and both hands together. An SMG has a stock, a
  vented handguard and a stubby magazine. A shotgun is the longest thing anyone carries
  and the only one with a moving part — the pump rides back on the kick and returns as the
  recoil decays, so it visibly cycles between shots. A crowbar is a hex shaft with a
  goose-neck claw, held one-handed with the off arm up as a guard, and a pipe is the same
  bar with a coupling ring and a blunt open end instead.
- **The crowbar swing is a real swing**: cocked back over one shoulder, a fast sweep across
  the front, then a slow return to guard, alternating shoulders so a flurry is a flurry
  and not one frame on a loop. The **damage lands a third of the way through the sweep**,
  when the bar is actually out in front of you — not on the button press.
- **Zombies use the same rig** with a different posture: arms out in front, one leg
  dragging, the head lolled over, and a face the colour of something that has stopped
  circulating. Arms go fully out the moment one commits to a leap, which makes the
  telegraph readable off the body as well as off the ring.

Adding a weapon is one row in `WEAPONS` (stats) and one row in `WEAPON_ART` (silhouette),
joined by a single `art` field. Nothing else in the renderer learns its name.

## Local co-op

The game boots into a lobby with nobody playing:

1. **`ENTER` on the keyboard, or `START` on a controller** — you take the next free slot
2. **Press it again** — you are ready
3. **`ESC` / `B`** — un-ready, and again to leave the lobby
4. When everyone in the lobby is ready, the match starts

Up to four, in any mix of one keyboard and three pads. `[` `]` changes the map and `C`
switches camera from the lobby too.

The roster is fixed once the match starts — everyone joins in the lobby, so a stray
`START` mid-firefight cannot re-split the screen on the people already playing.

To work on the split-screen layout without four controllers plugged in, open
`?players=4`. That skips the lobby entirely and starts with four players, the extra
three inert but fully rendered — which is also how the test suite drives the game.

## Zombies

The enemy is the dead. They carry nothing, so they never shoot — everything they do is
close-range, and every part of it is readable off the world rather than off UI.

- **They wander** when they have no idea you exist — a third of your walking pace,
  turning at random and bouncing off walls. That is the ambient population only.
- **They hunt.** A zombie that arrives with a wave knows roughly where the squad is and
  walks the actual route there, reading a heading off a flow field over the tile grid.
  Sight alone is not enough to make a horde: chasing needs line of sight, so a wave
  spawning three rooms away would otherwise mill about until the fight found it. The
  same field is what gets an investigating zombie *round* a corner instead of into it.
- **They see in a wide, short arc** — about 160° across and under five tiles, and it
  needs line of sight, the same primitive the player's flashlight uses. Walking past one
  head-on is hard; slipping behind it is easy. If a wall stops you seeing it, it cannot
  see you.
- **They hear through walls.** A shot carries 600–850 units depending on the weapon,
  breaking a pane 600, a sprinting footfall 180, and hitting the floor at the end of a
  dive 250. **Walking makes no noise at all.** Loudness falls off with distance and the
  loudest thing wins, so a zombie between two noises goes to the one filling its ears.
  Sound deliberately ignores walls: shooting from cover should still pull the room
  toward you.
- **They lunge.** In range they plant, and a red ring closes on them for about a third of
  a second — that is your window. Then they commit to a direction and leap; the leap does
  not steer. Contact costs you 18. A miss puts them face down for half a second, unable
  to move or turn, taking **60% extra damage**. Dodging is worth more than backing up:
  their chase pace is below your walk, so the leap is the only way they can catch you.

`F1` then `F3` draws the field, one arrow per tile — the fastest way to see why a horde
is going the wrong way.

Every number above lives in one row of `ZOMBIE_DEFS` (`src/sim/zombies.ts`). **Adding a
kind of zombie is one entry in that table** — a runner is a walker with a bigger
`chaseSpeed` and a shorter windup, a brute one with more health and a heavier bite. The
state machine, the renderer and the director all read the table by key, so nothing else
changes. `F1` draws each zombie's state and sense arc while you tune.

## Modes

The lobby hands off to a mode select:

**Story** is the campaign — hand-made missions on a mission map. Finish one and it
unlocks whatever required it, and you come back to the map after every mission, won or
lost. Missions have placed zombies you can learn, spawn zones so reinforcements are not
always the same, and a safe room to reach. Progress is kept in `localStorage`.

**Survival** is the endless one: a fresh procedural layout every run, bigger waves and
shorter breathers. No exit, no objective — last as long as you can.

The starter campaign, *Sector 7*, lives in `src/campaign/campaign.ts`: five missions as
glyph art, each with a node position on the mission map and a list of missions it
requires. Adding one is an entry in that array — the mission select screen has no
per-mission code in it.

**Vertical Slice** is a six-floor building: car park, service corridors, the street
outside, lobby, cubicle floor, roof. Stairs (`^`) join the floors and the squad carries
its condition up, so it plays as one continuous climb. See
[docs/LEVELS.md](docs/LEVELS.md#multi-floor-missions).

## Dead in Space

The other opening mission is nine decks of a derelict colony ship, and it is the one the
objective chain was built for. It runs in four acts:

**Act I — wake up.** Cryo-sleep sickness has taken everyone's memory and the ship is
running on dying emergency batteries. You start with a **crowbar and no gun at all**,
which changes the whole texture of a floor: melee is quiet, so a deck cleared with it
stays cleared, and two zombies in a doorway is a fight rather than a formality. Standing
orders say report to the security hub — and the first gun on the ship is in its armoury,
along with a log that starts to explain what happened.

**Act II — the wall.** Up through the residential deck to the bridge, where the blast
door is dead: *no main power, manual bypass at the reactor.* Walking up to it is loud.
The director drops whatever it was doing, opens every door on the deck at once, and from
here the ship is hunting you rather than merely containing you.

**Act III — the descent.** Down into engineering and the reactor, the two darkest decks
in the game. Three fusion sockets, each one seven seconds of holding a button while
somebody else watches the door — and seating the first cell starts a siege that runs
until the last one is in. When it is, **main power comes back**: the lights slam on
across every deck, the alarm starts, and the director is handed everything left.

**Act IV — the run back.** The same maps, walked the other way with the alarm blazing:
cabins sealed that were open, vents broken through that were not, and a director leaning
more than twice as hard as it did on the way down. At the top, the blast door finally
answers — a ninety-second unseal you have to survive on the catwalk before the bridge is
yours.

Four crew terminals along the way carry the story. They gate nothing, which is exactly
why they are worth the detour.

## The extraction finale

The roof does not end when you reach it. There is a helipad with nothing on it and an
unlit signal flare sitting in the middle of it, and the mission ends the way it should
end:

**Light the flare** — one player standing on it for a moment and it goes up. **Hold for
two minutes** — the director drops its phase loop and runs a holdout instead, closing
the gap between waves from eight seconds to three and raising the live cap as the clock
runs down, so the heaviest wave lands on the pickup rather than somewhere in the middle.
The burning flare is a lure as well as a light: everything that cannot see a player
walks toward it, which is what makes the roof a place to defend. Then **nine seconds of
helicopter**, coming in from off the map with the rotor thumping into the noise field —
as loud to the horde as it is to you — and only once the skids are down is the pad an
exit at all.

It is two glyphs to author: a block of exit tiles for the pad and one `F` for the
beacon. Any floor can have one. The details are in
[docs/LEVELS.md](docs/LEVELS.md#the-extraction-finale).

## Sound

Everything is synthesised — oscillators, filtered noise and envelopes. There are no
sample files, no loader and nothing to 404, which is the same bet the renderer makes
with blocks instead of sprites and for the same reason: one file you can read beats a
folder of binaries you cannot diff.

**Every noise the zombies hear is a sound you hear.** The noise field feeds the audio
layer directly, so the loudness on screen is the same number the director uses — a
shotgun is louder in your ears for exactly the reason it pulls a bigger room. That
matters because the game now has a mechanic you cannot learn any other way.

On top of that: a growl for the crowd, more often and higher the more of them are near
and the more of them are hunting, so a horde sounds like a horde without forty voices; a
rising **screech on the windup**, because a telegraph you can only see is no use when
the thing is behind you; a whoosh on the leap; the two-tone whoop of a car alarm; and
the ordinary business of hits, reloads, downs and revives.

Sounds are placed against the **nearest** player and panned against that player's own
view — split screen has no single pair of ears, and averaging four positions puts every
sound in the middle of nowhere. Anything past about 23 tiles is inaudible. Voices are
capped per frame, because a panic horde will happily ask for forty.

The bus never throws: no audio device, a context that will not start, a headless test
runner — all of them get a bus that counts what it was asked to play and makes no sound.
`M` mutes, and the choice is remembered. Nothing in `src/sim` imports any of it; the
audio layer watches the world from outside, the same way the renderer does.

## The director

Pressure has a shape, modelled on Left 4 Dead's AI Director rather than on a spawn
table. It runs four phases in a loop:

| phase | what it does |
| --- | --- |
| **buildup** | releases a wave every 9–16s (7–12s in survival), one door at a time |
| **peak** | holds for 4s with nothing new arriving — the fight you are in is the fight |
| **fade** | stops spawning and waits for the squad to get on top of it |
| **relax** | 18–30s of guaranteed quiet (12–20s in survival) before it starts again |

The phase changes on **intensity**, not on a clock: survivor stress climbs when you take
damage, when zombies are inside about four tiles of you, and hard while anyone is down,
and it decays whenever none of that is happening. The squad's intensity is the *worst*
player's rather than the average — one person being mauled is a peak even if the other
three are fine.

**Waves come out of doors.** Zone tiles (`8`) that touch each other are one door, so a
row of twelve along a wall is a single way in and not twelve. A wave is a group out of
one door, never the same door twice running, and never a door anybody can currently see
— using exactly the test that decides whether a zombie gets drawn, so nothing ever pops
in where you are looking. A map with four separated doors therefore plays differently
every run, which is the whole reason to paint more than one.

**Car alarms** cut across the whole loop. An alarmed car (`A`, drawn in warning colours
with hazard lights) that takes a bullet drops the director into a **panic**: a wave out of
*every* door at once, ignoring the usual "not while anyone is watching" rule, and twenty
seconds of noise loud enough to pull every zombie on the floor toward the car while more
keep arriving every 3–5 seconds. A second flow field, aimed at the open ring around the
car, is what actually routes them there. Then it fades. Once per car, ever — the tiles are spent
and become an ordinary wreck.

**A lit signal flare** cuts across it the other way. Where a panic is a shock, a
**holdout** is a scripted two minutes with a known end: the loop and its intensity gate
are set aside, the gap between waves closes from eight seconds to three as the clock
runs down and the live cap climbs with it, so the heaviest wave lands on the pickup
rather than somewhere in the middle. The intensity gate has to go, because a squad
pinned in one place is *permanently* at peak stress, and a director reading that would
politely stop sending anything at exactly the wrong moment. See
[the extraction finale](#the-extraction-finale).

**Arriving is quiet.** No authored zombie is placed within about six tiles of a spawn
tile, and the director adds nothing for the first six seconds of a floor. Walking out of
a stairwell into a bite is not difficulty; it is the game starting before you did.

Underneath all of it a couple of **wanderers** per squad are kept alive at all times,
well away from everyone, so a relax reads as quiet rather than as the level having run
out. `F1` shows the phase, the intensity, the wave count and the door count.

Tuning is two tables at the top of `src/sim/director.ts` — `STORY_TUNING` and
`SURVIVAL_TUNING`.

## Maps

Levels are 2D arrays of tile ids — `0` floor, `1` wall, `2` player spawn, `3` zombie,
`4` crate, `5` glass, `6` lamp, `7` exit, `8` spawn zone, `9` stairs, `20` signal flare,
plus scenery (`10` car, `11` window, `12` reception desk, `13` cubicle, `14` flare,
`15` lift door, `16` blocked floor, `17` broken glass, `18` broken window) and the
objective devices (`21` terminal, `23` weapon locker, `25` fusion socket, `27` blast
door, `28` stairs down):

```
[1,1,1,1,1,1,1],
[1,0,0,0,0,0,1],
[1,2,0,0,0,3,1],
[1,0,0,4,0,8,1],
[1,7,0,0,0,0,1],
[1,1,1,1,1,1,1],
```

or the same thing as glyph art, which is how the campaign missions are written:

```
#######
#.....#
#P...E#
#..X.Z#
#>....#
#######
```

Paint one in the **editor** (`/editor.html`) and hit ▶ Play, drop a `.json` onto the game
window, or just paste rows like the above straight into the game with `Ctrl+V`. Built-ins
load with `?level=corridors`, `?level=showcase` or `?level=procedural`.

Adding a new tile type is one row in `TILE_DEFS` — the collision, vision, renderer,
editor palette and importer all read from that one table.
[docs/LEVELS.md](docs/LEVELS.md) has the full reference.

## Current state

Implemented: fixed-timestep loop, device-agnostic input with drop-in join, tile world
driven by a tile-id registry, circle-vs-grid collision, DDA raycast vision cones with
adaptive shadow edges, per-viewport cameras and split-screen layout, the lighting
composite with static lamps, pooled bullets and particles, zombies that see in an arc,
hear through walls, path by flow field and lunge, downed and revive, an intensity-driven wave director,
a flare-and-helicopter extraction finale, top-down character art with a solved arm rig,
distance-driven gaits and per-weapon silhouettes, melee weapons, hold-to-use devices
(terminals, weapon lockers, fusion sockets and a blast door) driving a multi-act
objective chain, per-floor difficulty pressure, HUD per viewport,
a debug overlay, synthesised positional sound, the level format with a tolerant
importer, and a map editor.

Not built yet: music, menus and a controller-assignment screen, per-player loadouts and
an ammo economy, saves, and netcode. The architecture doc says where each of
those attaches.
