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

## Modes

The lobby hands off to a mode select:

**Story** is the campaign — hand-made missions on a mission map. Finish one and it
unlocks whatever required it, and you come back to the map after every mission, won or
lost. Missions have placed zombies you can learn, spawn zones so reinforcements are not
always the same, and a safe room to reach. Progress is kept in `localStorage`.

**Survival** is the endless one: a fresh procedural layout every run and a director that
never stops. No exit, no objective — last as long as you can.

The starter campaign, *Sector 7*, lives in `src/campaign/campaign.ts`: five missions as
glyph art, each with a node position on the mission map and a list of missions it
requires. Adding one is an entry in that array — the mission select screen has no
per-mission code in it.

The opening mission, **Vertical Slice**, is a six-floor building: car park, service
corridors, the street outside, lobby, cubicle floor, roof. Stairs (`^`) join the floors
and the squad carries its condition up, so it plays as one continuous climb. See
[docs/LEVELS.md](docs/LEVELS.md#multi-floor-missions).

## Maps

Levels are 2D arrays of tile ids — `0` floor, `1` wall, `2` player spawn, `3` zombie,
`4` crate, `5` glass, `6` lamp, `7` exit, `8` spawn zone, `9` stairs, plus scenery
(`10` car, `11` window, `12` reception desk, `13` cubicle, `14` flare, `15` lift door,
`16` blocked floor):

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
composite with static lamps, pooled bullets and particles, enemies with cone-based
perception, downed and revive, a population director, HUD per viewport, a debug overlay,
the level format with a tolerant importer, and a map editor.

Not built yet: audio, menus and a controller-assignment screen, weapon pickups and
progression, objectives, saves, and netcode. The architecture doc says where each of
those attaches.
