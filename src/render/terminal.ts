import { hackProgress, type HackSession } from "../sim/hacking";
import type { Viewport } from "./viewport";

/**
 * CORE 12b — The console, drawn over one player's viewport and nobody else's.
 *
 * This is the whole trick of the mechanic, and it is why the game draws per viewport
 * rather than per screen: in split screen, ONE quarter of the glass becomes a terminal
 * and the other three keep showing the room. The player in it genuinely cannot see what
 * is happening to them, and their squad genuinely can — which is a thing you cannot do
 * with a single camera, and the reason CORE 10 says nothing may assume one screen.
 *
 * The screen is deliberately loud and slightly awful: phosphor green, a scanline wash,
 * a cursor, and a log that scrolls. Not because it is pretty, but because the contrast
 * with the dark room the other players are looking at is the point — a glance at your
 * neighbour's quarter should be enough to know they are blind.
 */

const GREEN = "#7cff9b";
const DIM = "#2f7a45";
const WARN = "#ffd257";
const BAD = "#ff6b5c";

export function drawTerminal(
  ctx: CanvasRenderingContext2D, hack: HackSession, vp: Viewport, dpr: number,
): void {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.beginPath();
  ctx.rect(vp.x, vp.y, vp.w, vp.h);
  ctx.clip();
  ctx.translate(vp.x, vp.y);

  // The glass.
  ctx.fillStyle = "#04120a";
  ctx.fillRect(0, 0, vp.w, vp.h);
  const glow = ctx.createRadialGradient(
    vp.w / 2, vp.h / 2, 0, vp.w / 2, vp.h / 2, Math.max(vp.w, vp.h) * 0.7,
  );
  glow.addColorStop(0, "rgba(40,120,70,0.35)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, vp.w, vp.h);

  const pad = Math.max(16, Math.min(34, vp.w * 0.06));
  const mono = (size: number, weight = 600): string =>
    `${weight} ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const scale = Math.min(1, vp.w / 620);
  const big = Math.round(20 * scale + 8);
  const small = Math.round(11 * scale + 3);

  ctx.textBaseline = "top";

  // Header.
  ctx.fillStyle = GREEN;
  ctx.font = mono(big, 700);
  ctx.fillText(hack.kind === "door" ? "LOCK CONTROL" : "FIRE CONTROL", pad, pad);
  ctx.font = mono(small);
  ctx.fillStyle = DIM;
  ctx.fillText(
    hack.kind === "door" ? "deck mag-lock array" : "turret grid — all emplacements",
    pad, pad + big + 4,
  );

  // The feed, most recent last, with a blinking cursor on the end.
  const lines = hack.feed.slice(-5);
  let fy = pad + big + small + 18;
  ctx.font = mono(small, 500);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    ctx.fillStyle = line.startsWith("!!") ? BAD : i === lines.length - 1 ? GREEN : DIM;
    ctx.fillText(line, pad, fy);
    fy += small + 6;
  }
  if (Math.floor(hack.noise * 2.5) % 2 === 0) {
    ctx.fillStyle = GREEN;
    ctx.fillRect(pad, fy + 2, small * 0.55, small * 0.9);
  }

  // The interlocks. One row each: a rail, the band you have to stop in, and the sweep.
  // Laid out UP from the footer rather than down from the feed: the feed grows as the
  // hack goes on, and a row that slides under the prompt is a row you cannot read.
  const rowH = Math.max(24, Math.min(46, vp.h * 0.1));
  const railW = vp.w - pad * 2;
  const footerTop = vp.h - pad - small * 2 - 10;
  const top = Math.max(fy + small, footerTop - rowH * hack.tumblers.length - 6);
  for (let i = 0; i < hack.tumblers.length; i++) {
    const t = hack.tumblers[i];
    const y = top + i * rowH;
    const live = i === hack.index;

    ctx.fillStyle = "rgba(120,255,155,0.08)";
    ctx.fillRect(pad, y, railW, rowH - 8);

    // The band. Green while you are on it, amber while the console is sulking after a
    // miss — the one moment pressing the button does nothing, so it has to be visible.
    const bandX = pad + (t.band - t.width) * railW;
    const bandW = t.width * 2 * railW;
    ctx.fillStyle = t.locked ? "rgba(120,255,155,0.30)"
      : live ? (hack.resync > 0 ? "rgba(255,210,87,0.30)" : "rgba(120,255,155,0.22)")
        : "rgba(120,255,155,0.10)";
    ctx.fillRect(bandX, y, bandW, rowH - 8);

    if (t.locked) {
      ctx.fillStyle = GREEN;
      ctx.font = mono(small, 700);
      ctx.fillText("LOCKED", pad + 10, y + (rowH - 8) / 2 - small * 0.6);
    } else if (live) {
      // The sweep itself.
      const cx = pad + t.cursor * railW;
      ctx.fillStyle = hack.resync > 0 ? WARN : "#ffffff";
      ctx.fillRect(cx - 2, y - 3, 4, rowH - 2);
    }
  }

  // Footer: what to press, and what it has cost so far.
  ctx.font = mono(small, 700);
  ctx.fillStyle = hack.resync > 0 ? WARN : GREEN;
  const prompt = hack.resync > 0 ? "RESYNC…" : "FIRE — STOP THE SWEEP IN THE BAND";
  ctx.fillText(prompt, pad, footerTop + 2);
  ctx.fillStyle = DIM;
  ctx.font = mono(small, 500);
  ctx.fillText(
    `USE — BACK OUT    ${Math.round(hackProgress(hack) * 100)}%` +
    (hack.faults > 0 ? `    ${hack.faults} FAULT${hack.faults > 1 ? "S" : ""}` : ""),
    pad, footerTop + small + 6,
  );

  // Scanlines over everything, and a border that says this is a screen and not the room.
  ctx.fillStyle = "rgba(0,0,0,0.16)";
  for (let y = 0; y < vp.h; y += 3) ctx.fillRect(0, y, vp.w, 1);
  ctx.strokeStyle = hack.resync > 0 ? "rgba(255,210,87,0.5)" : "rgba(124,255,155,0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, vp.w - 2, vp.h - 2);

  ctx.restore();
}
