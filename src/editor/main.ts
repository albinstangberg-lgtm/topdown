import { TILE_DEFS, tileDef, TILE_FLOOR, TILE_WALL } from "../world/tiles";
import {
  levelToArrayLiteral, parseLevelText, serializeLevel, type LevelData,
} from "../world/level";
import { BUILTIN_LEVELS, DRAFT_KEY } from "../levels";

/**
 * CORE 15 — The map editor.
 *
 * A separate page that reads and writes the same level format the game imports, using
 * the same tile registry for its palette. It holds no game code: it edits a grid of
 * ids and hands it over. That separation is why the editor cannot drift out of sync
 * with the game — there is only one definition of what a `5` means.
 */

type Tool = "paint" | "rect" | "fill" | "pick";

const MIN = 3;
const MAX = 256;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>("grid");
const ctx = canvas.getContext("2d")!;
const statusEl = $<HTMLDivElement>("status");
const hoverEl = $<HTMLDivElement>("hover");
const nameInput = $<HTMLInputElement>("name");
const colsInput = $<HTMLInputElement>("cols");
const rowsInput = $<HTMLInputElement>("rows");

const state = {
  name: "untitled",
  cols: 25,
  rows: 17,
  tiles: new Uint8Array(25 * 17),
  brush: TILE_WALL,
  tool: "paint" as Tool,
};

const view = { x: 0, y: 0, scale: 24 };
// Typed off the live buffer so undo snapshots always match the grid's exact type.
const undoStack: (typeof state.tiles)[] = [];
const redoStack: (typeof state.tiles)[] = [];
let dirtySincePress = false;
let dragStart: { tx: number; ty: number } | null = null;
let hoverTile: { tx: number; ty: number } | null = null;
let painting: 0 | 1 | 2 = 0; // 0 none, 1 brush, 2 erase

// --- model -------------------------------------------------------------------

function idx(tx: number, ty: number): number { return ty * state.cols + tx; }
function inBounds(tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < state.cols && ty < state.rows;
}
function get(tx: number, ty: number): number {
  return inBounds(tx, ty) ? state.tiles[idx(tx, ty)] : TILE_FLOOR;
}
function set(tx: number, ty: number, id: number): void {
  if (!inBounds(tx, ty)) return;
  if (state.tiles[idx(tx, ty)] === id) return;
  state.tiles[idx(tx, ty)] = id;
  dirtySincePress = true;
}

function snapshot(): void {
  undoStack.push(new Uint8Array(state.tiles));
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
}

function undo(): void {
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(new Uint8Array(state.tiles));
  state.tiles = prev;
  // A snapshot may come from a different grid size; trust its length.
  reconcileSize();
  draw();
}

function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(new Uint8Array(state.tiles));
  state.tiles = next;
  reconcileSize();
  draw();
}

/** Undo across a resize: infer the missing dimension from the buffer length. */
function reconcileSize(): void {
  if (state.tiles.length === state.cols * state.rows) return;
  state.rows = Math.max(MIN, Math.round(state.tiles.length / state.cols));
  syncSizeInputs();
}

function resize(cols: number, rows: number): void {
  cols = Math.max(MIN, Math.min(MAX, cols | 0));
  rows = Math.max(MIN, Math.min(MAX, rows | 0));
  const next = new Uint8Array(cols * rows);
  for (let ty = 0; ty < Math.min(rows, state.rows); ty++) {
    for (let tx = 0; tx < Math.min(cols, state.cols); tx++) {
      next[ty * cols + tx] = state.tiles[idx(tx, ty)];
    }
  }
  snapshot();
  state.cols = cols;
  state.rows = rows;
  state.tiles = next;
  syncSizeInputs();
  fitView();
  draw();
}

function blankRoom(): void {
  snapshot();
  for (let ty = 0; ty < state.rows; ty++) {
    for (let tx = 0; tx < state.cols; tx++) {
      const edge = tx === 0 || ty === 0 || tx === state.cols - 1 || ty === state.rows - 1;
      state.tiles[idx(tx, ty)] = edge ? TILE_WALL : TILE_FLOOR;
    }
  }
  draw();
}

function addBorder(): void {
  snapshot();
  for (let tx = 0; tx < state.cols; tx++) { set(tx, 0, TILE_WALL); set(tx, state.rows - 1, TILE_WALL); }
  for (let ty = 0; ty < state.rows; ty++) { set(0, ty, TILE_WALL); set(state.cols - 1, ty, TILE_WALL); }
  draw();
}

function floodFill(tx: number, ty: number, id: number): void {
  const target = get(tx, ty);
  if (target === id) return;
  const queue = [tx, ty];
  while (queue.length > 0) {
    const y = queue.pop()!;
    const x = queue.pop()!;
    if (!inBounds(x, y) || get(x, y) !== target) continue;
    set(x, y, id);
    queue.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
}

function paintRect(a: { tx: number; ty: number }, b: { tx: number; ty: number }, id: number): void {
  const x0 = Math.min(a.tx, b.tx);
  const x1 = Math.max(a.tx, b.tx);
  const y0 = Math.min(a.ty, b.ty);
  const y1 = Math.max(a.ty, b.ty);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, id);
}

// --- view --------------------------------------------------------------------

function resizeCanvas(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function fitView(): void {
  const pad = 40;
  const sx = (canvas.clientWidth - pad) / state.cols;
  const sy = (canvas.clientHeight - pad) / state.rows;
  view.scale = Math.max(6, Math.min(48, Math.min(sx, sy)));
  view.x = (canvas.clientWidth - state.cols * view.scale) / 2;
  view.y = (canvas.clientHeight - state.rows * view.scale) / 2;
}

function screenToTile(sx: number, sy: number): { tx: number; ty: number } {
  return {
    tx: Math.floor((sx - view.x) / view.scale),
    ty: Math.floor((sy - view.y) / view.scale),
  };
}

function draw(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.fillStyle = "#080910";
  ctx.fillRect(0, 0, w, h);

  const s = view.scale;
  ctx.save();
  ctx.translate(view.x, view.y);

  for (let ty = 0; ty < state.rows; ty++) {
    for (let tx = 0; tx < state.cols; tx++) {
      const def = tileDef(get(tx, ty));
      ctx.fillStyle = def.color;
      ctx.fillRect(tx * s, ty * s, s, s);
      if (def.spawn || def.light) {
        ctx.fillStyle = "#0009";
        ctx.font = `700 ${Math.max(8, s * 0.5)}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(def.glyph, tx * s + s / 2, ty * s + s / 2 + 1);
      }
    }
  }

  if (s >= 10) {
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let tx = 0; tx <= state.cols; tx++) { ctx.moveTo(tx * s, 0); ctx.lineTo(tx * s, state.rows * s); }
    for (let ty = 0; ty <= state.rows; ty++) { ctx.moveTo(0, ty * s); ctx.lineTo(state.cols * s, ty * s); }
    ctx.stroke();
  }

  ctx.strokeStyle = "#5ad2ff";
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, state.cols * s, state.rows * s);

  if (hoverTile && inBounds(hoverTile.tx, hoverTile.ty)) {
    if (state.tool === "rect" && dragStart) {
      const x0 = Math.min(dragStart.tx, hoverTile.tx);
      const y0 = Math.min(dragStart.ty, hoverTile.ty);
      const x1 = Math.max(dragStart.tx, hoverTile.tx);
      const y1 = Math.max(dragStart.ty, hoverTile.ty);
      ctx.fillStyle = "rgba(90,210,255,0.25)";
      ctx.fillRect(x0 * s, y0 * s, (x1 - x0 + 1) * s, (y1 - y0 + 1) * s);
    }
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.strokeRect(hoverTile.tx * s + 1, hoverTile.ty * s + 1, s - 2, s - 2);
  }
  ctx.restore();
}

// --- level in / out ----------------------------------------------------------

function currentLevel(): LevelData {
  const grid: number[][] = [];
  for (let ty = 0; ty < state.rows; ty++) {
    const row: number[] = [];
    for (let tx = 0; tx < state.cols; tx++) row.push(get(tx, ty));
    grid.push(row);
  }
  return { name: state.name, grid };
}

function applyLevel(level: LevelData, warnings: string[] = []): void {
  snapshot();
  state.rows = level.grid.length;
  state.cols = level.grid[0].length;
  state.tiles = new Uint8Array(level.grid.flat());
  state.name = level.name;
  nameInput.value = level.name;
  syncSizeInputs();
  fitView();
  draw();
  report(warnings.length > 0 ? warnings.join("\n") : `Loaded "${level.name}" — ${state.cols}×${state.rows}`,
    warnings.length > 0 ? "warn" : "ok");
}

function loadText(text: string, name: string): void {
  try {
    const { level, warnings } = parseLevelText(text, name);
    applyLevel(level, warnings);
  } catch (err) {
    report(err instanceof Error ? err.message : String(err), "error");
  }
}

function report(message: string, kind: "ok" | "warn" | "error" = "ok"): void {
  statusEl.textContent = message;
  statusEl.className = kind === "error" ? "error" : kind === "ok" ? "ok" : "";
}

/** Live feedback on the things that will bite you when the map is played. */
function levelNotes(): string {
  const counts = new Map<number, number>();
  for (const id of state.tiles) counts.set(id, (counts.get(id) ?? 0) + 1);
  const notes: string[] = [];
  if (!counts.get(2)) notes.push("no player spawn (id 2) — players start in the most open space");
  if (!counts.get(3)) notes.push("no enemy spawn (id 3) — enemies use any floor tile");
  const walkable = TILE_DEFS.filter((d) => !d.solid).reduce((n, d) => n + (counts.get(d.id) ?? 0), 0);
  if (walkable === 0) notes.push("no walkable tiles at all");
  return notes.join("\n");
}

function syncSizeInputs(): void {
  colsInput.value = String(state.cols);
  rowsInput.value = String(state.rows);
}

// --- UI ----------------------------------------------------------------------

function buildPalette(): void {
  const host = $<HTMLDivElement>("palette");
  host.innerHTML = "";
  TILE_DEFS.forEach((def, i) => {
    const btn = document.createElement("button");
    btn.className = `tile${def.id === state.brush ? " active" : ""}`;
    btn.dataset.id = String(def.id);
    btn.title = def.hint;
    btn.innerHTML =
      `<span class="id">${def.id}</span>` +
      `<span class="swatch" style="background:${def.color}"></span>` +
      `<span class="name">${def.name}</span>` +
      `<span class="hint">${i < 10 ? i : ""}</span>`;
    btn.addEventListener("click", () => selectBrush(def.id));
    host.appendChild(btn);
  });
}

function selectBrush(id: number): void {
  state.brush = id;
  for (const el of document.querySelectorAll<HTMLElement>(".tile")) {
    el.classList.toggle("active", Number(el.dataset.id) === id);
  }
  report(`${tileDef(id).name} — ${tileDef(id).hint}`);
}

function selectTool(tool: Tool): void {
  state.tool = tool;
  for (const el of document.querySelectorAll<HTMLElement>("#tools button")) {
    el.classList.toggle("active", el.dataset.tool === tool);
  }
}

function buildBuiltins(): void {
  const host = $<HTMLDivElement>("builtins");
  for (const level of BUILTIN_LEVELS) {
    const btn = document.createElement("button");
    btn.textContent = level.name;
    btn.addEventListener("click", () => loadText(level.source, level.name));
    host.appendChild(btn);
  }
}

function download(): void {
  const level = currentLevel();
  const blob = new Blob([serializeLevel(level)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${level.name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "level"}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  report(`Saved ${a.download}`, "ok");
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    report(`${what} copied to clipboard`, "ok");
  } catch {
    report(`Clipboard blocked — here it is in the console instead`, "warn");
    console.log(text);
  }
}

function play(): void {
  localStorage.setItem(DRAFT_KEY, serializeLevel(currentLevel()));
  window.open("./index.html?level=draft", "_blank");
  report("Handed to the game as ?level=draft", "ok");
}

// --- input -------------------------------------------------------------------

function applyAt(tx: number, ty: number, erase: boolean): void {
  const id = erase ? TILE_FLOOR : state.brush;
  if (state.tool === "pick") { selectBrush(get(tx, ty)); return; }
  if (state.tool === "fill") { floodFill(tx, ty, id); return; }
  set(tx, ty, id);
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const t = screenToTile(e.offsetX, e.offsetY);
  if (e.button === 1) return; // middle button pans, handled in pointermove
  if (!inBounds(t.tx, t.ty)) return;

  snapshot();
  dirtySincePress = false;
  painting = e.button === 2 ? 2 : 1;

  if (state.tool === "rect") { dragStart = t; draw(); return; }
  applyAt(t.tx, t.ty, painting === 2);
  draw();
});

canvas.addEventListener("pointermove", (e) => {
  const t = screenToTile(e.offsetX, e.offsetY);
  hoverTile = t;
  const def = tileDef(get(t.tx, t.ty));
  hoverEl.textContent = inBounds(t.tx, t.ty)
    ? `${t.tx}, ${t.ty}  ·  ${def.id} ${def.name}`
    : `${t.tx}, ${t.ty}  ·  outside`;

  if ((e.buttons & 4) !== 0) { // middle drag pans
    view.x += e.movementX;
    view.y += e.movementY;
    draw();
    return;
  }
  if (painting !== 0 && state.tool !== "rect" && state.tool !== "pick") {
    applyAt(t.tx, t.ty, painting === 2);
  }
  draw();
});

window.addEventListener("pointerup", (e) => {
  if (painting !== 0 && state.tool === "rect" && dragStart && hoverTile) {
    paintRect(dragStart, hoverTile, painting === 2 ? TILE_FLOOR : state.brush);
  }
  if (painting !== 0 && !dirtySincePress) undoStack.pop(); // nothing changed, drop the snapshot
  painting = 0;
  dragStart = null;
  if (e.isTrusted) {
    const notes = levelNotes();
    if (notes) report(notes, "warn");
  }
  draw();
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const before = screenToTile(e.offsetX, e.offsetY);
  view.scale = Math.max(4, Math.min(64, view.scale * (e.deltaY < 0 ? 1.12 : 0.89)));
  const after = screenToTile(e.offsetX, e.offsetY);
  view.x += (after.tx - before.tx) * view.scale;
  view.y += (after.ty - before.ty) * view.scale;
  draw();
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (document.activeElement instanceof HTMLInputElement) return;
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (e.code.startsWith("Digit")) {
    const n = Number(e.code.slice(5));
    if (TILE_DEFS[n]) selectBrush(TILE_DEFS[n].id);
  }
  if (e.code === "KeyB") selectTool("paint");
  if (e.code === "KeyR") selectTool("rect");
  if (e.code === "KeyF") selectTool("fill");
  if (e.code === "KeyI") selectTool("pick");
});

window.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text");
  if (text) loadText(text, "pasted");
});

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  file.text().then((text) => loadText(text, file.name.replace(/\.[^.]+$/, "")));
});

$("file").addEventListener("change", (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  file.text().then((text) => loadText(text, file.name.replace(/\.[^.]+$/, "")));
});

$("paste").addEventListener("click", async () => {
  try {
    loadText(await navigator.clipboard.readText(), "pasted");
  } catch {
    report("Clipboard read blocked — use Ctrl+V on the page instead", "warn");
  }
});

$("resize").addEventListener("click", () => resize(Number(colsInput.value), Number(rowsInput.value)));
$("blank").addEventListener("click", blankRoom);
$("border").addEventListener("click", addBorder);
$("download").addEventListener("click", download);
$("copyJson").addEventListener("click", () => copy(serializeLevel(currentLevel()), "Level JSON"));
$("copyArray").addEventListener("click", () => copy(levelToArrayLiteral(currentLevel()), "Grid rows"));
$("play").addEventListener("click", play);
nameInput.addEventListener("input", () => { state.name = nameInput.value.trim() || "untitled"; });

for (const el of document.querySelectorAll<HTMLElement>("#tools button")) {
  el.addEventListener("click", () => selectTool(el.dataset.tool as Tool));
}

window.addEventListener("resize", resizeCanvas);

// --- boot --------------------------------------------------------------------

buildPalette();
buildBuiltins();
selectBrush(TILE_WALL);
resizeCanvas();
blankRoom();
undoStack.length = 0;
fitView();
draw();
report("Paint with the mouse. Drop or paste a map to load one.", "ok");
