import { clamp } from '../lib/math';
import type { CameraTuning, RawMeasure } from './CameraDriver';
import { MAX_STRETCH, type ComfortBox } from './mapping';
import { DEFAULT_PINCH } from './pinch';

/**
 * Auto-calibration estimators. Pure functions over RawMeasure samples.
 * Every estimator returns null when its data can't be trusted; the caller then
 * keeps the existing value for that parameter. Bad data never produces bad tuning.
 *
 * `estimateCalibration` is the single entry point: the live UI and the replay
 * test over real recordings both run exactly this code.
 */

// ─── helpers ────────────────────────────────────────────────────────────────

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const i = clamp(p, 0, 1) * (s.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

const median = (v: readonly number[]) => percentile(v, 0.5);

/**
 * The lowest level a sequence holds for `frames` consecutive samples. The pinch
 * detector fires only after that many frames below its threshold, so this is
 * exactly how low a threshold can go without firing on this sequence.
 */
export function sustainedMin(seq: readonly number[], frames: number): number {
  let best = Infinity;
  for (let i = 0; i + frames <= seq.length; i++) {
    let hi = -Infinity;
    for (let j = i; j < i + frames; j++) hi = Math.max(hi, seq[j]);
    best = Math.min(best, hi);
  }
  return best;
}

function std(values: readonly number[]): number {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length);
}

// ─── step 1: still hand ─────────────────────────────────────────────────────

export const STILL_MS = 1200;
/** Time alone isn't enough: a stalled camera can span 1.2 s with two frames. */
export const STILL_MIN_SAMPLES = 24;
const STILL_MAX_SPEED = 0.3; // camera-heights per second
/** After this long, stop insisting on stillness (tremor-friendly). */
const STILL_GIVE_UP_MS = 8000;
/** A frame gap this long breaks the window (tab switch, camera stall). */
const MAX_FRAME_GAP_MS = 250;

/** Online detector for "the hand has been held still long enough". */
export class StillWindow {
  buf: RawMeasure[] = [];
  hint: '' | 'raise' | 'hold' = 'raise';
  private start: number | null = null;

  /** @returns progress 0..1 (1 = window complete) */
  push(m: RawMeasure): number {
    this.start ??= m.t;
    if (!m.present) {
      this.buf = [];
      this.hint = 'raise';
      return 0;
    }
    const prev = this.buf.at(-1);
    if (prev && m.t - prev.t > MAX_FRAME_GAP_MS) this.buf = [];
    else if (prev) {
      const speed = Math.hypot((m.x - prev.x) * m.aspect, m.y - prev.y) / Math.max((m.t - prev.t) / 1000, 1e-3);
      if (speed > STILL_MAX_SPEED && m.t - this.start < STILL_GIVE_UP_MS) {
        this.buf = [];
        this.hint = 'hold';
      }
    }
    this.buf.push(m);
    if (this.buf.length > 3) this.hint = '';
    const b = this.buf;
    const span = b.length > 1 ? (b[b.length - 1].t - b[0].t) / STILL_MS : 0;
    return Math.min(span, b.length / STILL_MIN_SAMPLES);
  }
}

export interface StillStats {
  /** Landmark noise, normalized camera-height units (per-axis std). */
  jitter: number;
  /** Camera frames per second actually delivered. */
  fps: number;
  /** Fraction of frames lost to brief tracking flicker (not the hand being lowered). */
  dropout: number;
  /** Relaxed open-hand thumb–index distance (m). */
  openPinch: number;
  /** Relaxed index extension (m). */
  openCurl: number;
  /** Apparent hand size (wrist → middle knuckle, camera heights); undefined in old recordings. */
  scale?: number;
  n: number;
}

/** Absences up to this long are tracking flicker; longer ones are the user lowering the hand. */
const FLICKER_MS = 250;

/**
 * @param still contiguous present samples while the hand was held still
 * @param all every frame of the step (present or not), for fps and flicker
 */
export function measureStill(still: readonly RawMeasure[], all: readonly RawMeasure[]): StillStats | null {
  if (still.length < 12 || all.length < 12) return null;
  // Noise from first differences: robust to slow drift. For white noise, std(Δ) = √2·σ.
  const dx: number[] = [];
  const dy: number[] = [];
  for (let i = 1; i < still.length; i++) {
    dx.push((still[i].x - still[i - 1].x) * still[i].aspect); // x in camera-height units
    dy.push(still[i].y - still[i - 1].y);
  }
  const jitter = Math.sqrt((std(dx) ** 2 + std(dy) ** 2) / 2) / Math.SQRT2;

  // FPS from the median frame interval, so one stall doesn't drag it down.
  const intervals: number[] = [];
  for (let i = 1; i < all.length; i++) intervals.push(all[i].t - all[i - 1].t);
  const fps = 1000 / Math.max(median(intervals), 1);

  // Flicker: short absences after the hand first appeared.
  const first = all.findIndex((m) => m.present);
  const seen = first < 0 ? [] : all.slice(first);
  let flicker = 0;
  for (let i = 0; i < seen.length; ) {
    if (seen[i].present) {
      i++;
      continue;
    }
    let j = i;
    while (j < seen.length && !seen[j].present) j++;
    const end = j < seen.length ? seen[j].t : seen[seen.length - 1].t;
    if (end - seen[i].t <= FLICKER_MS && j < seen.length) flicker += j - i;
    i = j;
  }

  return {
    jitter,
    fps,
    dropout: seen.length ? flicker / seen.length : 0,
    openPinch: median(still.map((m) => m.pinch)),
    openCurl: median(still.map((m) => m.curl)),
    scale: still.some((m) => m.scale !== undefined) ? median(still.filter((m) => m.scale !== undefined).map((m) => m.scale!)) : undefined,
    n: still.length,
  };
}

// ─── step 2: comfortable reach → comfort box ────────────────────────────────

export interface ReachStats {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  aspect: number;
  n: number;
  /** How far the hand extends beyond the fingertip (median; normalized). Absent in old recordings. */
  extent?: { above: number; below: number; left: number; right: number };
}

export function measureReach(samples: readonly RawMeasure[]): ReachStats | null {
  const p = samples.filter((m) => m.present);
  if (p.length < 20) return null;
  const xs = p.map((m) => m.x);
  const ys = p.map((m) => m.y);
  // 5th–95th percentile: the space the hand actually lives in, not one stray flick.
  const withBox = p.filter((m) => m.bbox);
  return {
    x0: percentile(xs, 0.05),
    x1: percentile(xs, 0.95),
    y0: percentile(ys, 0.05),
    y1: percentile(ys, 0.95),
    aspect: median(p.map((m) => m.aspect)),
    n: p.length,
    extent:
      withBox.length >= 20
        ? {
            above: median(withBox.map((m) => Math.max(0, m.y - m.bbox![1]))),
            below: median(withBox.map((m) => Math.max(0, m.bbox![3] - m.y))),
            left: median(withBox.map((m) => Math.max(0, m.x - m.bbox![0]))),
            right: median(withBox.map((m) => Math.max(0, m.bbox![2] - m.x))),
          }
        : undefined,
  };
}

/** Keep the whole hand at least this far inside the frame (normalized). */
const FRAME_MARGIN = 0.05;

/**
 * Keep the box where the WHOLE hand stays in frame when the fingertip is at any box
 * edge. Real recording (slouched): the box put the screen's bottom where the wrist
 * left the frame, and tracking glitched there. Shift first; shrink height only if the
 * hand can't fit otherwise (never below 0.2).
 */
function fitInFrame(box: ComfortBox, r: ReachStats, viewAspect: number): ComfortBox {
  const e = r.extent;
  if (!e) return box;
  const b = { ...box };
  const top = FRAME_MARGIN + e.above;
  const bottom = 1 - FRAME_MARGIN - e.below;
  if (bottom - top < b.size) b.size = Math.max(bottom - top, 0.2);
  b.cy = clamp(b.cy, top + b.size / 2, Math.max(top + b.size / 2, bottom - b.size / 2));
  const w = (b.size * viewAspect) / r.aspect / (b.stretch ?? 1);
  const left = FRAME_MARGIN + e.left;
  const right = 1 - FRAME_MARGIN - e.right;
  b.cx = clamp(b.cx, left + w / 2, Math.max(left + w / 2, right - w / 2));
  return b;
}

/** Portion of the measured reach the box uses, so the edges are reachable without straining. */
const REACH_MARGIN = 0.9;
/** Smallest box (camera-height fraction): caps cursor gain. */
const MIN_BOX = 0.3;
/**
 * The screen should span at least this many hand-lengths (wrist → middle knuckle) of
 * movement. Real recordings: landmark noise is ~0.02 hand-lengths per frame at ANY
 * distance, so precision depends on travel measured in hand-lengths. The best session
 * (92% hits, "most comfortable") spanned 3.2; the worst spanned 1.3.
 */
export const TRAVEL_HANDS = 3;
/** Smallest reach (camera-height units) we believe; anything less means "didn't really move". */
const MIN_REACH = 0.12;

/**
 * The box must fit inside the reach on BOTH axes (so every screen edge is reachable).
 * Box width in camera-height units = size · viewAspect / stretch. Use as much height
 * as the reach allows; if the width then doesn't fit, stretch x (up to MAX_STRETCH)
 * before giving up height. A taller box means less vertical gain and a calmer cursor.
 */
export function boxFromReach(r: ReachStats, viewAspect: number, handScale?: number): ComfortBox | null {
  const yRange = r.y1 - r.y0;
  const xRange = (r.x1 - r.x0) * r.aspect; // in camera-height units
  if (yRange < MIN_REACH || xRange < MIN_REACH) return null;
  // Precision floor: at least TRAVEL_HANDS hand-lengths, even if the user's demonstrated
  // reach was smaller (fitInFrame may still shrink it if the frame can't hold it).
  const size = Math.max(
    REACH_MARGIN * Math.min(yRange, (xRange * MAX_STRETCH) / viewAspect),
    handScale ? TRAVEL_HANDS * handScale : 0,
  );
  const stretch = clamp((size * viewAspect) / (REACH_MARGIN * xRange), 1, MAX_STRETCH);
  return fitInFrame({
    cx: clamp((r.x0 + r.x1) / 2, 0.2, 0.8),
    cy: clamp((r.y0 + r.y1) / 2, 0.2, 0.8),
    // Floor 0.30: every real calibration hit the old 0.25 floor, where 1% of camera
    // height = 30 px of cursor and aiming noise was 45–180 px. Precision beats reach.
    size: clamp(size, MIN_BOX, 0.9),
    stretch,
  }, r, viewAspect);
}

/**
 * The end of the reach step is excluded from the "open hand" distribution: users
 * start closing their fingers in anticipation of the pinch step (seen in real
 * recordings: 3.7–4.5 cm gaps in the last ~600 ms).
 */
export const REACH_ANTICIPATION_MS = 700;

/**
 * Removes deliberate pinches from a stream, leaving only natural movement. Users
 * sometimes pinch mid-step (seen in a real recording: 2.8 cm for half a second
 * during the reach step); counting that as a "relaxed hand" would make the fingers
 * look like they naturally come within 2.8 cm and ruin the threshold estimate.
 * A segment below 75% of baseline is dropped if ≥ MIN_PINCH_FRAMES of it go below 55%.
 */
export function stripPinches(samples: readonly RawMeasure[], baseline: number): RawMeasure[] {
  const out: RawMeasure[] = [];
  let seg: RawMeasure[] = [];
  const flush = () => {
    if (seg.filter((m) => m.pinch < baseline * 0.55).length < MIN_PINCH_FRAMES) out.push(...seg);
    seg = [];
  };
  for (const m of samples) {
    if (m.present && m.pinch < baseline * 0.75) {
      seg.push(m);
      continue;
    }
    flush();
    out.push(m);
  }
  flush();
  return out;
}

/** Natural, non-pinching movement from the reach step: the open-hand distribution. */
export function naturalMovement(reach: readonly RawMeasure[], baseline: number): RawMeasure[] {
  const end = reach.at(-1)?.t ?? 0;
  return stripPinches(
    reach.filter((m) => m.t < end - REACH_ANTICIPATION_MS),
    baseline,
  ).filter((m) => m.present);
}

// ─── step 3: pinches ────────────────────────────────────────────────────────

export interface PinchEvent {
  /** Closest thumb–index distance reached (m). */
  min: number;
  /** Index extension at that moment (m). */
  curl: number;
}

/** Fist ≈ 0.3 × open index extension, pinch ≈ 0.7× (measured on real photos). */
const FIST_CURL_RATIO = 0.5;
/** A deliberate pinch lasts ≥ ~100 ms; 1–2-frame dips are noise or flicks. */
const MIN_PINCH_FRAMES = 3;

/**
 * Counts deliberate pinches RELATIVE to the user's own open hand, not with the
 * thresholds being calibrated, so calibration never depends on its own output.
 * - starts disarmed: a hand that begins the step half-closed must open first
 * - ignores closures shorter than MIN_PINCH_FRAMES
 * - rejects fists (index curled into the palm), which would teach the fist guard wrong
 */
export class RelativePinchCounter {
  private armed = false;
  private inPinch = false;
  private frames = 0;
  private current: PinchEvent = { min: Infinity, curl: 0 };
  /** Closures rejected as fists. */
  rejected = 0;

  constructor(
    readonly baseline: number,
    private openCurl = 0,
    private enterRatio = 0.55,
    private exitRatio = 0.75,
  ) {}

  /** 0..1 progress toward a pinch (UI feedback). */
  closure(pinch: number): number {
    return clamp((this.baseline - pinch) / (this.baseline * (1 - this.enterRatio)), 0, 1);
  }

  push(m: RawMeasure): PinchEvent | null {
    if (!m.present) return null;
    const enter = this.baseline * this.enterRatio;
    const exit = this.baseline * this.exitRatio;
    if (!this.armed) {
      if (m.pinch > exit) this.armed = true;
      return null;
    }
    if (!this.inPinch) {
      if (m.pinch < enter) {
        this.inPinch = true;
        this.frames = 1;
        this.current = { min: m.pinch, curl: m.curl };
      }
      return null;
    }
    if (m.pinch <= exit) {
      this.frames++;
      if (m.pinch < this.current.min) this.current = { min: m.pinch, curl: m.curl };
      return null;
    }

    this.inPinch = false;
    if (this.frames < MIN_PINCH_FRAMES) return null;
    if (this.openCurl && this.current.curl < this.openCurl * FIST_CURL_RATIO) {
      this.rejected++;
      return null;
    }
    return this.current;
  }

  get pinching(): boolean {
    return this.inPinch;
  }
}

export interface PinchCalibration {
  pressAt: number;
  releaseAt: number;
  openAt: number;
  curlAt: number;
}

/** When raising the threshold, clear the chosen pinch by this much (m). */
const CLOSED_MARGIN = 0.006;
/** A pinch counts as caught if it closes this far below the threshold (m). */
const CATCH_MARGIN = 0.001;
/** Always stay this far below how close relaxed fingers get (m). */
const OPEN_MARGIN = 0.004;
/** Raise the threshold only if the default would catch fewer than this share of pinches. */
const MAJORITY = 2 / 3;

/**
 * Press threshold = the evidence-based default, moved only as far as this session
 * proves necessary. Findings from 11 real recordings:
 * - Pinch closure (2.2–4.3 cm) and relaxed posture (4.1–8 cm) shift between sessions,
 *   and overlap by a few mm across sessions. Fitting one 10-second session tightly
 *   overfits.
 * - LOWERING is always safe (relaxed fingers came close → avoid false clicks).
 * - RAISING to catch a session's loosest pinch caused false clicks in other sessions.
 *   A missed pinch is recoverable (pinch firmer, and the cursor squeeze shows how
 *   close you are); a false click is not. So raise only when the default misses most
 *   of this session's pinches (a genuinely loose pincher).
 *
 * @param open thumb–index distances during natural, non-pinching movement, in time order
 * @param events deliberate pinches
 */
export function pinchFromEvents(open: readonly number[], events: readonly PinchEvent[]): PinchCalibration | null {
  if (events.length < 2 || open.length < 20) return null;
  // How close fingers get when NOT pinching, as the detector sees it (a percentile
  // let a real session's closest 2% of frames, which arrive in runs, false-click).
  const openLow = sustainedMin(open, DEFAULT_PINCH.confirmFrames);
  const mins = events.map((e) => e.min).sort((a, b) => a - b);
  const need = Math.ceil(mins.length * MAJORITY);
  const caught = (press: number) => mins.filter((m) => m < press - CATCH_MARGIN).length;

  let pressAt = DEFAULT_PINCH.pressAt;
  if (caught(pressAt) < need) pressAt = mins[need - 1] + CLOSED_MARGIN; // loose pincher
  pressAt = Math.min(pressAt, openLow - OPEN_MARGIN); // relaxed fingers come close
  if (caught(pressAt) < need || pressAt < 0.02) return null; // no safe threshold: keep current

  const defaultHyst = DEFAULT_PINCH.releaseAt - DEFAULT_PINCH.pressAt;
  const room = Math.max(openLow - pressAt, 0);
  const releaseAt = Math.min(pressAt + clamp(room * 0.5 + 0.004, 0.006, defaultHyst), 0.08);
  const openAt = clamp(median(open), releaseAt + 0.01, 0.13);
  // Fist guard must sit safely below this user's pinching curl (so real pinches
  // are never rejected), but not so low it stops catching fists (~2.3–2.9 cm).
  const pinchCurl = Math.min(...events.map((e) => e.curl));
  const curlAt = clamp(pinchCurl * 0.75, 0.02, 0.045);
  return { pressAt, releaseAt, openAt, curlAt };
}

// ─── combine ────────────────────────────────────────────────────────────────

export interface CalibrationParts {
  still: StillStats | null;
  box: ComfortBox | null;
  pinch: PinchCalibration | null;
}

export interface CalibrationOutcome {
  tuning: CameraTuning;
  /** One line per parameter group: what was set, or why it was kept. */
  notes: string[];
}

/**
 * Merges estimates into a copy of `base`. Parameters without trustworthy data keep
 * their current values.
 * @param viewH viewport height in px, to express jitter in on-screen pixels
 */
export function buildTuning(base: CameraTuning, parts: CalibrationParts, viewH: number): CalibrationOutcome {
  const t: CameraTuning = structuredClone(base);
  const notes: string[] = [];

  if (parts.box) {
    t.box = parts.box;
    notes.push(
      `reach: box ${parts.box.size.toFixed(2)} at (${parts.box.cx.toFixed(2)}, ${parts.box.cy.toFixed(2)}), x-stretch ${(parts.box.stretch ?? 1).toFixed(2)}`,
    );
  } else notes.push('reach: kept (not enough movement)');

  if (parts.still) {
    const s = parts.still;
    // Jitter as it will appear on screen with the (new) box.
    const jitterPx = (s.jitter / t.box.size) * viewH;
    // Noisier signal (dim light, low-res camera) → smooth harder at rest.
    t.minCutoff = clamp(1.6 * Math.pow(1 / Math.max(jitterPx, 0.25), 0.7), 0.4, 2.0);
    t.predictMs = clamp(1000 / s.fps, 16, 40);
    t.graceMs = clamp(200 + s.dropout * 1000, 150, 400);
    if (s.scale) t.calibratedScale = s.scale;
    notes.push(
      `still: jitter ${jitterPx.toFixed(2)} px → cutoff ${t.minCutoff.toFixed(2)}; ${s.fps.toFixed(0)} fps → predict ${t.predictMs.toFixed(0)} ms; flicker ${(s.dropout * 100).toFixed(0)}% → grace ${t.graceMs.toFixed(0)} ms`,
    );
  } else notes.push('still: kept (hand not held still long enough)');

  if (parts.pinch) {
    const p = parts.pinch;
    t.pinch = { ...t.pinch, pressAt: p.pressAt, releaseAt: p.releaseAt, openAt: p.openAt };
    t.curlAt = p.curlAt;
    notes.push(
      `pinch: press ${(p.pressAt * 100).toFixed(1)} cm, release ${(p.releaseAt * 100).toFixed(1)} cm, open ${(p.openAt * 100).toFixed(1)} cm, fist below ${(p.curlAt * 100).toFixed(1)} cm`,
    );
  } else notes.push('pinch: kept (pinches not clearly separable)');

  return { tuning: t, notes };
}

export interface StepSamples {
  still: readonly RawMeasure[];
  reach: readonly RawMeasure[];
  pinch: readonly RawMeasure[];
}

export interface CalibrationEstimate extends CalibrationOutcome {
  still: StillStats | null;
  box: ComfortBox | null;
  pinch: PinchCalibration | null;
  events: PinchEvent[];
  baseline: number;
  rejectedFists: number;
}

/** Fallback open-hand baseline (m) if the still step didn't produce one. */
const FALLBACK_BASELINE = 0.085;

export function pinchBaseline(still: StillStats | null): number {
  return still && still.openPinch > 0.045 ? still.openPinch : FALLBACK_BASELINE;
}

/**
 * Everything, from raw per-step samples. Deterministic: the same samples always
 * give the same tuning, so a recording can be replayed to reproduce a calibration.
 */
export function estimateCalibration(
  steps: StepSamples,
  base: CameraTuning,
  view: { w: number; h: number },
): CalibrationEstimate {
  const win = new StillWindow();
  let stillBuf: RawMeasure[] = [];
  for (const m of steps.still) {
    if (win.push(m) >= 1) {
      stillBuf = win.buf;
      break;
    }
  }
  const still = stillBuf.length ? measureStill(stillBuf, steps.still) : null;

  const reach = measureReach(steps.reach);
  const box = reach ? boxFromReach(reach, view.w / view.h, still?.scale) : null;

  const baseline = pinchBaseline(still);
  const counter = new RelativePinchCounter(baseline, still?.openCurl ?? 0);
  const events: PinchEvent[] = [];
  for (const m of steps.pinch) {
    const e = counter.push(m);
    if (e) events.push(e);
  }

  const open = [...stillBuf.map((m) => m.pinch), ...naturalMovement(steps.reach, baseline).map((m) => m.pinch)];
  const pinch = pinchFromEvents(open, events);

  return {
    ...buildTuning(base, { still, box, pinch }, view.h),
    still,
    box,
    pinch,
    events,
    baseline,
    rejectedFists: counter.rejected,
  };
}
