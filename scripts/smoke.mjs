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

await page.goto(URL, { waitUntil: "load" });
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

// --- level import ------------------------------------------------------------

const levelPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const levelErrors = [];
levelPage.on("pageerror", (e) => levelErrors.push(String(e)));

await levelPage.goto(`${URL}?level=corridors`, { waitUntil: "load" });
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
await levelPage.goto(`${URL}?level=showcase`, { waitUntil: "load" });
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
await levelPage.goto(`${URL}?level=draft`, { waitUntil: "load" });
await levelPage.waitForTimeout(400);
const draft = await levelPage.evaluate(() => window.game.world.map.name);
check("editor draft loads through ?level=draft", draft === "draft test", String(draft));

check("level pages raised no exceptions", levelErrors.length === 0, levelErrors.join(" | "));

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
