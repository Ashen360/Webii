import { describe, expect, it } from 'vitest';
import { mapToViewport, DEFAULT_BOX } from '../src/input/mapping';
import { OneEuroFilter } from '../src/input/OneEuro';
import { DEFAULT_PINCH, PinchDetector } from '../src/input/pinch';
import { noise } from './synthetic';

const std = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

describe('OneEuroFilter', () => {
  it('suppresses jitter when the hand is still', () => {
    const f = new OneEuroFilter(1.2, 0.012);
    const rnd = noise(7);
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const v = 500 + rnd() * 4; // ±4 px landmark jitter
      raw.push(v);
      out.push(f.filter(v, i / 60));
    }
    expect(std(out.slice(60))).toBeLessThan(std(raw.slice(60)) * 0.35);
  });

  it('keeps lag small during fast motion', () => {
    const f = new OneEuroFilter(1.2, 0.012);
    let y = 0;
    for (let i = 0; i <= 30; i++) y = f.filter(i * 40, i / 60); // 2400 px/s sweep
    expect(1200 - y).toBeLessThan(80); // < ~2 frames behind
  });

  it('reset forgets history', () => {
    const f = new OneEuroFilter();
    f.filter(0, 0);
    f.filter(10, 0.016);
    f.reset();
    expect(f.filter(900, 1)).toBe(900);
  });
});

describe('PinchDetector', () => {
  const armed = () => {
    const p = new PinchDetector({ ...DEFAULT_PINCH });
    p.update(0.1);
    return p;
  };

  it('requires confirm frames to press', () => {
    const p = armed();
    expect(p.update(0.02)).toBeNull();
    expect(p.update(0.02)).toBe('press');
    expect(p.pressed).toBe(true);
  });

  it('does not flicker when hovering around the press threshold (hysteresis)', () => {
    const p = armed();
    p.update(0.02);
    p.update(0.02);
    const transitions = [0.035, 0.028, 0.04, 0.03, 0.042, 0.029].map((d) => p.update(d));
    expect(transitions.every((t) => t === null)).toBe(true);
    expect(p.pressed).toBe(true);
    p.update(0.06);
    expect(p.update(0.06)).toBe('release');
  });

  it('ignores a single noisy frame', () => {
    const p = armed();
    expect([0.02, 0.08, 0.02, 0.08].map((d) => p.update(d)).every((t) => t === null)).toBe(true);
  });

  it('a hand that appears already pinched must open before it can click', () => {
    const p = new PinchDetector();
    for (let i = 0; i < 10; i++) expect(p.update(0.015)).toBeNull();
    p.update(0.08); // opens → armed
    p.update(0.015);
    expect(p.update(0.015)).toBe('press');
  });

  it('strength ramps from open to pressed', () => {
    const p = armed();
    p.update(DEFAULT_PINCH.openAt);
    expect(p.strength).toBe(0);
    p.update(DEFAULT_PINCH.pressAt);
    expect(p.strength).toBe(1);
  });
});

describe('mapToViewport', () => {
  const cam = { w: 640, h: 480 };
  const view = { w: 1600, h: 900 };

  it('maps the box centre to the viewport centre', () => {
    const p = mapToViewport(0.5, 0.5, DEFAULT_BOX, cam, view);
    expect(p.x).toBeCloseTo(800);
    expect(p.y).toBeCloseTo(450);
  });

  it('mirrors x: hand on the camera’s left is the user’s right', () => {
    expect(mapToViewport(0.4, 0.5, DEFAULT_BOX, cam, view).x).toBeGreaterThan(800);
  });

  it('stretch increases horizontal gain only', () => {
    const s = { ...DEFAULT_BOX, stretch: 1.3 };
    const c = mapToViewport(0.5, 0.5, s, cam, view);
    const d = 0.02;
    const dxIso = c.x - mapToViewport(0.5 + d, 0.5, DEFAULT_BOX, cam, view).x;
    const dxStr = c.x - mapToViewport(0.5 + d, 0.5, s, cam, view).x;
    expect(dxStr / dxIso).toBeCloseTo(1.3, 5);
    expect(mapToViewport(0.5, 0.52, s, cam, view).y).toBeCloseTo(mapToViewport(0.5, 0.52, DEFAULT_BOX, cam, view).y, 5);
  });

  it('is isotropic: equal physical motion → equal cursor motion', () => {
    const d = 0.05; // normalized height units
    const c = mapToViewport(0.5, 0.5, DEFAULT_BOX, cam, view);
    const dy = mapToViewport(0.5, 0.5 + d, DEFAULT_BOX, cam, view).y - c.y;
    // Same physical distance horizontally = d * (camH / camW) in normalized x.
    const dx = c.x - mapToViewport(0.5 + d * (cam.h / cam.w), 0.5, DEFAULT_BOX, cam, view).x;
    expect(dx).toBeCloseTo(dy, 5);
  });
});

describe('Emitter', () => {
  it('a handler subscribed during an emit does not receive that same event', async () => {
    const { Emitter } = await import('../src/lib/emitter');
    const e = new Emitter<{ ping: number }>();
    const got: number[] = [];
    // e.g. the pinch that closes calibration opens the click test (real bug: trial 1 got it)
    e.on('ping', () => e.on('ping', (n) => got.push(n)));
    e.emit('ping', 1);
    expect(got).toEqual([]);
    e.emit('ping', 2);
    expect(got).toEqual([2]);
  });
});
