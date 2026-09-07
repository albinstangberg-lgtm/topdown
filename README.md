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
| Move | `WASD` | Left stick |
| Aim | Mouse | Right stick |
| Fire | Left click / `Space` | RT / RB / A |
| Dash | `Shift` | LT / B |
| Revive teammate | Hold `E` | Hold X |
| Join the game | — | `START` |

Debug: `F1` overlay, `F2` collision grid, `Shift+R` restart, `[` / `]` change map.

## Local co-op

Player 1 is the keyboard and mouse. Plug in a gamepad and press `START` to drop in as
player 2, 3 or 4 — the screen re-splits live (full → side by side → quadrants) and the
new player spawns next to the squad.

To work on the split-screen layout without four controllers plugged in, open
`?players=4`. The extra players are inert but fully rendered.

## Maps

Levels are 2D arrays of tile ids — `0` floor, `1` wall, `2` player spawn, `3` enemy
spawn, `4` crate, `5` glass, `6` lamp:

```
[1,1,1,1,1,1,1],
[1,0,0,0,0,0,1],
[1,2,0,0,0,3,1],
[1,0,0,4,0,0,1],
[1,1,1,1,1,1,1],
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
