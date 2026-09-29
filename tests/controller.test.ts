import { describe, expect, it } from 'vitest';
import { CameraDriver, DEFAULT_TUNING } from '../src/input/CameraDriver';
import { HandController } from '../src/input/Hand';
import { fakeTracker, frame } from './synthetic';

const VIEW = { w: 1280, h: 720 };
const FRAME_MS = 1000 / 30; // typical webcam

/** Wires a CameraDriver into a HandController with a scripted clock. */
function rig() {
  const tracker = fakeTracker();
  const driver = new CameraDriver(tracker.subscribe, structuredClone(DEFAULT_TUNING), VIEW);
  const hand = new HandController(() => VIEW);
  hand.setDriver(driver);
  const log: string[] = [];
  hand.on('pinchstart', () => log.push('start'));
  hand.on('pinchend', (e) => log.push(e.cancelled ? 'cancel' : 'end'));
  hand.on('found', () => log.push('found'));
  hand.on('lost', () => log.push('lost'));
  let t = 1000;
  /** Push one camera frame and render once. */
  const step = (nx: number, ny: number, pinch: number, present = true, curl?: number) => {
    t += FRAME_MS;
    tracker.push(frame(t, nx, ny, pinch, present, curl));
    hand.update(t);
  };
  const hold = (n: number, nx: number, ny: number, pinch: number, present = true) => {
    for (let i = 0; i < n; i++) step(nx, ny, pinch, present);
  };
  return { hand, driver, log, step, hold, tracker, now: () => t };
}

describe('Hand controller (camera pipeline)', () => {
  it('announces the hand and follows it', () => {
    const r = rig();
    r.hold(20, 0.5, 0.5, 0.1);
    expect(r.log).toEqual(['found']);
    expect(r.hand.state).toBe('tracking');
    expect(r.hand.position.x).toBeCloseTo(640, 0);
    expect(r.hand.position.y).toBeCloseTo(360, 0);
  });

  it('drift lock: closing a pinch barely moves the cursor', () => {
    const r = rig();
    r.hold(30, 0.5, 0.5, 0.1);
    const before = { ...r.hand.position };
    // The index tip dips 0.03 (≈40 px) toward the thumb while the pinch closes.
    const steps = 6;
    for (let i = 1; i <= steps; i++) r.step(0.5, 0.5 + (0.03 * i) / steps, 0.1 - (0.08 * i) / steps);
    r.hold(3, 0.53 - 0.03, 0.53, 0.02);
    expect(r.log).toContain('start');
    const drift = Math.hypot(r.hand.position.x - before.x, r.hand.position.y - before.y);
    const naive = (0.03 / DEFAULT_TUNING.box.size) * VIEW.h;
    expect(naive).toBeGreaterThan(35);
    expect(drift).toBeLessThan(4); // was ~24 px before rewind-on-press
  });

  it('drags 1:1 (trailing by the hold radius) while pinched, and the offset melts after release', () => {
    const r = rig();
    r.hold(30, 0.5, 0.5, 0.1);
    for (let i = 1; i <= 6; i++) r.step(0.5, 0.5 + 0.005 * i, 0.1 - (0.08 * i) / 6);
    r.hold(3, 0.5, 0.53, 0.02);
    expect(r.hand.isPinching).toBe(true);

    const x0 = r.hand.position.x;
    r.hold(20, 0.4, 0.53, 0.02); // move the hand 0.1 normalized (mirrored → right)
    const expected = (0.1 / (DEFAULT_TUNING.box.size * (VIEW.w / VIEW.h) * (480 / 640))) * VIEW.w;
    expect(r.hand.position.x - x0).toBeCloseTo(expected - DEFAULT_TUNING.holdRadius, -1);

    r.hold(40, 0.4, 0.53, 0.1); // release and rest
    expect(r.log.at(-1)).toBe('end');
    const truth = ((1 - 0.4 - (0.5 - (DEFAULT_TUNING.box.size * (VIEW.w / VIEW.h) * 0.75) / 2)) /
      (DEFAULT_TUNING.box.size * (VIEW.w / VIEW.h) * 0.75)) * VIEW.w;
    expect(Math.abs(r.hand.position.x - truth)).toBeLessThan(3);
  });

  it('a fist is not a pinch (thumb and index tips close, index curled)', () => {
    const r = rig();
    r.hold(20, 0.5, 0.5, 0.1);
    for (let i = 0; i < 20; i++) r.step(0.5, 0.5, 0.028, true, 0.023); // measured fist values
    expect(r.log).toEqual(['found']);
    expect(r.hand.pinchStrength).toBe(0);
  });

  it('hold stabilizer: landmark wobble during a held pinch does not move the cursor', () => {
    const r = rig();
    r.hold(30, 0.5, 0.5, 0.1);
    for (let i = 1; i <= 6; i++) r.step(0.5, 0.5, 0.1 - (0.08 * i) / 6);
    r.hold(2, 0.5, 0.5, 0.02);
    expect(r.hand.isPinching).toBe(true);
    const held = { ...r.hand.position };
    // ±0.004 normalized ≈ ±7 px of wobble, plus the pinch gap creeping up (seen in real data)
    for (let i = 0; i < 30; i++) r.step(0.5 + (i % 2 ? 0.004 : -0.004), 0.5 + (i % 3 ? 0.003 : -0.003), 0.02 + i * 0.0007);
    expect(r.hand.isPinching).toBe(true);
    expect(Math.hypot(r.hand.position.x - held.x, r.hand.position.y - held.y)).toBeLessThan(1);
  });

  it('release rewind: the click lands where the pinch was held, not where opening moved the tip', () => {
    const r = rig();
    let end: { x: number; y: number } | null = null;
    r.hand.on('pinchend', (e) => (end = e));
    r.hold(30, 0.5, 0.5, 0.1);
    for (let i = 1; i <= 6; i++) r.step(0.5, 0.5, 0.1 - (0.08 * i) / 6);
    r.hold(10, 0.5, 0.5, 0.02);
    const held = { ...r.hand.position };
    // Opening: the tip swings 0.03 (≈ 40 px) up and sideways as the fingers part.
    for (let i = 1; i <= 6; i++) r.step(0.5 - 0.02 * (i / 6), 0.5 - 0.03 * (i / 6), 0.02 + (0.08 * i) / 6);
    expect(end).not.toBeNull();
    expect(Math.hypot(end!.x - held.x, end!.y - held.y)).toBeLessThan(4);
  });

  it('edge guard: a hand touching the frame edge cannot start a press', () => {
    const r = rig();
    r.hold(20, 0.5, 0.78, 0.1); // landmarks reach y 0.98: at the bottom edge
    r.hold(6, 0.5, 0.78, 0.02); // glitchy "closure" at the edge
    expect(r.log).toEqual(['found']);
    r.hold(4, 0.5, 0.5, 0.1); // back inside the frame
    r.hold(4, 0.5, 0.5, 0.02);
    expect(r.log).toEqual(['found', 'start']);
  });

  it('short dropouts are tolerated silently', () => {
    const r = rig();
    r.hold(20, 0.5, 0.5, 0.1);
    r.hold(3, 0, 0, 0, false); // 100 ms gap < grace
    r.hold(5, 0.5, 0.5, 0.1);
    expect(r.log).toEqual(['found']);
  });

  it('losing the hand mid-pinch cancels the press, then reports loss', () => {
    const r = rig();
    r.hold(20, 0.5, 0.5, 0.1);
    r.hold(4, 0.5, 0.5, 0.02);
    expect(r.hand.isPinching).toBe(true);
    r.hold(12, 0, 0, 0, false);
    expect(r.log).toEqual(['found', 'start', 'cancel', 'lost']);
    expect(r.hand.state).toBe('lost');
    expect(r.hand.isPinching).toBe(false);
  });

  it('a hand re-entering already pinched does not click until it opens', () => {
    const r = rig();
    r.hold(20, 0.5, 0.5, 0.1);
    r.hold(12, 0, 0, 0, false);
    r.log.length = 0;
    r.hold(10, 0.5, 0.5, 0.02);
    expect(r.log).toEqual(['found']);
    r.hold(3, 0.5, 0.5, 0.1);
    r.hold(3, 0.5, 0.5, 0.02);
    expect(r.log).toEqual(['found', 'start']);
  });

  it('falls back to "searching" after being lost for a while', () => {
    const r = rig();
    r.hold(10, 0.5, 0.5, 0.1);
    r.hold(12, 0, 0, 0, false);
    expect(r.hand.state).toBe('lost');
    r.hold(90, 0, 0, 0, false); // 3 s
    expect(r.hand.state).toBe('searching');
  });

  it('predicts between camera frames at constant velocity', () => {
    const r = rig();
    // Sweep right at a steady pace so the filter settles.
    let nx = 0.7;
    for (let i = 0; i < 30; i++) r.step((nx -= 0.004), 0.5, 0.1);
    const atFrame = r.hand.position.x;
    r.hand.update(r.now() + FRAME_MS / 2); // render frame between two camera frames
    expect(r.hand.position.x).toBeGreaterThan(atFrame);
    expect(r.hand.speed).toBeGreaterThan(100);
    expect(r.hand.direction.x).toBeCloseTo(1, 1);
  });

  it('keeps a short trail and clears it on loss', () => {
    const r = rig();
    r.hold(30, 0.5, 0.5, 0.1); // 1 s
    const span = r.hand.path.at(-1)!.t - r.hand.path[0].t;
    expect(span).toBeLessThanOrEqual(500);
    r.hold(12, 0, 0, 0, false);
    expect(r.hand.path.length).toBe(0);
  });

  it('swapping drivers mid-pinch cancels cleanly', () => {
    const r = rig();
    r.hold(20, 0.5, 0.5, 0.1);
    r.hold(4, 0.5, 0.5, 0.02);
    r.hand.setDriver(null);
    expect(r.log).toEqual(['found', 'start', 'cancel', 'lost']);
  });
});
