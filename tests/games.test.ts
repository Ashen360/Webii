// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attractPainter } from '../src/games/attract';
import { DEMO_GAME } from '../src/games/demo';
import { GameScene } from '../src/games/GameScene';
import { BEAT, GameRunner, INTRO_HOLD, INTRO_MIN, RESUME_BEAT } from '../src/games/runner';
import { bestScore, recordScore } from '../src/games/scores';
import type { Game, GameEnv, GameSpec } from '../src/games/types';
import { HandController, type Hand } from '../src/input/Hand';
import { ScriptDriver } from '../src/input/ScriptDriver';

// ─── helpers ────────────────────────────────────────────────────────────────

/** A canvas context that accepts every call (happy-dom has no 2D canvas). */
const fakeCtx = () =>
  new Proxy({} as CanvasRenderingContext2D, {
    get: (_t, k) => (k === 'canvas' ? {} : () => {}),
    set: () => true,
  });

function fakeHand(present = true): Hand & { present: boolean } {
  return {
    source: 'script',
    state: present ? 'tracking' : 'searching',
    present,
    position: { x: 100, y: 100 },
    velocity: { x: 0, y: 0 },
    direction: { x: 0, y: 0 },
    speed: 0,
    isPinching: false,
    pinchStrength: 0,
    path: [],
    nearEdge: false,
    on: () => () => {},
  };
}

/** A probe game: records what the framework calls. */
class Probe implements Game {
  over = false;
  starts: { w: number; h: number; first: number }[] = [];
  updates = 0;
  lastTime = 0;
  start(w: number, h: number, env: GameEnv) {
    this.starts.push({ w, h, first: env.rng() });
    this.updates = 0;
  }
  update(_dt: number, _hand: Hand, time: number) {
    this.updates++;
    this.lastTime = time;
  }
  draw() {}
  result() {
    return { score: this.updates, display: String(this.updates), label: 'frames' };
  }
  autopilot() {
    return { x: 10, y: 10 };
  }
}

const spec = (over: Partial<GameSpec> = {}): GameSpec & { probe: () => Probe } => {
  let last: Probe;
  return { id: 'probe', title: 'Probe', instruction: '', color: '#000', create: () => (last = new Probe()), probe: () => last, ...over };
};

function run(r: GameRunner, hand: Hand, seconds: number, dt = 1 / 60) {
  for (let t = 0; t < seconds - 1e-9; t += dt) r.update(dt, hand);
}

const field = () => ({ w: 800, h: 600 });

/** Intro → countdown → play. */
function toPlay(r: GameRunner, hand: Hand) {
  run(r, hand, Math.max(INTRO_HOLD, INTRO_MIN) + 0.05);
  run(r, hand, BEAT * 3 + 0.05);
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

// ─── runner ─────────────────────────────────────────────────────────────────

describe('GameRunner lifecycle', () => {
  it('starts on the intro and waits for a hand held up', () => {
    const s = spec();
    const r = new GameRunner(s, field, { cue: () => {}, attract: false, seed: 1 });
    expect(r.phase).toBe('intro');
    expect(s.probe().starts[0]).toMatchObject({ w: 800, h: 600 });

    run(r, fakeHand(false), 5);
    expect(r.phase).toBe('intro'); // no hand, no start

    const h = fakeHand(true);
    run(r, h, INTRO_HOLD * 0.6);
    run(r, fakeHand(false), 0.1); // hand dipped out: the hold starts over
    run(r, h, INTRO_HOLD * 0.6);
    expect(r.phase).toBe('intro');
    run(r, h, INTRO_HOLD * 0.5);
    expect(r.phase).toBe('countdown');
  });

  it('counts down 3, 2, 1, go, and only updates the game while playing', () => {
    const s = spec();
    const r = new GameRunner(s, field, { cue: () => {}, attract: false, seed: 1 });
    const beats: number[] = [];
    r.on('beat', (n) => beats.push(n));
    const h = fakeHand();
    run(r, h, Math.max(INTRO_HOLD, INTRO_MIN) + 0.05);
    expect(r.countdown).toBe(3);
    run(r, h, BEAT * 3 - 0.05);
    expect(r.phase).toBe('countdown');
    expect(s.probe().updates).toBe(0);
    run(r, h, 0.1);
    expect(beats).toEqual([3, 2, 1, 0]);
    expect(r.phase).toBe('play');
    run(r, h, 0.5);
    expect(s.probe().updates).toBeGreaterThan(20);
  });

  it('a long frame during the countdown still announces every beat in order', () => {
    const r = new GameRunner(spec(), field, { cue: () => {}, attract: false, seed: 1 });
    const beats: number[] = [];
    r.on('beat', (n) => beats.push(n));
    run(r, fakeHand(), Math.max(INTRO_HOLD, INTRO_MIN) + 0.05);
    r.update(5, fakeHand());
    expect(beats).toEqual([3, 2, 1, 0]);
    expect(r.phase).toBe('play');
  });

  it('a timed game ends on time, warning for the last 3 seconds', () => {
    const s = spec({ duration: 5 });
    const r = new GameRunner(s, field, { cue: () => {}, attract: false, seed: 1 });
    const warns: number[] = [];
    const finished = vi.fn();
    r.on('warn', (n) => warns.push(n));
    r.on('finish', finished);
    const h = fakeHand();
    toPlay(r, h);
    run(r, h, 4.9);
    expect(r.phase).toBe('play');
    expect(r.timeLeft).toBeGreaterThan(0);
    expect(r.timeLeft).toBeLessThan(0.15);
    run(r, h, 0.2);
    expect(r.phase).toBe('result');
    expect(warns).toEqual([3, 2, 1]);
    expect(finished).toHaveBeenCalledOnce();
    expect(r.result?.label).toBe('frames');
  });

  it('an untimed game ends when it says so', () => {
    const s = spec();
    const r = new GameRunner(s, field, { cue: () => {}, attract: false, seed: 1 });
    const h = fakeHand();
    toPlay(r, h);
    run(r, h, 30);
    expect(r.phase).toBe('play');
    s.probe().over = true;
    r.update(1 / 60, h);
    expect(r.phase).toBe('result');
    expect(r.timeLeft).toBeNull();
  });

  it('pauses the moment the hand is lost; resumes only on request, after a short countdown', () => {
    const s = spec({ duration: 20 });
    const r = new GameRunner(s, field, { cue: () => {}, attract: false, seed: 1 });
    const h = fakeHand();
    toPlay(r, h);
    run(r, h, 2);
    const t = r.time;

    h.present = false;
    r.update(1 / 60, h);
    expect(r.phase).toBe('paused');
    expect(r.pauseReason).toBe('lost');
    const updates = s.probe().updates;

    h.present = true;
    run(r, h, 3); // the hand is back, but a returning hand doesn't restart the game by itself
    expect(r.phase).toBe('paused');
    expect(s.probe().updates).toBe(updates);
    expect(r.time).toBe(t); // paused time doesn't count

    r.resume();
    expect(r.phase).toBe('countdown');
    run(r, h, RESUME_BEAT * 3 + 0.05);
    expect(r.phase).toBe('play');
    expect(r.time).toBeLessThan(t + 0.1);
  });

  it('a lost hand during the countdown pauses too', () => {
    const r = new GameRunner(spec(), field, { cue: () => {}, attract: false, seed: 1 });
    const h = fakeHand();
    run(r, h, Math.max(INTRO_HOLD, INTRO_MIN) + 0.05);
    h.present = false;
    r.update(1 / 60, h);
    expect(r.phase).toBe('paused');
  });

  it('user pause works in play; pause is ignored on the intro and result', () => {
    const r = new GameRunner(spec({ duration: 1 }), field, { cue: () => {}, attract: false, seed: 1 });
    const h = fakeHand();
    r.pause('user');
    expect(r.phase).toBe('intro');
    toPlay(r, h);
    r.pause('user');
    expect(r.phase).toBe('paused');
    r.resume();
    run(r, h, RESUME_BEAT * 3 + 1.2);
    expect(r.phase).toBe('result');
    r.pause('user');
    expect(r.phase).toBe('result');
  });

  it('retry starts a fresh round (new seed) straight into the countdown', () => {
    const s = spec({ duration: 1 });
    const r = new GameRunner(s, field, { cue: () => {}, attract: false, seed: 42 });
    const h = fakeHand();
    toPlay(r, h);
    run(r, h, 1.1);
    expect(r.phase).toBe('result');
    r.retry();
    expect(r.phase).toBe('countdown');
    expect(r.time).toBe(0);
    expect(r.result).toBeNull();
    const [a, b] = s.probe().starts;
    expect(a.first).not.toBe(b.first);
    // Same seed → same round.
    const s2 = spec();
    new GameRunner(s2, field, { cue: () => {}, attract: false, seed: 42 });
    expect(s2.probe().starts[0].first).toBe(a.first);
  });
});

// ─── scripted hand ──────────────────────────────────────────────────────────

describe('ScriptDriver (attract-mode hand)', () => {
  it('follows its target smoothly through the Hand contract', () => {
    let target: { x: number; y: number } | null = { x: 100, y: 100 };
    const hand = new HandController(() => ({ w: 1000, h: 1000 }));
    const found = vi.fn();
    const lost = vi.fn();
    hand.on('found', found);
    hand.on('lost', lost);
    hand.setDriver(new ScriptDriver(() => target));
    hand.update(0);
    expect(hand.source).toBe('script');
    expect(found).toHaveBeenCalledOnce();
    expect(hand.position).toEqual({ x: 100, y: 100 }); // appears where it is, no fly-in

    target = { x: 600, y: 100 };
    let peak = 0;
    for (let t = 16; t < 1000; t += 16) {
      hand.update(t);
      peak = Math.max(peak, hand.speed);
      expect(hand.position.x).toBeLessThanOrEqual(601); // critically damped: no big overshoot
    }
    expect(hand.position.x).toBeCloseTo(600, 0);
    expect(peak).toBeGreaterThan(1500); // a real swipe velocity (Slice reads it)
    expect(hand.direction.x).toBe(0); // settled

    target = null;
    hand.update(1016);
    expect(hand.present).toBe(false);
    expect(lost).toHaveBeenCalledOnce();
  });
});

// ─── attract mode ───────────────────────────────────────────────────────────

describe('attract mode', () => {
  it('the demo game plays itself (autopilot → scripted hand → score) and loops', () => {
    const paint = attractPainter(DEMO_GAME, 3);
    const ctx = fakeCtx();
    const probe = vi.spyOn(DEMO_GAME, 'create');
    let t = 0;
    paint(ctx, 320, 200, t, '#000');
    const game = probe.mock.results[0].value as Game;
    const start = vi.spyOn(game, 'start');
    for (; t < 15; t += 1 / 60) paint(ctx, 320, 200, t, '#000');
    expect(game.result().score).toBeGreaterThan(5);
    expect(start).not.toHaveBeenCalled();
    // After its (short) round plus the result hold, it starts over.
    for (; t < 26; t += 1 / 60) paint(ctx, 320, 200, t, '#000');
    expect(start).toHaveBeenCalledOnce();
    probe.mockRestore();
  });

  it('each painter owns its game (tile and preview don’t share state)', () => {
    const create = vi.spyOn(DEMO_GAME, 'create');
    const a = attractPainter(DEMO_GAME);
    const b = attractPainter(DEMO_GAME);
    a(fakeCtx(), 100, 100, 0, '#000');
    b(fakeCtx(), 100, 100, 0, '#000');
    expect(create).toHaveBeenCalledTimes(2);
    create.mockRestore();
  });

  it('a big time jump (scene returning to the front) is not simulated', () => {
    const create = vi.spyOn(DEMO_GAME, 'create');
    const paint = attractPainter(DEMO_GAME);
    paint(fakeCtx(), 300, 200, 0, '#000');
    const game = create.mock.results[0].value as Game;
    const before = game.result().score; // the ghost hand may appear right on a bubble
    paint(fakeCtx(), 300, 200, 500, '#000');
    expect(game.over).toBe(false);
    expect(game.result().score).toBe(before);
    create.mockRestore();
  });
});

// ─── scores ─────────────────────────────────────────────────────────────────

describe('best scores', () => {
  it('keeps the highest score per game', () => {
    expect(bestScore('x')).toBeNull();
    expect(recordScore('x', 10)).toEqual({ previous: null, isBest: true });
    expect(recordScore('x', 7)).toEqual({ previous: 10, isBest: false });
    expect(recordScore('x', 12)).toEqual({ previous: 10, isBest: true });
    expect(bestScore('x')).toBe(12);
    expect(recordScore('y', 0).isBest).toBe(false); // a zero isn't a record
  });
});

// ─── scene ──────────────────────────────────────────────────────────────────

describe('GameScene', () => {
  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
  });

  function mount(over: Partial<GameSpec> = {}) {
    const hand = fakeHand();
    const play = vi.fn();
    const onExit = vi.fn();
    const scene = new GameScene(spec({ duration: 2, ...over }), { hand, play, onExit, seed: 5 });
    document.body.append(scene.el);
    return { scene, hand, play, onExit };
  }
  const step = (scene: GameScene, s: number) => {
    for (let t = 0; t < s; t += 1 / 60) scene.update(1 / 60);
  };

  it('renders each phase and plays the shared sounds', () => {
    const { scene, play } = mount();
    expect(scene.el.dataset.phase).toBe('intro');
    expect(scene.el.querySelector('.game-intro h1')!.textContent).toBe('Probe');
    step(scene, Math.max(INTRO_HOLD, INTRO_MIN) + 0.05);
    expect(scene.el.dataset.phase).toBe('countdown');
    expect(scene.el.querySelector('.game-count')!.textContent).toBe('3');
    step(scene, BEAT * 3 + 0.05);
    expect(scene.el.dataset.phase).toBe('play');
    // 3 · 2 · 1 · go, then the 2 s game is already in its final seconds (warn tick).
    expect(play.mock.calls.map((c) => c[0])).toEqual(['tick', 'tick', 'tick', 'go', 'tick']);
    expect(scene.el.querySelector('.game-timer b')!.textContent).toBe('2');
    step(scene, 2.1);
    expect(scene.el.dataset.phase).toBe('result');
    expect(scene.el.querySelector('.game-result-best')!.textContent).toBe('First score!');
    expect(play).toHaveBeenLastCalledWith('success');
  });

  it('pause button, Escape, resume, again and exit', () => {
    const { scene, onExit } = mount();
    expect(scene.onBack()).toBe(false); // intro: Escape goes back
    step(scene, Math.max(INTRO_HOLD, INTRO_MIN) + BEAT * 3 + 0.1);
    expect(scene.onBack()).toBe(true); // playing: Escape pauses
    expect(scene.el.dataset.phase).toBe('paused');
    expect(scene.el.querySelector('.game-paused h2')!.textContent).toBe('Paused');
    scene.el.querySelector<HTMLElement>('.game-resume')!.click();
    expect(scene.el.dataset.phase).toBe('countdown');
    step(scene, RESUME_BEAT * 3 + 0.05);
    scene.el.querySelector<HTMLElement>('.game-pause-btn')!.click();
    expect(scene.el.dataset.phase).toBe('paused');
    scene.el.querySelector<HTMLElement>('.game-paused .game-exit')!.click();
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('a lost hand shows the hand-lost card; a second round compares with the best', () => {
    const { scene, hand } = mount();
    step(scene, Math.max(INTRO_HOLD, INTRO_MIN) + BEAT * 3 + 0.1);
    hand.present = false;
    scene.update(1 / 60);
    expect(scene.el.querySelector('.game-paused h2')!.textContent).toBe('Hand lost');
    hand.present = true;
    scene.el.querySelector<HTMLElement>('.game-resume')!.click();
    step(scene, RESUME_BEAT * 3 + 2.2);
    expect(scene.el.dataset.phase).toBe('result');
    scene.el.querySelector<HTMLElement>('.game-again')!.click();
    expect(scene.el.dataset.phase).toBe('countdown');
    step(scene, BEAT * 3 + 0.05);
    hand.present = false; // lose a chunk of play so this round scores lower
    scene.update(1 / 60);
    hand.present = true;
    scene.runner.resume();
    step(scene, RESUME_BEAT * 3 + 2.2);
    expect(scene.el.querySelector('.game-result-best')!.textContent).toMatch(/^(Best: \d+|New best!)$/);
  });

  it('hides the normal cursor only while an ownCursor game is playing', () => {
    const { scene } = mount({ ownCursor: true });
    step(scene, Math.max(INTRO_HOLD, INTRO_MIN) + BEAT * 3 + 0.1);
    expect(document.body.classList.contains('game-own-cursor')).toBe(true);
    scene.runner.pause('user');
    expect(document.body.classList.contains('game-own-cursor')).toBe(false);
    scene.onDestroy();
    expect(document.body.classList.contains('game-own-cursor')).toBe(false);
  });

  it('pauses when the page is hidden', () => {
    const { scene } = mount();
    step(scene, Math.max(INTRO_HOLD, INTRO_MIN) + BEAT * 3 + 0.1);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(scene.runner.pauseReason).toBe('hidden');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
});
