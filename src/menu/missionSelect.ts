import { isUnlocked, type Campaign, type Mission } from "../campaign/campaign";
import { drawScrim, footer, MenuCursor, pulse, title } from "./ui";

/**
 * CORE 18 — Mission select.
 *
 * The campaign drawn as what it is: a graph. Every mission is a node placed by the
 * author, lines run from a mission to the ones it unlocks, and finishing one opens its
 * dependents. You come back here after every mission, won or lost.
 *
 * Navigation picks the node that best matches the direction you pushed — no fixed
 * ordering, so adding a mission to the campaign file needs no menu changes.
 */
export class MissionSelect {
  index = 0;
  private cursor = new MenuCursor();
  /** Set by the shell after a mission ends, shown as a banner over the map. */
  notice = "";
  private noticeTime = 0;

  constructor(readonly campaign: Campaign) {}

  setNotice(text: string): void {
    this.notice = text;
    this.noticeTime = 3.5;
  }

  /** Focus the first playable mission that is not finished yet. */
  focusNext(completed: ReadonlySet<string>): void {
    const next = this.campaign.missions.findIndex(
      (m) => !completed.has(m.id) && isUnlocked(m, completed),
    );
    if (next >= 0) this.index = next;
  }

  /** Returns the mission to launch on the step it is confirmed. */
  update(
    moveX: number, moveY: number, confirm: boolean, dt: number,
    completed: ReadonlySet<string>, aspect: number,
  ): Mission | null {
    if (this.noticeTime > 0) this.noticeTime -= dt;

    const step = this.cursor.step(moveX, moveY, dt);
    if (step.x !== 0 || step.y !== 0) this.moveSelection(step.x, step.y, aspect);

    const mission = this.campaign.missions[this.index];
    if (confirm && mission && isUnlocked(mission, completed)) return mission;
    return null;
  }

  /**
   * Pick the node most in the pushed direction: score by how well its offset lines up
   * with the input, penalised by distance. Simple, and it behaves sensibly for any
   * layout an author comes up with.
   */
  private moveSelection(dx: number, dy: number, aspect: number): void {
    const from = this.campaign.missions[this.index];
    if (!from) return;

    let best = -1;
    let bestScore = 0;
    this.campaign.missions.forEach((m, i) => {
      if (i === this.index) return;
      // Node positions are normalised, so undo the aspect ratio before comparing.
      const ox = (m.node.x - from.node.x) * aspect;
      const oy = m.node.y - from.node.y;
      const dist = Math.hypot(ox, oy);
      if (dist < 1e-4) return;
      const alignment = (ox * dx + oy * dy) / dist;
      if (alignment < 0.35) return;
      const score = alignment / (0.2 + dist);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0) this.index = best;
  }

  draw(
    ctx: CanvasRenderingContext2D, width: number, height: number, dpr: number,
    completed: ReadonlySet<string>,
  ): void {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScrim(ctx, width, height);
    const p = pulse();

    const done = this.campaign.missions.filter((m) => completed.has(m.id)).length;
    title(
      ctx, this.campaign.name.toUpperCase(),
      `${done} of ${this.campaign.missions.length} missions complete`,
      width, height * 0.14,
    );

    // Map area, inset so nodes never touch the title or the brief.
    const left = width * 0.16;
    const top = height * 0.3;
    const mapW = width * 0.68;
    const mapH = height * 0.34;
    const at = (m: Mission): { x: number; y: number } =>
      ({ x: left + m.node.x * mapW, y: top + m.node.y * mapH });

    // Links first, so nodes sit on top of them.
    ctx.lineWidth = 2;
    for (const mission of this.campaign.missions) {
      const to = at(mission);
      for (const reqId of mission.requires) {
        const req = this.campaign.missions.find((m) => m.id === reqId);
        if (!req) continue;
        const from = at(req);
        const open = completed.has(reqId);
        ctx.strokeStyle = open ? "rgba(139,255,122,0.35)" : "rgba(255,255,255,0.09)";
        ctx.setLineDash(open ? [] : [4, 6]);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    this.campaign.missions.forEach((mission, i) => {
      const pos = at(mission);
      const unlocked = isUnlocked(mission, completed);
      const finished = completed.has(mission.id);
      const selected = i === this.index;
      const r = 21;

      const color = finished ? "#8bff7a" : unlocked ? "#ffd257" : "#4a5064";

      if (selected) {
        ctx.strokeStyle = `rgba(255,255,255,${0.35 + p * 0.5})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 8, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = finished ? "rgba(139,255,122,0.16)"
        : unlocked ? "rgba(255,210,87,0.13)" : "rgba(255,255,255,0.03)";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.stroke();

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "700 15px ui-monospace, monospace";
      ctx.fillStyle = color;
      ctx.fillText(finished ? "✓" : unlocked ? String(i + 1) : "·", pos.x, pos.y + 1);

      ctx.font = "600 10px ui-monospace, monospace";
      ctx.fillStyle = unlocked ? "rgba(216,222,235,0.8)" : "rgba(120,130,150,0.4)";
      ctx.fillText(unlocked ? mission.name : "LOCKED", pos.x, pos.y + r + 14);
    });

    // Brief for the highlighted mission.
    const mission = this.campaign.missions[this.index];
    const briefY = top + mapH + 62;
    if (mission) {
      const unlocked = isUnlocked(mission, completed);
      ctx.textAlign = "center";
      ctx.font = "700 18px ui-monospace, monospace";
      ctx.fillStyle = unlocked ? "#f2f4f8" : "rgba(140,150,170,0.7)";
      ctx.fillText(unlocked ? mission.name : "LOCKED", width / 2, briefY);

      ctx.font = "500 12px ui-monospace, monospace";
      ctx.fillStyle = "rgba(150,160,180,0.85)";
      ctx.fillText(
        unlocked ? mission.brief : `Finish ${mission.requires.join(" and ")} first.`,
        width / 2, briefY + 22,
      );

      if (unlocked) {
        ctx.font = "700 11px ui-monospace, monospace";
        ctx.fillStyle = `rgba(230,236,248,${0.4 + p * 0.5})`;
        ctx.fillText(completed.has(mission.id) ? "PRESS START TO REPLAY" : "PRESS START TO DEPLOY",
          width / 2, briefY + 48);
      }
    }

    if (this.noticeTime > 0) {
      ctx.globalAlpha = Math.min(1, this.noticeTime);
      ctx.font = "700 20px ui-monospace, monospace";
      ctx.fillStyle = this.notice.includes("FAILED") ? "#ff7a7a" : "#8bff7a";
      ctx.fillText(this.notice, width / 2, height * 0.24);
      ctx.globalAlpha = 1;
    }

    footer(ctx, "MOVE  pick a mission     START / ENTER  deploy     B / ESC  change mode",
      width, height - 28);
    ctx.restore();
  }
}
