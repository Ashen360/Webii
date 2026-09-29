// Replays real calibration recordings (calibration-data/, gitignored) through the
// production estimator and pinch detector. Skipped when no recordings exist.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  estimateCalibration,
  naturalMovement,
  pinchBaseline,
  RelativePinchCounter,
  type StepSamples,
} from '../src/input/calibration';
import { DEFAULT_TUNING, type CameraTuning, type RawMeasure } from '../src/input/CameraDriver';
import { PinchDetector } from '../src/input/pinch';
import { recordSamples, type CalibrationRecord } from '../src/ui/Calibration';

const DIR = join(__dirname, '..', 'calibration-data');
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^calibration-.*\.json$/.test(f)).sort() : [];
const runs = files.map((f) => {
  const record = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as CalibrationRecord;
  const steps = recordSamples(record);
  const est = estimateCalibration(steps, DEFAULT_TUNING, { w: record.viewport.w, h: record.viewport.h });
  const baseline = pinchBaseline(est.still);
  return {
    file: f,
    name: f.slice(12, 31) + (f.match(/-([a-z]+)\.json$/)?.[1] ? ` (${f.match(/-([a-z]+)\.json$/)![1]})` : ''),
    record,
    steps,
    est,
    natural: naturalMovement(steps.reach, baseline),
    deliberate: countDeliberate(steps, baseline, est.still?.openCurl ?? 0),
  };
});

function countDeliberate(s: StepSamples, baseline: number, openCurl: number): number {
  const c = new RelativePinchCounter(baseline, openCurl);
  return s.pinch.filter((m) => c.push(m)).length;
}

/** Presses the production detector (with fist guard) would fire over a sequence. */
function presses(seq: readonly RawMeasure[], t: CameraTuning): number {
  const p = new PinchDetector({ ...t.pinch });
  let n = 0;
  for (const m of seq) {
    if (!m.present) {
      p.reset();
      continue;
    }
    if (p.update(m.curl < t.curlAt ? t.pinch.openAt : m.pinch) === 'press') n++;
  }
  return n;
}

/** Sessions recorded in postures where the hand is small or seen at a low angle. */
const HARD = /-(far|slouched)\d*\.json$/;

/** False clicks during natural movement: never allowed, in any session, with any tuning. */
function noFalseClicks(t: CameraTuning, label: string) {
  for (const r of runs) expect(presses(r.natural, t), `${label} → ${r.name}: false clicks`).toBe(0);
}

/**
 * "Deliberate" is itself a heuristic label (relative closure ≥ 100 ms), so allow one
 * disagreement per run.
 */
function catches(t: CameraTuning, targets: typeof runs, label: string, minRate = 0.95) {
  let caught = 0;
  let total = 0;
  for (const r of targets) {
    const c = presses(r.steps.pinch, t);
    expect(c, `${label} → ${r.name}: pinches`).toBeGreaterThanOrEqual(r.deliberate - 1);
    caught += Math.min(c, r.deliberate);
    total += r.deliberate;
  }
  expect(caught / Math.max(total, 1), `${label}: catch rate`).toBeGreaterThanOrEqual(minRate);
}

/**
 * Firm vs light pinch style, from the session's own data: a light pincher's typical
 * deliberate closure doesn't get below the default threshold. (Round 4 showed the
 * same user switching to light pinches once calibration accepted them.)
 */
const isLight = (r: (typeof runs)[number]) => {
  const mins = r.est.events.map((e) => e.min).sort((a, b) => a - b);
  return mins.length > 0 && mins[Math.floor(mins.length / 2)] > DEFAULT_TUNING.pinch.pressAt;
};

describe.skipIf(runs.length === 0)(`replay ${runs.length} real calibration recording(s)`, () => {
  it('the defaults never false-click, in any session', () => {
    noFalseClicks(DEFAULT_TUNING, 'defaults');
  });

  it('the defaults catch ≥ 90% of pinches in firm-pinch, normal-posture sessions', () => {
    // Measured: 92% over 23 sessions (the misses are borderline 3.9–4.0 cm pinches).
    // Catching them needs press ≥ 4.2 cm, which false-clicks where a relaxed hand came
    // to 4.1 cm. Zero false clicks beats the last few percent; see the pinch limitation.
    catches(DEFAULT_TUNING, runs.filter((r) => !HARD.test(r.file) && !isLight(r)), 'defaults', 0.9);
  });

  it('each session’s calibration catches its own pinches and never false-clicks in it', () => {
    // Per run: at most one miss (calibration deliberately won't chase a lone loose pinch).
    // Excluded from the catch check: the first slouched session, where the hand sat at
    // the frame's bottom edge and glitches (2.2–3.9 cm) undercut real pinches; the edge
    // guard, not a threshold, handles that.
    for (const r of runs) {
      expect(presses(r.natural, r.est.tuning), `self-calibrated ${r.name}: false clicks`).toBe(0);
      if (!/-slouched\.json$/.test(r.file) && !isLight(r)) catches(r.est.tuning, [r], `self-calibrated ${r.name}`, 0);
    }
  });

  // KNOWN LIMITATION, not asserted: LIGHT pinches (round 4: plateaus at 5.7–6.5 cm)
  // overlap a relaxed hand in world thumb–index distance, so they can't be reliably
  // separated by any threshold on this feature. Needs a better pinch feature, found
  // with labelled data (prompted "pinch now / release now" recordings).
  //
  // KNOWN LIMITATION, not asserted: a calibration can false-click in a *different*
  // session when posture (hand size in frame) or pinch style (firm vs light) changed,
  // e.g. far → sitting, or light-pinch sitting2 (5.7 cm) → an old firm session whose
  // relaxed fingers came to 5.0 cm. The app mitigates this by suggesting
  // re-calibration when the hand size differs from the calibrated one.

  it('estimates are sane', () => {
    for (const r of runs) {
      const t = r.est.tuning;
      expect(t.pinch.releaseAt, r.name).toBeGreaterThan(t.pinch.pressAt);
      expect(t.pinch.openAt, r.name).toBeGreaterThan(t.pinch.releaseAt);
      expect(t.predictMs, r.name).toBeLessThanOrEqual(40);
      expect(t.box.stretch ?? 1, r.name).toBeLessThanOrEqual(1.35);
      if (r.est.still) expect(r.est.still.fps, r.name).toBeGreaterThan(20); // no stall-poisoned fps
    }
  });
});
