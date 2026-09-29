import { describe, expect, it } from 'vitest';
import { GameRunner } from '../src/games/runner';
import { DURATION, SLICE_GAME, SLICE_SPEED, SliceGame, segmentDistance, type Target } from '../src/games/slice/slice';
import type { GameCue } from '../src/games/types';
import { HandController, type Hand } from '../src/input/Hand';
import { ScriptDriver } from '../src/input/ScriptDriver';
import { seededRandom } from '../src/lib/math';

const W = 1280;
const H = 720;
const DT = 1 / 60;

/** A hand we move by hand: position plus the speed the Hand contract would report. */
function manualHand(): Hand & { position: { x: number; y: number }; speed: number; velocity: { x: number; y: number } } {
  return {
    source: 'script', state: 'tracking', present: true, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 },
    direction: { x: 0, y: 0 }, speed: 0, isPinching: false, pinchStrength: 0, path: [], nearEdge: false, on: () => () => {},
  };
}

function newGame(seed = 1, cues: GameCue[] = []) {
  const g = new SliceGame();
  g.start(W, H, { rng: seededRandom(seed), cue: (c) => cues.push(c), attract: false });
  return g;
}

/** A still target placed by the test (gravity would move it; we put it back each frame). */
function place(g: SliceGame, x: number, y: number): Target {
  const t: Target = { x, y, vx: 0, vy: 0, r: 40, kind: 0, tint: '#f00', rot: 0, vr: 0, wobble: 0, cut: false, missed: false };
  g.targets.push(t);
  return t;
}

/** Moves the hand from a to b over `frames` frames at the implied speed, pinning targets in place. */
function swipe(g: SliceGame, hand: ReturnType<typeof manualHand>, a: [number, number], b: [number, number], frames: number, time = { t: 0 }) {
  const pins = g.targets.map((o) => [o, o.x, o.y] as const);
  const speed = Math.hypot(b[0] - a[0], b[1] - a[1]) / (frames * DT);
  for (let i = 0; i <= frames; i++) {
    const k = i / frames;
    hand.position = { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k };
    hand.speed = i === 0 ? 0 : speed;
    hand.velocity = { x: ((b[0] - a[0]) / (frames * DT)) * (i ? 1 : 0), y: ((b[1] - a[1]) / (frames * DT)) * (i ? 1 : 0) };
    for (const [o, x, y] of pins) Object.assign(o, { x, y, vx: 0, vy: 0 });
    g.update(DT, hand, (time.t += DT));
  }
}

describe('segmentDistance', () => {
  it('measures to the nearest point of the segment, including its ends', () => {
    expect(segmentDistance(0, 0, 10, 0, 5, 3)).toBeCloseTo(3);
    expect(segmentDistance(0, 0, 10, 0, 13, 4)).toBeCloseTo(5); // past the end
    expect(segmentDistance(0, 0, 10, 0, -3, 0)).toBeCloseTo(3); // before the start
    expect(segmentDistance(2, 2, 2, 2, 5, 6)).toBeCloseTo(5); // a point
  });
});

describe('Slice', () => {
  it('a fast swipe through a shape cuts it into two halves that fly apart across the swipe', () => {
    const cues: GameCue[] = [];
    const g = newGame(1, cues);
    const hand = manualHand();
    const o = place(g, 640, 300);
    // 400 px in 10 frames = 2400 px/s ≫ SLICE_SPEED.
    swipe(g, hand, [440, 300], [840, 300], 10);
    expect(o.cut).toBe(true);
    expect(g.sliced).toBe(1);
    expect(cues).toContain('swish');
    const [a, b] = g.pieces;
    expect(a.side).toBe(-b.side);
    // Horizontal cut → the halves separate vertically, and both carry the swipe to the right.
    expect(Math.sign(a.vy - b.vy)).toBe(a.side > b.side ? 1 : -1);
    expect(Math.abs(a.vy - b.vy)).toBeGreaterThan(H * 0.5);
    expect(a.angle).toBeCloseTo(0);
  });

  it('the cut follows the swipe direction', () => {
    const g = newGame(1);
    const hand = manualHand();
    place(g, 640, 360);
    swipe(g, hand, [540, 260], [740, 460], 6); // diagonal, down-right
    expect(g.pieces[0].angle).toBeCloseTo(Math.PI / 4, 1);
  });

  it('a slow pass only bumps the shape and says "Faster!"', () => {
    const g = newGame(1);
    const hand = manualHand();
    const o = place(g, 640, 300);
    // 400 px in 60 frames = 400 px/s < SLICE_SPEED × 720.
    expect(400).toBeLessThan(SLICE_SPEED * H);
    swipe(g, hand, [440, 300], [840, 300], 60);
    expect(o.cut).toBe(false);
    expect(g.sliced).toBe(0);
  });

  it('a fast swipe that passes beside the shape doesn’t cut it', () => {
    const g = newGame(1);
    const hand = manualHand();
    const o = place(g, 640, 300);
    swipe(g, hand, [440, 300 + 40 * 1.3], [840, 300 + 40 * 1.3], 10);
    expect(o.cut).toBe(false);
  });

  it('a very fast swipe still cuts even when a frame jumps right over the shape', () => {
    const g = newGame(1);
    const hand = manualHand();
    const o = place(g, 640, 300);
    swipe(g, hand, [300, 300], [980, 300], 1); // one frame, 680 px: the blade is the segment
    expect(o.cut).toBe(true);
  });

  it('several shapes in one stroke make a combo with bonus points', () => {
    const cues: GameCue[] = [];
    const g = newGame(1, cues);
    const hand = manualHand();
    const time = { t: 0 };
    place(g, 400, 300);
    place(g, 640, 300);
    place(g, 880, 300);
    swipe(g, hand, [250, 300], [1030, 300], 12, time);
    expect(g.sliced).toBe(3);
    // The stroke ends when the hand slows down.
    hand.speed = 0;
    g.update(DT, hand, (time.t += DT));
    expect(g.bonus).toBe(2);
    expect(g.bestCombo).toBe(3);
    expect(g.result().score).toBe(5);
    expect(g.result().detail).toContain('best combo ×3');
    expect(cues).toContain('score');
  });

  it('shapes that fall back down uncut are missed', () => {
    const cues: GameCue[] = [];
    const g = newGame(2, cues);
    const hand = manualHand();
    hand.position = { x: 5, y: 5 }; // far corner, still
    for (let t = DT; t < 12; t += DT) g.update(DT, hand, t);
    expect(g.missed).toBeGreaterThan(3);
    expect(g.sliced).toBe(0);
    expect(cues.filter((c) => c === 'miss').length).toBe(g.missed);
  });

  it('launches stay on screen and rise well into the field', () => {
    const g = newGame(4);
    const hand = manualHand();
    hand.position = { x: 5, y: 5 };
    const seen = new Map<Target, number>();
    for (let t = DT; t < DURATION; t += DT) {
      g.update(DT, hand, t);
      for (const o of g.targets) seen.set(o, Math.min(seen.get(o) ?? Infinity, o.y));
      for (const o of g.targets) expect(o.x).toBeGreaterThan(-o.r);
      for (const o of g.targets) expect(o.x).toBeLessThan(W + o.r);
    }
    expect(seen.size).toBeGreaterThan(40);
    for (const top of seen.values()) {
      // Apex 18–48% down; later shapes in a wave start a little lower (staggered).
      expect(top).toBeLessThan(H * 0.65);
      expect(top).toBeGreaterThan(0);
    }
  });

  it('a good player (autopilot through a scripted hand) slices nearly everything; a slow hand slices nothing', () => {
    for (const [w, h] of [[1280, 720], [1920, 935], [320, 200], [390, 780]] as const) {
      const g = new SliceGame();
      g.start(w, h, { rng: seededRandom(1), cue: () => {}, attract: true });
      const hand = new HandController(() => ({ w, h }));
      let time = 0;
      hand.setDriver(new ScriptDriver(() => g.autopilot(time)));
      for (let t = 0; t < DURATION; t += DT) {
        time += DT;
        hand.update(time * 1000);
        g.update(DT, hand, time);
      }
      expect(g.sliced / (g.sliced + g.missed), `${w}×${h}`).toBeGreaterThanOrEqual(0.9);
    }
    const g = new SliceGame();
    g.start(W, H, { rng: seededRandom(3), cue: () => {}, attract: false });
    const hand = new HandController(() => ({ w: W, h: H }));
    let time = 0;
    hand.setDriver(new ScriptDriver(() => ({ x: 640 + Math.sin(time * 0.5) * 500, y: 360 + Math.sin(time * 0.9) * 200 })));
    for (let t = 0; t < DURATION; t += DT) {
      time += DT;
      hand.update(time * 1000);
      g.update(DT, hand, time);
    }
    expect(g.sliced).toBe(0);
  });

  it('gets busier over the round', () => {
    const g = newGame(9);
    const hand = manualHand();
    hand.position = { x: 5, y: 5 };
    const seen = new Set<Target>();
    const launches: number[] = [];
    for (let t = DT; t < DURATION; t += DT) {
      g.update(DT, hand, t);
      for (const o of g.targets) if (!seen.has(o)) seen.add(o), launches.push(t);
    }
    const early = launches.filter((t) => t < 15).length;
    const late = launches.filter((t) => t > DURATION - 15).length;
    expect(late).toBeGreaterThan(early * 1.5);
  });

  it('the same seed gives the same round', () => {
    const run = () => {
      const g = newGame(21);
      const hand = manualHand();
      for (let t = DT; t < 20; t += DT) {
        hand.position = { x: 640 + Math.sin(t * 7) * 500, y: 300 };
        hand.speed = 3000;
        g.update(DT, hand, t);
      }
      return g.result();
    };
    expect(run()).toEqual(run());
  });

  it('runs a full 45 s round through the framework', () => {
    const r = new GameRunner(SLICE_GAME, () => ({ w: W, h: H }), { cue: () => {}, attract: false, seed: 4 });
    const hand = manualHand();
    hand.position = { x: 5, y: 5 };
    for (let t = 0; t < 60 && r.phase !== 'result'; t += DT) r.update(DT, hand);
    expect(r.phase).toBe('result');
    expect(r.time).toBeCloseTo(DURATION, 1);
    expect(r.result!.label).toBe('points');
  });
});
