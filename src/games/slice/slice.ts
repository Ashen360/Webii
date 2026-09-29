import type { Hand } from '../../input/Hand';
import { clamp, lerp, type Vec2 } from '../../lib/math';
import type { Palette } from '../../shell/theme';
import type { Game, GameEnv, GameResult, GameSpec } from '../types';
import { TINTS, drawObject, popText, smallBoost } from '../util';

/**
 * Slice: shapes are tossed up in arcs; swipe through them to cut them.
 * The game reads the hand as MOTION: every frame the hand's path from the previous
 * frame is a blade segment, and it only cuts while the hand is fast. A slow touch
 * just nudges the shape ("Faster!"). The cut splits the shape along the swipe, and the
 * halves fly apart the way the hand was going, so the player sees their own movement
 * interpreted. Several cuts in one stroke make a combo.
 *
 * Sizes and speeds are relative to the field height, so the same code runs full
 * screen and in a channel tile.
 */

export const DURATION = 45;
/** Gravity, field heights / s². */
const GRAVITY = 1.25;
/** The hand must move at least this fast (field heights / s) to cut. */
export const SLICE_SPEED = 0.8;
/** Cuts closer together than this (s) belong to the same stroke (combo). */
const COMBO_GAP = 0.35;
/** Seconds between waves at the start and the end of a round. */
const WAVE_EVERY = [1.5, 0.85] as const;
/** Cutting is a little generous: the blade may pass this much outside the outline. */
const CUT_SLOP = 1.12;

export interface Target {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  kind: number;
  tint: string;
  rot: number;
  vr: number;
  wobble: number;
  cut: boolean;
  missed: boolean;
}

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  kind: number;
  tint: string;
  /** Cut line angle (radians); the piece is the half on `side` of it. */
  angle: number;
  side: 1 | -1;
  /** The shape's own rotation when it was cut. */
  base: number;
  /** Spin since the cut. */
  rot: number;
  vr: number;
  born: number;
}

interface Flash {
  x: number;
  y: number;
  angle: number;
  len: number;
  at: number;
}

interface Pop {
  x: number;
  y: number;
  at: number;
  text: string;
  color: string;
}

export const targetRadius = (w: number, h: number) => Math.min(h * 0.06 * smallBoost(h), w * 0.08);

/** Shortest distance from point (cx, cy) to the segment a→b. */
export function segmentDistance(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((cx - ax) * dx + (cy - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(ax + dx * t - cx, ay + dy * t - cy);
}

export class SliceGame implements Game {
  over = false;
  targets: Target[] = [];
  pieces: Piece[] = [];
  sliced = 0;
  missed = 0;
  bonus = 0;
  bestCombo = 0;
  /** Cuts in the stroke in progress. */
  combo = 0;

  private w = 0;
  private h = 0;
  private env!: GameEnv;
  private time = 0;
  private nextWave = 0;
  private last: Vec2 | null = null;
  private lastCutAt = -Infinity;
  private fasterAt = -Infinity;
  private flashes: Flash[] = [];
  private pops: Pop[] = [];
  /** Attract mode: the stroke being performed. */
  private plan: { target: Target; a: Vec2; b: Vec2; t0: number; t1: number } | null = null;
  private rest: Vec2 = { x: 0, y: 0 };

  start(w: number, h: number, env: GameEnv): void {
    this.w = w;
    this.h = h;
    this.env = env;
    this.targets = [];
    this.pieces = [];
    this.flashes = [];
    this.pops = [];
    this.sliced = this.missed = this.bonus = this.bestCombo = this.combo = 0;
    this.time = 0;
    this.nextWave = 0.5;
    this.last = null;
    this.lastCutAt = this.fasterAt = -Infinity;
    this.plan = null;
    this.rest = { x: w / 2, y: h * 0.7 };
  }

  resize(w: number, h: number): void {
    const sx = w / this.w;
    const sy = h / this.h;
    for (const o of [...this.targets, ...this.pieces]) {
      o.x *= sx;
      o.y *= sy;
      o.vx *= sx;
      o.vy *= sy;
      o.r = targetRadius(w, h);
    }
    this.last = null;
    this.w = w;
    this.h = h;
  }

  private get progress(): number {
    return clamp(this.time / DURATION, 0, 1);
  }

  update(dt: number, hand: Hand, time: number): void {
    this.time = time;
    if (time >= this.nextWave) this.wave();

    const g = GRAVITY * this.h;
    for (const o of this.targets) {
      o.vy += g * dt;
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      o.rot += o.vr * dt;
      o.wobble = Math.max(0, o.wobble - dt * 3);
    }
    for (const p of this.pieces) {
      p.vy += g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }

    this.blade(hand);

    for (const o of this.targets) {
      if (!o.cut && o.vy > 0 && o.y - o.r > this.h) {
        o.missed = true;
        this.missed++;
        this.env.cue('miss');
      }
    }
    this.targets = this.targets.filter((o) => !o.cut && !o.missed);
    this.pieces = this.pieces.filter((p) => time - p.born < 1.6 && p.y - p.r < this.h * 1.2);
    this.flashes = this.flashes.filter((f) => time - f.at < 0.3);
    this.pops = this.pops.filter((p) => time - p.at < 0.9);
  }

  /** This frame's hand motion as a blade segment: cut what it crosses, if fast enough. */
  private blade(hand: Hand): void {
    const p = { x: hand.position.x, y: hand.position.y };
    const from = this.last ?? p;
    this.last = p;
    const fast = hand.speed >= SLICE_SPEED * this.h;

    if (fast) {
      const dx = p.x - from.x;
      const dy = p.y - from.y;
      const angle = Math.atan2(dy, dx);
      for (const o of this.targets) {
        if (o.cut || segmentDistance(from.x, from.y, p.x, p.y, o.x, o.y) > o.r * CUT_SLOP) continue;
        this.cutTarget(o, angle, hand);
      }
    } else {
      // A slow touch bumps the shape: the hand is felt, but it isn't a blade.
      for (const o of this.targets) {
        if (Math.hypot(o.x - p.x, o.y - p.y) > o.r) continue;
        if (o.wobble < 0.2) {
          o.vx += clamp(hand.velocity.x * 0.4, -this.h * 0.3, this.h * 0.3);
          o.wobble = 1;
        }
        if (this.time - this.fasterAt > 1.5) {
          this.fasterAt = this.time;
          this.pops.push({ x: o.x, y: o.y - o.r * 1.6, at: this.time, text: 'Faster!', color: '#7d848e' });
        }
      }
    }

    // A stroke ends when the hand slows down or no cut followed for a moment.
    if (this.combo && (!fast || this.time - this.lastCutAt > COMBO_GAP)) this.endCombo();
  }

  private cutTarget(o: Target, angle: number, hand: Hand): void {
    o.cut = true;
    this.sliced++;
    this.combo++;
    this.lastCutAt = this.time;
    this.env.cue('swish');

    // Halves separate across the cut and carry some of the swipe's momentum.
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const sep = this.h * 0.35;
    const push = clamp(hand.speed * 0.08, 0, this.h * 0.4);
    for (const side of [1, -1] as const) {
      this.pieces.push({
        x: o.x,
        y: o.y,
        vx: o.vx * 0.6 - dir.y * side * sep + dir.x * push,
        vy: Math.min(o.vy, 0) * 0.4 + dir.x * side * sep + dir.y * push,
        r: o.r,
        kind: o.kind,
        tint: o.tint,
        angle,
        side,
        base: o.rot,
        rot: 0,
        vr: side * 2.4,
        born: this.time,
      });
    }
    this.flashes.push({ x: o.x, y: o.y, angle, len: o.r * 3.2, at: this.time });
    this.pops.push({ x: o.x, y: o.y - o.r * 1.4, at: this.time, text: '+1', color: o.tint });
  }

  private endCombo(): void {
    if (this.combo >= 2) {
      const extra = this.combo - 1;
      this.bonus += extra;
      this.pops.push({ x: this.last?.x ?? this.w / 2, y: (this.last?.y ?? this.h / 2) - this.h * 0.1, at: this.time, text: `Combo ×${this.combo} +${extra}`, color: '#f0527a' });
      this.env.cue('score');
    }
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.combo = 0;
  }

  /** A wave of 1–3 shapes tossed up from below, more and faster over the round. */
  private wave(): void {
    const p = this.progress;
    const count = 1 + Math.floor(this.env.rng() * (1 + p * 2.2));
    const r = targetRadius(this.w, this.h);
    const g = GRAVITY * this.h;
    for (let i = 0; i < count; i++) {
      const x0 = this.w * (0.15 + this.env.rng() * 0.7);
      const y0 = this.h + r;
      const apex = this.h * (0.18 + this.env.rng() * 0.3);
      const vy = -Math.sqrt(2 * g * (y0 - apex));
      const flight = (2 * -vy) / g;
      // Drift toward the middle so shapes stay on screen.
      const vx = ((this.w * 0.5 - x0) * (0.3 + this.env.rng() * 0.5)) / flight;
      this.targets.push({
        // Staggered launch: later shapes start a little lower (they appear a beat later).
        x: x0,
        y: y0 + i * r * 1.5,
        vx,
        vy,
        r,
        kind: Math.floor(this.env.rng() * 3),
        tint: TINTS[Math.floor(this.env.rng() * TINTS.length)],
        rot: this.env.rng() * Math.PI,
        vr: (this.env.rng() - 0.5) * 3,
        wobble: 0,
        cut: false,
        missed: false,
      });
    }
    this.nextWave = this.time + lerp(WAVE_EVERY[0], WAVE_EVERY[1], p) * (0.85 + this.env.rng() * 0.3);
  }

  hud(): string {
    return String(this.sliced + this.bonus);
  }

  result(): GameResult {
    const score = this.sliced + this.bonus;
    const parts = [`${this.sliced} sliced`, `${this.missed} missed`];
    if (this.bestCombo >= 2) parts.push(`best combo ×${this.bestCombo}`);
    return { score, display: String(score), label: 'points', detail: this.sliced + this.missed ? parts.join(' · ') : undefined };
  }

  // ─── attract mode ───────────────────────────────────────────────────────

  /**
   * A good player: pick the shape that leaves soonest, predict where it will be, and
   * swipe straight through that spot at slicing speed. Timings lead by the scripted
   * hand's spring lag (≈ 2/ω) so the ghost hand really crosses the shape on time.
   */
  autopilot(time: number): Vec2 | null {
    const LAG = 0.125;
    const STROKE = 0.2;
    const LEAD = 0.42;
    if (this.plan && time > this.plan.t1 + 0.04) {
      this.rest = this.plan.b;
      this.plan = null;
    }
    if (!this.plan) {
      const tc = time + LEAD;
      let best: Target | null = null;
      let bestLeave = Infinity;
      let at: Vec2 = { x: 0, y: 0 };
      for (const o of this.targets) {
        if (o.cut) continue;
        const q = this.predict(o, LEAD);
        if (q.y < this.h * 0.08 || q.y > this.h * 0.88 || q.x < 0 || q.x > this.w) continue;
        const leave = this.timeToLeave(o);
        if (leave < bestLeave) {
          bestLeave = leave;
          best = o;
          at = q;
        }
      }
      if (!best) return this.rest;
      const L = Math.max(this.h * 0.36, best.r * 4);
      const sign = this.rest.x <= at.x ? 1 : -1;
      const tilt = (this.env.rng() - 0.5) * 0.9;
      const d = { x: Math.cos(tilt) * sign, y: Math.sin(tilt) };
      this.plan = {
        target: best,
        a: { x: at.x - (d.x * L) / 2, y: at.y - (d.y * L) / 2 },
        b: { x: at.x + (d.x * L) / 2, y: at.y + (d.y * L) / 2 },
        t0: tc - STROKE / 2 - LAG,
        t1: tc + STROKE / 2 - LAG,
      };
    }
    const { a, b, t0, t1 } = this.plan;
    if (time <= t0) return a;
    if (time >= t1) return b;
    const k = (time - t0) / (t1 - t0);
    return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
  }

  private predict(o: Target, dt: number): Vec2 {
    return { x: o.x + o.vx * dt, y: o.y + o.vy * dt + 0.5 * GRAVITY * this.h * dt * dt };
  }

  /** Seconds until the shape falls out of the bottom of the field. */
  private timeToLeave(o: Target): number {
    const g = GRAVITY * this.h;
    const dy = this.h + o.r - o.y;
    return (-o.vy + Math.sqrt(Math.max(0, o.vy * o.vy + 2 * g * dy))) / g;
  }

  // ─── drawing ──────────────────────────────────────────────────────────────

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette, hand: Hand): void {
    const s = Math.min(w, h);
    for (const o of this.targets) {
      ctx.save();
      ctx.translate(o.x + Math.sin(this.time * 40) * o.wobble * o.r * 0.12, o.y);
      ctx.rotate(o.rot);
      drawObject(ctx, o.kind, o.r, o.tint, pal.card);
      ctx.restore();
    }
    for (const p of this.pieces) this.drawPiece(ctx, p, pal);

    ctx.lineCap = 'round';
    for (const f of this.flashes) {
      const k = (this.time - f.at) / 0.3;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = pal.card;
      ctx.lineWidth = Math.max(2, s * 0.012 * (1 - k));
      const dx = (Math.cos(f.angle) * f.len * (0.6 + k * 0.4)) / 2;
      const dy = (Math.sin(f.angle) * f.len * (0.6 + k * 0.4)) / 2;
      ctx.beginPath();
      ctx.moveTo(f.x - dx, f.y - dy);
      ctx.lineTo(f.x + dx, f.y + dy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    this.drawTrail(ctx, hand, pal, s);

    for (const p of this.pops) {
      const k = (this.time - p.at) / 0.9;
      ctx.globalAlpha = 1 - k * k;
      popText(ctx, p.text, p.x, p.y - k * h * 0.05, s * (p.text === '+1' ? 0.045 : 0.05), p.color, w);
    }
    ctx.globalAlpha = 1;
  }

  /** One half of a cut shape: clip to its side of the cut line, then draw the whole shape. */
  private drawPiece(ctx: CanvasRenderingContext2D, p: Piece, pal: Palette): void {
    const k = clamp((this.time - p.born - 0.8) / 0.8, 0, 1);
    ctx.save();
    ctx.globalAlpha = 1 - k;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    // In the cut line's frame, this half is y > 0 (side 1) or y < 0 (side -1).
    ctx.rotate(p.angle);
    ctx.beginPath();
    ctx.rect(-p.r * 2, p.side > 0 ? 0 : -p.r * 2, p.r * 4, p.r * 2);
    ctx.clip();
    ctx.rotate(p.base - p.angle);
    drawObject(ctx, p.kind, p.r, p.tint, pal.card);
    // The fresh cut face.
    ctx.rotate(p.angle - p.base);
    ctx.strokeStyle = pal.card;
    ctx.globalAlpha = (1 - k) * 0.8;
    ctx.lineWidth = Math.max(1.5, p.r * 0.12);
    ctx.beginPath();
    ctx.moveTo(-p.r * 1.2, 0);
    ctx.lineTo(p.r * 1.2, 0);
    ctx.stroke();
    ctx.restore();
  }

  /** The blade: the last ~0.15 s of the hand's path, tapered, bright only when fast enough. */
  private drawTrail(ctx: CanvasRenderingContext2D, hand: Hand, pal: Palette, s: number): void {
    const path = hand.path;
    if (!hand.present || path.length < 2) return;
    const now = path[path.length - 1].t;
    const hot = hand.speed >= SLICE_SPEED * this.h;
    ctx.lineCap = 'round';
    ctx.strokeStyle = hot ? pal.accent : pal.ink(0.22);
    for (let i = 1; i < path.length; i++) {
      const age = (now - path[i].t) / 150;
      if (age > 1 || age < 0) continue; // (never trust a clock to be monotonic)
      ctx.globalAlpha = (1 - age) * (hot ? 1 : 0.7);
      ctx.lineWidth = Math.max(1.5, s * 0.022 * (1 - age));
      ctx.beginPath();
      ctx.moveTo(path[i - 1].x, path[i - 1].y);
      ctx.lineTo(path[i].x, path[i].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Tip of the blade (the game draws its own hand).
    ctx.fillStyle = hot ? pal.accent : pal.ink(0.35);
    ctx.beginPath();
    ctx.arc(hand.position.x, hand.position.y, Math.max(4, s * 0.014), 0, Math.PI * 2);
    ctx.fill();
  }
}

export const SLICE_GAME: GameSpec = {
  id: 'slice',
  title: 'Slice',
  instruction: 'Swipe fast through the shapes. Slow hands only bump them.',
  color: '#f0527a',
  duration: DURATION,
  ownCursor: true,
  create: () => new SliceGame(),
};
