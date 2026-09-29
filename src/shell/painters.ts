/**
 * Live, looping canvas previews for the non-game channel tiles and preview screens.
 * Pure functions of time: (ctx, w, h, t seconds, colour). Games don't need one: their
 * tiles and previews run the real game in attract mode (games/attract.ts).
 */
import { palette } from './theme';

export type Painter = (ctx: CanvasRenderingContext2D, w: number, h: number, t: number, color: string) => void;

const TAU = Math.PI * 2;

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export function ghostCursor(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, pinch = 0) {
  ctx.lineWidth = s * 0.14;
  ctx.strokeStyle = palette().accent;
  ctx.fillStyle = pinch > 0.5 ? palette().accent : palette().card;
  ctx.beginPath();
  ctx.arc(x, y, s * (1 - pinch * 0.3), 0, TAU);
  ctx.fill();
  ctx.stroke();
}

function shape(ctx: CanvasRenderingContext2D, kind: number, x: number, y: number, r: number, rot = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  if (kind === 0) ctx.arc(0, 0, r, 0, TAU);
  else if (kind === 1) {
    for (let i = 0; i < 3; i++) ctx.lineTo(Math.cos((i / 3) * TAU - Math.PI / 2) * r * 1.15, Math.sin((i / 3) * TAU - Math.PI / 2) * r * 1.15);
    ctx.closePath();
  } else ctx.roundRect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7, r * 0.3);
  ctx.fill();
  ctx.restore();
}

// ─── channel tiles ──────────────────────────────────────────────────────────

export const gamesTile: Painter = (ctx, w, h, t, color) => {
  const tints = [color, '#ffb347', '#6cc4ff'];
  for (let i = 0; i < 3; i++) {
    const phase = t * 2.2 + i * 1.1;
    const bounce = Math.abs(Math.sin(phase));
    const x = w * (0.28 + i * 0.22);
    const y = h * 0.72 - bounce * h * 0.34;
    const squash = 1 - Math.max(0, 0.25 - bounce) * 1.2;
    ctx.fillStyle = tints[i];
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(2 - squash, squash);
    shape(ctx, i, 0, 0, h * 0.11, Math.sin(phase) * 0.3);
    ctx.restore();
  }
  ctx.fillStyle = palette().ink(0.08);
  ctx.fillRect(w * 0.15, h * 0.84, w * 0.7, 3);
};

export const portfolioTile: Painter = (ctx, w, h, t, color) => {
  for (let i = 2; i >= 0; i--) {
    const f = Math.sin(t * 1.4 + i * 0.9);
    ctx.save();
    ctx.translate(w / 2 + (i - 1) * w * 0.12, h / 2 + f * h * 0.03 + (i - 1) * h * 0.04);
    ctx.rotate((i - 1) * 0.12 + f * 0.03);
    ctx.fillStyle = palette().card;
    ctx.shadowColor = palette().ink(0.18);
    ctx.shadowBlur = 10;
    rr(ctx, -w * 0.22, -h * 0.26, w * 0.44, h * 0.52, 10);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = i === 0 ? color : palette().ink(0.12);
    rr(ctx, -w * 0.18, -h * 0.21, w * 0.36, h * 0.22, 6);
    ctx.fill();
    ctx.fillStyle = palette().ink(0.12);
    rr(ctx, -w * 0.18, h * 0.05, w * 0.28, h * 0.05, 3);
    ctx.fill();
    ctx.restore();
  }
};

export const settingsTile: Painter = (ctx, w, h, t, color) => {
  for (let i = 0; i < 3; i++) {
    const y = h * (0.3 + i * 0.2);
    const v = 0.5 + Math.sin(t * 1.3 + i * 1.7) * 0.35;
    ctx.fillStyle = palette().ink(0.1);
    rr(ctx, w * 0.2, y - 3, w * 0.6, 6, 3);
    ctx.fill();
    ctx.fillStyle = color;
    rr(ctx, w * 0.2, y - 3, w * 0.6 * v, 6, 3);
    ctx.fill();
    ctx.fillStyle = palette().card;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(w * 0.2 + w * 0.6 * v, y, h * 0.06, 0, TAU);
    ctx.fill();
    ctx.stroke();
  }
};
