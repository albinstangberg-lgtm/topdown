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

// Bullets damage enemies. Deliberately fires the bullet directly rather than going
// through aiming: two earlier versions of this check were flaky because the shot
// depended on the cursor, a damping camera and whatever wall happened to be in front.
// Aiming has its own checks; this one is about damage and kill accounting.
const killed = await page.evaluate(async () => {
  const w = window.game.world;
  const p = w.players[0];
  const e = w.enemies[0] ?? null;
  if (!e) return "no enemy spawned";

  // Put the target somewhere with room around it, then shoot from a clear side.
  const spot = w.map.mostOpenPoint();
  e.x = spot.x; e.y = spot.y; e.prevX = e.x; e.prevY = e.y; e.health = 20;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const from = dirs
    .map(([dx, dy]) => ({ dx, dy, x: spot.x - dx * 60, y: spot.y - dy * 60 }))
    .find((c) => !w.map.isSolidAt(c.x, c.y));
  if (!from) return "nowhere clear to shoot from";

  const kills = p.kills;
  for (let i = 0; i < 3; i++) {
    w.bullets.spawn(from.x, from.y, Math.atan2(from.dy, from.dx), 800, 12, "player", p.id, 1, "#fff");
  }
  await new Promise((r) => setTimeout(r, 400));
  return { gone: !w.enemies.some((x) => x.id === e.id), kills, after: p.kills };
});
check("player bullets kill enemies, and the kill is credited",
  typeof killed === "object" && killed.gone && killed.after === killed.kills + 1,
  JSON.stringify(killed));

// AI perception: a zombie with the player in its arc and clear line of sight
// must leave its wander on its own.
await page.waitForFunction(() => window.game.world.enemies.length > 0, null, { timeout: 8000 });
const perceived = await page.evaluate(async () => {
  const w = window.game.world;
  const p = w.players[0];
  const e = w.enemies[0];
  e.x = p.x + 120;
  e.y = p.y;
  e.facing = Math.PI;
  e.alertness = 0;
  e.state = "wander";
  e.stateTimer = 0;
  await new Promise((r) => setTimeout(r, 400));
  return { state: e.state, target: e.targetId };
});
check("zombies acquire a target through their sense arc",
  perceived.state !== "wander" && perceived.target === 0, JSON.stringify(perceived));

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
const quietField = () => camPage.evaluate(() => {
  const w = window.game.world;
  w.mode = "story";                 // story + zero spawn zones = no reinforcements
  w.map.spawnZones.length = 0;
  w.enemies.length = 0;
  const p = w.players[0];
  p.health = p.maxHealth;
  p.downed = false;
  p.stance = "stand";
  p.stanceTimer = 0;
});
await quietField();

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

// --- movement ----------------------------------------------------------------

// Speed is read off the velocity vector rather than displacement, so a wall in the
// way cannot make the measurement lie.
const speedWhile = async (keys) => {
  await camPage.evaluate(() => {
    const p = window.game.world.players[0];
    p.stance = "stand"; p.stanceTimer = 0; p.stamina = p.maxStamina; p.exhausted = false;
    p.vx = 0; p.vy = 0;
  });
  for (const k of keys) await camPage.keyboard.down(k);
  await camPage.waitForTimeout(400);                 // let the ramp settle
  const v = await camPage.evaluate(() => {
    const p = window.game.world.players[0];
    return { speed: Math.hypot(p.vx, p.vy), stamina: p.stamina };
  });
  for (const k of keys) await camPage.keyboard.up(k);
  await camPage.waitForTimeout(150);
  return v;
};

await camPage.mouse.move(640, 720 * 0.78 - 220);     // dead ahead: no steering
const walking = await speedWhile(["KeyW"]);
const sprinting = await speedWhile(["KeyW", "ShiftLeft"]);
check("walk is 70% and sprint 110% of the old baseline speed",
  Math.abs(walking.speed - 165) < 6 && Math.abs(sprinting.speed - 259) < 8,
  `walk ${walking.speed.toFixed(0)}u/s, sprint ${sprinting.speed.toFixed(0)}u/s`);
check("only sprinting drains stamina",
  walking.stamina >= 99.5 && sprinting.stamina < 95,
  `walking ${walking.stamina.toFixed(0)}, sprinting ${sprinting.stamina.toFixed(0)}`);

// Run the tank dry and confirm sprint locks out until stamina recovers.
const exhaustion = await camPage.evaluate(async () => {
  const p = window.game.world.players[0];
  p.stance = "stand"; p.stamina = 6; p.exhausted = false;
  return { start: p.stamina };
});
await camPage.keyboard.down("KeyW");
await camPage.keyboard.down("ShiftLeft");
await camPage.waitForTimeout(600);
const drained = await camPage.evaluate(() => {
  const p = window.game.world.players[0];
  return { exhausted: p.exhausted, stamina: p.stamina, speed: Math.hypot(p.vx, p.vy) };
});
await camPage.keyboard.up("ShiftLeft");
await camPage.keyboard.up("KeyW");
check("running out of stamina locks sprint back down to walking pace",
  drained.exhausted === true && drained.stamina < 1 && drained.speed < 175,
  `${JSON.stringify(exhaustion)} -> ${JSON.stringify(drained)}`);

// The dive: launch, land, get up — and you cannot shoot mid-flight.
const dive = await camPage.evaluate(async () => {
  const p = window.game.world.players[0];
  p.stance = "stand"; p.stanceTimer = 0; p.diveCooldown = 0;
  p.stamina = p.maxStamina; p.exhausted = false;
  p.ammo = p.weapon.magazine;

  const seen = [];
  const t0 = performance.now();
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
  await new Promise((r) => setTimeout(r, 120));
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "ControlLeft" }));
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "ControlLeft" }));

  let firedMidDive = false;
  let movedWhileProne = 0;
  let proneAt = null;
  while (performance.now() - t0 < 2900) {
    if (seen.length === 0 || seen[seen.length - 1].stance !== p.stance) {
      seen.push({ stance: p.stance, at: (performance.now() - t0) / 1000 });
    }
    if (p.stance === "dive") {
      const ammo = p.ammo;
      p.fireCooldown = 0;
      if (p.ammo < ammo) firedMidDive = true;
    }
    if (p.stance === "prone") {
      if (proneAt === null) proneAt = { x: p.x, y: p.y };
      movedWhileProne = Math.max(movedWhileProne, Math.hypot(p.x - proneAt.x, p.y - proneAt.y));
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }));
  return { seen, firedMidDive, movedWhileProne, stamina: p.stamina };
});
const order = dive.seen.map((s) => s.stance).join(">");
const proneStart = dive.seen.find((s) => s.stance === "prone");
const standUp = dive.seen.find((s) => s.stance === "standUp");
const proneLength = standUp && proneStart ? standUp.at - proneStart.at : 0;
check("a dive puts you on the floor for ~1.5s and then stands you back up",
  order === "stand>dive>prone>standUp>stand" &&
  Math.abs(proneLength - 1.5) < 0.2 && dive.movedWhileProne < 4,
  `${order}, prone ${proneLength.toFixed(2)}s, drift ${dive.movedWhileProne.toFixed(1)}u`);

// You can shoot lying down — that is the point of the dive.
const proneFire = await camPage.evaluate(async () => {
  const p = window.game.world.players[0];
  p.stance = "prone"; p.stanceTimer = 4; p.ammo = p.weapon.magazine; p.reloadTimer = 0;
  p.weaponUp = 1; p.weaponHold = 1;
  const before = p.ammo;
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
  await new Promise((r) => setTimeout(r, 400));
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
  const after = p.ammo;
  p.stance = "stand"; p.stanceTimer = 0;
  return { before, after };
});
check("you can shoot from the floor", proneFire.after < proneFire.before,
  JSON.stringify(proneFire));

// Lean: the eye slides sideways, the collision body does not, and a wall stops it.
await quietField();
const lean = await camPage.evaluate(async () => {
  const p = window.game.world.players[0];
  const m = window.game.world.map;
  const TILE = 48;
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  // Open floor, facing "north" so leaning moves the eye along x.
  const put = (tx, ty) => {
    p.x = tx * TILE; p.y = ty * TILE; p.prevX = p.x; p.prevY = p.y;
    p.vx = 0; p.vy = 0; p.facing = -Math.PI / 2; p.lean = 0;
    p.stance = "stand"; p.stanceTimer = 0;
  };
  put(12.5, 9.5);
  await settle(200);
  const bodyBefore = { x: p.x, y: p.y };

  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE" }));   // lean right
  await settle(500);
  const leaned = { eyeX: p.eyeX, eyeY: p.eyeY, x: p.x, y: p.y, lean: p.lean };
  // Facing north, screen-right is world -x.
  const eyeShift = leaned.eyeX - leaned.x;
  const bodyMoved = Math.hypot(leaned.x - bodyBefore.x, leaned.y - bodyBefore.y);
  const coneFollowed = Math.abs(p.cone.x - p.eyeX) < 0.001;

  // Now hard against a wall: the lean must not push the eye through it.
  let wall = null;
  for (let ty = 1; ty < m.rows - 1 && !wall; ty++) {
    for (let tx = 1; tx < m.cols - 1; tx++) {
      if (m.isSolid(tx, ty) && !m.isSolid(tx + 1, ty)) { wall = { tx, ty }; break; }
    }
  }
  put(wall.tx + 1.4, wall.ty + 0.5);
  p.facing = -Math.PI / 2;                       // wall is now to screen-left... lean into it
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyE" }));
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyQ" }));   // lean left
  await settle(500);
  const insideWall = m.isSolidAt(p.eyeX, p.eyeY);
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyQ" }));
  await settle(300);
  return { eyeShift, bodyMoved, coneFollowed, insideWall, leanValue: leaned.lean };
});
check("leaning moves where you look and shoot, but never the body or into a wall",
  Math.abs(lean.eyeShift) > 15 && lean.bodyMoved < 1 && lean.coneFollowed &&
  lean.insideWall === false,
  JSON.stringify(lean));

// Manual reload: tops up a partial magazine, ignores a full one, works prone.
await quietField();
const reload = await camPage.evaluate(async () => {
  const p = window.game.world.players[0];
  const press = () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyR" }));
  };
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  p.stance = "stand"; p.stanceTimer = 0; p.reloadTimer = 0;
  p.ammo = 7;
  press();
  await settle(120);
  const started = p.reloadTimer > 0;
  await settle(p.weapon.reloadTime * 1000 + 250);
  const topped = p.ammo;

  // A full magazine should not cost you a reload you did not need.
  press();
  await settle(150);
  const wastedOnFull = p.reloadTimer > 0;

  // On the floor you can still reload.
  p.stance = "prone"; p.stanceTimer = 4; p.ammo = 5;
  press();
  await settle(150);
  const proneReload = p.reloadTimer > 0;

  // Mid-dive you cannot.
  p.reloadTimer = 0; p.ammo = 5;
  p.stance = "dive"; p.stanceTimer = 0.3;
  press();
  await settle(100);
  const diveReload = p.reloadTimer > 0;

  p.stance = "stand"; p.stanceTimer = 0; p.reloadTimer = 0; p.ammo = p.weapon.magazine;
  return { started, topped, magazine: p.weapon.magazine, wastedOnFull, proneReload, diveReload };
});
check("manual reload tops up a partial magazine, and only when it should",
  reload.started && reload.topped === reload.magazine && !reload.wastedOnFull &&
  reload.proneReload && !reload.diveReload,
  JSON.stringify(reload));

// Weapon stance: the gun only comes up when the aim device is actually pushed.
await quietField();
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
// There is no mid-match join any more, so the pad comes in through the lobby.
await padPage.goto(`${URL}?level=showcase`, { waitUntil: "load" });
await padPage.waitForTimeout(500);
const padStartPress = () => padPage.evaluate(async () => {
  window.__pad.buttons[9].pressed = true;
  await new Promise((r) => setTimeout(r, 160));
  window.__pad.buttons[9].pressed = false;
  await new Promise((r) => setTimeout(r, 160));
});
await padPage.keyboard.press("Enter");      // keyboard takes slot 1
await padPage.waitForTimeout(200);
await padStartPress();                      // pad takes slot 2
await padPage.keyboard.press("Enter");      // keyboard ready
await padPage.waitForTimeout(200);
await padStartPress();                      // pad ready -> mode select
await padPage.waitForTimeout(300);
await padPage.keyboard.down("KeyD");        // highlight SURVIVAL
await padPage.waitForTimeout(200);
await padPage.keyboard.up("KeyD");
await padPage.keyboard.press("Enter");      // deploy
await padPage.waitForTimeout(500);
const joined = await padPage.evaluate(() => ({
  players: window.game.world.players.length,
  views: window.game.views.length,
  phase: window.game.phase,
}));
check("a gamepad joins through the lobby and gets its own viewport",
  joined.players === 2 && joined.views === 2 && joined.phase === "playing",
  JSON.stringify(joined));

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
  p.stance = "stand"; p.stanceTimer = 0; p.diveCooldown = 0; p.stamina = p.maxStamina;
  window.__pad.buttons[6].pressed = true;   // LT = dive
  window.__pad.axes[0] = 1;                 // needs a direction to dive in
  await new Promise((r) => setTimeout(r, 200));
  window.__pad.buttons[6].pressed = false;
  window.__pad.axes[0] = 0;
  const dashed = p.stance === "dive" || p.stance === "prone";
  p.stance = "stand"; p.stanceTimer = 0;    // do not leave the next check on the floor

  const ammo = p.ammo;
  window.__pad.buttons[7] = { pressed: true, value: 1, touched: true }; // RT = fire
  await new Promise((r) => setTimeout(r, 300));
  window.__pad.buttons[7] = { pressed: false, value: 0, touched: false };
  return { dashed, fired: p.ammo < ammo };
});
check("gamepad trigger fires and LT dives",
  padButtons.dashed && padButtons.fired, JSON.stringify(padButtons));

// A is sprint now, not fire.
const padSprint = await padPage.evaluate(async () => {
  const p = window.game.world.players[1];
  p.stance = "stand"; p.stanceTimer = 0; p.stamina = p.maxStamina; p.exhausted = false;
  p.ammo = p.weapon.magazine; p.reloadTimer = 0; p.vx = 0; p.vy = 0;
  const ammoBefore = p.ammo;

  window.__pad.axes[1] = -1;                  // left stick forward
  await new Promise((r) => setTimeout(r, 400));
  const walkSpeed = Math.hypot(p.vx, p.vy);

  window.__pad.buttons[0].pressed = true;     // A
  await new Promise((r) => setTimeout(r, 450));
  const sprintSpeed = Math.hypot(p.vx, p.vy);
  const stamina = p.stamina;
  window.__pad.buttons[0].pressed = false;
  window.__pad.axes[1] = 0;
  return { walkSpeed, sprintSpeed, stamina, ammoBefore, ammoAfter: p.ammo };
});
check("A sprints and no longer fires",
  Math.abs(padSprint.walkSpeed - 165) < 8 && Math.abs(padSprint.sprintSpeed - 259) < 10 &&
  padSprint.stamina < 95 && padSprint.ammoAfter === padSprint.ammoBefore,
  `walk ${padSprint.walkSpeed.toFixed(0)}, sprint ${padSprint.sprintSpeed.toFixed(0)}, ` +
  `stamina ${padSprint.stamina.toFixed(0)}, ammo ${padSprint.ammoAfter}`);
// Mid-match join is gone: an unclaimed device pressing START must be ignored.
const lateJoin = await padPage.evaluate(async () => {
  const before = window.game.world.players.length;
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "Enter" }));
  await new Promise((r) => setTimeout(r, 400));
  return { before, after: window.game.world.players.length };
});
check("nobody can join once the match has started",
  lateJoin.after === lateJoin.before, JSON.stringify(lateJoin));

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
check("the game boots into the lobby with nobody playing",
  atBoot.phase === "lobby" && atBoot.players === 0 && atBoot.slots === 0 && atBoot.hintHidden,
  JSON.stringify(atBoot));

await lobbyPage.keyboard.press("Enter");
await lobbyPage.waitForTimeout(200);
await padStart();
const slots = await lobbyPage.evaluate(() => ({
  phase: window.game.phase,
  slots: window.game.lobby.slots.map((s) => `${s.sourceId}:${s.ready}`),
}));
check("ENTER and START each claim a slot, and claiming does not start the match",
  slots.phase === "lobby" && slots.slots.join(",") === "kbm:false,pad0:false",
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
  roster: window.game.lobby.slots.length,
}));
check("the lobby hands off to mode select once every joined player is ready",
  oneReady === "lobby" && started.phase === "mode" && started.roster === 2,
  `${oneReady} then ${JSON.stringify(started)}`);
check("lobby page raised no exceptions", lobbyErrors.length === 0, lobbyErrors.join(" | "));

// --- campaign ----------------------------------------------------------------

const storyPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const storyErrors = [];
storyPage.on("pageerror", (e) => storyErrors.push(String(e)));
await storyPage.goto(URL, { waitUntil: "load" });
await storyPage.evaluate(() => localStorage.removeItem("topdown.campaign.sector-7"));
await storyPage.reload({ waitUntil: "load" });
await storyPage.waitForTimeout(600);

// Walk the whole flow the way a person does: join, ready, story, deploy.
await storyPage.keyboard.press("Enter");        // claim a slot
await storyPage.waitForTimeout(200);
await storyPage.keyboard.press("Enter");        // ready -> mode select
await storyPage.waitForTimeout(300);
const atMode = await storyPage.evaluate(() => window.game.phase);
await storyPage.keyboard.press("Enter");        // STORY is the first card
await storyPage.waitForTimeout(300);
const atMissions = await storyPage.evaluate(() => ({
  phase: window.game.phase,
  index: window.game.missionSelect.index,
}));
check("story mode leads to the mission map, survival does not",
  atMode === "mode" && atMissions.phase === "missions" && atMissions.index === 0,
  `${atMode} -> ${JSON.stringify(atMissions)}`);

// Locked missions must refuse to deploy.
const locked = await storyPage.evaluate(async () => {
  const g = window.game;
  g.missionSelect.index = g.missionSelect.campaign.missions.findIndex((m) => m.requires.length > 0);
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "Enter" }));
  await new Promise((r) => setTimeout(r, 400));
  const phase = g.phase;
  g.missionSelect.index = 0;
  return { phase };
});
check("a locked mission cannot be deployed", locked.phase === "missions",
  JSON.stringify(locked));

await storyPage.keyboard.press("Enter");        // deploy the first mission
await storyPage.waitForTimeout(600);
const deployed = await storyPage.evaluate(() => {
  const w = window.game.world;
  return {
    phase: window.game.phase,
    mode: w.mode,
    map: w.map.name,
    placedZombies: w.map.enemySpawns.length,
    enemiesNow: w.enemies.length,
    // Authored zombies inside the arrival bubble are dropped on purpose, so the two
    // counts need not match — but nothing may end up standing on the squad.
    nearSpawn: w.enemies.filter((e) => w.map.playerSpawns.some(
      (p) => Math.hypot(p.x - e.x, p.y - e.y) < 300)).length,
    zones: w.map.spawnZones.length,
    stairs: w.map.stairs.length,
    objective: w.objective.kind,
  };
});
check("a story mission loads with its placed zombies, zones and a way onward",
  deployed.phase === "playing" && deployed.mode === "story" &&
  deployed.placedZombies > 0 && deployed.enemiesNow > 0 &&
  deployed.enemiesNow <= deployed.placedZombies && deployed.nearSpawn === 0 &&
  deployed.zones > 0 && deployed.stairs > 0 && deployed.objective === "stairs",
  JSON.stringify(deployed));

// The director in a story map may only use the authored zones.
const zoneOnly = await storyPage.evaluate(async () => {
  const w = window.game.world;
  const zones = w.map.spawnZones;
  w.enemies.length = 0;
  // Skip the arrival grace and the opening breather: this check is about WHERE waves
  // come from, not when.
  w.director.grace = 0;
  w.director.phase = "buildup";
  w.director.waveTimer = 0;

  // Enemies start walking the moment they exist, so record where each one APPEARED
  // rather than where it has got to by the end of the sample.
  const seen = new Map();
  const t0 = performance.now();
  while (performance.now() - t0 < 5000) {
    for (const e of w.enemies) {
      if (!seen.has(e.id)) seen.set(e.id, { x: e.x, y: e.y });
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  const spawns = [...seen.values()];
  const offZone = spawns.filter(
    (p) => !zones.some((z) => Math.hypot(z.x - p.x, z.y - p.y) < 1),
  );
  return { zoneCount: zones.length, spawned: spawns.length, offZone: offZone.length };
});
check("story reinforcements only come from spawn zones",
  zoneOnly.spawned > 0 && zoneOnly.offZone === 0, JSON.stringify(zoneOnly));

// Climbing: the stairs load the next floor and the squad's condition comes with it.
const climbed = await storyPage.evaluate(async () => {
  const w = window.game.world;
  const p = w.players[0];
  const before = { map: w.map.name, x: p.x, y: p.y };
  // The zone check above leaves a real fight behind, and it sometimes leaves the
  // tester on the floor. This check is about what the stairs carry up, so it starts
  // from a squad that is on its feet rather than from whoever won that scrap.
  p.downed = false;
  p.bleedout = 0;
  p.health = 41;
  p.ammo = 7;
  p.stamina = 33;

  const step = w.map.stairs[0];
  p.x = step.x; p.y = step.y; p.prevX = p.x; p.prevY = p.y;
  await new Promise((r) => setTimeout(r, 1400));
  return {
    before: before.map,
    after: w.map.name,
    health: p.health,
    ammo: p.ammo,
    stamina: Math.round(p.stamina),
    inBounds: p.x >= 0 && p.y >= 0 && p.x <= w.map.worldWidth && p.y <= w.map.worldHeight,
    solid: w.map.isSolidAt(p.x, p.y),
  };
});
check("stairs move the squad up a floor, carrying its condition",
  climbed.before !== climbed.after && climbed.after.includes("Floor 2") &&
  climbed.health === 41 && climbed.ammo === 7 && climbed.inBounds && !climbed.solid,
  JSON.stringify(climbed));

// Climb the rest of the building. The roof is where the climbing stops: it has no
// stairs and its exit is a helipad that does nothing until the finale has run.
const topped = await storyPage.evaluate(async () => {
  const g = window.game;
  const visited = [g.world.map.name];
  for (let i = 0; i < 8; i++) {
    const w = g.world;
    const step = w.map.stairs[0];
    if (!step || g.phase !== "playing") break;
    const p = w.players[0];
    p.health = p.maxHealth;
    p.downed = false;
    p.x = step.x; p.y = step.y; p.prevX = p.x; p.prevY = p.y;
    await new Promise((r) => setTimeout(r, 1300));
    if (g.phase === "playing" && !visited.includes(w.map.name)) visited.push(w.map.name);
  }

  // Standing on the pad with the flare unlit must achieve exactly nothing.
  const w = g.world;
  const p = w.players[0];
  const exit = w.map.exits[0];
  p.health = p.maxHealth;
  p.downed = false;
  p.x = exit.x; p.y = exit.y; p.prevX = p.x; p.prevY = p.y;
  await new Promise((r) => setTimeout(r, 1200));
  return {
    visited,
    phase: g.phase,
    objective: w.objective.kind,
    extraction: w.extraction.phase,
    flares: w.map.signals.length,
  };
});
// The previous check already took us to floor 2, so this climbs the remaining four.
check("the whole building can be climbed, and the roof's pad is shut until the flare is lit",
  topped.visited.some((n) => n.includes("Floor 6")) && topped.visited.length === 5 &&
  topped.phase === "playing" && topped.flares === 1 &&
  topped.extraction === "signal" && topped.objective === "signal",
  JSON.stringify(topped));

// The finale: light it, hold it, board what turns up. The two minutes are skipped by
// winding the clock on — the check is about the state machine and what gates the exit,
// and sitting through the countdown twice would double the runtime of the suite.
const finale = await storyPage.evaluate(async () => {
  const g = window.game;
  const w = g.world;
  const p = w.players[0];
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  // Keep the tester alive and the roof clear: this check is not about the fight.
  const hold = () => {
    p.health = p.maxHealth;
    p.downed = false;
    p.stance = "stand";
    p.stanceTimer = 0;
    w.enemies.length = 0;
  };

  const lampsBefore = w.staticLights.length;
  const flare = w.map.signals[0];
  hold();
  p.x = flare.x; p.y = flare.y; p.prevX = p.x; p.prevY = p.y;
  await settle(2200);
  const lit = {
    phase: w.extraction.phase,
    seconds: Math.round(w.extraction.timeLeft),
    director: w.director.phase,
    lure: w.lureFlow.goalCount,
    litTheRoof: w.staticLights.length > lampsBefore,
  };

  // Still nothing doing on the pad while the clock is running.
  const exit = w.map.exits[0];
  hold();
  p.x = exit.x; p.y = exit.y; p.prevX = p.x; p.prevY = p.y;
  await settle(1200);
  const holding = { phase: g.phase, objective: w.objective.kind };

  w.extraction.timeLeft = 0.2;
  hold();
  await settle(800);
  const inbound = { phase: w.extraction.phase, flying: w.chopper.active };

  w.extraction.timeLeft = 0.2;
  hold();
  await settle(800);
  const landed = {
    phase: w.extraction.phase,
    onThePad: Math.hypot(w.chopper.x - w.extraction.padX, w.chopper.y - w.extraction.padY) < 1,
    altitude: w.chopper.altitude,
  };

  // Skids down: now it is an exit like any other.
  hold();
  p.x = exit.x; p.y = exit.y; p.prevX = p.x; p.prevY = p.y;
  await settle(1400);
  return { lit, holding, inbound, landed, phase: g.phase, completed: [...g.completed] };
});
check("the flare starts the holdout, and only a landed helicopter is an exit",
  finale.lit.phase === "holdout" && finale.lit.seconds >= 115 &&
  finale.lit.director === "holdout" && finale.lit.lure > 0 && finale.lit.litTheRoof &&
  finale.holding.phase === "playing" && finale.holding.objective === "holdout" &&
  finale.inbound.phase === "inbound" && finale.inbound.flying === true &&
  finale.landed.phase === "ready" && finale.landed.onThePad &&
  finale.landed.altitude === 0 &&
  finale.phase === "missions" && finale.completed.includes("tower"),
  JSON.stringify(finale));

// Progress persists across a reload and opens what required it.
await storyPage.reload({ waitUntil: "load" });
await storyPage.waitForTimeout(500);
const persisted = await storyPage.evaluate(() => {
  const g = window.game;
  const missions = g.missionSelect.campaign.missions;
  const unlocked = missions
    .filter((m) => m.requires.every((r) => g.completed.has(r)))
    .map((m) => m.id);
  return { completed: [...g.completed], unlocked };
});
check("progress persists and unlocks the missions that required it",
  persisted.completed.includes("tower") && persisted.unlocked.includes("outpost") &&
  !persisted.unlocked.includes("vault"),
  JSON.stringify(persisted));

// A single-floor mission still ends on its exit tile rather than stairs.
await storyPage.goto(`${URL}?players=1&mission=outpost`, { waitUntil: "load" });
await storyPage.waitForTimeout(600);
const singleFloor = await storyPage.evaluate(async () => {
  const w = window.game.world;
  const kind = w.objective.kind;
  const p = w.players[0];
  const exit = w.map.exits[0];
  p.x = exit.x; p.y = exit.y; p.prevX = p.x; p.prevY = p.y;
  await new Promise((r) => setTimeout(r, 1400));
  return { kind, phase: window.game.phase };
});
check("a one-floor mission still extracts on its exit",
  singleFloor.kind === "exit" && singleFloor.phase === "missions",
  JSON.stringify(singleFloor));

check("campaign page raised no exceptions", storyErrors.length === 0, storyErrors.join(" | "));

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

// Glass: a bullet goes through it and shatters it into something walkable.
const glassBreak = await camPage.evaluate(async () => {
  const art = [
    "###########",
    "#.........#",
    "#..GGGGG..#",
    "#.........#",
    "#....P....#",
    "###########",
  ].join("\n");
  window.game.loadLevelText(art, "glass break test");
  await new Promise((r) => setTimeout(r, 400));

  const w = window.game.world;
  const m = w.map;
  const T = 48;
  const p = w.players[0];
  const before = { id: m.tileAt(5, 2), solid: m.isSolid(5, 2) };

  w.bullets.spawn(5.5 * T, 4.0 * T, -Math.PI / 2, 800, 10, "player", p.id, 1, "#fff");
  let reachedAbove = false;
  const until = performance.now() + 500;
  while (performance.now() < until) {
    for (const b of w.bullets.items) if (b.active && b.y < 1.5 * T) reachedAbove = true;
    await new Promise((r) => requestAnimationFrame(r));
  }

  return {
    before,
    after: { id: m.tileAt(5, 2), solid: m.isSolid(5, 2) },
    shotCarriedOn: reachedAbove,
    // Only the pane it crossed should go; the rest of the wall stands.
    neighbourIntact: m.tileAt(4, 2) === 5 && m.tileAt(6, 2) === 5,
  };
});
check("a bullet passes through glass and shatters just the pane it crossed",
  glassBreak.before.id === 5 && glassBreak.before.solid === true &&
  glassBreak.after.id === 17 && glassBreak.after.solid === false &&
  glassBreak.shotCarriedOn && glassBreak.neighbourIntact,
  JSON.stringify(glassBreak));

// And the squad can then walk through the hole it made.
const throughHole = await camPage.evaluate(async () => {
  const w = window.game.world;
  const T = 48;
  const p = w.players[0];
  p.stance = "stand"; p.stanceTimer = 0;
  p.x = 5.5 * T; p.y = 3.5 * T; p.prevX = p.x; p.prevY = p.y;
  for (let i = 0; i < 60; i++) {
    p.vy = -700;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { pastPane: p.y < 1.9 * T, endY: Math.round((p.y / T) * 10) / 10 };
});
check("once broken, the squad walks through the gap",
  throughHole.pastPane === true, JSON.stringify(throughHole));

// Windows smash the same way — but into their own tile, because a window is also a
// way in for the director and breaking it must not quietly delete the spawn point.
const windowBreak = await camPage.evaluate(async () => {
  const art = [
    "#####W#####",
    "#.........#",
    "#.........#",
    "#....P....#",
    "#.........#",
    "###########",
  ].join("\n");
  window.game.loadLevelText(art, "window break test");
  await new Promise((r) => setTimeout(r, 400));

  const w = window.game.world;
  const m = w.map;
  const T = 48;
  const before = { id: m.tileAt(5, 0), solid: m.isSolid(5, 0), zones: m.spawnZones.length };

  const p = w.players[0];
  w.bullets.spawn(5.5 * T, 3.0 * T, -Math.PI / 2, 800, 10, "player", p.id, 1, "#fff");
  await new Promise((r) => setTimeout(r, 400));

  p.stance = "stand"; p.stanceTimer = 0;
  p.x = 5.5 * T; p.y = 1.5 * T; p.prevX = p.x; p.prevY = p.y;
  for (let i = 0; i < 60; i++) {
    p.vy = -700;
    await new Promise((r) => requestAnimationFrame(r));
  }

  return {
    before,
    after: { id: m.tileAt(5, 0), solid: m.isSolid(5, 0), zones: m.spawnZones.length },
    walkedIn: p.y < 1.0 * T,
  };
});
check("a window smashes into a walkable hole that is still a spawn zone",
  windowBreak.before.id === 11 && windowBreak.before.solid === true &&
  windowBreak.after.id === 18 && windowBreak.after.solid === false &&
  windowBreak.after.zones === windowBreak.before.zones && windowBreak.walkedIn,
  JSON.stringify(windowBreak));

// Intact glass: blocks the body, not the eye. Two halves, deliberately separated —
// the sight half needs an enemy behind the pane, and that enemy shoots the pane out,
// which used to leave the movement half walking through a hole and still passing.
//
// This page has been toggled to the FIXED camera by an earlier check, where the cursor
// sets facing absolutely, so the cursor goes out to the right where the pane is. The
// check asserts that facing, so it fails loudly rather than measuring the wrong way.
const GLASS_ART = [
  "###############",
  "#.............#",
  "#......G......#",
  "#......G......#",
  "#..P...G...E..#",
  "#......G......#",
  "#.............#",
  "###############",
].join("\n");

await camPage.mouse.move(640 + 320, 360);
await camPage.waitForTimeout(250);
const glassSight = await camPage.evaluate(async (art) => {
  window.game.loadLevelText(art, "intact glass sight");
  await new Promise((r) => setTimeout(r, 400));
  const w = window.game.world;
  const T = 48;
  const p = w.players[0];
  p.stance = "stand"; p.stanceTimer = 0; p.health = p.maxHealth; p.downed = false;
  p.x = 4.5 * T; p.y = 4.5 * T; p.prevX = p.x; p.prevY = p.y;
  p.facing = 0;
  window.game.cameras[0].snapTo(p.x, p.y, 0);

  const e = w.enemies[0];
  if (!e) return "no enemy behind the glass";
  e.x = 11.5 * T; e.y = 4.5 * T;
  await new Promise((r) => setTimeout(r, 300));
  return {
    seenThroughGlass: e.visible,
    paneIntact: w.map.tileAt(7, 4) === 5,
    facing: Math.round(p.facing * 100) / 100,
  };
}, GLASS_ART);
check("you can see through intact glass",
  typeof glassSight === "object" && Math.abs(glassSight.facing) < 0.2 &&
  glassSight.paneIntact === true && glassSight.seenThroughGlass === true,
  JSON.stringify(glassSight));

const glassMove = await camPage.evaluate(async (art) => {
  window.game.loadLevelText(art, "intact glass movement");
  await new Promise((r) => setTimeout(r, 300));
  const w = window.game.world;
  const m = w.map;
  const T = 48;
  // No enemy: nothing else is allowed to shoot the pane out during the test.
  w.enemies.length = 0;
  const p = w.players[0];
  p.stance = "stand"; p.stanceTimer = 0; p.health = p.maxHealth; p.downed = false;
  p.x = 4.5 * T; p.y = 4.5 * T; p.prevX = p.x; p.prevY = p.y;

  for (let i = 0; i < 70; i++) {
    p.vx = 800;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return {
    movedThrough: p.x > 7.5 * T,
    stillGlass: m.tileAt(7, 4) === 5,
    endX: Math.round((p.x / T) * 10) / 10,
  };
}, GLASS_ART);
check("intact glass stops the body",
  glassMove.movedThrough === false && glassMove.stillGlass === true,
  JSON.stringify(glassMove));

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

// Blocked floor: solid to a body, transparent to sight AND to bullets. The three
// axes are separate flags, and this is the tile that proves it.
const blocked = await levelPage.evaluate(async () => {
  const art = [
    "####################",
    "#..................#",
    "#..................#",
    "#....____.....E....#",
    "#....____..........#",
    "#....____..........#",
    "#..................#",
    "#........P.........#",
    "#..................#",
    "####################",
  ].join("\n");
  window.game.loadLevelText(art, "blocked floor test");
  await new Promise((r) => setTimeout(r, 400));

  const w = window.game.world;
  const m = w.map;
  const T = 48;
  const p = w.players[0];

  // Walk hard into the patch from below; the body must not get in.
  p.x = 6.5 * T; p.y = 6.5 * T; p.prevX = p.x; p.prevY = p.y;
  for (let i = 0; i < 70; i++) {
    p.vy = -700;
    await new Promise((r) => requestAnimationFrame(r));
  }
  const insidePatch = m.isSolidAt(p.x, p.y);
  const gotPast = p.y < 5.6 * T;

  // A bullet crossing it must carry on.
  // Fired from well left of the patch, so it has to cross the whole thing. Track the
  // furthest it gets rather than sampling once — a fixed wait is a race.
  w.bullets.spawn(1.5 * T, 3.5 * T, 0, 800, 10, "player", p.id, 1, "#fff");
  let reached = 0;
  const until = performance.now() + 700;
  while (performance.now() < until) {
    for (const b of w.bullets.items) if (b.active) reached = Math.max(reached, b.x);
    await new Promise((r) => requestAnimationFrame(r));
  }
  const bulletPast = reached > 9 * T;

  return {
    solid: m.isSolid(5, 3),
    opaque: m.isOpaque(5, 3),
    stopsShots: m.blocksShots(5, 3),
    insidePatch, gotPast, bulletPast, reached: Math.round(reached / 48),
  };
});
check("blocked floor stops bodies but not sight or bullets",
  blocked.solid && !blocked.opaque && !blocked.stopsShots &&
  !blocked.insidePatch && !blocked.gotPast && blocked.bulletPast,
  JSON.stringify(blocked));

check("level pages raised no exceptions", levelErrors.length === 0, levelErrors.join(" | "));

// --- zombies -----------------------------------------------------------------
//
// The enemy is the dead: no guns, a telegraphed leap you can dodge, and ears that
// work through walls. Each check runs on its own arena so the director cannot wander
// a second zombie into the answer.

const zomPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const zomErrors = [];
zomPage.on("pageerror", (e) => zomErrors.push(String(e)));
await zomPage.goto(`${URL}?camera=fixed&players=1`, { waitUntil: "load" });
await zomPage.waitForTimeout(500);

const ARENA = [
  "###############",
  "#.............#",
  "#.............#",
  "#..P.......E..#",
  "#.............#",
  "#.............#",
  "###############",
].join("\n");

// A wall down the middle: the two halves cannot see each other at all.
const SPLIT_ARENA = [
  "###############",
  "#......#......#",
  "#......#......#",
  "#..P...#...E..#",
  "#......#......#",
  "#......#......#",
  "###############",
].join("\n");

/** Load an arena and quiet the director, so only the authored zombie exists. */
const arena = async (art, name) => zomPage.evaluate(async ([art, name]) => {
  window.game.loadLevelText(art, name);
  await new Promise((r) => setTimeout(r, 250));
  const w = window.game.world;
  w.mode = "story";
  w.map.spawnZones.length = 0;
  const p = w.players[0];
  p.health = p.maxHealth; p.downed = false;
  p.stance = "stand"; p.stanceTimer = 0;
  p.ammo = p.weapon.magazine; p.reloadTimer = 0;
}, [art, name]);

// Zombies do not shoot. They close and they bite, and nothing they do ever puts an
// enemy bullet in the world — the whole reason the gunner AI came out.
await arena(ARENA, "zombie melee");
const melee = await zomPage.evaluate(async () => {
  const w = window.game.world;
  const T = 48;
  const p = w.players[0];
  const e = w.enemies[0];
  if (!e) return "no zombie in the arena";
  p.x = 4.5 * T; p.y = 3.5 * T; p.prevX = p.x; p.prevY = p.y;
  e.x = 8.5 * T; e.y = 3.5 * T; e.prevX = e.x; e.prevY = e.y;
  e.facing = Math.PI; e.state = "wander"; e.alertness = 0; e.attackCooldown = 0;

  const health = p.health;
  const states = [];
  let enemyBullet = false;
  const until = performance.now() + 3200;
  while (performance.now() < until) {
    if (states[states.length - 1] !== e.state) states.push(e.state);
    if (w.bullets.items.some((b) => b.active && b.team === "enemy")) enemyBullet = true;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { states, enemyBullet, hurt: health - p.health };
});
check("a zombie closes, winds up, leaps — and never fires a shot",
  typeof melee === "object" && !melee.enemyBullet &&
  melee.states.includes("windup") && melee.states.includes("lunge") &&
  melee.states.includes("recover") && melee.hurt > 0,
  JSON.stringify(melee));

// The leap is a commitment, and the recovery is the payoff for dodging it.
await arena(ARENA, "zombie recovery");
const vulnerable = await zomPage.evaluate(async () => {
  const w = window.game.world;
  const T = 48;
  const p = w.players[0];
  const e = w.enemies[0];
  if (!e) return "no zombie in the arena";
  p.x = 4.5 * T; p.y = 3.5 * T;

  const hitOnce = async (state) => {
    e.x = 8.5 * T; e.y = 3.5 * T; e.prevX = e.x; e.prevY = e.y;
    e.health = e.maxHealth = 400;
    e.state = state;
    e.stateTimer = 5;
    const before = e.health;
    w.bullets.spawn(e.x - 60, e.y, 0, 800, 10, "player", p.id, 1, "#fff");
    await new Promise((r) => setTimeout(r, 300));
    return Math.round(before - e.health);
  };
  const upright = await hitOnce("chase");
  const down = await hitOnce("recover");
  e.health = e.maxHealth = 40;
  return { upright, down };
});
check("a zombie caught recovering from a missed leap takes extra damage",
  typeof vulnerable === "object" && vulnerable.upright === 10 && vulnerable.down > 10,
  JSON.stringify(vulnerable));

// Hearing goes through walls — that is what stops shooting from cover being free.
await arena(SPLIT_ARENA, "zombie hearing");
const heard = await zomPage.evaluate(async () => {
  const w = window.game.world;
  const T = 48;
  const p = w.players[0];
  const e = w.enemies[0];
  if (!e) return "no zombie in the arena";
  p.x = 3.5 * T; p.y = 3.5 * T; p.prevX = p.x; p.prevY = p.y;
  e.x = 11.5 * T; e.y = 3.5 * T; e.prevX = e.x; e.prevY = e.y;
  // Facing away from the wall, so nothing about this is sight.
  e.facing = 0; e.state = "wander"; e.alertness = 0; e.stateTimer = 0;
  const walled = w.map.isSolidAt(7.5 * T, 3.5 * T);
  const startX = e.x;

  w.noise.emit(p.x, p.y, 700, "shot");
  await new Promise((r) => setTimeout(r, 700));
  return { walled, state: e.state, movedToward: Math.round(startX - e.x) };
});
check("a zombie walks toward a noise it heard through a wall",
  typeof heard === "object" && heard.walled === true &&
  heard.state === "investigate" && heard.movedToward > 5,
  JSON.stringify(heard));

// What is loud and what is not: firing yes, sprinting yes, walking no.
await arena(ARENA, "zombie noise sources");
const loudness = await zomPage.evaluate(async () => {
  const w = window.game.world;
  const p = w.players[0];
  w.enemies.length = 0;

  const listen = async (ms) => {
    const kinds = new Set();
    const until = performance.now() + ms;
    while (performance.now() < until) {
      for (const n of w.noise.items) if (n.active) kinds.add(n.kind);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return [...kinds];
  };

  const press = (code, down) =>
    window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code }));

  p.stamina = p.maxStamina; p.exhausted = false;
  press("KeyW", true);
  const walking = await listen(700);
  press("ShiftLeft", true);
  const sprinting = await listen(700);
  press("ShiftLeft", false);
  press("KeyW", false);

  p.weaponUp = 1; p.weaponHold = 1; p.ammo = p.weapon.magazine; p.fireCooldown = 0;
  press("Space", true);
  const shooting = await listen(400);
  press("Space", false);

  return { walking, sprinting, shooting };
});
check("walking is silent, sprinting and shooting are not",
  loudness.walking.length === 0 &&
  loudness.sprinting.includes("step") && loudness.shooting.includes("shot"),
  JSON.stringify(loudness));

// --- the director ------------------------------------------------------------
//
// Waves, not a drip: a group out of one door at a time, never the same door twice
// running, never one the squad is looking at, and nothing at all while the fight is
// already at its peak. A 21x17 arena with a zone tile at each compass point, so there
// are four distinct doors and at most one of them can be inside the player's cone.

const DIRECTOR_ARENA = [
  "#####################",
  "#.........Z.........#",
  "#...................#",
  "#...................#",
  "#...................#",
  "#...................#",
  "#...................#",
  "#...................#",
  "#Z........P........Z#",
  "#...................#",
  "#...................#",
  "#...................#",
  "#...................#",
  "#...................#",
  "#...................#",
  "#.........Z.........#",
  "#####################",
].join("\n");

/** Load the arena in story mode, so the director may only use the authored zones. */
const directorArena = async () => zomPage.evaluate(async (art) => {
  window.game.loadLevelText(art, "director arena");
  await new Promise((r) => setTimeout(r, 250));
  const w = window.game.world;
  w.mode = "story";
  w.enemies.length = 0;
  const p = w.players[0];
  p.health = p.maxHealth; p.downed = false;
  p.stance = "stand"; p.stanceTimer = 0;
  w.director.reset();
  return w.director.doorCount;
}, DIRECTOR_ARENA);

const doorCount = await directorArena();
check("touching zone tiles group into doors", doorCount === 4, `doors ${doorCount}`);

// A wave is a group arriving together out of one door, out of sight.
const wave = await zomPage.evaluate(async () => {
  const w = window.game.world;
  w.enemies.length = 0;
  w.director.grace = 0;
  w.director.phase = "buildup";
  w.director.waveTimer = 0;

  const seen = new Map();
  const t0 = performance.now();
  while (performance.now() - t0 < 2500 && w.director.waves === 0) {
    await new Promise((r) => requestAnimationFrame(r));
  }
  // The wave has landed: record where each of them appeared, and whether the squad
  // could have watched it happen.
  for (const e of w.enemies) seen.set(e.id, { x: e.x, y: e.y, visible: e.visible });
  const spawns = [...seen.values()];
  const spread = Math.max(...spawns.map((a) =>
    Math.max(...spawns.map((b) => Math.hypot(a.x - b.x, a.y - b.y)))));
  const onZone = spawns.every((sp) =>
    w.map.spawnZones.some((z) => Math.hypot(z.x - sp.x, z.y - sp.y) < 1));
  return {
    waves: w.director.waves,
    size: spawns.length,
    spread: Math.round(spread),
    onZone,
    anyVisible: spawns.some((sp) => sp.visible),
  };
});
check("a wave is a group from one door, on its zone tiles, out of sight",
  wave.waves === 1 && wave.size >= 4 && wave.spread < 48 &&
  wave.onZone && !wave.anyVisible,
  JSON.stringify(wave));

// Pressure has to arrive from somewhere new, or a map with four doors plays like a
// map with one.
await directorArena();
const rotation = await zomPage.evaluate(async () => {
  const w = window.game.world;
  const used = [];
  for (let i = 0; i < 4; i++) {
    w.enemies.length = 0;                 // stay under the cap so every wave lands
    w.director.grace = 0;
    w.director.phase = "buildup";
    w.director.waveTimer = 0;
    const before = w.director.waves;
    const until = performance.now() + 2500;
    while (performance.now() < until && w.director.waves === before) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    used.push(w.director.lastDoor);
  }
  let repeats = 0;
  for (let i = 1; i < used.length; i++) if (used[i] === used[i - 1]) repeats++;
  return { used, repeats };
});
check("consecutive waves never come from the same door",
  rotation.used.length === 4 && rotation.used.every((d) => d >= 0) && rotation.repeats === 0,
  JSON.stringify(rotation));

// At the peak, the director stops adding. The fight you are in is the fight.
await directorArena();
const peaked = await zomPage.evaluate(async () => {
  const w = window.game.world;
  const p = w.players[0];
  w.director.grace = 0;
  w.director.phase = "buildup";
  w.director.waveTimer = 0;
  const until = performance.now() + 2500;
  while (performance.now() < until && w.director.waves === 0) {
    await new Promise((r) => requestAnimationFrame(r));
  }

  // A big hit is a peak: stress is driven by damage taken, so take some.
  p.health = p.maxHealth - 60;
  await new Promise((r) => setTimeout(r, 200));
  const phaseAtPeak = w.director.phase;
  const wavesAtPeak = w.director.waves;
  await new Promise((r) => setTimeout(r, 3000));
  p.health = p.maxHealth;
  return {
    intensity: Math.round(w.director.intensity * 100) / 100,
    phaseAtPeak,
    phaseAfter: w.director.phase,
    added: w.director.waves - wavesAtPeak,
  };
});
check("no new waves while the squad is at its peak",
  peaked.phaseAtPeak === "peak" && peaked.added === 0 &&
  (peaked.phaseAfter === "peak" || peaked.phaseAfter === "fade" || peaked.phaseAfter === "relax"),
  JSON.stringify(peaked));

// --- arrival, cars and alarms -------------------------------------------------

// Walking out of the stairwell into a bite is not difficulty. Nothing authored sits
// inside the bubble around a spawn tile, and the director adds nothing for a moment.
await zomPage.evaluate(async () => {
  window.game.loadLevelText([
    "###############",
    "#.............#",
    "#..P.......E..#",     // 8 tiles apart: outside the bubble, must survive
    "#.............#",
    "#....E........#",     // 2 tiles from the spawn: inside it, must be dropped
    "###############",
  ].join("\n"), "arrival safety");
  await new Promise((r) => setTimeout(r, 300));
});
const arrival = await zomPage.evaluate(() => {
  const w = window.game.world;
  const T = 48;
  const spawn = w.map.playerSpawns[0];
  return {
    authored: w.map.enemySpawns.length,
    placed: w.enemies.length,
    nearest: Math.round(Math.min(...w.enemies.map((e) => Math.hypot(e.x - spawn.x, e.y - spawn.y)))),
    grace: w.director.grace > 0,
    tile: T,
  };
});
check("nothing is placed on top of where the squad arrives",
  arrival.authored === 2 && arrival.placed === 1 && arrival.nearest > 300 && arrival.grace,
  JSON.stringify(arrival));

// A car is one body, however many tiles the author drew it with.
const cars = await zomPage.evaluate(async () => {
  window.game.loadLevelText([
    "###############",
    "#..P..........#",
    "#....CC...AA..#",
    "#....CC...AA..#",
    "#.............#",
    "###############",
  ].join("\n"), "car bodies");
  await new Promise((r) => setTimeout(r, 250));
  const m = window.game.world.map;
  return m.cars.map((c) => ({ tiles: c.tiles.length, w: c.w, h: c.h, alarmed: c.alarmed }));
});
check("touching car tiles are one vehicle, not four",
  cars.length === 2 && cars.every((c) => c.tiles === 4 && c.w === 96 && c.h === 96) &&
  cars.filter((c) => c.alarmed).length === 1,
  JSON.stringify(cars));

// The alarm: one bullet, every door at once, twenty seconds of noise — and never again
// from that car, because the tiles themselves are spent.
const alarmed = await zomPage.evaluate(async () => {
  window.game.loadLevelText([
    "#####################",
    "#.........Z.........#",
    "#...................#",
    "#...................#",
    "#...................#",
    "#........AA.........#",
    "#Z.......AA........Z#",
    "#...................#",
    "#.........P.........#",
    "#...................#",
    "#...................#",
    "#...................#",
    "#.........Z.........#",
    "#####################",
  ].join("\n"), "car alarm");
  await new Promise((r) => setTimeout(r, 300));
  const w = window.game.world;
  const T = 48;
  w.mode = "story";
  w.enemies.length = 0;
  w.director.grace = 0;
  const p = w.players[0];
  p.health = p.maxHealth; p.downed = false;

  const before = { doors: w.director.doorCount, waves: w.director.waves, alarmTiles: 4 };
  // Straight up into the car from below.
  w.bullets.spawn(9.5 * T, 8.5 * T, -Math.PI / 2, 800, 10, "player", p.id, 1, "#fff");
  await new Promise((r) => setTimeout(r, 500));

  const after = {
    ringing: w.alarm.active,
    phase: w.director.phase,
    spawned: w.enemies.length,
    waves: w.director.waves,
    stillAlarmed: w.map.cars.some((c) => c.alarmed),
    carIntact: w.map.cars.length === 1 && w.map.cars[0].tiles.length === 4,
    loud: w.noise.items.some((n) => n.active && n.kind === "alarm"),
  };
  // Shoot the same car again: it is spent, so nothing may happen a second time.
  w.enemies.length = 0;
  const wavesBefore = w.director.waves;
  w.bullets.spawn(9.5 * T, 8.5 * T, -Math.PI / 2, 800, 10, "player", p.id, 1, "#fff");
  await new Promise((r) => setTimeout(r, 300));
  after.secondSpawned = w.enemies.length;
  after.secondWaves = w.director.waves - wavesBefore;
  return { before, after };
});
check("a bullet in an alarmed car opens every door, once",
  alarmed.before.doors === 4 && alarmed.after.ringing && alarmed.after.phase === "panic" &&
  alarmed.after.spawned >= 12 && alarmed.after.loud &&
  !alarmed.after.stillAlarmed && alarmed.after.carIntact,
  JSON.stringify(alarmed));
check("a spent alarm cannot go off again",
  alarmed.after.secondSpawned === 0 && alarmed.after.secondWaves === 0,
  JSON.stringify({ spawned: alarmed.after.secondSpawned, waves: alarmed.after.secondWaves }));

// --- pathfinding ---------------------------------------------------------------
//
// A zombie that arrives with a wave knows roughly where the squad is and walks the
// route, rather than shambling until the fight happens to find it. The wall here has
// exactly one gap, in the corner furthest from both of them, so "walked round it" is
// the only way across.

const MAZE = [
  "###############",
  "#......#......#",
  "#..P...#......#",
  "#......#......#",
  "#......#......#",
  "#......#......#",
  "#......#....E.#",
  "#.............#",     // the only way through
  "###############",
].join("\n");

const hunted = await zomPage.evaluate(async (art) => {
  window.game.loadLevelText(art, "flow field");
  await new Promise((r) => setTimeout(r, 300));
  const w = window.game.world;
  const T = 48;
  w.mode = "story";
  w.map.spawnZones.length = 0;
  w.director.grace = 999;                  // this check is about the AI, not the director
  const p = w.players[0];
  p.health = p.maxHealth; p.downed = false; p.stance = "stand"; p.stanceTimer = 0;
  p.x = 3.5 * T; p.y = 2.5 * T; p.prevX = p.x; p.prevY = p.y;

  const e = w.enemies[0];
  if (!e) return "no zombie in the maze";
  e.x = 12.5 * T; e.y = 6.5 * T; e.prevX = e.x; e.prevY = e.y;
  e.hunting = true;
  e.state = "hunt";
  e.alertness = 0;
  e.stateTimer = 0;
  const startDist = Math.hypot(p.x - e.x, p.y - e.y);
  const sawAtStart = w.squadCanSee(e.x, e.y);

  let crossed = false;
  let closest = startDist;
  // Deliberately runs the whole window rather than stopping at the crossing: getting
  // through the gap is half the claim, closing on him afterwards is the other half.
  const until = performance.now() + 9000;
  while (performance.now() < until) {
    if (e.x < 7 * T) crossed = true;       // through the gap, onto the player's side
    closest = Math.min(closest, Math.hypot(p.x - e.x, p.y - e.y));
    p.health = p.maxHealth;                // it will reach him; that is the point
    await new Promise((r) => requestAnimationFrame(r));
  }
  return {
    sawAtStart,
    crossed,
    startDist: Math.round(startDist),
    closest: Math.round(closest),
    state: e.state,
  };
}, MAZE);
check("a hunting zombie walks round a wall to reach the squad",
  typeof hunted === "object" && !hunted.sawAtStart && hunted.crossed &&
  hunted.closest < hunted.startDist / 2,
  JSON.stringify(hunted));

// And a wave arrives hunting, so the horde converges instead of milling about.
await directorArena();
const converge = await zomPage.evaluate(async () => {
  const w = window.game.world;
  w.enemies.length = 0;
  w.director.grace = 0;
  w.director.phase = "buildup";
  w.director.waveTimer = 0;
  const until = performance.now() + 2500;
  while (performance.now() < until && w.director.waves === 0) {
    await new Promise((r) => requestAnimationFrame(r));
  }
  const p = w.players[0];
  const spread = () => w.enemies.reduce((n, e) => n + Math.hypot(p.x - e.x, p.y - e.y), 0) /
    Math.max(1, w.enemies.length);
  const before = spread();
  const hunting = w.enemies.filter((e) => e.hunting).length;
  await new Promise((r) => setTimeout(r, 2000));
  return {
    hunting,
    count: w.enemies.length,
    before: Math.round(before),
    after: Math.round(spread()),
  };
});
check("a wave arrives hunting and closes on the squad",
  converge.count >= 4 && converge.hunting === converge.count &&
  converge.after < converge.before - 60,
  JSON.stringify(converge));

// --- audio ---------------------------------------------------------------------
//
// The bus counts every sound it is ASKED for, whether or not a device exists, so these
// checks work in a headless runner with no output at all. What they are really testing
// is the wiring: that the noise the zombies hear is the noise the player hears.

const audible = await zomPage.evaluate(async () => {
  const g = window.game, w = g.world;
  window.game.loadLevelText([
    "###############",
    "#.............#",
    "#..P......G...#",
    "#.............#",
    "###############",
  ].join("\n"), "audio wiring");
  await new Promise((r) => setTimeout(r, 300));
  w.mode = "story";
  w.map.spawnZones.length = 0;
  w.enemies.length = 0;
  w.director.grace = 999;
  const T = 48;
  const p = w.players[0];
  p.health = p.maxHealth; p.downed = false; p.stance = "stand"; p.stanceTimer = 0;
  p.x = 3.5 * T; p.y = 2.5 * T; p.prevX = p.x; p.prevY = p.y;
  p.facing = 0; p.weaponUp = 1; p.weaponHold = 1;
  p.ammo = p.weapon.magazine; p.reloadTimer = 0; p.fireCooldown = 0;

  const before = { ...g.audio.bus.played };
  // A real shot through the real fire path. Where it goes is up to the cursor, which
  // has its own checks — so the pane gets its own bullet, down the real bullet path.
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
  await new Promise((r) => setTimeout(r, 400));
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
  w.bullets.spawn(6 * T, 2.5 * T, 0, 800, 10, "player", p.id, 1, "#fff");
  await new Promise((r) => setTimeout(r, 300));
  const after = g.audio.bus.played;
  const since = (k) => (after[k] ?? 0) - (before[k] ?? 0);
  return { shot: since("shot"), glass: since("glass"), pane: w.map.tileAt(10, 2) };
});
check("firing is heard, and so is the pane it breaks",
  audible.shot > 0 && audible.glass > 0 && audible.pane === 17,
  JSON.stringify(audible));

// Distance and side, against the nearest player.
const placed = await zomPage.evaluate(() => {
  const w = window.game.world;
  const p = w.players[0];
  const ears = [{ x: p.x, y: p.y, facing: 0 }];
  const bus = window.game.audio.bus;
  const near = bus.place(p.x + 40, p.y, ears, false);
  const right = bus.place(p.x + 300, p.y, ears, false);
  const left = bus.place(p.x - 300, p.y, ears, false);
  const away = bus.place(p.x + 5000, p.y, ears, false);
  return {
    near: +near.gain.toFixed(2),
    far: +right.gain.toFixed(2),
    rightPan: +right.pan.toFixed(2),
    leftPan: +left.pan.toFixed(2),
    away: away.gain,
  };
});
check("sounds fall off with distance and sit on the right side",
  placed.near > placed.far && placed.far > 0 && placed.away === 0 &&
  placed.rightPan > 0.4 && placed.leftPan < -0.4,
  JSON.stringify(placed));

// The windup is a tell you can hear, which matters when it is behind you.
const screech = await zomPage.evaluate(async () => {
  const w = window.game.world;
  const g = window.game;
  const T = 48;
  w.enemies.length = 0;
  const before = g.audio.bus.played.screech ?? 0;
  // Borrow a zombie by loading a map that has one, rather than reaching into the sim.
  window.game.loadLevelText([
    "###############",
    "#.............#",
    "#..P.......E..#",
    "#.............#",
    "###############",
  ].join("\n"), "audio screech");
  await new Promise((r) => setTimeout(r, 300));
  w.director.grace = 999;
  const p = w.players[0];
  const e = w.enemies[0];
  if (!e) return "no zombie";
  p.x = 4.5 * T; p.y = 2.5 * T; p.prevX = p.x; p.prevY = p.y;
  e.x = 7 * T; e.y = 2.5 * T; e.prevX = e.x; e.prevY = e.y;
  e.facing = Math.PI; e.state = "wander"; e.alertness = 0; e.attackCooldown = 0;
  const until = performance.now() + 3000;
  while (performance.now() < until && (g.audio.bus.played.screech ?? 0) === before) {
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { before, after: g.audio.bus.played.screech ?? 0, state: e.state };
});
check("a zombie winding up screeches",
  typeof screech === "object" && screech.after > screech.before,
  JSON.stringify(screech));

// Mute is a preference, so it has to survive the page.
const muting = await zomPage.evaluate(() => {
  const a = window.game.audio;
  const first = a.toggleMute();
  const stored = localStorage.getItem("topdown.audio.muted");
  const second = a.toggleMute();
  return { first, stored, second, muted: a.bus.isMuted };
});
check("mute toggles and is remembered",
  muting.first === true && muting.stored === "1" &&
  muting.second === false && muting.muted === false,
  JSON.stringify(muting));

check("zombie pages raised no exceptions", zomErrors.length === 0, zomErrors.join(" | "));

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
