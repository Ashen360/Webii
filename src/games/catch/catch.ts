import type { Hand } from '../../input/Hand';
import { clamp, lerp, type Vec2 } from '../../lib/math';
import type { Palette } from '../../shell/theme';
import type { Game, GameEnv, GameResult, GameSpec } from '../types';
import { TINTS, drawObject, popText, smallBoost } from '../util';

/**
 * Catch: things fall, your hand's x position moves a basket under them.
 * Tests exactly what the seed asks for: hand position, reaction, tracking stability.
 *
 * Everything is sized from the field (the same code runs full screen and in a tile):
 * the basket is wide (hands are imprecise), objects start slow and speed up over the
 * round, and spawns are spaced so every object is reachable by a moving hand.
 */

export const DURATION = 40;
/** Basket rim height, as a fraction of the field height. */
export const BASKET_Y = 0.84;
/** Fall speed (field heights per second) at the start and the end of a round. */
const FALL = [0.34, 0.68] as const;
/** Seconds between drops at the start and the end of a round. */
const EVERY = [1.15, 0.5] as const;
/** The furthest a new drop lands from the previous one, as a fraction of the field width. */
export const MAX_JUMP = 0.55;

export interface Drop {
  x: number;
  y: number;
  r: number;
  vy: number;
  kind: number;
  tint: string;
  spin: number;
  /** Set when caught or missed (seconds of play), for the exit animation. */
  doneAt: number | null;
  caught: boolean;
}

interface Pop {
  x: number;
  y: number;
  at: number;
  text: string;
}

/** Size helpers: the basket must be wide enough for a hand, but not the whole screen. */
export const basketWidth = (w: number, h: number) => clamp(Math.max(h * 0.24, w * 0.12) * smallBoost(h), 0, w * 0.34);
export const dropRadius = (w: number, h: number) => Math.min(h * 0.042 * smallBoost(h), w * 0.06);

export class CatchGame implements Game {
  over = false;
  drops: Drop[] = [];
  caught = 0;
  missed = 0;
  streak = 0;
  bestStreak = 0;
  /** Basket centre x (follows the hand). */
  bx = 0;

  private w = 0;
  private h = 0;
  private env!: GameEnv;
  private time = 0;
  private nextAt = 0;
  private lastX = 0.5;
  private tilt = 0;
  private squash = 0;
  private pops: Pop[] = [];

  start(w: number, h: number, env: GameEnv): void {
    this.w = w;
    this.h = h;
    this.env = env;
    this.drops = [];
    this.pops = [];
    this.caught = this.missed = this.streak = this.bestStreak = 0;
    this.time = 0;
    this.nextAt = 0.4;
    this.lastX = 0.5;
    this.bx = w / 2;
    this.tilt = this.squash = 0;
  }

  resize(w: number, h: number): void {
    const sx = w / this.w;
    const sy = h / this.h;
    for (const d of this.drops) {
      d.x *= sx;
      d.y *= sy;
      d.vy *= sy;
      d.r = dropRadius(w, h);
    }
    this.bx *= sx;
    this.w = w;
    this.h = h;
  }

  /** 0 → 1 over the round. */
  private get progress(): number {
    return clamp(this.time / DURATION, 0, 1);
  }

  update(dt: number, hand: Hand, time: number): void {
    this.time = time;
    this.follow(hand, dt);

    if (time >= this.nextAt) this.spawn();

    const line = this.h * BASKET_Y;
    const half = basketWidth(this.w, this.h) / 2;
    for (const d of this.drops) {
      if (d.doneAt !== null) continue;
      const prevY = d.y;
      d.y += d.vy * dt;
      // Caught when it crosses the rim inside the basket (a little generous at the lips).
      if (prevY < line && d.y >= line && Math.abs(d.x - this.bx) <= half + d.r * 0.5) {
        d.doneAt = time;
        d.caught = true;
        d.y = line;
        this.caught++;
        this.streak++;
        this.bestStreak = Math.max(this.bestStreak, this.streak);
        this.squash = 1;
        this.pops.push({ x: d.x, y: line - this.h * 0.08, at: time, text: this.streak >= 5 && this.streak % 5 === 0 ? `${this.streak} in a row!` : '+1' });
        this.env.cue('score');
      } else if (d.y - d.r > this.h) {
        d.doneAt = time;
        this.missed++;
        this.streak = 0;
        this.env.cue('miss');
      }
    }
    this.drops = this.drops.filter((d) => d.doneAt === null || time - d.doneAt < 0.4);
    this.pops = this.pops.filter((p) => time - p.at < 0.9);
    this.squash = Math.max(0, this.squash - dt * 5);
  }

  /** The basket follows the hand's x; it leans into fast moves. */
  private follow(hand: Hand, dt: number): void {
    if (!hand.present) return;
    const half = basketWidth(this.w, this.h) / 2;
    // The basket stays fully on screen; drops spawn far enough in to still be catchable.
    this.bx = clamp(hand.position.x, half, this.w - half);
    const lean = clamp(hand.velocity.x / (this.w * 2), -1, 1) * 0.22;
    this.tilt += (lean - this.tilt) * Math.min(1, dt * 12);
  }

  private spawn(): void {
    const p = this.progress;
    const r = dropRadius(this.w, this.h);
    const margin = Math.max(r * 1.5, basketWidth(this.w, this.h) * 0.35);
    // Keep consecutive drops within reach: a random spot, but no more than MAX_JUMP away.
    const u = this.env.rng();
    const x = clamp(this.lastX + (u - 0.5) * 2 * MAX_JUMP, 0, 1);
    this.lastX = x;
    this.drops.push({
      x: margin + x * (this.w - 2 * margin),
      y: -r,
      r,
      vy: this.h * lerp(FALL[0], FALL[1], p) * (0.9 + this.env.rng() * 0.2),
      kind: Math.floor(this.env.rng() * 3),
      tint: TINTS[Math.floor(this.env.rng() * TINTS.length)],
      spin: (this.env.rng() - 0.5) * 4,
      doneAt: null,
      caught: false,
    });
    this.nextAt = this.time + lerp(EVERY[0], EVERY[1], p) * (0.85 + this.env.rng() * 0.3);
  }

  hud(): string {
    return String(this.caught);
  }

  result(): GameResult {
    const total = this.caught + this.missed;
    return {
      score: this.caught,
      display: String(this.caught),
      label: 'caught',
      detail: !total ? undefined : this.missed ? `${this.missed} missed · best streak ${this.bestStreak}` : 'Perfect round!',
    };
  }

  /** A good player: under the drop that reaches the rim first. */
  autopilot(): Vec2 | null {
    const line = this.h * BASKET_Y;
    let best: Drop | null = null;
    let soonest = Infinity;
    for (const d of this.drops) {
      if (d.doneAt !== null || d.y > line) continue;
      const eta = (line - d.y) / d.vy;
      if (eta < soonest) {
        soonest = eta;
        best = d;
      }
    }
    return { x: best ? best.x : this.bx, y: line };
  }

  // ─── drawing ──────────────────────────────────────────────────────────────

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette, hand: Hand): void {
    // Before play (intro, countdown) the basket already follows the hand, so the player
    // can get into position; catching only happens in update().
    if (this.time === 0 && hand.present) this.bx = clamp(hand.position.x, basketWidth(w, h) / 2, w - basketWidth(w, h) / 2);
    const line = h * BASKET_Y;
    const s = Math.min(w, h);

    // Ground shadow of the basket.
    const bw = basketWidth(w, h);
    ctx.fillStyle = pal.ink(0.06);
    ctx.beginPath();
    ctx.ellipse(this.bx, h * 0.95, bw * 0.45, h * 0.015, 0, 0, Math.PI * 2);
    ctx.fill();

    for (const d of this.drops) this.drawDrop(ctx, d, pal);
    this.drawBasket(ctx, line, bw, h, pal);

    for (const p of this.pops) {
      const k = (this.time - p.at) / 0.9;
      ctx.globalAlpha = 1 - k * k;
      popText(ctx, p.text, p.x, p.y - k * h * 0.06, s * (p.text === '+1' ? 0.05 : 0.045), TINTS[0], w);
    }
    ctx.globalAlpha = 1;
  }

  private drawDrop(ctx: CanvasRenderingContext2D, d: Drop, pal: Palette): void {
    let scale = 1;
    let alpha = 1;
    if (d.doneAt !== null) {
      const k = (this.time - d.doneAt) / 0.4;
      scale = d.caught ? 1 - k * 0.7 : 1;
      alpha = 1 - k;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(d.x, d.y);
    ctx.rotate(d.spin * this.time);
    ctx.scale(scale, scale);
    drawObject(ctx, d.kind, d.r, d.tint, pal.card);
    ctx.restore();
  }

  private drawBasket(ctx: CanvasRenderingContext2D, line: number, bw: number, h: number, pal: Palette): void {
    const depth = h * 0.075;
    const sq = this.squash * 0.12;
    ctx.save();
    ctx.translate(this.bx, line);
    ctx.rotate(this.tilt);
    ctx.scale(1 + sq, 1 - sq);
    // Bowl: wider at the rim, rounded bottom.
    ctx.beginPath();
    ctx.moveTo(-bw / 2, 0);
    ctx.lineTo(bw / 2, 0);
    ctx.quadraticCurveTo(bw * 0.44, depth, bw * 0.3, depth);
    ctx.lineTo(-bw * 0.3, depth);
    ctx.quadraticCurveTo(-bw * 0.44, depth, -bw / 2, 0);
    ctx.closePath();
    ctx.fillStyle = pal.card;
    ctx.shadowColor = pal.ink(0.18);
    ctx.shadowBlur = h * 0.02;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(2, h * 0.006);
    ctx.strokeStyle = pal.ink(0.12);
    ctx.stroke();
    // Rim in the game colour.
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(3, h * 0.012);
    ctx.strokeStyle = TINTS[0];
    ctx.beginPath();
    ctx.moveTo(-bw / 2, 0);
    ctx.lineTo(bw / 2, 0);
    ctx.stroke();
    ctx.restore();
  }
}

export const CATCH_GAME: GameSpec = {
  id: 'catch',
  title: 'Catch',
  instruction: 'Move your hand left and right to catch what falls.',
  color: '#ff8a3d',
  duration: DURATION,
  ownCursor: true,
  create: () => new CatchGame(),
};
