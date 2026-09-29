import { Emitter } from '../lib/emitter';
import { clamp, lowPassAlpha, smoothstep } from '../lib/math';
import type { TrackerFrame } from '../tracking/types';
import type { HandDriver, HandSample, TrackingState } from './Hand';
import { DEFAULT_BOX, mapToViewport, type ComfortBox } from './mapping';
import { OneEuroFilter } from './OneEuro';
import { DEFAULT_PINCH, PinchDetector, type PinchConfig } from './pinch';

export interface CameraTuning {
  /** One Euro: jitter vs. lag. */
  minCutoff: number;
  beta: number;
  /** Max ms to extrapolate between camera frames (render rate > camera rate). */
  predictMs: number;
  /** Detection gap tolerated before the hand counts as lost. */
  graceMs: number;
  /** After this long lost, go back to "searching" (raise your hand). */
  searchAfterMs: number;
  /** Pinch strength where cursor damping begins (drift lock). */
  dampStart: number;
  /** 0..1 fraction of motion absorbed at full pinch strength. */
  dampMax: number;
  /** Time constant for the drift offset to melt away after release. */
  offsetDecayMs: number;
  /** On press/release, rewind the cursor to where the fingers started closing/opening (max this far back). */
  rewindMs: number;
  /**
   * Hold stabilizer (px): while pinched, the cursor ignores hand wobble within this
   * radius of where the press happened. Landmarks get noisier while the fingertips
   * touch; without this a held pinch drifts off small targets. Beyond the radius the
   * cursor follows continuously (drag), trailing by the radius. Kept near the noise
   * level (8 px): with release-selects, users make small corrections while holding.
   */
  holdRadius: number;
  /**
   * 0..1: as the pinch closes, move the tracked point from the index tip to the index
   * knuckle (keeping the offset, so there's no jump). The knuckle doesn't move when the
   * fingers close, and while pinched it jitters 27–41% less than the tip (real recordings).
   * OFF by default: replaying real click tests, it scored WORSE (2–6/12 vs 6–11/12),
   * because users correct their aim during a hold by moving the fingertip, which the
   * knuckle doesn't follow. Kept as a debug option.
   */
  anchorBlend: number;
  /** Index tip–knuckle distance (m) below which the finger counts as curled (fist, not pinch). */
  curlAt: number;
  /**
   * Edge guard (fraction of frame): no new press while any landmark is this close to
   * the image border. Real recording (slouched): with the hand at the bottom edge,
   * landmarks glitched into 2-frame fake closures of 2.2–3.9 cm.
   */
  edgeMargin: number;
  /** Apparent hand size when calibrated; a big change means the posture changed. */
  calibratedScale?: number;
  box: ComfortBox;
  pinch: PinchConfig;
}

export const DEFAULT_TUNING: CameraTuning = {
  minCutoff: 1.2,
  beta: 0.012,
  predictMs: 35,
  graceMs: 200,
  searchAfterMs: 2500,
  dampStart: 0.45,
  dampMax: 0.85,
  offsetDecayMs: 180,
  rewindMs: 300,
  holdRadius: 8,
  anchorBlend: 0,
  curlAt: 0.04,
  edgeMargin: 0.03,
  box: { ...DEFAULT_BOX },
  pinch: { ...DEFAULT_PINCH },
};

const VELOCITY_CUTOFF_HZ = 8;
/** Pinch distance must shrink by at least this much per frame to count as "closing". */
const CLOSING_EPS = 0.0015;

interface HistoryEntry {
  t: number;
  x: number;
  y: number;
  d: number;
}
const INDEX_TIP = 8;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const WRIST = 0;
const MIDDLE_MCP = 9;

/**
 * Raw, un-tuned per-frame measurements for calibration. Independent of the current
 * mapping, filter and thresholds, so calibrating is never biased by its own output.
 */
export interface RawMeasure {
  t: number;
  present: boolean;
  /** Index tip, normalized camera coords, x mirrored (user's right = 1). */
  x: number;
  y: number;
  /** Thumb–index tip distance, metres (world space). */
  pinch: number;
  /** Index tip–knuckle distance, metres. */
  curl: number;
  /** Camera width / height. */
  aspect: number;
  /** Hand bounding box [x0, y0, x1, y1], normalized, x mirrored. Absent in old recordings. */
  bbox?: [number, number, number, number];
  /** Apparent hand size: wrist → middle knuckle, in camera heights. Shrinks with distance. */
  scale?: number;
  /** Hand touching the frame edge: landmarks unreliable, pinch not trusted. */
  edge?: boolean;
}

export type FrameSubscribe = (fn: (f: TrackerFrame) => void) => () => void;

/**
 * Interprets tracker frames: map → filter → pinch → drift lock → loss handling.
 * Runs once per camera frame; `sample` extrapolates once per render frame.
 */
export class CameraDriver implements HandDriver {
  readonly source = 'camera' as const;
  readonly pinch: PinchDetector;
  /** Last raw thumb–index distance in metres (debug). */
  pinchDistance = 0;
  /** Last index tip–knuckle distance in metres (debug). */
  indexCurl = 0;
  /** Hand touching the frame edge (debug). */
  atEdge = false;
  /** Smoothed apparent hand size (wrist → middle knuckle, camera heights); 0 = unknown. */
  handScale = 0;

  private state: TrackingState = 'starting';
  private present = false;
  private lastSeen = 0;
  private lostAt = 0;
  private lastT = 0;
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  /** Filtered hand position (before drift offset), viewport px. */
  private px = 0;
  private py = 0;
  private vx = 0;
  private vy = 0;
  /** Drift-lock offset added to the hand position. */
  private ox = 0;
  private oy = 0;
  private damp = 0;
  /** Final cursor output at camera rate (after drift lock, hold stabilizer, rewinds). */
  private cx = 0;
  private cy = 0;
  /** Where the current press happened (hold stabilizer anchor). */
  private pressPos: { x: number; y: number } | null = null;
  private history: HistoryEntry[] = [];
  /** Tip − knuckle, frozen while the anchor blend is active. */
  private lockX = 0;
  private lockY = 0;
  private view: { w: number; h: number };
  private unsubscribe: () => void;
  private measures = new Emitter<{ measure: RawMeasure }>();

  constructor(
    subscribe: FrameSubscribe,
    public tuning: CameraTuning = structuredClone(DEFAULT_TUNING),
    view = { w: 1280, h: 720 },
  ) {
    this.view = view;
    this.fx = new OneEuroFilter(tuning.minCutoff, tuning.beta);
    this.fy = new OneEuroFilter(tuning.minCutoff, tuning.beta);
    this.pinch = new PinchDetector(tuning.pinch);
    this.unsubscribe = subscribe((f) => this.onFrame(f));
  }

  /** Subscribe to raw per-frame measurements (calibration). */
  onMeasure(fn: (m: RawMeasure) => void): () => void {
    return this.measures.on('measure', fn);
  }

  /** Re-read tuning after live edits. */
  applyTuning(): void {
    this.fx.minCutoff = this.fy.minCutoff = this.tuning.minCutoff;
    this.fx.beta = this.fy.beta = this.tuning.beta;
    this.pinch.config = this.tuning.pinch;
  }

  onFrame(f: TrackerFrame): void {
    const t = f.t;
    if (this.state === 'starting') this.state = 'searching';

    if (!f.hand) {
      this.measures.emit('measure', { t, present: false, x: 0, y: 0, pinch: 0, curl: 0, aspect: f.videoW / f.videoH });
      if (this.present && t - this.lastSeen > this.tuning.graceMs) {
        this.present = false;
        this.state = 'lost';
        this.lostAt = t;
        this.pinch.reset();
        this.damp = 0;
      } else if (this.state === 'lost' && t - this.lostAt > this.tuning.searchAfterMs) {
        this.state = 'searching';
      }
      return;
    }

    const first = !this.present;
    if (first) {
      // Fresh acquisition: forget old motion so the cursor doesn't fling.
      this.fx.reset();
      this.fy.reset();
      this.pinch.reset();
      this.vx = this.vy = this.ox = this.oy = this.damp = 0;
      this.history = [];
      this.pressPos = null;
      this.present = true;
      this.state = 'tracking';
    }
    this.lastSeen = t;

    const { landmarks, world } = f.hand;
    const tip = landmarks[INDEX_TIP];
    const knuckle = landmarks[INDEX_MCP];
    // Anchor blend: track the knuckle (plus the frozen tip offset) as the pinch closes.
    // Uses last frame's pinch state; the pinch itself is updated below.
    const blend = this.tuning.anchorBlend * (this.pinch.pressed ? 1 : smoothstep(this.tuning.dampStart, 1, this.pinch.strength));
    if (blend === 0 || first) {
      this.lockX = tip.x - knuckle.x;
      this.lockY = tip.y - knuckle.y;
    }
    const src = {
      x: tip.x + (knuckle.x + this.lockX - tip.x) * blend,
      y: tip.y + (knuckle.y + this.lockY - tip.y) * blend,
    };
    const m = mapToViewport(src.x, src.y, this.tuning.box, { w: f.videoW, h: f.videoH }, this.view);
    let x = this.fx.filter(m.x, t / 1000);
    let y = this.fy.filter(m.y, t / 1000);
    const dt = (t - this.lastT) / 1000;

    const a = world[THUMB_TIP];
    const b = world[INDEX_TIP];
    const k = world[INDEX_MCP];
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    // A fist also brings thumb and index tips together (~3 cm, measured), but its
    // index is curled into the palm. Only an extended-ish index can pinch.
    this.indexCurl = Math.hypot(b.x - k.x, b.y - k.y, b.z - k.z);
    const curled = this.indexCurl < this.tuning.curlAt;

    let x0 = 1;
    let y0 = 1;
    let x1 = 0;
    let y1 = 0;
    for (const p of landmarks) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    const em = this.tuning.edgeMargin;
    this.atEdge = x0 < em || y0 < em || x1 > 1 - em || y1 > 1 - em;
    // Untrusted pinch (fist or hand at the frame edge) can't start a press; a press
    // already held is left to release normally.
    const untrusted = curled || (this.atEdge && !this.pinch.pressed);
    const transition = this.pinch.update(untrusted ? this.tuning.pinch.openAt : this.pinchDistance);

    const aspect = f.videoW / f.videoH;
    const w0 = landmarks[WRIST];
    const w9 = landmarks[MIDDLE_MCP];
    const scale = Math.hypot((w0.x - w9.x) * aspect, w0.y - w9.y);
    this.handScale = this.handScale ? this.handScale + (scale - this.handScale) * 0.05 : scale;
    this.measures.emit('measure', {
      t,
      present: true,
      x: 1 - tip.x,
      y: tip.y,
      pinch: this.pinchDistance,
      curl: this.indexCurl,
      aspect,
      bbox: [1 - x1, y0, 1 - x0, y1],
      scale,
      edge: this.atEdge,
    });

    if (!first && dt > 0) {
      const al = lowPassAlpha(VELOCITY_CUTOFF_HZ, dt);
      this.vx += al * ((x - this.px) / dt - this.vx);
      this.vy += al * ((y - this.py) / dt - this.vy);

      // Drift lock: closing a pinch drags the index tip toward the thumb. Absorb
      // that motion into an offset while the pinch closes, hold it while pressed
      // (so drags are exact), and let it melt away once the hand opens again.
      this.damp = this.pinch.pressed ? 1 : smoothstep(this.tuning.dampStart, 1, this.pinch.strength);
      if (!this.pinch.pressed) {
        const absorbed = this.tuning.dampMax * this.damp;
        this.ox -= (x - this.px) * absorbed;
        this.oy -= (y - this.py) * absorbed;
        const decay = Math.exp(((-dt * 1000) / this.tuning.offsetDecayMs) * (1 - this.damp));
        this.ox *= decay;
        this.oy *= decay;
      }
    }

    // Rewind: damping catches most of the pinch drift, but the tip starts sliding
    // the moment the fingers start closing. On press, put the cursor back where it
    // was when the closing motion began — that's where the user was aiming.
    if (transition === 'press') {
      const anchor = this.closingStart(t);
      if (anchor) {
        // Also snap the filter to the raw position: otherwise its lag from the
        // closing motion keeps sliding the cursor for a few frames after the press.
        this.fx.reset();
        this.fy.reset();
        x = this.fx.filter(m.x, t / 1000);
        y = this.fy.filter(m.y, t / 1000);
        this.ox = anchor.x - x;
        this.oy = anchor.y - y;
      }
      this.pressPos = { x: x + this.ox, y: y + this.oy };
    }

    let cx = x + this.ox;
    let cy = y + this.oy;

    // Hold stabilizer: a soft dead zone around the press point (continuous, no jump
    // when leaving it, so a deliberate drag just starts moving).
    if (this.pinch.pressed && this.pressPos) {
      const dx = cx - this.pressPos.x;
      const dy = cy - this.pressPos.y;
      const d = Math.hypot(dx, dy);
      const k = d > this.tuning.holdRadius ? (d - this.tuning.holdRadius) / d : 0;
      cx = this.pressPos.x + dx * k;
      cy = this.pressPos.y + dy * k;
    }

    // Release rewind, mirroring the press: opening the fingers moves the index tip,
    // and the release only registers once they're well apart. Put the cursor back
    // where it was when the opening began, so the click lands where it was held.
    if (transition === 'release') {
      const anchor = this.openingStart(t) ?? { x: cx, y: cy };
      this.ox = anchor.x - x;
      this.oy = anchor.y - y;
      cx = anchor.x;
      cy = anchor.y;
      this.pressPos = null;
    }

    this.px = x;
    this.py = y;
    this.cx = cx;
    this.cy = cy;
    this.lastT = t;
    this.history.push({ t, x: cx, y: cy, d: this.pinchDistance });
    while (this.history.length && t - this.history[0].t > this.tuning.rewindMs) this.history.shift();
  }

  /** The cursor position just before the current pinch started closing. */
  private closingStart(now: number): HistoryEntry | null {
    const h = this.history;
    let i = h.length - 1;
    if (i < 0) return null;
    // Skip frames where the pinch was already (nearly) closed, e.g. confirm frames.
    while (i > 0 && h[i].d <= this.tuning.pinch.pressAt) i--;
    // Walk back while the distance was still shrinking.
    while (i > 0 && h[i - 1].d > h[i].d + CLOSING_EPS && now - h[i - 1].t <= this.tuning.rewindMs) i--;
    return h[i];
  }

  /** The cursor position just before the current pinch started opening. */
  private openingStart(now: number): HistoryEntry | null {
    const h = this.history;
    let i = h.length - 1;
    if (i < 0) return null;
    // Walk back while the distance was still growing (i.e. the fingers were opening).
    while (i > 0 && h[i - 1].d < h[i].d - CLOSING_EPS && now - h[i - 1].t <= this.tuning.rewindMs) i--;
    return h[i];
  }

  sample(now: number, view: { w: number; h: number }): HandSample {
    this.view = view;
    // Extrapolate between camera frames, but not while pinching: prediction would
    // re-introduce exactly the drift the lock removes.
    const ahead = (clamp(now - this.lastT, 0, this.tuning.predictMs) / 1000) * (1 - this.damp);
    return {
      state: this.state,
      present: this.present,
      x: clamp(this.cx + this.vx * ahead, 0, view.w),
      y: clamp(this.cy + this.vy * ahead, 0, view.h),
      vx: this.vx,
      vy: this.vy,
      pinchStrength: this.pinch.strength,
      pressed: this.pinch.pressed,
      nearEdge: this.atEdge,
    };
  }

  dispose(): void {
    this.unsubscribe();
  }
}
