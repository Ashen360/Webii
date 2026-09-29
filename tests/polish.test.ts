// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attractPainter, STILL_AT } from '../src/games/attract';
import { CATCH_GAME, CatchGame } from '../src/games/catch/catch';
import { GameScene } from '../src/games/GameScene';
import { BEAT, INTRO_HOLD, INTRO_MIN } from '../src/games/runner';
import type { Game, GameSpec } from '../src/games/types';
import type { Hand } from '../src/input/Hand';
import { Loop } from '../src/lib/loop';
import { ByteProgress } from '../src/tracking/HandTracker';

const fakeCtx = () =>
  new Proxy({} as CanvasRenderingContext2D, {
    get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}),
    set: () => true,
  });

const hand = (): Hand => ({
  source: 'script', state: 'tracking', present: true, position: { x: 100, y: 100 }, velocity: { x: 0, y: 0 },
  direction: { x: 0, y: 0 }, speed: 0, isPinching: false, pinchStrength: 0, path: [], nearEdge: false, on: () => () => {},
});

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('loading progress', () => {
  it('weights parallel downloads by bytes, ignoring files whose size is still unknown', () => {
    const seen: number[] = [];
    const p = new ByteProgress((f) => seen.push(f));
    p.update('wasm', 0, 0); // size not known yet
    expect(seen.at(-1)).toBe(0);
    p.update('wasm', 0, 11_000);
    p.update('model', 0, 7_500);
    p.update('wasm', 5_500, 11_000);
    expect(seen.at(-1)).toBeCloseTo(5_500 / 18_500);
    p.update('model', 7_500, 7_500);
    p.update('wasm', 11_000, 11_000);
    expect(seen.at(-1)).toBe(1);
    // Never above 1, even if a server sends more than it announced.
    p.update('model', 9_000, 7_500);
    expect(seen.at(-1)).toBe(1);
  });
});

describe('robustness', () => {
  it('a throwing system is reported once and never stops the others', () => {
    const loop = new Loop();
    const good = vi.fn();
    loop.add(() => {
      throw new Error('boom');
    });
    loop.add(good);
    loop.step(0);
    loop.step(16);
    loop.step(32);
    expect(good).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('a game that crashes shows an error card with a way out, and Escape exits', () => {
    const broken: GameSpec = {
      ...CATCH_GAME,
      id: 'broken',
      create: () => {
        const g = new CatchGame();
        g.update = () => {
          throw new Error('bug');
        };
        return g;
      },
    };
    const onExit = vi.fn();
    const play = vi.fn();
    const scene = new GameScene(broken, { hand: hand(), play, onExit, seed: 1 });
    document.body.append(scene.el);
    for (let t = 0; t < Math.max(INTRO_HOLD, INTRO_MIN) + BEAT * 3 + 0.2; t += 1 / 60) scene.update(1 / 60);
    expect(scene.failed).toBe(true);
    expect(scene.el.dataset.phase).toBe('error');
    expect(play).toHaveBeenLastCalledWith('error');
    expect(scene.onBack()).toBe(false); // Escape leaves instead of "pausing" a dead game
    scene.update(1 / 60); // stays stopped
    scene.el.querySelector<HTMLElement>('.game-error .game-exit')!.click();
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('a game that crashes in attract mode blanks its own tile only', () => {
    const create = vi.fn(() => {
      const g = new CatchGame();
      g.draw = () => {
        throw new Error('bug');
      };
      return g as Game;
    });
    const paint = attractPainter({ ...CATCH_GAME, create }, 1, { still: false });
    expect(() => paint(fakeCtx(), 300, 200, 0, '#000')).not.toThrow();
    expect(() => paint(fakeCtx(), 300, 200, 0.1, '#000')).not.toThrow();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe('reduced motion', () => {
  it('attract mode shows one representative frame, frozen', () => {
    let game: CatchGame | null = null;
    const paint = attractPainter({ ...CATCH_GAME, create: () => (game = new CatchGame()) }, 1, { still: true });
    paint(fakeCtx(), 320, 200, 0, '#000');
    const snapshot = JSON.stringify(game!.drops.map((d) => [d.x, d.y]));
    expect(game!.drops.length).toBeGreaterThan(0); // something is on screen
    for (let t = 0; t < 5; t += 1 / 60) paint(fakeCtx(), 320, 200, t, '#000');
    expect(JSON.stringify(game!.drops.map((d) => [d.x, d.y]))).toBe(snapshot);
    expect(STILL_AT).toBeGreaterThan(2);
  });
});

describe('new best celebration', () => {
  function finishRound(scene: GameScene) {
    for (let t = 0; t < 60 && scene.runner.phase !== 'result'; t += 1 / 60) scene.update(1 / 60);
  }
  const spec = (score: number): GameSpec => ({
    id: 'fixed',
    title: 'Fixed',
    instruction: '',
    color: '#123456',
    duration: 1,
    create: () =>
      ({
        over: false,
        start() {},
        update() {},
        draw() {},
        result: () => ({ score, display: String(score), label: 'pts' }),
        autopilot: () => null,
      }) as Game,
  });

  beforeEach(() => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof matchMedia;
  });

  it('confetti for a beaten best, not for the first score, not for a lower one', () => {
    const run = (score: number) => {
      const s = new GameScene(spec(score), { hand: hand(), play: () => {}, onExit: () => {}, seed: 1 });
      document.body.append(s.el);
      finishRound(s);
      return s.el.querySelectorAll('.game-confetti i').length;
    };
    expect(run(5)).toBe(0); // first score
    expect(run(9)).toBeGreaterThan(10); // new best
    expect(run(3)).toBe(0); // not a best
  });

  it('no confetti with reduced motion', () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q })) as unknown as typeof matchMedia;
    const a = new GameScene(spec(5), { hand: hand(), play: () => {}, onExit: () => {}, seed: 1 });
    finishRound(a);
    const b = new GameScene(spec(9), { hand: hand(), play: () => {}, onExit: () => {}, seed: 1 });
    finishRound(b);
    expect(b.el.querySelector('.game-confetti')).toBeNull();
  });
});
