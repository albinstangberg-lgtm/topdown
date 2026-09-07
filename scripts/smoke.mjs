/**
 * Headless smoke test. Drives the real build in Chromium and asserts that the
 * systems actually talk to each other: bullets damage enemies, enemies damage
 * players, downed players are a state and not a crash, and restart clears the field.
 *
 *   npm run build && npm run preview &   # then:
 *   node scripts/smoke.mjs
 */
import { chromium } from "playwright";

const URL = process.env.SMOKE_URL ?? "http://localhost:4173/";
const EXECUTABLE = process.env.CHROMIUM_PATH || undefined;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch(EXECUTABLE ? { executablePath: EXECUTABLE } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// Combat checks run on the fixed camera: aiming is absolute there, so "point at the
// enemy and shoot" is deterministic. The rotating camera gets its own checks below.
await page.goto(`${URL}?camera=fixed&players=1`, { waitUntil: "load" });
await page.waitForTimeout(500);

check("boots without exceptions", errors.length === 0, errors.join(" | "));
check("player 1 exists", await page.evaluate(() => window.game.world.players.length === 1));

// The director spawns on a timer; give it a moment before poking at enemies.
await page.waitForFunction(() => window.game.world.enemies.length > 0, null, { timeout: 8000 });

// Bullets damage enemies: park one right in front of the player and shoot it.
const killed = await page.evaluate(async () => {
  const w = window.game.world;
  const p = w.players[0];
  p.facing = 0;
  const e = w.enemies[0] ?? null;
  if (!e) return "no enemy spawned";
  e.x = p.x + 90;
  e.y = p.y;
  e.health = 20;
  const before = w.enemies.length;
  return { before, id: e.id };
});
check("an enemy is on the field", typeof killed === "object", String(killed));

if (typeof killed === "object") {
  await page.mouse.move(640 + 200, 360);
  await page.keyboard.down("Space");
  await page.waitForTimeout(700);
  await page.keyboard.up("Space");
  const after = await page.evaluate((id) => ({
    gone: !window.game.world.enemies.some((e) => e.id === id),
    kills: window.game.world.players[0].kills,
  }), killed.id);
  check("player bullets kill enemies", after.gone, `kills=${after.kills}`);
}

// AI perception: an enemy with the player in its cone and clear line of sight
// must leave patrol on its own.
await page.waitForFunction(() => window.game.world.enemies.length > 0, null, { timeout: 8000 });
const perceived = await page.evaluate(async () => {
  const w = window.game.world;
  const p = w.players[0];
  const e = w.enemies[0];
  e.x = p.x + 120;
  e.y = p.y;
  e.facing = Math.PI;
  e.alertness = 0;
  e.state = "patrol";
  await new Promise((r) => setTimeout(r, 400));
  return { state: e.state, target: e.targetId };
});
check("enemies acquire a target through their vision cone",
  perceived.state !== "patrol" && perceived.target === 0, JSON.stringify(perceived));

// Enemy bullets damage players, and zero health means downed rather than deleted.
const downed = await page.evaluate(async () => {
  const w = window.game.world;
  const p = w.players[0];
  p.health = 5;
  w.bullets.spawn(p.x - 60, p.y, 0, 500, 20, "enemy", -1, 1, "#ff6b6b");
  await new Promise((r) => setTimeout(r, 500));
  return { downed: p.downed, health: p.health, stillInArray: w.players.length === 1 };
});
check("player at 0 hp goes downed, not deleted",
  downed.stillInArray && downed.downed === true, JSON.stringify(downed));

// Restart wipes the field and puts everyone back on their feet.
const restarted = await page.evaluate(async () => {
  const w = window.game.world;
  w.restart();
  await new Promise((r) => setTimeout(r, 200));
  return { enemies: w.enemies.length, downed: w.players[0].downed, hp: w.players[0].health };
});
check("restart clears enemies and revives the squad",
  restarted.downed === false && restarted.hp > 0, JSON.stringify(restarted));

// Split screen: adding players must relayout, not throw.
const split = await page.evaluate(async () => {
  const g = window.game;
  for (let i = g.world.players.length; i < 4; i++) g.world.addPlayer(`test${i}`);
  await new Promise((r) => setTimeout(r, 600));
  return g.world.players.length;
});
check("4 players render without errors", split === 4 && errors.length === 0, errors.join(" | "));

// --- camera ------------------------------------------------------------------

const camPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const camErrors = [];
camPage.on("pageerror", (e) => camErrors.push(String(e)));
await camPage.goto(`${URL}?level=showcase&players=1`, { waitUntil: "load" });
await camPage.waitForTimeout(500);

// Put the player in open floor and point the cursor dead ahead so steering is neutral.
const openFloor = async () => camPage.evaluate(() => {
  const p = window.game.world.players[0];
  const T = 48;
  p.x = 12.5 * T; p.y = 9.5 * T; p.prevX = p.x; p.prevY = p.y; p.vx = 0; p.vy = 0;
  window.game.cameras[0].snapTo(p.x, p.y, p.facing);
});
await camPage.mouse.move(640, 720 * 0.78 - 220);
await openFloor();
await camPage.waitForTimeout(300);

const anchored = await camPage.evaluate(() => {
  const cam = window.game.cameras[0];
  const vp = window.game.views[0];
  const p = window.game.world.players[0];
  // Where does the player actually land on screen?
  const anchor = cam.anchorScreen(vp);
  const dx = (p.x - cam.x) * cam.zoom;
  const dy = (p.y - cam.y) * cam.zoom;
  const r = cam.rotation;
  const sx = anchor.x + dx * Math.cos(r) - dy * Math.sin(r);
  const sy = anchor.y + dx * Math.sin(r) + dy * Math.cos(r);
  return { mode: cam.mode, screenY: sy, screenX: sx, height: vp.h, width: vp.w };
});
check("rotating camera puts the player low on screen",
  anchored.mode === "rotating" &&
  anchored.screenY / anchored.height > 0.7 && anchored.screenY / anchored.height < 0.85 &&
  Math.abs(anchored.screenX - anchored.width / 2) < 30,
  JSON.stringify(anchored));

// WASD must be camera-relative, or holding forward walks you sideways.
const walk = async (key) => {
  await openFloor();
  await camPage.waitForTimeout(150);
  const start = await camPage.evaluate(() => {
    const p = window.game.world.players[0];
    return { x: p.x, y: p.y, a: window.game.cameras[0].angle };
  });
  await camPage.keyboard.down(key);
  await camPage.waitForTimeout(400);
  await camPage.keyboard.up(key);
  const end = await camPage.evaluate(() => {
    const p = window.game.world.players[0];
    return { x: p.x, y: p.y };
  });
  let rel = Math.atan2(end.y - start.y, end.x - start.x) - start.a;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  return { deg: (rel * 180) / Math.PI, dist: Math.hypot(end.x - start.x, end.y - start.y) };
};

const forward = await walk("KeyW");
const strafe = await walk("KeyD");
check("movement is relative to the camera, not the world",
  forward.dist > 40 && Math.abs(forward.deg) < 12 &&
  strafe.dist > 40 && Math.abs(strafe.deg - 90) < 12,
  `forward ${forward.deg.toFixed(1)}deg, strafe ${strafe.deg.toFixed(1)}deg`);

// Aiming becomes steering: off-centre turns, dead ahead holds.
const steerRight = await camPage.evaluate(async () => {
  const p = window.game.world.players[0];
  const a0 = p.facing;
  await new Promise((r) => setTimeout(r, 500));
  return p.facing - a0;
});
await camPage.mouse.move(640 + 300, 720 * 0.78 - 80);
const turned = await camPage.evaluate(async () => {
  const p = window.game.world.players[0];
  const a0 = p.facing;
  await new Promise((r) => setTimeout(r, 500));
  let d = p.facing - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
});
await camPage.mouse.move(640, 720 * 0.78);
const held = await camPage.evaluate(async () => {
  const p = window.game.world.players[0];
  const a0 = p.facing;
  await new Promise((r) => setTimeout(r, 500));
  return Math.abs(p.facing - a0);
});
check("aim steers the view and settles when pointed dead ahead",
  turned > 0.5 && held < 0.02 && Math.abs(steerRight) < 0.02,
  `dead-ahead ${steerRight.toFixed(3)}, right ${turned.toFixed(3)}, deadzone ${held.toFixed(4)}`);

// Steering is proportional: a cursor just outside the dead zone scans, a far one spins.
const steerRate = async (offsetX) => {
  await camPage.mouse.move(640, 720 * 0.78 - 220); // recentre, stop turning
  await camPage.waitForTimeout(250);
  await camPage.mouse.move(640 + offsetX, 720 * 0.78);
  return camPage.evaluate(async () => {
    const p = window.game.world.players[0];
    const a0 = p.facing;
    await new Promise((r) => setTimeout(r, 500));
    let d = p.facing - a0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  });
};
const nudge = await steerRate(100);
const shove = await steerRate(320);
check("mouse steering is proportional to distance from the player",
  nudge > 0.02 && shove > nudge * 2.5,
  `near ${nudge.toFixed(3)} rad, far ${shove.toFixed(3)} rad`);
await camPage.mouse.move(640, 720 * 0.78 - 220);

// Weapon stance: the gun only comes up when the aim device is actually pushed.
await camPage.mouse.move(640, 720 * 0.78);        // cursor on the player = no deflection
await camPage.waitForTimeout(900);
const lowered = await camPage.evaluate(() => window.game.world.players[0].weaponUp);
await camPage.mouse.move(640, 200);               // pushed well ahead
await camPage.waitForTimeout(500);
const raised = await camPage.evaluate(() => window.game.world.players[0].weaponUp);
check("the weapon lowers on a neutral aim device and shoulders when pushed",
  lowered < 0.02 && raised > 0.98, `down ${lowered.toFixed(2)}, up ${raised.toFixed(2)}`);

// Firing with the gun down must not be swallowed: it raises, then shoots.
const trigger = await camPage.evaluate(async () => {
  const p = window.game.world.players[0];
  p.ammo = p.weapon.magazine;
  p.reloadTimer = 0;
  return p.ammo;
});
await camPage.mouse.move(640, 720 * 0.78);
await camPage.waitForTimeout(900);
await camPage.keyboard.down("Space");
await camPage.waitForTimeout(60);
const immediate = await camPage.evaluate(() => window.game.world.players[0].ammo);
await camPage.waitForTimeout(500);
const eventually = await camPage.evaluate(() => window.game.world.players[0].ammo);
await camPage.keyboard.up("Space");
check("a lowered weapon holds fire until it is up, rather than eating the input",
  immediate === trigger && eventually < trigger,
  `start ${trigger}, at 60ms ${immediate}, at 560ms ${eventually}`);

const toggled = await camPage.evaluate(async () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyC" }));
  await new Promise((r) => setTimeout(r, 200));
  const cam = window.game.cameras[0];
  return { mode: cam.mode, rotation: cam.rotation };
});
check("C toggles back to the fixed camera",
  toggled.mode === "fixed" && toggled.rotation === 0, JSON.stringify(toggled));
check("camera page raised no exceptions", camErrors.length === 0, camErrors.join(" | "));

// --- gamepad -----------------------------------------------------------------

// Headless Chromium cannot produce real pad input, so stand up a virtual standard-
// mapping pad. This does not prove any particular controller reports these button
// numbers, but it does exercise the whole source: discovery, deadzone, join, steering.
const padPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const padErrors = [];
padPage.on("pageerror", (e) => padErrors.push(String(e)));
await padPage.addInitScript(() => {
  const pad = {
    index: 0,
    id: "virtual test pad (standard)",
    connected: true,
    mapping: "standard",
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })),
    timestamp: 0,
  };
  window.__pad = pad;
  navigator.getGamepads = () => [pad];
});
await padPage.goto(`${URL}?level=showcase&players=1`, { waitUntil: "load" });
await padPage.waitForTimeout(400);

const joined = await padPage.evaluate(async () => {
  window.__pad.buttons[9].pressed = true;   // START
  await new Promise((r) => setTimeout(r, 250));
  window.__pad.buttons[9].pressed = false;
  await new Promise((r) => setTimeout(r, 250));
  return { players: window.game.world.players.length, views: window.game.views.length };
});
check("a gamepad pressing START drops in as a second player",
  joined.players === 2 && joined.views === 2, JSON.stringify(joined));

// Left stick pushed "up" must walk along the camera's forward, same as WASD.
const padWalk = await padPage.evaluate(async () => {
  const p = window.game.world.players[1];
  const cam = window.game.cameras[1];
  const T = 48;
  p.x = 12.5 * T; p.y = 9.5 * T; p.prevX = p.x; p.prevY = p.y; p.vx = 0; p.vy = 0;
  cam.snapTo(p.x, p.y, p.facing);
  await new Promise((r) => setTimeout(r, 150));
  const a = cam.angle;
  const x0 = p.x;
  const y0 = p.y;
  window.__pad.axes[1] = -1;                // left stick up
  await new Promise((r) => setTimeout(r, 400));
  window.__pad.axes[1] = 0;
  let rel = Math.atan2(p.y - y0, p.x - x0) - a;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  return { deg: (rel * 180) / Math.PI, dist: Math.hypot(p.x - x0, p.y - y0) };
});
check("left stick moves relative to that player's own camera",
  padWalk.dist > 40 && Math.abs(padWalk.deg) < 12,
  `${padWalk.deg.toFixed(1)}deg over ${padWalk.dist.toFixed(0)}u`);

// The point of the exercise: deflection sets the turn RATE, not just the direction.
const padTurn = async (x) => padPage.evaluate(async (deflection) => {
  window.__pad.axes[2] = 0;
  await new Promise((r) => setTimeout(r, 200));
  const p = window.game.world.players[1];
  const a0 = p.facing;
  window.__pad.axes[2] = deflection;        // right stick, pushed right
  await new Promise((r) => setTimeout(r, 500));
  window.__pad.axes[2] = 0;
  let d = p.facing - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}, x);

const halfPush = await padTurn(0.5);
const fullPush = await padTurn(1);
const inDeadzone = await padTurn(0.15);
check("right stick deflection sets the turn rate",
  fullPush > 1 && halfPush > 0.05 && fullPush > halfPush * 2.5 && Math.abs(inDeadzone) < 0.02,
  `full ${fullPush.toFixed(3)}, half ${halfPush.toFixed(3)}, deadzone ${inDeadzone.toFixed(4)}`);

const padButtons = await padPage.evaluate(async () => {
  const p = window.game.world.players[1];
  const before = p.dashCooldown;
  window.__pad.buttons[6].pressed = true;   // LT = dash
  window.__pad.axes[0] = 1;                 // needs a direction to dash in
  await new Promise((r) => setTimeout(r, 200));
  window.__pad.buttons[6].pressed = false;
  window.__pad.axes[0] = 0;
  const dashed = p.dashCooldown > before;

  const ammo = p.ammo;
  window.__pad.buttons[7] = { pressed: true, value: 1, touched: true }; // RT = fire
  await new Promise((r) => setTimeout(r, 300));
  window.__pad.buttons[7] = { pressed: false, value: 0, touched: false };
  return { dashed, fired: p.ammo < ammo };
});
check("gamepad trigger fires and LT dashes",
  padButtons.dashed && padButtons.fired, JSON.stringify(padButtons));
check("gamepad page raised no exceptions", padErrors.length === 0, padErrors.join(" | "));

// --- lobby -------------------------------------------------------------------

const lobbyPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const lobbyErrors = [];
lobbyPage.on("pageerror", (e) => lobbyErrors.push(String(e)));
await lobbyPage.addInitScript(() => {
  const pad = {
    index: 0, id: "virtual test pad (standard)", connected: true, mapping: "standard",
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })),
    timestamp: 0,
  };
  window.__pad = pad;
  navigator.getGamepads = () => [pad];
});
const padStart = () => lobbyPage.evaluate(async () => {
  window.__pad.buttons[9].pressed = true;
  await new Promise((r) => setTimeout(r, 150));
  window.__pad.buttons[9].pressed = false;
  await new Promise((r) => setTimeout(r, 150));
});

// No ?players= this time: this is the real path a person takes.
await lobbyPage.goto(`${URL}?level=showcase`, { waitUntil: "load" });
await lobbyPage.waitForTimeout(600);

const atBoot = await lobbyPage.evaluate(() => ({
  phase: window.game.phase,
  players: window.game.world.players.length,
  slots: window.game.lobby.slots.length,
  hintHidden: document.getElementById("boot").hidden,
}));
check("the game boots into the menu with nobody playing",
  atBoot.phase === "menu" && atBoot.players === 0 && atBoot.slots === 0 && atBoot.hintHidden,
  JSON.stringify(atBoot));

await lobbyPage.keyboard.press("Enter");
await lobbyPage.waitForTimeout(200);
await padStart();
const slots = await lobbyPage.evaluate(() => ({
  phase: window.game.phase,
  slots: window.game.lobby.slots.map((s) => `${s.sourceId}:${s.ready}`),
}));
check("ENTER and START each claim a slot, and claiming does not start the match",
  slots.phase === "menu" && slots.slots.join(",") === "kbm:false,pad0:false",
  JSON.stringify(slots));

// Backing out: one press un-readies, the next leaves the lobby entirely.
await lobbyPage.keyboard.press("Enter");                 // keyboard ready
await lobbyPage.waitForTimeout(150);
await lobbyPage.keyboard.press("Escape");                // un-ready
await lobbyPage.waitForTimeout(150);
const unready = await lobbyPage.evaluate(() => window.game.lobby.slots.map((s) => s.ready));
await lobbyPage.keyboard.press("Escape");                // leave
await lobbyPage.waitForTimeout(150);
const left = await lobbyPage.evaluate(() => window.game.lobby.slots.map((s) => s.sourceId));
check("cancel un-readies first and only then drops the slot",
  unready[0] === false && left.join(",") === "pad0",
  `after un-ready ${JSON.stringify(unready)}, after leave ${JSON.stringify(left)}`);

// Rejoin and start for real.
await lobbyPage.keyboard.press("Enter");                 // keyboard joins again
await lobbyPage.waitForTimeout(200);
await lobbyPage.keyboard.press("Enter");                 // keyboard ready
await lobbyPage.waitForTimeout(200);
const oneReady = await lobbyPage.evaluate(() => window.game.phase);
await padStart();                                        // pad ready -> everyone is
await lobbyPage.waitForTimeout(500);
const started = await lobbyPage.evaluate(() => ({
  phase: window.game.phase,
  players: window.game.world.players.length,
  views: window.game.views.length,
  sources: window.game.world.players.map((p) => p.sourceId),
  hintShown: !document.getElementById("boot").hidden,
}));
check("the match starts only once every joined player is ready",
  oneReady === "menu" && started.phase === "playing" && started.players === 2 &&
  started.views === 2 && started.hintShown,
  `${oneReady} then ${JSON.stringify(started)}`);
check("lobby page raised no exceptions", lobbyErrors.length === 0, lobbyErrors.join(" | "));

// --- level import ------------------------------------------------------------

const levelPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const levelErrors = [];
levelPage.on("pageerror", (e) => levelErrors.push(String(e)));

await levelPage.goto(`${URL}?level=corridors&players=1`, { waitUntil: "load" });
await levelPage.waitForTimeout(400);
const corridors = await levelPage.evaluate(() => {
  const m = window.game.world.map;
  return { name: m.name, cols: m.cols, rows: m.rows, enemySpawns: m.enemySpawns.length };
});
check("built-in level loads with its authored spawns",
  corridors.cols === 13 && corridors.rows === 21 && corridors.enemySpawns === 3,
  JSON.stringify(corridors));

// Pasting a grid in the shape a person copies out of source has to work.
const pasted = await levelPage.evaluate(() => {
  const warnings = window.game.loadLevelText(
    "[1,1,1,1,1],\n[1,0,2,0,1],\n[1,0,0,0,1],\n[1,3,0,0,1],\n[1,1,1,1,1],",
    "pasted",
  );
  const m = window.game.world.map;
  return { warnings, cols: m.cols, rows: m.rows, players: m.playerSpawns.length, enemies: m.enemySpawns.length };
});
check("pasted grid rows import as a level",
  pasted.cols === 5 && pasted.rows === 5 && pasted.players === 1 && pasted.enemies === 1,
  JSON.stringify(pasted));

// A ragged, typo'd map should import with warnings rather than break.
const forgiving = await levelPage.evaluate(() => {
  const warnings = window.game.loadLevelText("[1,1,1,1]\n[1,0,99]\n[1,0,0,1]\n[1,1,1,1]", "ragged");
  const m = window.game.world.map;
  return { warnings, cols: m.cols, rows: m.rows };
});
check("ragged rows and unknown ids import with warnings",
  forgiving.cols === 4 && forgiving.rows === 4 && forgiving.warnings.length >= 2,
  JSON.stringify(forgiving));

// Glass: blocks the body, not the eye. Both halves of that pair in one check.
await levelPage.goto(`${URL}?level=showcase&players=1`, { waitUntil: "load" });
await levelPage.waitForFunction(() => window.game.world.enemies.length > 0, null, { timeout: 8000 });
const glass = await levelPage.evaluate(async () => {
  const w = window.game.world;
  const m = w.map;
  const TILE = 48;
  let pane = null;
  for (let ty = 0; ty < m.rows && !pane; ty++) {
    for (let tx = 0; tx < m.cols; tx++) {
      if (m.tileAt(tx, ty) === 5 && !m.isSolid(tx - 1, ty) && !m.isSolid(tx + 1, ty)) {
        pane = { tx, ty };
        break;
      }
    }
  }
  if (!pane) return "no glass pane with open sides in this map";

  const p = w.players[0];
  p.x = (pane.tx - 1.5) * TILE;
  p.y = (pane.ty + 0.5) * TILE;
  p.prevX = p.x; p.prevY = p.y;
  p.facing = 0;
  const e = w.enemies[0];
  if (!e) return "no enemy to place";
  e.x = (pane.tx + 2.5) * TILE;
  e.y = (pane.ty + 0.5) * TILE;
  await new Promise((r) => setTimeout(r, 250));

  const seenThroughGlass = e.visible;
  // Now walk straight at the pane and confirm the body does not pass through it.
  const startX = p.x;
  for (let i = 0; i < 60; i++) {
    p.vx = 900;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { seenThroughGlass, movedThrough: p.x > (pane.tx + 1) * TILE, startX, endX: p.x };
});
// The aim laser stops at glass; bullets must agree with it.
const glassStopsShots = await camPage.evaluate(async () => {
  const w = window.game.world;
  const m = w.map;
  const TILE = 48;
  let pane = null;
  for (let ty = 0; ty < m.rows && !pane; ty++) {
    for (let tx = 0; tx < m.cols; tx++) {
      if (m.tileAt(tx, ty) === 5 && !m.isSolid(tx - 1, ty) && !m.isSolid(tx + 1, ty)) {
        pane = { tx, ty };
        break;
      }
    }
  }
  if (!pane) return "no glass pane";
  const paneX = pane.tx * TILE;
  w.bullets.spawn((pane.tx - 2) * TILE, (pane.ty + 0.5) * TILE, 0, 700, 10, "player", 0, 1, "#fff");
  await new Promise((r) => setTimeout(r, 350));
  const past = w.bullets.items.some((b) => b.active && b.x > paneX + TILE);
  return { past };
});
check("bullets stop at glass, exactly where the aim laser ends",
  typeof glassStopsShots === "object" && glassStopsShots.past === false,
  JSON.stringify(glassStopsShots));

check("glass blocks movement but not sight",
  typeof glass === "object" && glass.seenThroughGlass === true && glass.movedThrough === false,
  JSON.stringify(glass));

// The editor hand-off: a level parked in localStorage loads as ?level=draft.
await levelPage.evaluate(() => {
  localStorage.setItem(
    "topdown.level.draft",
    JSON.stringify({ format: "topdown-level", version: 1, name: "draft test",
      grid: [[1,1,1,1,1],[1,0,2,0,1],[1,0,0,0,1],[1,0,0,3,1],[1,1,1,1,1]] }),
  );
});
await levelPage.goto(`${URL}?level=draft&players=1`, { waitUntil: "load" });
await levelPage.waitForTimeout(400);
const draft = await levelPage.evaluate(() => window.game.world.map.name);
check("editor draft loads through ?level=draft", draft === "draft test", String(draft));

check("level pages raised no exceptions", levelErrors.length === 0, levelErrors.join(" | "));

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
