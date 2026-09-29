import type { Hand } from '../input/Hand';
import type { Vec2 } from '../lib/math';
import type { Palette } from '../shell/theme';
import type { Game, GameEnv, GameSpec } from './types';

/**
 * Framework demo (dev only, `?game=demo`): touch the bubbles with your hand. The
 * smallest game that exercises the whole framework (timer, score, cues, autopilot,
 * resize), so Phase 6 can be verified before Catch exists. Not in the shelf.
 */

interface Bubble {
  x: number;
  y: number;
  r: number;
  born: number;
  popped: number | null;
}

class Pop implements Game {
  over = false;
  private w = 0;
  private h = 0;
  private env!: GameEnv;
  private bubbles: Bubble[] = [];
  private score = 0;
  private time = 0;

  start(w: number, h: number, env: GameEnv): void {
    this.w = w;
    this.h = h;
    this.env = env;
    this.score = 0;
    this.time = 0;
    this.bubbles = [];
    for (let i = 0; i < 3; i++) this.spawn();
  }

  resize(w: number, h: number): void {
    const sx = w / this.w;
    const sy = h / this.h;
    for (const b of this.bubbles) {
      b.x *= sx;
      b.y *= sy;
      b.r *= Math.min(sx, sy);
    }
    this.w = w;
    this.h = h;
  }

  update(_dt: number, hand: Hand, time: number): void {
    this.time = time;
    for (const b of this.bubbles) {
      if (b.popped === null && Math.hypot(hand.position.x - b.x, hand.position.y - b.y) < b.r) {
        b.popped = time;
        this.score++;
        this.env.cue('score');
      }
    }
    // Popped bubbles linger briefly (burst), then a new one replaces each.
    const before = this.bubbles.length;
    this.bubbles = this.bubbles.filter((b) => b.popped === null || time - b.popped < 0.3);
    for (let i = this.bubbles.length; i < before; i++) this.spawn();
  }

  draw(ctx: CanvasRenderingContext2D, _w: number, _h: number, pal: Palette): void {
    for (const b of this.bubbles) {
      const grow = Math.min(1, (this.time - b.born) / 0.25 + (b.born === 0 ? 1 : 0));
      const burst = b.popped === null ? 0 : (this.time - b.popped) / 0.3;
      ctx.globalAlpha = 1 - burst;
      ctx.fillStyle = pal.accent;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r * grow * (1 + burst * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  hud(): string {
    return String(this.score);
  }

  result() {
    return { score: this.score, display: String(this.score), label: 'popped' };
  }

  autopilot(): Vec2 | null {
    const live = this.bubbles.filter((b) => b.popped === null);
    if (!live.length) return { x: this.w / 2, y: this.h / 2 };
    const t = live.reduce((a, b) => (a.born <= b.born ? a : b));
    return { x: t.x, y: t.y };
  }

  private spawn(): void {
    const s = Math.min(this.w, this.h);
    const r = s * 0.07;
    const m = r + s * 0.1;
    this.bubbles.push({
      x: m + this.env.rng() * (this.w - 2 * m),
      y: m + this.env.rng() * (this.h - 2 * m),
      r,
      born: this.time,
      popped: null,
    });
  }
}

export const DEMO_GAME: GameSpec = {
  id: 'demo',
  title: 'Pop',
  instruction: 'Touch the bubbles with your hand.',
  color: '#2f7df6',
  duration: 20,
  create: () => new Pop(),
};
