import { clamp } from '../lib/math';

/** Helpers shared by the games (no game logic here). */

/** Small fields (a channel tile) draw things bigger so they stay readable; ≥ 600 px tall is 1. */
export const smallBoost = (h: number) => clamp(600 / h, 1, 1.8);

/** Bright, friendly object colours used by every game. */
export const TINTS = ['#ff8a3d', '#ffb347', '#6cc4ff', '#7c5cff', '#f0527a', '#12a594'];

/** Traces shape `kind` (0 circle, 1 triangle, 2 rounded square) of radius r at the origin. */
export function shapePath(ctx: CanvasRenderingContext2D, kind: number, r: number): void {
  ctx.beginPath();
  if (kind === 0) ctx.arc(0, 0, r, 0, Math.PI * 2);
  else if (kind === 1) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
      ctx.lineTo(Math.cos(a) * r * 1.2, Math.sin(a) * r * 1.2);
    }
    ctx.closePath();
  } else ctx.roundRect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7, r * 0.3);
}

/** Draws a filled game object with a soft highlight, so shapes read as objects. */
export function drawObject(ctx: CanvasRenderingContext2D, kind: number, r: number, tint: string, highlight: string): void {
  ctx.fillStyle = tint;
  shapePath(ctx, kind, r);
  ctx.fill();
  const a = ctx.globalAlpha;
  ctx.globalAlpha = a * 0.35;
  ctx.fillStyle = highlight;
  ctx.beginPath();
  ctx.arc(-r * 0.3, -r * 0.3, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = a;
}

/** Floating score text, kept inside the field. */
export function popText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, w: number): void {
  ctx.font = `900 ${Math.max(12, size)}px 'Nunito Variable', system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  const half = ctx.measureText(text).width / 2 + size * 0.3;
  ctx.fillText(text, clamp(x, half, w - half), y);
}
