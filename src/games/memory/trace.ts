import type { Vec2 } from '../../lib/math';

/**
 * Memory Trace geometry and scoring, pure (no canvas, no hand): shapes, resampling,
 * and the accuracy score specified in PROJECT.md §6.
 *
 * Score: resample the target outline and the player's path to evenly spaced points.
 * Each point's closeness (0..1) to the OTHER curve uses a soft Gaussian falloff scaled
 * to the shape size. Coverage = mean closeness of the target's points ("did you draw
 * all of it?"), precision = mean closeness of the path's points ("did you draw only
 * it?"), accuracy = their F1. No translation or scale alignment: remembering WHERE the
 * shape was is part of the memory test.
 */

export interface Shape {
  name: string;
  /** Outline in unit coordinates (centre 0,0, radius ≈ 1). */
  points: Vec2[];
  closed: boolean;
}

export interface Score {
  coverage: number;
  precision: number;
  accuracy: number;
  /** Closeness of each resampled target point (for the reveal's "missed" glow). */
  targetCloseness: number[];
  /** Closeness of each resampled path point (for colouring the replay). */
  pathCloseness: number[];
  target: Vec2[];
  path: Vec2[];
}

/** Gaussian falloff width, as a fraction of the shape's radius. */
export const SIGMA = 0.2;

const TAU = Math.PI * 2;
const polygon = (n: number, rot = -Math.PI / 2) => Array.from({ length: n }, (_, i) => ({ x: Math.cos(rot + (i / n) * TAU), y: Math.sin(rot + (i / n) * TAU) }));

export const SHAPES = {
  circle: (): Shape => ({ name: 'Circle', points: polygon(48), closed: true }),
  triangle: (): Shape => ({ name: 'Triangle', points: polygon(3), closed: true }),
  square: (): Shape => ({ name: 'Square', points: polygon(4, -Math.PI / 4), closed: true }),
  diamond: (): Shape => ({ name: 'Diamond', points: polygon(4).map((p) => ({ x: p.x * 0.75, y: p.y })), closed: true }),
  pentagon: (): Shape => ({ name: 'Pentagon', points: polygon(5), closed: true }),
  hexagon: (): Shape => ({ name: 'Hexagon', points: polygon(6, 0), closed: true }),
  star: (): Shape => ({
    name: 'Star',
    points: Array.from({ length: 10 }, (_, i) => {
      const a = -Math.PI / 2 + (i / 10) * TAU;
      const k = i % 2 ? 0.45 : 1;
      return { x: Math.cos(a) * k, y: Math.sin(a) * k };
    }),
    closed: true,
  }),
};

/**
 * The shape for a given round (1-based): simple first, then harder, then abstract.
 * Round 1: circle / square / triangle / diamond · 2–3: star / pentagon / hexagon ·
 * 4+: a random abstract polygon (5–7 corners, never self-intersecting).
 */
export function shapeForRound(round: number, rng: () => number): Shape {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length) % xs.length];
  if (round <= 1) return pick([SHAPES.circle, SHAPES.square, SHAPES.triangle, SHAPES.diamond])();
  if (round <= 3) return pick([SHAPES.star, SHAPES.pentagon, SHAPES.hexagon])();
  return abstractShape(rng);
}

export function abstractShape(rng: () => number): Shape {
  const n = 5 + Math.floor(rng() * 3);
  // Corners at sorted angles around the centre can't cross each other.
  const angles = Array.from({ length: n }, (_, i) => (i + 0.25 + rng() * 0.5) * (TAU / n)).sort((a, b) => a - b);
  const points = angles.map((a) => {
    const r = 0.45 + rng() * 0.55;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  return { name: 'Mystery shape', points, closed: true };
}

export function length(points: readonly Vec2[], closed: boolean): number {
  let total = 0;
  const n = points.length;
  for (let i = 1; i < n + (closed ? 1 : 0); i++) {
    const a = points[i - 1];
    const b = points[i % n];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** Evenly spaced points along a polyline, `step` apart (the last point is kept). */
export function resample(points: readonly Vec2[], step: number, closed = false): Vec2[] {
  if (points.length === 0) return [];
  if (points.length === 1 || step <= 0) return [{ ...points[0] }];
  const src = closed ? [...points, points[0]] : points;
  const out: Vec2[] = [{ ...src[0] }];
  let carry = 0; // distance travelled since the last emitted point
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1];
    const b = src[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg === 0) continue;
    let d = step - carry;
    while (d <= seg) {
      const k = d / seg;
      out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
      d += step;
    }
    carry = seg - (d - step);
  }
  const last = src[src.length - 1];
  const end = out[out.length - 1];
  if (!closed && Math.hypot(last.x - end.x, last.y - end.y) > step * 0.25) out.push({ ...last });
  return out;
}

/** Shortest distance from p to a polyline (segments between consecutive points). */
export function distanceToPolyline(p: Vec2, line: readonly Vec2[], closed = false): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return Math.hypot(p.x - line[0].x, p.y - line[0].y);
  let best = Infinity;
  const n = line.length;
  for (let i = 1; i < n + (closed ? 1 : 0); i++) {
    const a = line[i - 1];
    const b = line[i % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
    if (d < best) best = d;
  }
  return best;
}

/**
 * @param target the shape outline in field px
 * @param path the player's recorded hand path in field px
 * @param radius the shape's radius in px (sets the falloff)
 */
export function scoreTrace(target: readonly Vec2[], closed: boolean, path: readonly Vec2[], radius: number): Score {
  const step = Math.max(1, (length(target, closed) || 1) / 200);
  const t = resample(target, step, closed);
  const p = resample(path, step);
  const sigma = SIGMA * radius;
  const close = (d: number) => Math.exp(-((d / sigma) ** 2));
  const targetCloseness = t.map((q) => (p.length ? close(distanceToPolyline(q, p)) : 0));
  const pathCloseness = p.map((q) => close(distanceToPolyline(q, target, closed)));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const coverage = mean(targetCloseness);
  // A path that never moved (a single point) has shown nothing: no precision credit.
  const precision = p.length > 1 ? mean(pathCloseness) : 0;
  const accuracy = coverage + precision > 0 ? (2 * coverage * precision) / (coverage + precision) : 0;
  return { coverage, precision, accuracy, targetCloseness, pathCloseness, target: t, path: p };
}
