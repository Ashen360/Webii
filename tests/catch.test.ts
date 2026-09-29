import { describe, expect, it } from 'vitest';
import { BASKET_Y, CATCH_GAME, CatchGame, DURATION, MAX_JUMP, basketWidth } from '../src/games/catch/catch';
import { GameRunner } from '../src/games/runner';
import type { GameCue } from '../src/games/types';
import { HandController, type Hand } from '../src/input/Hand';
import { ScriptDriver } from '../src/input/ScriptDriver';
import { seededRandom } from '../src/lib/math';

const W = 1280;
const H = 720;
const DT = 1 / 60;

function stillHand(x: number): Hand {
  return {
    source: 'script', state: 'tracking', present: true, position: { x, y: H * 0.8 }, velocity: { x: 0, y: 0 },
    direction: { x: 0, y: 0 }, speed: 0, isPinching: false, pinchStrength: 0, path: [], nearEdge: false, on: () => () => {},
  };
}

function newGame(seed = 1, cues: GameCue[] = [], w = W, h = H) {
  const g = new CatchGame();
  g.start(w, h, { rng: seededRandom(seed), cue: (c) => cues.push(c), attract: false });
  return g;
}

/** Plays a full round with the game's own autopilot driving a scripted hand. */
function autoplay(seed: number, w = W, h = H) {
  const g = newGame(seed, [], w, h);
  let time = 0;
  const hand = new HandController(() => ({ w, h }));
  hand.setDriver(new ScriptDriver(() => g.autopilot()));
  for (let t = 0; t < DURATION; t += DT) {
    time += DT;
    hand.update(time * 1000);
    g.update(DT, hand, time);
  }
  return g;
}

describe('Catch', () => {
  it('a drop that lands in the basket is caught; one that misses it is missed', () => {
    const cues: GameCue[] = [];
    const g = newGame(3, cues);
    let t = 0;
    // Hand under the first drop.
    while (!g.drops.length) g.update(DT, stillHand(W / 2), (t += DT));
    const first = g.drops[0];
    while (first.doneAt === null) g.update(DT, stillHand(first.x), (t += DT));
    expect(first.caught).toBe(true);
    expect(g.caught).toBe(1);
    expect(cues).toEqual(['score']);

    // Now park the hand far away from the next drop.
    while (g.drops.filter((d) => d.doneAt === null).length === 0) g.update(DT, stillHand(first.x), (t += DT));
    const next = g.drops.find((d) => d.doneAt === null)!;
    const away = next.x < W / 2 ? W - 1 : 1;
    while (next.doneAt === null) g.update(DT, stillHand(away), (t += DT));
    expect(next.caught).toBe(false);
    expect(g.missed).toBeGreaterThanOrEqual(1);
    expect(g.streak).toBe(0);
    expect(cues).toContain('miss');
  });

  it('the edge of the basket is generous, beyond it is not', () => {
    const g = newGame(5);
    let t = 0;
    while (!g.drops.length) g.update(DT, stillHand(W / 2), (t += DT));
    const d = g.drops[0];
    const half = basketWidth(W, H) / 2;
    // Hold the basket so the drop is just inside the lip.
    const inside = d.x - (half + d.r * 0.4);
    while (d.doneAt === null) g.update(DT, stillHand(inside), (t += DT));
    expect(d.caught).toBe(true);

    const g2 = newGame(5);
    t = 0;
    while (!g2.drops.length) g2.update(DT, stillHand(W / 2), (t += DT));
    const d2 = g2.drops[0];
    const outside = d2.x - (half + d2.r * 1.2);
    while (d2.doneAt === null) g2.update(DT, stillHand(outside), (t += DT));
    expect(d2.caught).toBe(false);
  });

  it('a good player (the autopilot through a scripted hand) catches nearly everything, at any field size', () => {
    for (const [w, h] of [[1280, 720], [1920, 935], [320, 200], [390, 780]] as const) {
      for (const seed of [1, 2, 3]) {
        const g = autoplay(seed, w, h);
        const total = g.caught + g.missed;
        expect(total).toBeGreaterThan(40);
        expect(g.caught / total, `${w}×${h} seed ${seed}`).toBeGreaterThanOrEqual(0.95);
      }
    }
  });

  it('a hand held still in the middle catches only a small share', () => {
    const g = newGame(7);
    let t = 0;
    for (; t < DURATION; t += DT) g.update(DT, stillHand(W / 2), t + DT);
    expect(g.caught / (g.caught + g.missed)).toBeLessThan(0.45);
  });

  /** Every drop the round spawns, in order, with the play time it appeared. */
  function spawned(seed: number) {
    const g = newGame(seed);
    const seen = new Set<object>();
    const out: { t: number; x: number; vy: number }[] = [];
    const hand = stillHand(W / 2);
    for (let t = DT; t < DURATION; t += DT) {
      g.update(DT, hand, t);
      for (const d of g.drops) {
        if (seen.has(d)) continue;
        seen.add(d);
        out.push({ t, x: d.x, vy: d.vy });
      }
    }
    return out;
  }

  it('gets harder over the round: faster and more frequent drops', () => {
    const spawns = spawned(11);
    expect(spawns.length).toBeGreaterThan(40);
    const early = spawns.filter((s) => s.t < 10);
    const late = spawns.filter((s) => s.t > DURATION - 10);
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(late.length).toBeGreaterThan(early.length * 1.5);
    expect(avg(late.map((s) => s.vy))).toBeGreaterThan(avg(early.map((s) => s.vy)) * 1.4);
  });

  it('consecutive drops stay within reach of each other', () => {
    for (const seed of [13, 14, 15]) {
      const xs = spawned(seed).map((s) => s.x);
      for (let i = 1; i < xs.length; i++) expect(Math.abs(xs[i] - xs[i - 1])).toBeLessThanOrEqual(W * MAX_JUMP);
    }
  });

  it('the same seed gives the same round', () => {
    const a = autoplay(21);
    const b = autoplay(21);
    expect(a.result()).toEqual(b.result());
  });

  it('resizing mid-round keeps drops where they were, proportionally', () => {
    const g = newGame(2);
    let t = 0;
    while (g.drops.length < 2) g.update(DT, stillHand(W / 2), (t += DT));
    const before = g.drops.map((d) => [d.x / W, d.y / H]);
    g.resize(W / 2, H / 2);
    g.drops.forEach((d, i) => {
      expect(d.x / (W / 2)).toBeCloseTo(before[i][0], 5);
      expect(d.y / (H / 2)).toBeCloseTo(before[i][1], 5);
    });
  });

  it('runs a full round through the framework: 40 s, then a result', () => {
    const r = new GameRunner(CATCH_GAME, () => ({ w: W, h: H }), { cue: () => {}, attract: false, seed: 4 });
    const hand = stillHand(W / 2);
    for (let t = 0; t < 50 && r.phase !== 'result'; t += DT) r.update(DT, hand);
    expect(r.phase).toBe('result');
    expect(r.time).toBeCloseTo(DURATION, 1);
    expect(r.result!.label).toBe('caught');
    expect(r.result!.detail).toMatch(/missed · best streak \d+/);
  });

  it('the basket sits at the rim line and follows the hand before play starts', () => {
    const g = newGame(1);
    g.draw(fakeCtx(), W, H, { card: '#fff', ink: () => '#000', accent: '#00f', chrome: '#fff' }, stillHand(200));
    expect(g.bx).toBe(200);
    expect(g.autopilot()).toEqual({ x: 200, y: H * BASKET_Y });
    // …and never leaves the screen.
    g.draw(fakeCtx(), W, H, { card: '#fff', ink: () => '#000', accent: '#00f', chrome: '#fff' }, stillHand(0));
    expect(g.bx).toBe(basketWidth(W, H) / 2);
  });
});

function fakeCtx() {
  return new Proxy({} as CanvasRenderingContext2D, { get: () => () => {}, set: () => true });
}
