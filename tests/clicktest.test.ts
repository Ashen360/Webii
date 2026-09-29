// Replays click-test recordings (calibration-data/clicktest-*.json, gitignored)
// through the real driver + controller with different tunings, and scores hits
// against the recorded targets. A synthetic recording checks the harness itself.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClickTestRecord } from '../src/debug/ClickTest';
import { CameraDriver, DEFAULT_TUNING, type CameraTuning } from '../src/input/CameraDriver';
import { HandController } from '../src/input/Hand';
import { fakeTracker, frame } from './synthetic';

/** Tuning without the click stabilizers (hold radius, press/release rewind). */
const legacy = (t: CameraTuning): CameraTuning => ({ ...structuredClone(t), holdRadius: 0, rewindMs: 0 });

interface Score {
  hits: number;
  attempts: number;
  drift: number[];
}

export function replayClicks(rec: Pick<ClickTestRecord, 'measures' | 'trials' | 'viewport' | 'camera'>, tuning: CameraTuning): Score {
  const view = { w: rec.viewport.w, h: rec.viewport.h };
  const cam = { w: Math.round(480 * rec.camera.aspect), h: 480 };
  const tracker = fakeTracker();
  const hand = new HandController(() => view);
  hand.setDriver(new CameraDriver(tracker.subscribe, structuredClone(tuning), view));

  const windows = rec.trials.map((tr, i) => ({ tr, from: tr.shownAt, to: rec.trials[i + 1]?.shownAt ?? Infinity }));
  const done = new Set<number>();
  let press: { x: number; y: number; t: number } | null = null;
  let now = 0;
  const score: Score = { hits: 0, attempts: 0, drift: [] };
  hand.on('pinchstart', (p) => (press = { ...p, t: now }));
  hand.on('pinchend', (e) => {
    const p = press;
    press = null;
    if (!p || e.cancelled) return;
    const w = windows.findIndex((x) => p.t >= x.from && p.t < x.to);
    if (w < 0 || done.has(w)) return;
    done.add(w);
    const { target } = windows[w].tr;
    const inside = (q: { x: number; y: number }) => Math.hypot(q.x - target.x, q.y - target.y) <= target.r;
    score.attempts++;
    score.drift.push(Math.hypot(e.x - p.x, e.y - p.y));
    if (inside(p) && inside(e)) score.hits++;
  });
  for (const [t, present, x, y, pinch, curl] of rec.measures as number[][]) {
    now = t;
    tracker.push(frame(t, 1 - x, y, pinch, present === 1, curl, cam));
    hand.update(t);
  }
  return score;
}

const med = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : 0);

describe('click replay harness (synthetic)', () => {
  it('scores every attempt against its target, and sees the stabilizers remove press→release drift', () => {
    // A hand aiming at a small target: approach, pinch (tip dips toward the thumb),
    // hold with wobble, then open (tip swings away) — the pattern users reported.
    const view = { w: 1280, h: 720 };
    const box = DEFAULT_TUNING.box;
    const toNorm = (px: number, py: number) => {
      const w = box.size * (view.w / view.h) * (3 / 4);
      return { x: box.cx - w / 2 + (px / view.w) * w, y: box.cy - box.size / 2 + (py / view.h) * box.size };
    };
    const measures: ClickTestRecord['measures'] = [];
    const trials: ClickTestRecord['trials'] = [];
    let t = 0;
    const push = (px: number, py: number, pinch: number, wob = 0) => {
      const n = toNorm(px + wob, py + wob / 2);
      measures.push([(t += 33.3), 1, n.x, n.y, pinch, 0.07]);
    };
    for (let k = 0; k < 6; k++) {
      const tx = 300 + k * 130;
      const ty = 250 + (k % 3) * 90;
      trials.push({ target: { x: tx, y: ty, r: 38 }, shownAt: t, press: null, release: null, hit: false });
      for (let i = 0; i < 20; i++) push(tx - 30, ty + 18, 0.09); // aimed 35 px off-centre: near the edge
      for (let i = 1; i <= 5; i++) push(tx - 30, ty + 18 + i * 4, 0.09 - i * 0.013); // dip while closing
      for (let i = 0; i < 12; i++) push(tx - 30, ty + 38, 0.028 + (i % 4) * 0.003, i % 2 ? 7 : -7); // held, wobbling
      for (let i = 1; i <= 5; i++) push(tx - 30 - i * 5, ty + 38 - i * 8, 0.03 + i * 0.013); // opening swing
      for (let i = 0; i < 10; i++) push(tx - 40, ty - 10, 0.09);
    }
    const rec = { measures, trials, viewport: { ...view, dpr: 1 }, camera: { aspect: 4 / 3 } };
    const before = replayClicks(rec, legacy(DEFAULT_TUNING));
    const after = replayClicks(rec, DEFAULT_TUNING);
    expect(before.attempts).toBe(6);
    expect(after.attempts).toBe(6);
    expect(after.hits).toBe(6);
    expect(after.hits).toBeGreaterThanOrEqual(before.hits);
    expect(med(before.drift)).toBeGreaterThan(5); // the old behaviour drifts between press and release
    expect(med(after.drift)).toBeLessThan(1); // the stabilizers hold the click point
  });
});

const DIR = join(__dirname, '..', 'calibration-data');
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^clicktest-.*\.json$/.test(f)).sort() : [];

describe.skipIf(files.length === 0)(`replay ${files.length} real click test(s)`, () => {
  it('the click stabilizers never make real clicks worse', () => {
    const rows: string[] = [];
    for (const f of files) {
      const rec = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as ClickTestRecord;
      const b = replayClicks(rec, legacy(rec.tuning));
      const a = replayClicks(rec, { ...legacy(rec.tuning), holdRadius: DEFAULT_TUNING.holdRadius, rewindMs: DEFAULT_TUNING.rewindMs });
      rows.push(`${f}: before ${b.hits}/${b.attempts} (drift ${med(b.drift).toFixed(0)} px) → after ${a.hits}/${a.attempts} (drift ${med(a.drift).toFixed(0)} px)`);
      expect(a.hits, f).toBeGreaterThanOrEqual(b.hits);
    }
    console.info(rows.join('\n'));
  });
});
