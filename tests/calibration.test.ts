import { describe, expect, it } from 'vitest';
import {
  boxFromReach,
  buildTuning,
  measureReach,
  measureStill,
  percentile,
  pinchFromEvents,
  RelativePinchCounter,
  StillWindow,
  sustainedMin,
} from '../src/input/calibration';
import { DEFAULT_TUNING, type RawMeasure } from '../src/input/CameraDriver';
import { DEFAULT_PINCH } from '../src/input/pinch';
import { noise } from './synthetic';

const m = (t: number, x: number, y: number, pinch = 0.09, curl = 0.075, present = true): RawMeasure => ({
  t,
  present,
  x,
  y,
  pinch,
  curl,
  aspect: 4 / 3,
});

describe('sustainedMin', () => {
  it('is the lowest level held for N consecutive frames (what the detector can fire on)', () => {
    expect(sustainedMin([9, 2, 9, 4, 4, 9], 2)).toBe(4); // the lone 2 cannot trigger a 2-frame detector
    expect(sustainedMin([9, 2, 9, 4, 4, 9], 1)).toBe(2);
  });
});

describe('percentile', () => {
  it('interpolates', () => {
    expect(percentile([0, 10], 0.5)).toBe(5);
    expect(percentile([3, 1, 2], 0)).toBe(1);
  });
});

describe('measureStill', () => {
  it('recovers landmark noise and fps', () => {
    const rnd = noise(3);
    const sigma = 0.002;
    const all: RawMeasure[] = [];
    for (let i = 0; i < 60; i++) {
      // slow drift + noise
      all.push(m(i * 33.3, 0.5 + i * 0.0005 + rnd() * sigma * 1.7, 0.5 + rnd() * sigma * 1.7));
    }
    const s = measureStill(all, all)!;
    expect(s.fps).toBeCloseTo(30, 0);
    expect(s.dropout).toBe(0);
    expect(s.openPinch).toBeCloseTo(0.09);
    // uniform(-1,1)·1.7σ has std ≈ σ; the drift must not inflate it much
    expect(s.jitter).toBeGreaterThan(sigma * 0.6);
    expect(s.jitter).toBeLessThan(sigma * 1.8);
  });

  it('fps ignores a single camera stall (real recording: one 2.7 s gap read as 15 fps)', () => {
    const all = Array.from({ length: 60 }, (_, i) => m(i * 33.3 + (i >= 30 ? 2700 : 0), 0.5, 0.5));
    expect(measureStill(all, all)!.fps).toBeCloseTo(30, 0);
  });

  it('counts brief flicker as dropout, but not the time before the hand was raised or a lowered hand', () => {
    const all: RawMeasure[] = [];
    let t = 0;
    const push = (n: number, present: boolean) => {
      for (let i = 0; i < n; i++) all.push(m((t += 33.3), 0.5, 0.5, 0.09, 0.075, present));
    };
    push(60, false); // before the hand is raised: ignored
    push(40, true);
    push(3, false); // 100 ms flicker: counts
    push(40, true);
    push(90, false); // hand lowered for 3 s: ignored
    push(20, true);
    const s = measureStill(all.filter((x) => x.present), all)!;
    expect(s.dropout).toBeCloseTo(3 / (40 + 3 + 40 + 90 + 20), 3);
  });

  it('refuses too little data', () => {
    expect(measureStill([m(0, 0.5, 0.5)], [m(0, 0.5, 0.5)])).toBeNull();
  });
});

describe('StillWindow', () => {
  it('needs enough samples, not just enough time', () => {
    const w = new StillWindow();
    w.push(m(0, 0.5, 0.5));
    expect(w.push(m(200, 0.5, 0.5))).toBeLessThan(1);
    const w2 = new StillWindow();
    let p = 0;
    for (let i = 0; i <= 40; i++) p = w2.push(m(i * 33.3, 0.5, 0.5));
    expect(p).toBeGreaterThanOrEqual(1);
  });

  it('restarts on movement and on frame gaps', () => {
    const w = new StillWindow();
    for (let i = 0; i < 20; i++) w.push(m(i * 33, 0.5, 0.5));
    w.push(m(700, 0.6, 0.5)); // big jump → moving
    expect(w.buf.length).toBe(1);
    expect(w.hint).toBe('hold');
    for (let i = 1; i < 10; i++) w.push(m(700 + i * 33, 0.6, 0.5));
    w.push(m(1400, 0.6, 0.5)); // 400 ms gap
    expect(w.buf.length).toBe(1);
  });
});

describe('reach → comfort box', () => {
  const sweep = (x0: number, x1: number, y0: number, y1: number) => {
    const out: RawMeasure[] = [];
    for (let i = 0; i < 200; i++) {
      const a = (i / 200) * Math.PI * 6;
      out.push(m(i * 20, (x0 + x1) / 2 + (Math.cos(a) * (x1 - x0)) / 2, (y0 + y1) / 2 + (Math.sin(a * 1.3) * (y1 - y0)) / 2));
    }
    return out;
  };

  it('centres the box on where the hand lives, and fits both axes', () => {
    const r = measureReach(sweep(0.4, 0.8, 0.2, 0.6))!;
    const box = boxFromReach(r, 16 / 9)!;
    expect(box.cx).toBeCloseTo(0.6, 1);
    expect(box.cy).toBeCloseTo(0.4, 1);
    // Width in normalized x must fit inside the x reach
    const widthNorm = (box.size * (16 / 9)) / (4 / 3) / box.stretch!;
    expect(widthNorm).toBeLessThanOrEqual(r.x1 - r.x0 + 1e-9);
    expect(box.size).toBeLessThanOrEqual(r.y1 - r.y0 + 1e-9);
  });

  it('on a wide screen, stretches x (bounded) instead of shrinking the box', () => {
    // Real run 2: reach ~0.36 x 0.32 on a 1920×935 window. Isotropic gave the minimum box.
    const r = measureReach(sweep(0.26, 0.62, 0.33, 0.65))!;
    const view = 1920 / 935;
    const box = boxFromReach(r, view)!;
    expect(box.stretch).toBeGreaterThan(1);
    expect(box.stretch).toBeLessThanOrEqual(1.35);
    expect(box.size).toBeGreaterThan(0.25); // taller than the isotropic result
    expect((box.size * view) / (4 / 3) / box.stretch!).toBeLessThanOrEqual(r.x1 - r.x0 + 1e-9);
  });

  it('keeps stretch at 1 when the reach already matches the screen', () => {
    const r = measureReach(sweep(0.2, 0.8, 0.3, 0.6))!;
    expect(boxFromReach(r, 16 / 9)!.stretch).toBe(1);
  });

  it('keeps the whole hand in frame: shifts the box up when the wrist would leave the bottom', () => {
    // Slouched-like: fingertip lives at y 0.6–0.82, the hand extends 0.25 below the tip.
    const s = sweep(0.35, 0.65, 0.6, 0.82).map((x) => ({ ...x, bbox: [x.x - 0.05, x.y, x.x + 0.08, x.y + 0.25] as [number, number, number, number], scale: 0.1 }));
    const box = boxFromReach(measureReach(s)!, 16 / 9)!;
    expect(box.cy + box.size / 2 + 0.25).toBeLessThanOrEqual(0.95 + 1e-6); // wrist inside the frame at the screen bottom
    expect(box.size).toBeGreaterThanOrEqual(0.2);
  });

  it('spans at least 3 hand-lengths when the hand size is known', () => {
    const r = measureReach(sweep(0.4, 0.6, 0.4, 0.55))!; // small demonstrated reach
    const box = boxFromReach(r, 16 / 9, 0.12)!;
    expect(box.size).toBeCloseTo(0.36, 5); // 3 × 0.12, not the reach-based ~0.3 floor
  });

  it('keeps defaults if the hand barely moved', () => {
    const r = measureReach(sweep(0.49, 0.53, 0.49, 0.52))!;
    expect(boxFromReach(r, 16 / 9)).toBeNull();
  });

  it('refuses too few samples', () => {
    expect(measureReach([m(0, 0.5, 0.5)])).toBeNull();
  });
});

describe('RelativePinchCounter', () => {
  const feed = (c: RelativePinchCounter, seq: number[], curl = 0.07) =>
    seq.map((d, i) => c.push(m(i * 33, 0.5, 0.5, d, curl))).filter(Boolean);

  it('counts deliberate pinches relative to the open baseline', () => {
    const c = new RelativePinchCounter(0.09);
    const ev = feed(c, [0.09, 0.07, 0.04, 0.03, 0.028, 0.03, 0.08, 0.09, 0.03, 0.024, 0.026, 0.075]);
    expect(ev.map((e) => e!.min)).toEqual([0.028, 0.024]);
  });

  it('ignores a pinch already in progress when the step starts (real runs 2 and 3)', () => {
    const c = new RelativePinchCounter(0.087);
    const ev = feed(c, [0.044, 0.041, 0.04, 0.041, 0.045, 0.07, 0.09, 0.03, 0.027, 0.028, 0.08]);
    expect(ev.map((e) => e!.min)).toEqual([0.027]);
  });

  it('ignores 1–2-frame dips', () => {
    const c = new RelativePinchCounter(0.09);
    expect(feed(c, [0.09, 0.04, 0.08, 0.09, 0.04, 0.035, 0.08])).toEqual([]);
  });

  it('does not count a fist (index curled) as a calibration pinch', () => {
    const c = new RelativePinchCounter(0.087, 0.078); // measured open hand
    const fist = [0.087, 0.06, 0.031, 0.031, 0.031, 0.08, 0.087].map((d, i) =>
      c.push(m(i * 33, 0.5, 0.5, d, d < 0.05 ? 0.023 : 0.078)),
    );
    expect(fist.every((e) => e === null)).toBe(true);
    expect(c.rejected).toBe(1);
    const pinch = [0.05, 0.02, 0.018, 0.02, 0.08].map((d, i) => c.push(m(300 + i * 33, 0.5, 0.5, d, 0.055)));
    expect(pinch.filter(Boolean).length).toBe(1);
  });
});

describe('pinchFromEvents', () => {
  const open = Array.from({ length: 40 }, (_, i) => 0.06 + (i % 8) * 0.005);

  it('places thresholds between this user’s closed and open distances', () => {
    const p = pinchFromEvents(open, [
      { min: 0.029, curl: 0.068 },
      { min: 0.03, curl: 0.072 },
      { min: 0.029, curl: 0.073 },
    ])!;
    expect(p.pressAt).toBeGreaterThan(0.03);
    expect(p.pressAt).toBeLessThan(0.06);
    expect(p.releaseAt).toBeGreaterThan(p.pressAt);
    expect(p.openAt).toBeGreaterThan(p.releaseAt);
    expect(p.curlAt).toBeLessThan(0.068); // real pinches must pass the fist guard
    expect(p.curlAt).toBeGreaterThanOrEqual(0.02);
  });

  it('keeps the default when it already separates this session', () => {
    const p = pinchFromEvents(open, [{ min: 0.029, curl: 0.07 }, { min: 0.03, curl: 0.07 }])!;
    expect(p.pressAt).toBe(DEFAULT_PINCH.pressAt);
  });

  it('raises the threshold for a loose pincher (tips never get close)', () => {
    const wide = Array.from({ length: 40 }, (_, i) => 0.075 + (i % 8) * 0.004);
    const p = pinchFromEvents(wide, [{ min: 0.045, curl: 0.07 }, { min: 0.047, curl: 0.07 }])!;
    expect(p.pressAt).toBeGreaterThanOrEqual(0.047 + 0.006 - 1e-9);
    expect(p.releaseAt).toBeGreaterThan(p.pressAt);
  });

  it('lowers the threshold when relaxed fingers come close to the default', () => {
    const close = Array.from({ length: 40 }, (_, i) => 0.039 + (Math.floor(i / 4) % 8) * 0.004); // levels held 4 frames
    const p = pinchFromEvents(close, [{ min: 0.024, curl: 0.07 }, { min: 0.025, curl: 0.07 }])!;
    expect(p.pressAt).toBeLessThanOrEqual(0.039 - 0.004 + 1e-9);
    expect(p.pressAt).toBeGreaterThanOrEqual(0.025 + 0.006 - 1e-9);
  });

  it('fits a narrow but real gap (real run: pinches 3.3–3.4, relaxed down to 4.3 cm)', () => {
    const narrow = Array.from({ length: 40 }, (_, i) => 0.043 + (Math.floor(i / 4) % 10) * 0.004);
    const p = pinchFromEvents(narrow, [{ min: 0.034, curl: 0.07 }, { min: 0.033, curl: 0.07 }])!;
    expect(p.pressAt).toBeLessThanOrEqual(0.039 + 1e-9);
    expect(p.pressAt).toBeGreaterThan(0.034 + 0.001);
  });

  it('does not chase one loose pinch (real run: 3.3, 3.8, 4.3 cm)', () => {
    const p = pinchFromEvents(open, [
      { min: 0.033, curl: 0.07 },
      { min: 0.038, curl: 0.07 },
      { min: 0.043, curl: 0.07 },
    ])!;
    expect(p.pressAt).toBe(DEFAULT_PINCH.pressAt);
  });

  it('keeps the current value when no safe threshold exists', () => {
    const tight = Array.from({ length: 40 }, (_, i) => 0.036 + (i % 10) * 0.004);
    expect(pinchFromEvents(tight, [{ min: 0.034, curl: 0.07 }, { min: 0.035, curl: 0.07 }])).toBeNull();
  });

  it('refuses overlapping distributions', () => {
    expect(pinchFromEvents(open, [{ min: 0.07, curl: 0.06 }, { min: 0.072, curl: 0.06 }])).toBeNull();
  });

  it('refuses a single pinch', () => {
    expect(pinchFromEvents(open, [{ min: 0.015, curl: 0.06 }])).toBeNull();
  });
});

describe('buildTuning', () => {
  it('keeps every default when nothing was trustworthy', () => {
    const { tuning, notes } = buildTuning(DEFAULT_TUNING, { still: null, box: null, pinch: null }, 900);
    expect(tuning).toEqual(DEFAULT_TUNING);
    expect(notes.every((n) => n.includes('kept'))).toBe(true);
  });

  it('smooths harder for a noisy camera and predicts one frame at 30 fps', () => {
    const base = { still: { jitter: 0, fps: 30, dropout: 0, openPinch: 0.09, openCurl: 0.075, n: 40 }, box: null, pinch: null };
    const quiet = buildTuning(DEFAULT_TUNING, { ...base, still: { ...base.still, jitter: 0.0003 } }, 900).tuning;
    const noisy = buildTuning(DEFAULT_TUNING, { ...base, still: { ...base.still, jitter: 0.004 } }, 900).tuning;
    expect(noisy.minCutoff).toBeLessThan(quiet.minCutoff);
    expect(quiet.predictMs).toBeCloseTo(33.3, 0);
  });

  it('does not mutate the base tuning', () => {
    const base = structuredClone(DEFAULT_TUNING);
    buildTuning(base, { still: null, box: { cx: 0.6, cy: 0.4, size: 0.4 }, pinch: null }, 900);
    expect(base).toEqual(DEFAULT_TUNING);
  });
});
