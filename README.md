# topdown

A top-down twin-stick shooter prototype in TypeScript + Canvas2D. Everything is
blocks on purpose — the point of this build is the systems underneath, not the art.

The look it is aiming for: close overhead camera, hard black geometry, and a cone of
light in front of the player that carves the visible world out of the dark.

Built so that going from 1 player to 4-player split-screen co-op is a layout change,
not a rewrite. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the core systems
and the order to build them in.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

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

Debug: `F1` overlay, `F2` collision grid, `Shift+R` regenerate the level.

## Local co-op

Player 1 is the keyboard and mouse. Plug in a gamepad and press `START` to drop in as
player 2, 3 or 4 — the screen re-splits live (full → side by side → quadrants) and the
new player spawns next to the squad.

To work on the split-screen layout without four controllers plugged in, open
`?players=4`. The extra players are inert but fully rendered.

## Current state

Implemented: fixed-timestep loop, device-agnostic input with drop-in join, tile world
with a placeholder generator, circle-vs-grid collision, DDA raycast vision cones with
adaptive shadow edges, per-viewport cameras and split-screen layout, the lighting
composite, pooled bullets and particles, enemies with cone-based perception, downed
and revive, a population director, HUD per viewport, and a debug overlay.

Not built yet: audio, menus and a controller-assignment screen, real level content,
weapon pickups and progression, saves, and netcode. The architecture doc says where
each of those attaches.
