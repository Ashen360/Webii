import type { CameraDriver, CameraTuning, RawMeasure } from '../input/CameraDriver';
import {
  boxFromReach,
  estimateCalibration,
  measureReach,
  measureStill,
  pinchBaseline,
  RelativePinchCounter,
  StillWindow,
  type CalibrationOutcome,
  type PinchEvent,
  type StepSamples,
  type StillStats,
} from '../input/calibration';
import type { Hand } from '../input/Hand';
import type { ComfortBox } from '../input/mapping';

/**
 * Auto-calibration flow: hold still → show your space → pinch ×3 → done.
 * As the first-time onboarding (`onboarding: true`) it ends with a "try it" step:
 * point at a dot and pinch it, using the calibration just made.
 */

type Step = 'still' | 'reach' | 'pinch' | 'done' | 'try';

const REACH_MS = 4500;
const PINCHES = 3;
const PINCH_TIMEOUT_MS = 15000;
const DONE_GUARD_MS = 700;

/**
 * Compact sample: [t (ms since start), present, x, y, pinch (m), curl (m),
 *   bbox x0, y0, x1, y1, scale, edge]. The last six are absent in older recordings.
 */
export type Compact = [number, 0 | 1, number, number, number, number, ...number[]];

export function compact(m: RawMeasure, t0: number): Compact {
  const r = (v: number) => +v.toFixed(5);
  const base: Compact = [Math.round((m.t - t0) * 10) / 10, m.present ? 1 : 0, r(m.x), r(m.y), r(m.pinch), r(m.curl)];
  if (m.bbox && m.scale !== undefined) base.push(...m.bbox.map(r), r(m.scale), m.edge ? 1 : 0);
  return base;
}

export function decode(c: Compact, aspect: number): RawMeasure {
  const [t, present, x, y, pinch, curl, x0, y0, x1, y1, scale, edge] = c;
  const m: RawMeasure = { t, present: present === 1, x, y, pinch, curl, aspect };
  if (scale !== undefined) {
    m.bbox = [x0, y0, x1, y1];
    m.scale = scale;
    m.edge = edge === 1;
  }
  return m;
}

export interface CalibrationRecord {
  version: 1;
  createdAt: string;
  /** performance.now() origin of sample times (absolute = t0 + t). */
  t0: number;
  userAgent: string;
  viewport: { w: number; h: number; dpr: number };
  camera: { aspect: number };
  before: CameraTuning;
  after: CameraTuning;
  notes: string[];
  estimates: {
    still: StillStats | null;
    box: ComfortBox | null;
    pinchEvents: PinchEvent[];
    openBaseline: number;
    rejectedFists: number;
  };
  samples: Record<'still' | 'reach' | 'pinch', Compact[]>;
}

/** Recording → raw step samples, for replaying a calibration through estimateCalibration. */
export function recordSamples(record: CalibrationRecord): StepSamples {
  const d = (c: Compact[]) => c.map((x) => decode(x, record.camera.aspect));
  return { still: d(record.samples.still), reach: d(record.samples.reach), pinch: d(record.samples.pinch) };
}

export interface CalibrationOptions {
  driver: CameraDriver;
  hand: Hand;
  video: HTMLVideoElement;
  onFinish: (outcome: CalibrationOutcome, record: CalibrationRecord) => void;
  onClose: () => void;
  /** First-time onboarding: friendlier flow ending with a "pinch the dot" try-out. */
  onboarding?: boolean;
  /** Lets the host make a region hand-interactive (the try-out dot), or none. */
  setInteractive?: (scope: HTMLElement | null) => void;
}

const COPY: Record<Step, { title: string; sub: string }> = {
  still: { title: 'Raise your hand', sub: 'Hold it still for a moment.' },
  reach: {
    title: 'Show me your space',
    sub: 'Move your hand around the area that feels comfortable: up, down, left and right.',
  },
  pinch: { title: `Pinch ${PINCHES} times`, sub: 'Touch your thumb and index fingertips together, then open.' },
  done: { title: 'All set', sub: 'Pinch (or click Done) to try it.' },
  try: { title: 'Now point at the dot', sub: 'Pinch, then release on it.' },
};

export class Calibration {
  readonly el: HTMLElement;
  private stage: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private titleEl: HTMLElement;
  private subEl: HTMLElement;
  private bar: HTMLElement;
  private bubbles: HTMLElement;
  private notesEl: HTMLElement;
  private actions: HTMLElement;
  private offs: (() => void)[] = [];

  private step: Step = 'still';
  private t0 = 0;
  private progress = 0;
  private aspect = 4 / 3;
  private last: RawMeasure | null = null;
  private hint = '';

  // data
  private rec: Record<'still' | 'reach' | 'pinch', Compact[]> = { still: [], reach: [], pinch: [] };
  /** Raw samples per step: the single source for the final estimate. */
  private raw: { still: RawMeasure[]; reach: RawMeasure[]; pinch: RawMeasure[] } = { still: [], reach: [], pinch: [] };
  private stillWin = new StillWindow();
  /** Live still estimate, only used for the pinch step's baseline. */
  private still: StillStats | null = null;
  private reachSamples: RawMeasure[] = [];
  private reachTime = 0;
  private liveBox: ComfortBox | null = null;
  private counter: RelativePinchCounter | null = null;
  private events: PinchEvent[] = [];
  private doneAt = 0;
  private hintUntil = 0;

  constructor(private o: CalibrationOptions) {
    this.el = document.createElement('div');
    this.el.className = 'calib';
    this.el.innerHTML = `
      <div class="calib-card">
        <ol class="calib-steps"><li></li><li></li><li></li></ol>
        <h2 class="calib-title"></h2>
        <p class="calib-sub"></p>
        <div class="calib-stage"><canvas></canvas><div class="calib-bubbles"></div></div>
        <div class="calib-try"><button class="calib-dot" data-hit data-hit-shape="circle" aria-label="The dot"></button></div>
        <div class="calib-bar"><i></i></div>
        <pre class="calib-notes" hidden></pre>
        <div class="calib-actions"></div>
      </div>`;
    this.stage = this.el.querySelector('canvas')!;
    this.ctx = this.stage.getContext('2d')!;
    this.titleEl = this.el.querySelector('.calib-title')!;
    this.subEl = this.el.querySelector('.calib-sub')!;
    this.bar = this.el.querySelector('.calib-bar i')!;
    this.bubbles = this.el.querySelector('.calib-bubbles')!;
    this.notesEl = this.el.querySelector('.calib-notes')!;
    this.actions = this.el.querySelector('.calib-actions')!;
    if (o.onboarding) {
      this.el.classList.add('is-onboarding');
      this.el.querySelector('.calib-steps')!.innerHTML = '<li></li>'.repeat(4);
    }
    this.el.querySelector('.calib-dot')!.addEventListener('click', () => this.tried());
    document.body.append(this.el);
    document.body.classList.add('is-calibrating');

    this.offs.push(o.driver.onMeasure((m) => this.onMeasure(m)));
    this.offs.push(
      o.hand.on('pinchstart', () => {
        if (this.step === 'done' && performance.now() - this.doneAt > DONE_GUARD_MS) this.close();
      }),
    );
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && this.close();
    addEventListener('keydown', esc);
    this.offs.push(() => removeEventListener('keydown', esc));

    this.t0 = performance.now();
    this.enter('still');
  }

  close(): void {
    this.o.setInteractive?.(null);
    this.offs.forEach((f) => f());
    this.el.remove();
    document.body.classList.remove('is-calibrating');
    this.o.onClose();
  }

  // ─── flow ─────────────────────────────────────────────────────────────────

  private enter(step: Step): void {
    this.step = step;
    this.progress = 0;
    this.hint = '';
    this.el.dataset.step = step;
    const idx = ['still', 'reach', 'pinch', this.o.onboarding ? 'try' : 'done'].indexOf(step);
    this.el.querySelectorAll('.calib-steps li').forEach((li, i) => {
      li.classList.toggle('is-done', i < idx);
      li.classList.toggle('is-now', i === idx);
    });
    this.titleEl.textContent = COPY[step].title;
    this.subEl.textContent = COPY[step].sub;
    this.titleEl.classList.remove('enter');
    void this.titleEl.offsetWidth;
    this.titleEl.classList.add('enter');

    if (step === 'pinch') {
      // Baseline from the still step; a sane fallback if that step gave up.
      this.counter = new RelativePinchCounter(pinchBaseline(this.still), this.still?.openCurl ?? 0);
      this.bubbles.innerHTML = '<span></span>'.repeat(PINCHES);
    }
    this.renderActions();
  }

  private renderActions(): void {
    this.actions.replaceChildren();
    const btn = (label: string, fn: () => void, primary = false) => {
      const b = document.createElement('button');
      b.className = primary ? 'btn btn-primary' : 'btn';
      b.textContent = label;
      b.addEventListener('click', fn);
      this.actions.append(b);
    };
    if (this.step === 'try') {
      btn('Skip', () => this.close());
    } else if (this.step === 'done') {
      btn('Redo', () => this.restart());
      btn('Done', () => this.close(), true);
    } else {
      btn(this.o.onboarding ? 'Skip setup' : 'Cancel', () => this.close());
      if (this.step !== 'still') btn('Skip step', () => this.advance());
    }
  }

  private restart(): void {
    this.rec = { still: [], reach: [], pinch: [] };
    this.raw = { still: [], reach: [], pinch: [] };
    this.stillWin = new StillWindow();
    this.still = this.liveBox = null;
    this.reachSamples = [];
    this.reachTime = 0;
    this.events = [];
    this.notesEl.hidden = true;
    this.bubbles.replaceChildren();
    this.t0 = performance.now();
    this.enter('still');
  }

  private advance(): void {
    if (this.step === 'still') {
      this.enter('reach');
    } else if (this.step === 'reach') {
      this.enter('pinch');
    } else if (this.step === 'pinch') {
      this.finish();
    }
  }

  private finish(): void {
    const before = structuredClone(this.o.driver.tuning);
    // Recompute everything from the raw samples: identical to replaying the recording.
    const est = estimateCalibration(this.raw, before, { w: innerWidth, h: innerHeight });
    const outcome: CalibrationOutcome = { tuning: est.tuning, notes: est.notes };
    const record: CalibrationRecord = {
      version: 1,
      createdAt: new Date().toISOString(),
      t0: this.t0,
      userAgent: navigator.userAgent,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      camera: { aspect: this.aspect },
      before,
      after: outcome.tuning,
      notes: outcome.notes,
      estimates: {
        still: est.still,
        box: est.box,
        pinchEvents: est.events,
        openBaseline: est.baseline,
        rejectedFists: est.rejectedFists,
      },
      samples: this.rec,
    };
    this.o.onFinish(outcome, record);
    if (this.o.onboarding) {
      // Try the fresh calibration on a real target.
      this.enter('try');
      this.o.setInteractive?.(this.el);
      // Measuring hid the cursor; now it's needed to point at the dot.
      document.body.classList.remove('is-calibrating');
      return;
    }
    this.enter('done');
    this.doneAt = performance.now();
    this.notesEl.hidden = false;
    this.notesEl.textContent = outcome.notes.join('\n');
  }

  private tried(): void {
    if (this.step !== 'try') return;
    this.o.setInteractive?.(null);
    this.titleEl.textContent = 'Perfect!';
    this.subEl.textContent = 'Welcome to Webii.';
    this.el.classList.add('is-perfect');
    this.actions.replaceChildren();
    setTimeout(() => this.close(), 1100);
  }

  // ─── measurement ──────────────────────────────────────────────────────────

  private onMeasure(m: RawMeasure): void {
    this.aspect = m.aspect;
    this.last = m;
    if (this.step === 'done' || this.step === 'try') return;
    this.rec[this.step].push(compact(m, this.t0));
    this.raw[this.step].push(m);
    if (this.step === 'still') this.onStill(m);
    else if (this.step === 'reach') this.onReach(m);
    else if (this.step === 'pinch') this.onPinch(m);
  }

  private onStill(m: RawMeasure): void {
    this.progress = this.stillWin.push(m);
    this.hint =
      this.stillWin.hint === 'raise' ? 'Raise your hand so the camera can see it.' : this.stillWin.hint === 'hold' ? 'Hold still…' : '';
    if (this.progress >= 1) {
      this.still = measureStill(this.stillWin.buf, this.raw.still);
      this.advance();
    }
  }

  private onReach(m: RawMeasure): void {
    const prev = this.reachSamples.at(-1);
    if (!m.present) {
      this.hint = 'Keep your hand in view.';
      return;
    }
    this.hint = m.edge ? 'Your hand is at the edge of the camera view. Stay a little inside it.' : '';
    if (prev) this.reachTime += Math.min(m.t - prev.t, 100);
    this.reachSamples.push(m);
    if (this.reachSamples.length % 6 === 0) {
      const r = measureReach(this.reachSamples);
      this.liveBox = r ? boxFromReach(r, innerWidth / innerHeight) : null;
    }
    this.progress = this.reachTime / REACH_MS;
    if (this.progress >= 1) this.advance();
  }

  private onPinch(m: RawMeasure): void {
    const c = this.counter!;
    const rejectedBefore = c.rejected;
    const ev = c.push(m);
    if (c.rejected > rejectedBefore) this.hintUntil = m.t + 2000;
    this.hint = !m.present
      ? 'Keep your hand in view.'
      : m.t < this.hintUntil
        ? 'That looked like a fist. Touch just the fingertips together.'
        : '';
    if (ev) {
      this.events.push(ev);
      this.bubbles.children[this.events.length - 1]?.classList.add('pop');
    }
    this.progress = this.events.length / PINCHES;
    if (this.events.length >= PINCHES || m.t - this.raw.pinch[0].t > PINCH_TIMEOUT_MS) this.advance();
  }

  // ─── rendering (per animation frame) ──────────────────────────────────────

  update(): void {
    this.bar.style.width = `${Math.min(1, this.progress) * 100}%`;
    const sub = this.hint || COPY[this.step].sub;
    if (this.subEl.textContent !== sub && !this.el.classList.contains('is-perfect')) this.subEl.textContent = sub;

    const c = this.stage;
    const dpr = devicePixelRatio;
    const w = c.clientWidth * dpr;
    const h = c.clientHeight * dpr;
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    c.parentElement!.style.aspectRatio = String(this.aspect);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    // Mirrored camera, dimmed, so the overlays read clearly.
    const v = this.o.video;
    if (v.readyState >= 2) {
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(v, 0, 0, w, h);
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(20, 24, 34, 0.45)';
    ctx.fillRect(0, 0, w, h);

    const m = this.last;
    const tip = m?.present ? { x: m.x * w, y: m.y * h } : null;

    if (this.step === 'reach') {
      ctx.fillStyle = 'rgba(120, 180, 255, 0.55)';
      for (const s of this.reachSamples) {
        ctx.beginPath();
        ctx.arc(s.x * w, s.y * h, 3 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      const b = this.liveBox;
      if (b) {
        const bw = (b.size * (innerWidth / innerHeight)) / this.aspect / (b.stretch ?? 1); // normalized x width
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2.5 * dpr;
        ctx.setLineDash([8 * dpr, 6 * dpr]);
        ctx.strokeRect((b.cx - bw / 2) * w, (b.cy - b.size / 2) * h, bw * w, b.size * h);
        ctx.setLineDash([]);
        ctx.fillStyle = '#fff';
        ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
        ctx.fillText('your screen', (b.cx - bw / 2) * w + 8 * dpr, (b.cy - b.size / 2) * h + 18 * dpr);
      }
    }

    if (tip) {
      const r = 14 * dpr;
      if (this.step === 'still') {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 5 * dpr;
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, r * 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = '#2f7df6';
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, r * 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, this.progress));
        ctx.stroke();
      }
      const closure = this.step === 'pinch' && m ? this.counter!.closure(m.pinch) : 0;
      ctx.fillStyle = this.counter?.pinching && this.step === 'pinch' ? '#2fb67c' : '#fff';
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, r * (1 - closure * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
