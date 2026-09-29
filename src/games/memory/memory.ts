import type { Hand } from '../../input/Hand';
import { clamp, lerp, type Vec2 } from '../../lib/math';
import type { Palette } from '../../shell/theme';
import type { Game, GameEnv, GameResult, GameSpec } from '../types';
import { popText } from '../util';
import { resample, scoreTrace, shapeForRound, type Score, type Shape } from './trace';

/**
 * Memory Trace: see a shape for 5 s, then draw it from memory in 10 s, then see how
 * close you got.
 *
 * - Memorize: the shape is shown with a countdown. The cursor stays visible so the
 *   player can move to where they want to start (PROJECT.md A5).
 * - Draw: the shape disappears; the hand's path is recorded CONTINUOUSLY (no pinch:
 *   holding a pinch for 10 s is tiring and degrades tracking).
 * - Reveal: the path freezes, the original draws back in, the player's path replays
 *   coloured by how close each part was, missed stretches of the shape glow, and the
 *   accuracy counts up. Then the framework's result tray shows the one number.
 *
 * Each retry is harder: simple shapes, then stars and polygons, then abstract ones.
 */

export const MEMORIZE = 5;
export const DRAW = 10;
export const REVEAL = 3.6;
const DRAW_END = MEMORIZE + DRAW;

export type Stage = 'memorize' | 'draw' | 'reveal';

const RED = '#f0527a';
const AMBER = '#ffb347';
const GREEN = '#2fb67c';

export class MemoryGame implements Game {
  over = false;
  shape!: Shape;
  /** Rounds started on this instance (retries get harder). */
  round = 0;
  /** The recorded hand path (field px). */
  path: Vec2[] = [];
  score: Score | null = null;

  private w = 0;
  private h = 0;
  private env!: GameEnv;
  private time = 0;
  /** Shape outline in field px, and an evenly resampled copy (the autopilot's guide). */
  private target: Vec2[] = [];
  private guide: Vec2[] = [];
  private lastTick = Infinity;
  private started = false;

  start(w: number, h: number, env: GameEnv): void {
    this.env = env;
    this.round++;
    this.shape = shapeForRound(this.round, env.rng);
    this.path = [];
    this.score = null;
    this.over = false;
    this.time = 0;
    this.lastTick = Infinity;
    this.started = false;
    this.layout(w, h);
  }

  resize(w: number, h: number): void {
    const sx = w / this.w;
    const sy = h / this.h;
    for (const p of this.path) {
      p.x *= sx;
      p.y *= sy;
    }
    this.layout(w, h);
    if (this.score) this.score = scoreTrace(this.target, this.shape.closed, this.path, this.radius);
  }

  /** Shape radius in px. */
  get radius(): number {
    return Math.min(this.w, this.h) * 0.28;
  }

  get stage(): Stage {
    return this.time < MEMORIZE ? 'memorize' : this.time < DRAW_END ? 'draw' : 'reveal';
  }

  private layout(w: number, h: number): void {
    this.w = w;
    this.h = h;
    const c = this.center;
    const R = this.radius;
    this.target = this.shape.points.map((p) => ({ x: c.x + p.x * R, y: c.y + p.y * R }));
    this.guide = resample(this.target, Math.max(1, R / 40), this.shape.closed);
  }

  /** A little above the middle: the result tray covers the bottom of the field. */
  private get center(): Vec2 {
    return { x: this.w / 2, y: this.h * 0.47 };
  }

  update(_dt: number, hand: Hand, time: number): void {
    const before = this.stage;
    this.time = time;
    this.started = true;
    const stage = this.stage;

    if (before === 'memorize' && stage !== 'memorize') this.env.cue('go');
    // Count down the last 3 seconds of each timed stage.
    const left = stage === 'memorize' ? MEMORIZE - time : stage === 'draw' ? DRAW_END - time : Infinity;
    const whole = Math.ceil(left);
    if (whole <= 3 && whole < this.lastTick) {
      this.env.cue('tick');
      this.lastTick = whole;
    }
    if (stage !== before) this.lastTick = Infinity;

    if (stage === 'draw' && hand.present) {
      const last = this.path[this.path.length - 1];
      const p = hand.position;
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 0.5) this.path.push({ x: p.x, y: p.y });
    }
    if (stage === 'reveal' && !this.score) this.score = scoreTrace(this.target, this.shape.closed, this.path, this.radius);
    if (time >= DRAW_END + REVEAL) this.over = true;
  }

  hud(): string {
    if (!this.started) return '';
    return this.stage === 'memorize' ? 'Memorize' : this.stage === 'draw' ? 'Draw it!' : '';
  }

  timer(): { left: number; total: number } | null {
    if (!this.started) return null;
    if (this.stage === 'memorize') return { left: MEMORIZE - this.time, total: MEMORIZE };
    if (this.stage === 'draw') return { left: DRAW_END - this.time, total: DRAW };
    return null;
  }

  result(): GameResult {
    const s = this.score ?? scoreTrace(this.target, this.shape.closed, this.path, this.radius);
    const pct = Math.round(s.accuracy * 100);
    return { score: pct, display: `${pct}%`, label: 'accurate', detail: this.shape.name };
  }

  /** A careful player: waits at the start point, then traces the outline with a slight wobble. */
  autopilot(time: number): Vec2 | null {
    const R = this.radius;
    const g = this.guide;
    if (!g.length) return this.center;
    if (time < MEMORIZE) return g[0];
    const u = clamp((time - MEMORIZE - 0.3) / (DRAW - 1.8), 0, 1);
    const p = g[Math.min(g.length - 1, Math.round(u * (g.length - 1)))];
    if (time >= DRAW_END) return p;
    return { x: p.x + Math.sin(time * 3.1) * R * 0.05, y: p.y + Math.cos(time * 2.3) * R * 0.05 };
  }

  // ─── drawing ──────────────────────────────────────────────────────────────

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette): void {
    if (!this.started) return;
    const R = this.radius;
    const lw = Math.max(3, R * 0.055);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (this.stage === 'memorize') {
      // A soft breathing fill behind a bold outline.
      ctx.globalAlpha = 0.1 + Math.sin(this.time * 3) * 0.03;
      ctx.fillStyle = MEMORY_GAME.color;
      this.outline(ctx, this.target, this.shape.closed);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = MEMORY_GAME.color;
      ctx.lineWidth = lw;
      this.outline(ctx, this.target, this.shape.closed);
      ctx.stroke();
      return;
    }

    if (this.stage === 'draw') {
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = lw;
      this.outline(ctx, this.path, false);
      ctx.stroke();
      return;
    }

    this.drawReveal(ctx, w, h, pal, lw);
  }

  private drawReveal(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette, lw: number): void {
    const s = this.score;
    if (!s) return;
    const rt = this.time - DRAW_END;

    // 1. The frozen path, faint, so nothing jumps when the reveal starts.
    ctx.strokeStyle = pal.ink(0.14);
    ctx.lineWidth = lw;
    this.outline(ctx, this.path, false);
    ctx.stroke();

    // 2. The original draws back in.
    const k1 = clamp(rt / 0.8, 0, 1);
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = MEMORY_GAME.color;
    ctx.lineWidth = lw * 2.4;
    this.outline(ctx, s.target.slice(0, Math.max(2, Math.ceil(s.target.length * k1))), false);
    if (k1 >= 1 && this.shape.closed) ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 3. Missed stretches of the shape glow.
    if (rt > 0.8) {
      ctx.fillStyle = RED;
      const pulse = 0.35 + 0.25 * Math.sin(rt * 7);
      for (let i = 0; i < s.target.length; i++) {
        if (s.targetCloseness[i] > 0.35) continue;
        ctx.globalAlpha = pulse * (1 - s.targetCloseness[i]);
        ctx.beginPath();
        ctx.arc(s.target[i].x, s.target[i].y, lw * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // 4. The player's path replays, coloured by closeness.
    const k2 = clamp((rt - 0.8) / 1.6, 0, 1);
    const n = Math.floor(s.path.length * k2);
    ctx.lineWidth = lw;
    for (let i = 1; i < n; i++) {
      ctx.strokeStyle = closenessColor(s.pathCloseness[i]);
      ctx.beginPath();
      ctx.moveTo(s.path[i - 1].x, s.path[i - 1].y);
      ctx.lineTo(s.path[i].x, s.path[i].y);
      ctx.stroke();
    }

    // 5. The accuracy counts up, in the middle of the shape (always open space).
    const k3 = clamp((rt - 0.8) / 1.8, 0, 1);
    const pct = Math.round(s.accuracy * 100 * (1 - (1 - k3) ** 3));
    ctx.globalAlpha = clamp((rt - 0.7) / 0.3, 0, 1);
    popText(ctx, `${pct}%`, this.center.x, this.center.y, Math.min(w, h) * 0.1, closenessColor(s.accuracy), w);
    ctx.globalAlpha = 1;
  }

  private outline(ctx: CanvasRenderingContext2D, pts: readonly Vec2[], closed: boolean): void {
    ctx.beginPath();
    if (!pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (closed) ctx.closePath();
  }
}

/** Red (far) → amber → green (on the line). */
export function closenessColor(c: number): string {
  const mix = (a: string, b: string, t: number) => {
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return `rgb(${pa.map((v, i) => Math.round(lerp(v, pb[i], t))).join(',')})`;
  };
  const x = clamp(c, 0, 1);
  return x < 0.5 ? mix(RED, AMBER, x / 0.5) : mix(AMBER, GREEN, (x - 0.5) / 0.5);
}

export const MEMORY_GAME: GameSpec = {
  id: 'memory',
  title: 'Memory Trace',
  instruction: 'Memorize the shape. Then draw it in the air, where it was.',
  color: '#7c5cff',
  format: (score) => `${score}%`,
  create: () => new MemoryGame(),
};
