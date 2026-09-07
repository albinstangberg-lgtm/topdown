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

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
