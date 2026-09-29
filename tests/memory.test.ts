import { describe, expect, it } from 'vitest';
import { DRAW, MEMORIZE, MEMORY_GAME, MemoryGame, REVEAL, closenessColor } from '../src/games/memory/memory';
import { SHAPES, abstractShape, distanceToPolyline, length, resample, scoreTrace, shapeForRound } from '../src/games/memory/trace';
import { GameRunner } from '../src/games/runner';
import type { GameCue } from '../src/games/types';
import { HandController, type Hand } from '../src/input/Hand';
import { ScriptDriver } from '../src/input/ScriptDriver';
import { seededRandom, type Vec2 } from '../src/lib/math';

const R = 200;
const px = (pts: Vec2[], dx = 0, dy = 0, k = 1) => pts.map((p) => ({ x: 640 + dx + p.x * R * k, y: 380 + dy + p.y * R * k }));
const closedLoop = (pts: Vec2[]) => [...pts, pts[0]];
const DT = 1 / 60;

describe('trace geometry', () => {
  it('resamples evenly, keeping the ends', () => {
    const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }];
    const r = resample(line, 10);
    expect(r[0]).toEqual({ x: 0, y: 0 });
    expect(r.at(-1)).toEqual({ x: 100, y: 50 });
    expect(r.length).toBe(16);
    for (let i = 1; i < r.length; i++) expect(Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y)).toBeLessThanOrEqual(10.0001);
    // A closed square of side 100 at step 10 → 40 points around, back to the start.
    const sq = resample([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], 10, true);
    expect(sq.length).toBe(41);
    expect(length([{ x: 0, y: 0 }, { x: 3, y: 4 }], false)).toBe(5);
    expect(length([{ x: 0, y: 0 }, { x: 3, y: 4 }], true)).toBe(10);
  });

  it('measures distance to a polyline, closed or not', () => {
    const l = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    expect(distanceToPolyline({ x: 50, y: 10 }, l)).toBeCloseTo(10);
    expect(distanceToPolyline({ x: 40, y: 60 }, l)).toBeCloseTo(Math.min(60, Math.hypot(60, 60) / Math.SQRT2 * 1)); // open: nearest is y=0 or x=100
    expect(distanceToPolyline({ x: 40, y: 60 }, l, true)).toBeCloseTo(Math.abs(40 - 60) / Math.SQRT2); // the closing diagonal
  });

  it('abstract shapes are simple polygons (corners in angular order around the centre)', () => {
    for (let s = 1; s < 30; s++) {
      const shape = abstractShape(seededRandom(s));
      expect(shape.points.length).toBeGreaterThanOrEqual(5);
      expect(shape.points.length).toBeLessThanOrEqual(7);
      const angles = shape.points.map((p) => Math.atan2(p.y, p.x) + (Math.atan2(p.y, p.x) < 0 ? 2 * Math.PI : 0));
      const sorted = [...angles].sort((a, b) => a - b);
      // Rotating order is preserved (a cyclic shift of the sorted list).
      const k = sorted.indexOf(angles[0]);
      expect(angles).toEqual([...sorted.slice(k), ...sorted.slice(0, k)]);
      for (const p of shape.points) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(1.0001);
    }
  });

  it('rounds get harder: simple, then star/polygons, then abstract', () => {
    const rng = seededRandom(1);
    const names = (round: number) => new Set(Array.from({ length: 40 }, () => shapeForRound(round, rng).name));
    expect([...names(1)].sort()).toEqual(['Circle', 'Diamond', 'Square', 'Triangle']);
    expect([...names(2)].sort()).toEqual(['Hexagon', 'Pentagon', 'Star']);
    expect([...names(5)]).toEqual(['Mystery shape']);
  });
});

describe('trace scoring (F1 of coverage and precision)', () => {
  const sq = SHAPES.square();
  const target = px(sq.points);
  const score = (path: Vec2[]) => scoreTrace(target, true, path, R);

  it('a perfect trace scores 100%', () => {
    expect(score(resample(closedLoop(target), 5)).accuracy).toBeCloseTo(1, 3);
  });

  it('falls off smoothly with distance (no alignment: position is part of the test)', () => {
    const a = score(px(closedLoop(sq.points), 0.1 * R)).accuracy;
    const b = score(px(closedLoop(sq.points), 0.25 * R)).accuracy;
    // Diagonal shifts (a sideways shift keeps a square's top and bottom edges on their lines).
    const c = score(px(closedLoop(sq.points), 0.4 * R, 0.4 * R)).accuracy;
    const d = score(px(closedLoop(sq.points), 2 * R, 2 * R)).accuracy;
    expect(a).toBeGreaterThan(0.85);
    expect(b).toBeGreaterThan(0.5);
    expect(b).toBeLessThan(0.7);
    expect(c).toBeLessThan(b);
    expect(d).toBeLessThan(0.02);
  });

  it('half the shape: full precision, half coverage', () => {
    const loop = resample(closedLoop(target), 5);
    const s = score(loop.slice(0, loop.length / 2));
    expect(s.precision).toBeGreaterThan(0.95);
    expect(s.coverage).toBeGreaterThan(0.45);
    expect(s.coverage).toBeLessThan(0.65);
  });

  it('the whole shape plus wandering off: full coverage, lower precision', () => {
    const s = score([...resample(closedLoop(target), 5), ...px([{ x: 1, y: 1 }, { x: 2, y: 1.5 }, { x: 2.5, y: -1 }])]);
    expect(s.coverage).toBeGreaterThan(0.95);
    expect(s.precision).toBeLessThan(0.75);
  });

  it('the wrong shape scores well below the right one; a scribble or nothing scores low', () => {
    const star = px(SHAPES.star().points);
    const right = scoreTrace(star, true, resample(closedLoop(star), 5), R).accuracy;
    const circle = scoreTrace(star, true, px(closedLoop(SHAPES.circle().points)), R).accuracy;
    expect(circle).toBeLessThan(right - 0.5);
    const rng = seededRandom(5);
    const scribble = Array.from({ length: 300 }, () => ({ x: 640 + (rng() - 0.5) * 900, y: 380 + (rng() - 0.5) * 600 }));
    expect(score(scribble).accuracy).toBeLessThan(0.5);
    expect(score([]).accuracy).toBe(0);
    expect(score([{ x: 640, y: 380 }]).accuracy).toBe(0); // a hand that never moved
  });

  it('closeness colours run red → amber → green', () => {
    expect(closenessColor(0)).toBe('rgb(240,82,122)');
    expect(closenessColor(0.5)).toBe('rgb(255,179,71)');
    expect(closenessColor(1)).toBe('rgb(47,182,124)');
  });
});

describe('Memory Trace game', () => {
  function still(x: number, y: number): Hand {
    return {
      source: 'script', state: 'tracking', present: true, position: { x, y }, velocity: { x: 0, y: 0 },
      direction: { x: 0, y: 0 }, speed: 0, isPinching: false, pinchStrength: 0, path: [], nearEdge: false, on: () => () => {},
    };
  }

  it('memorize 5 s → draw 10 s (recording) → reveal → over, with cues and the stage timer', () => {
    const cues: GameCue[] = [];
    const g = new MemoryGame();
    g.start(1280, 720, { rng: seededRandom(1), cue: (c) => cues.push(c), attract: false });
    expect(g.timer()).toBeNull(); // nothing shown before play starts
    let t = 0;
    const hand = still(100, 100);
    const step = (s: number, h: Hand = hand) => {
      for (let i = 0; i < Math.round(s / DT); i++) g.update(DT, h, (t += DT));
    };
    step(1);
    expect(g.stage).toBe('memorize');
    expect(g.hud()).toBe('Memorize');
    expect(g.timer()!.total).toBe(MEMORIZE);
    step(MEMORIZE - 1 + 0.05);
    expect(g.stage).toBe('draw');
    expect(g.hud()).toBe('Draw it!');
    expect(g.timer()!.total).toBe(DRAW);
    expect(cues.filter((c) => c === 'tick').length).toBe(3);
    expect(cues).toContain('go');
    expect(g.path.length).toBeLessThanOrEqual(1); // a still hand adds nothing more

    // Draw a line: every frame's position is recorded.
    for (let i = 0; i < 60; i++) g.update(DT, still(100 + i * 5, 100), (t += DT));
    expect(g.path.length).toBeGreaterThanOrEqual(60);
    step(DRAW - 1);
    expect(g.stage).toBe('reveal');
    expect(g.score).not.toBeNull();
    const frozen = g.path.length;
    step(1, still(900, 600));
    expect(g.path.length).toBe(frozen); // the path froze
    expect(g.over).toBe(false);
    step(REVEAL);
    expect(g.over).toBe(true);
    expect(cues.filter((c) => c === 'tick').length).toBe(6);
    expect(g.result().display).toMatch(/^\d+%$/);
    expect(g.result().label).toBe('accurate');
    expect(g.result().detail).toBe(g.shape.name);
  });

  it('a careful player (autopilot through a scripted hand) scores high on every difficulty, at any size', () => {
    for (const round of [1, 2, 4]) {
      for (const [w, h] of [[1280, 720], [1920, 935], [320, 200]] as const) {
        const g = new MemoryGame();
        const env = { rng: seededRandom(round), cue: () => {}, attract: true };
        for (let r = 0; r < round; r++) g.start(w, h, env);
        const hand = new HandController(() => ({ w, h }));
        let time = 0;
        hand.setDriver(new ScriptDriver(() => g.autopilot(time)));
        while (!g.over && time < 30) {
          time += DT;
          hand.update(time * 1000);
          g.update(DT, hand, time);
        }
        expect(g.over).toBe(true);
        expect(g.result().score, `round ${round} ${w}×${h} ${g.shape.name}`).toBeGreaterThanOrEqual(85);
      }
    }
  });

  it('retries on the same game get harder', () => {
    const g = new MemoryGame();
    const env = { rng: seededRandom(2), cue: () => {}, attract: false };
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      g.start(800, 600, env);
      names.push(g.shape.name);
    }
    expect(['Circle', 'Square', 'Triangle', 'Diamond']).toContain(names[0]);
    expect(['Star', 'Pentagon', 'Hexagon']).toContain(names[1]);
    expect(names[4]).toBe('Mystery shape');
  });

  it('resizing mid-draw keeps the path on the shape proportionally', () => {
    const g = new MemoryGame();
    g.start(1000, 800, { rng: seededRandom(1), cue: () => {}, attract: false });
    let t = MEMORIZE;
    const a = g.autopilot(t + 2)!;
    g.update(DT, still(a.x, a.y), (t += DT));
    g.update(DT, still(a.x + 10, a.y), (t += DT));
    g.resize(500, 400);
    expect(g.path[0].x).toBeCloseTo(a.x / 2);
    expect(g.path[0].y).toBeCloseTo(a.y / 2);
  });

  it('runs through the framework: untimed, ends itself after the reveal, stores a % best', () => {
    const r = new GameRunner(MEMORY_GAME, () => ({ w: 1280, h: 720 }), { cue: () => {}, attract: false, seed: 3 });
    const hand = still(640, 360);
    for (let t = 0; t < 40 && r.phase !== 'result'; t += DT) r.update(DT, hand);
    expect(r.phase).toBe('result');
    expect(r.timeLeft).toBeNull();
    expect(r.time).toBeCloseTo(MEMORIZE + DRAW + REVEAL, 1);
    expect(r.result!.display).toBe('0%'); // a hand that never moved drew nothing
    expect(MEMORY_GAME.format!(87)).toBe('87%');
  });
});
