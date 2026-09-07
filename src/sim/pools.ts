import type { Bullet, Particle, Team } from "./entities";
import { randRange, TAU } from "../core/math";

/**
 * Fixed-capacity pools. Bullets and particles are the only things that churn every
 * frame, so they never allocate: dead slots are reused. Keeps the GC out of the frame.
 */

const MAX_BULLETS = 1024;
const MAX_PARTICLES = 2048;

export class BulletPool {
  readonly items: Bullet[] = [];
  private cursor = 0;

  constructor() {
    for (let i = 0; i < MAX_BULLETS; i++) {
      this.items.push({
        active: false, x: 0, y: 0, prevX: 0, prevY: 0, vx: 0, vy: 0,
        life: 0, damage: 0, team: "player", ownerId: -1, color: "#fff",
      });
    }
  }

  spawn(
    x: number, y: number, angle: number, speed: number, damage: number,
    team: Team, ownerId: number, life: number, color: string,
  ): void {
    for (let i = 0; i < this.items.length; i++) {
      const b = this.items[(this.cursor + i) % this.items.length];
      if (b.active) continue;
      this.cursor = (this.cursor + i + 1) % this.items.length;
      b.active = true;
      b.x = b.prevX = x;
      b.y = b.prevY = y;
      b.vx = Math.cos(angle) * speed;
      b.vy = Math.sin(angle) * speed;
      b.life = life;
      b.damage = damage;
      b.team = team;
      b.ownerId = ownerId;
      b.color = color;
      return;
    }
  }
}

export class ParticlePool {
  readonly items: Particle[] = [];
  private cursor = 0;

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.items.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: "#fff" });
    }
  }

  private next(): Particle {
    const p = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    return p;
  }

  burst(x: number, y: number, count: number, speed: number, color: string, life = 0.35, size = 3): void {
    for (let i = 0; i < count; i++) {
      const p = this.next();
      const a = randRange(0, TAU);
      const s = randRange(speed * 0.3, speed);
      p.active = true;
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s;
      p.maxLife = p.life = life * randRange(0.6, 1.2);
      p.size = size * randRange(0.6, 1.3);
      p.color = color;
    }
  }

  update(dt: number): void {
    for (const p of this.items) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 6 * dt;
      p.vy *= 1 - 6 * dt;
    }
  }
}
