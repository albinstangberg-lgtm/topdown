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
| Shove a mutant off a pinned teammate | Hold `F` | Hold Y |
| Use a device (terminal, fusion socket, blast door) | Hold `F` | Hold Y |
| Pull an emergency breach lever | Hold `F` | Hold Y |
| Shoulder / put down a fusion core or a power cell | Tap `F` | Tap Y |
| Seat a carried core, or hand a cell to a teammate | Tap `F` | Tap Y |
| Use the utility item (hold for a medkit or a welder) | `G` | R3 |
| Flashlight on / off | `T` | LB + RB together |
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
  telegraph readable off the body as well as off the ring. A **Stalker** is the same rig
  flattened along its own length — it goes about on all fours — and comes up onto its
  haunches when it is sitting on somebody, so you can see what has your teammate.

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

## The mutants

Three things on the ship are not walkers, and each one exists to break a habit the squad
has already formed by the time they meet it.

### The Strangler — the dark is not empty

It never comes to you. It holds a corner outside your cone, reaches **400 units** — most
of a corridor, and well past what a flashlight shows you — and drags whoever it catches
away into the dark.

- It winds up for **0.7s** before it throws, and it is audible doing it. Break the line
  of sight during that and nothing happens at all.
- A caught player is **reeled in at 155 units/second and cannot shoot.** That is the
  whole design: the person in trouble is not the person who can solve it.
- **Cutting the tendril takes 26 damage** — two or three rounds — against the 90 it takes
  to kill the thing holding it. Cutting the rope is the panicked answer anyone can manage
  across a dark room; killing it is the considered one. Both work, and a round spent
  cutting is a round that does not reach the body, so it is a real choice.
- The tendril is drawn under the darkness pass, so **only the lit stretch of it shows.**
  Somebody has to put a beam on the rope before anybody can cut it.

### The Stalker — splitting up is not free

It reads the squad's overlapping cones and goes for whoever is outside them. Stay
together and it will sit in the ducts all mission. (Playing alone, you are by definition
the straggler — which is most of what makes a solo run of a deck with one on it feel
different from a co-op one.)

- **It only targets a player nobody else has eyes on.** Coverage is literally "is this
  player inside another player's cone, with line of sight" — so covering each other is
  the counterplay, not a suggestion.
- It is **silent** — it makes no footfall at all — until the **wet skitter** half a
  second before it goes. That is the only warning the target gets.
- A pounce ends **on top of you**: pinned, unable to shoot, taking 15/second. A teammate
  **shoves it off by holding USE** for about a second, or kills it. Adrenaline is the one
  self-rescue.
- **A beam full in its face blinds it** — 0.6s of light and it is out for two seconds,
  including mid-leap, where it drops on the spot.
- It uses the **ceiling ducts** to reposition. Up there nothing on the floor can touch
  it, but it scrapes as it goes, and a shot through the grate it is crossing reaches it.
  The shadow the renderer draws over the grate IS the hitbox — "shoot the shadow" is the
  whole rule.

### The Ceiling Lurker — the floor is not the only direction

It never walks the deck at all. It moves from ceiling vent to ceiling vent, out of reach
and out of every cone in the game, and it waits.

- **It drops on people who stand still.** Stop under an unlit grate for a second and a
  half and it comes down on top of you and pins you, the same restraint a Stalker's
  pounce makes — so the counter is the same too: a teammate shoving it off.
- **Lit floor denies it outright.** A flare, a glowstick or a working lamp under the
  grate and it will not commit, however long you stand there. A grate with a light under
  it is a safe tile, which is what turns "where are the vents" into map knowledge.
- **You cannot touch it up there.** Nothing on the floor reaches into a duct — but the
  shadow the renderer paints over the grate it is crossing is its hitbox, and a round
  through the grate does hit it. Shoot the shadow.
- It is **silent** apart from the scraping, so what you get is a sound above your head
  and about a second to not be under it.

## The utility slot

One primary weapon, one utility item. That cap is the design: with two slots every
pickup is a decision made out loud, and nothing needs an inventory screen. Items come
from **supply caches** you walk onto, the same way a weapon locker works.

| Item | What it does |
| --- | --- |
| **Medkit** | Hold `G` for 3 seconds. Puts back 70% of max health — yours, or a teammate's if one is in arm's reach. It will not pick somebody up off the floor: that is what reviving is for. |
| **Adrenaline** | Instant. Faster, reloads in 60% of the time for 8 seconds — and it **tears you out of a grip**, which is the only way to free yourself. |
| **Flare** | Throw it. Twenty seconds of a lit room, for everybody, with nobody holding a flashlight — which is the counter to both mutants at once. |
| **Welding tool** | Three charges. Stand in a bulkhead and hold `G` to seal it. It buys time, not safety: whatever is on the far side chews through it. |

## One battery for the whole suit

Guns on this ship do not eat boxes of brass. **The flashlight, the scope, the welding
tool and the magazine all draw off the same cell**, and that single shared number turns
every question the deck asks into a question about power:

- Walking with the beam on spends the magazine you have not fired yet — a fresh cell is
  about four and a half minutes of pure light and nothing else.
- **Reloading** is what actually costs: the charge goes in at the end of the reload, so a
  nearly-flat suit hands you a short magazine and you know exactly why.
- **Firing dips the light.** For two seconds after a shot the cone drops toward half
  range as power diverts to the weapon — which makes "you shoot, I'll hold the light"
  a real conversation, held in the dark, at the worst moment.
- Flat suit? The **crowbar and the halo are free**. A dead cell is dark and dangerous,
  never a soft lock: you still have a body, a bar of metal and enough glow to see your
  own boots. The ammo line in the HUD goes amber and tells you the primary is stowed.
- **Charging points** (`e`) put it back slowly while you stand on one — in the open,
  which is the price. **Battery racks** (`b`) give you a spare cell to carry.

## Heavy things are carried, not looted

Fusion cores and spare power cells are **two-handed objects**, not pickups. Shoulder one
and your primary goes away for as long as you are holding it: you have a sidearm and a
crowbar, and somebody else is doing the shooting. Walking a core across a dark deck is a
job for the squad, not for the person holding it.

- Tap `F` on a **core rack** (`O`) or a **battery rack** (`b`) to shoulder one; tap `F`
  again to put it down where you stand, and it stays there for whoever comes back.
- A core seats into a **fusion socket** with one press. On a deck that has a core rack on
  it the sockets will not take a dwell at all — you fetch, or the reactor stays dark.
- A cell goes to **whoever needs it more**: hold one next to a teammate with less charge
  than you and pressing `F` hands it over rather than topping up your own suit.

## Vacuum, and the doors that split you up

- **Hull breach levers** (`Y`). Ten seconds of open hull, and every one of them costs
  something. Walkers go out of the hole and off the ship — that is what you paid for.
  But the squad's **oxygen is shared** and it goes with them, the depressurisation is the
  loudest thing on the deck, and anybody not standing on a **railing** (`|`) is being
  dragged toward the same hole as the horde. Run out of air in there and it starts
  hurting everybody. The lever works once.
- **Airlocks** (`:`). A chamber holds **two people**. Step in with a teammate and the
  doors shut behind you for a five-second equalise — so a squad of four arrives on the
  far side as two pairs, and for those five seconds nobody can help anybody. The HUD
  counts it down for whoever is inside. One person alone never triggers it.

## Hazards, and the light you choose to carry

- **Exposed cables and standing water.** Touching flooded tiles gather into one puddle
  the way car tiles gather into one car. Put a round into a cable touching a puddle and
  the whole thing goes live for 2.4 seconds: it cooks anything standing in it, and it
  **whites out the vision of anyone nearby, including you**. A cable needs 12 seconds
  before it will do it again, so it is a tool rather than a doorway you can hold.
- **Coolant leaks.** A split pipe fills the room with fog that is baked into the map at
  load. In it your **cone is gone** and so is everybody else's — nothing inside a fog
  bank can be seen at all — but the halo stays, so you can still see your own boots. You
  navigate it by sound.
- **Sound you can see.** Every noise draws an expanding ring, over the darkness and over
  the fog, coloured by what made it and by whether a living thing or a dead one made it.
  Shamblers now make footfalls for exactly this reason — the horde cannot hear its own
  (or it would spend the mission walking toward itself), but you can. In a fog bank the
  ripples are the game.
- **Shadow lines.** Visibility is per light source and it is solved with real geometry,
  so anything standing behind cover *relative to the light that would show it* is
  invisible, at three feet as surely as at thirty. A torch pointed straight down a room
  full of crates leaves dead angles in it, and the counter is not a brighter torch — it
  is a second person lighting the same room from somewhere else.
- **Light-dependent aggro.** The flashlight is a **toggle** (`T`). In a room with its
  emergency lights still on, having it on costs you nothing. In a dead-dark one it is a
  lure on the same field a gunshot rides, every 0.9 seconds — so the dark is safer, and
  you cannot see in it. Walking a black deck with the beam off is a real option and a
  genuinely bad idea.

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

**Act II — the wall.** Up through the residential deck — which has a Ceiling Lurker in
its ducts — to the bridge approach, where the blast door is dead: *no main power, manual
bypass at the reactor.* The only way on is down, and the way down is a **two-person
airlock**, so a full squad arrives at the approach as two pairs five seconds apart.
Walking up to the door is loud: the director drops whatever it was doing, opens every
door on the deck at once, and from here the ship is hunting you rather than merely
containing you.

**Act III — the descent.** Down into engineering and the reactor, the two darkest decks
in the game — and the two where the suit battery starts to bite, which is why both have a
charging point on them. The reactor wants three cells, and they are on a **rack** beside
the housing: each one is carried out to its socket in both hands with your primary
stowed, so every trip is a job for the squad rather than for the person holding it. Seating the first core starts
a siege that runs until the last one is in. When it is, **main power comes back**: the
lights slam on across every deck, the alarm starts, and the director is handed everything
left.

**Act IV — the run back.** The same maps, walked the other way with the alarm blazing:
cabins sealed that were open, vents broken through that were not, a **hull breach** in
engineering with a lever and a line of railings for whoever is brave enough to use it,
and a director leaning more than twice as hard as it did on the way down. At the top, the blast door finally
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

Sounds are placed against the player with the best **line** to them — nearest only
breaks the tie — and panned against that player's own view: split screen has no single
pair of ears, and averaging four positions puts every sound in the middle of nowhere.
Anything past about 23 tiles is inaudible. Voices are capped per frame, because a panic
horde will happily ask for forty.

**Geometry is part of the mix.** Every positional sound is occluded against the walls
between it and whoever is listening, using the same raycast the vision cones use. One
partition puts a low-pass on it and takes most of the level; two metal bulkheads and it
is simply not played. That last part is the mechanic rather than the mix: behind a wall
the audibility threshold *rises*, so a footstep next door is not quiet — it is gone,
while a shotgun through the same wall still lands as a thump. It is the difference
between "I can just about hear something shuffling in there", which gives every ambush
away, and a silent room. Step round the corner and the same sound snaps to crisp, and
that transition is worth more than the information the muffled version was leaking.

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
`15` lift door, `16` blocked floor, `17` broken glass, `18` broken window), the
objective devices (`21` terminal, `23` weapon locker, `25` fusion socket, `27` blast
door, `28` stairs down), the ship's hazards (`29` ceiling vent, `30` flooded floor,
`31` exposed cable, `32` coolant leak, `33` bulkhead), its systems (`42` core rack,
`43` battery rack, `44` charging point, `45` breach lever, `47` hull breach,
`48` railing, `49`–`51` airlock chamber and doors) and what you find and fight in
them (`35`–`38` supply caches, `40` Strangler, `41` Stalker, `52` Ceiling Lurker):

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

Four built-in maps ship with the game, cycled with `[` and `]`: **Corridors**,
**Tile Showcase**, **Deck Hazards** and **Deck Systems**. The last two are showcase
decks — one of everything, within walking distance of the spawn. Hazards has both
ambush mutants, all four items, water and a cable, a coolant bank, vents and bulkheads;
Systems has the power budget (a charging point, both racks, three sockets that will only
take a carried core), an airlock, a hull breach with its lever and railings, and a
Ceiling Lurker in the vents.

## Current state

Implemented: fixed-timestep loop, device-agnostic input with drop-in join, tile world
driven by a tile-id registry, circle-vs-grid collision, DDA raycast vision cones with
adaptive shadow edges, per-viewport cameras and split-screen layout, the lighting
composite with static lamps, pooled bullets and particles, zombies that see in an arc,
hear through walls, path by flow field and lunge, downed and revive, an intensity-driven wave director,
a flare-and-helicopter extraction finale, top-down character art with a solved arm rig,
distance-driven gaits and per-weapon silhouettes, three ambush mutants (a ranged grab,
a pin and a ceiling drop) with vent travel, a one-slot utility inventory, electrified
water, coolant fog, a toggleable flashlight that trades sight for attention, one shared
suit battery behind the guns, lights and tools, two-handed carries that stow the primary,
hull breaches with shared oxygen and railings, two-person airlocks,
audio occluded against the geometry, a sound-ripple visualiser,
melee weapons, hold-to-use devices
(terminals, weapon lockers, fusion sockets and a blast door) driving a multi-act
objective chain, per-floor difficulty pressure, HUD per viewport,
a debug overlay, synthesised positional sound, the level format with a tolerant
importer, and a map editor.

Not built yet: music, menus and a controller-assignment screen, per-player loadouts,
saves, and netcode. The architecture doc says where each of
those attaches.
