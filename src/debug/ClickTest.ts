import type { CameraDriver, CameraTuning, RawMeasure } from '../input/CameraDriver';
import type { Hand } from '../input/Hand';
import { compact, type Compact } from '../ui/Calibration';

/**
 * Dev tool: pinch a small target N times while everything is recorded. The raw
 * measurements can be replayed through the driver with any tuning (tests/clicktest),
 * so click accuracy can be measured on real hands instead of guessed.
 */

const TRIALS = 12;
/** Same size as the smallest Phase 1 pad. */
const TARGET_PX = 76;


export interface ClickTrial {
  target: { x: number; y: number; r: number };
  shownAt: number;
  press: { t: number; x: number; y: number } | null;
  release: { t: number; x: number; y: number } | null;
  /** Release landed on the target (release-selects semantics). */
  hit: boolean;
}

export interface ClickTestRecord {
  kind: 'clicktest';
  version: 1;
  createdAt: string;
  userAgent: string;
  label: string;
  viewport: { w: number; h: number; dpr: number };
  camera: { aspect: number };
  tuning: CameraTuning;
  /** Raw measures: [t, present, x, y, pinch, curl], t relative to t0 (performance.now()). */
  measures: Compact[];
  /** Render-rate output: [t, x, y, pinching 0/1, strength]. */
  cursor: [number, number, number, 0 | 1, number][];
  trials: ClickTrial[];
  t0: number;
}

export interface ClickTestOptions {
  driver: CameraDriver;
  hand: Hand;
  onDone: (record: ClickTestRecord) => void;
  onClose: () => void;
}

export class ClickTest {
  readonly el: HTMLElement;
  private dot: HTMLElement;
  private info: HTMLElement;
  private offs: (() => void)[] = [];
  private t0 = performance.now();
  private measures: Compact[] = [];
  private cursor: ClickTestRecord['cursor'] = [];
  private trials: ClickTrial[] = [];
  private current: ClickTrial | null = null;
  private aspect = 4 / 3;
  private busy = false;
  private finished = false;

  constructor(private o: ClickTestOptions) {
    this.el = document.createElement('div');
    this.el.className = 'clicktest';
    this.el.innerHTML = `
      <div class="ct-info"></div>
      <div class="ct-dot"></div>
      <div class="ct-actions"><button class="btn">Cancel</button></div>`;
    this.dot = this.el.querySelector('.ct-dot')!;
    this.info = this.el.querySelector('.ct-info')!;
    this.el.querySelector('button')!.addEventListener('click', () => this.close());
    document.body.append(this.el);

    this.offs.push(
      o.driver.onMeasure((m: RawMeasure) => {
        this.aspect = m.aspect;
        this.measures.push(compact(m, this.t0));
      }),
      o.hand.on('pinchstart', ({ x, y }) => {
        if (this.current && !this.busy) this.current.press = { t: this.rel(), x, y };
      }),
      o.hand.on('pinchend', ({ x, y, cancelled }) => {
        const tr = this.current;
        if (!tr || this.busy || !tr.press) return;
        if (cancelled) {
          tr.press = null; // hand lost mid-pinch: not a real attempt
          return;
        }
        tr.release = { t: this.rel(), x, y };
        const inside = (p: { x: number; y: number }) => Math.hypot(p.x - tr.target.x, p.y - tr.target.y) <= tr.target.r;
        // Release selects (touch-like); press position kept for analysis.
        tr.hit = inside(tr.release);
        this.feedback(tr.hit);
      }),
    );
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && this.close();
    addEventListener('keydown', esc);
    this.offs.push(() => removeEventListener('keydown', esc));
    this.next();
  }

  update(now: number): void {
    const h = this.o.hand;
    this.cursor.push([
      Math.round((now - this.t0) * 10) / 10,
      Math.round(h.position.x * 10) / 10,
      Math.round(h.position.y * 10) / 10,
      h.isPinching ? 1 : 0,
      +h.pinchStrength.toFixed(3),
    ]);
  }

  close(): void {
    this.offs.forEach((f) => f());
    this.el.remove();
    this.o.onClose();
  }

  private rel(): number {
    return Math.round((performance.now() - this.t0) * 10) / 10;
  }

  private next(): void {
    if (this.trials.length >= TRIALS) return this.finish();
    const r = TARGET_PX / 2;
    const prev = this.current?.target;
    let x = 0;
    let y = 0;
    // Spread targets over the screen, not too close to the previous one.
    for (let i = 0; i < 20; i++) {
      x = innerWidth * (0.15 + Math.random() * 0.7);
      y = innerHeight * (0.2 + Math.random() * 0.62);
      if (!prev || Math.hypot(x - prev.x, y - prev.y) > Math.min(innerWidth, innerHeight) * 0.3) break;
    }
    this.current = { target: { x, y, r }, shownAt: this.rel(), press: null, release: null, hit: false };
    this.trials.push(this.current);
    this.dot.style.cssText = `left:${x}px;top:${y}px;width:${TARGET_PX}px;height:${TARGET_PX}px`;
    this.dot.className = 'ct-dot';
    this.info.textContent = `Click test · ${this.trials.length} / ${TRIALS} · pinch the dot`;
  }

  private feedback(hit: boolean): void {
    this.busy = true;
    this.dot.classList.add(hit ? 'hit' : 'miss');
    setTimeout(() => {
      this.busy = false;
      this.next();
    }, hit ? 450 : 700);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.dot.remove();
    const hits = this.trials.filter((t) => t.hit).length;
    const pressHits = this.trials.filter((t) => t.press && Math.hypot(t.press.x - t.target.x, t.press.y - t.target.y) <= t.target.r).length;
    const drift = this.trials
      .filter((t) => t.press && t.release)
      .map((t) => Math.hypot(t.release!.x - t.press!.x, t.release!.y - t.press!.y))
      .sort((a, b) => a - b);
    const med = drift.length ? drift[Math.floor(drift.length / 2)] : 0;
    this.info.textContent = `${hits} / ${TRIALS} clicks landed (${pressHits} pressed on target) · median press→release drift ${med.toFixed(0)} px`;
    this.el.querySelector('.ct-actions button')!.textContent = 'Done';
    this.o.onDone({
      kind: 'clicktest',
      version: 1,
      createdAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      label: new URLSearchParams(location.search).get('label') ?? '',
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      camera: { aspect: this.aspect },
      tuning: structuredClone(this.o.driver.tuning),
      measures: this.measures,
      cursor: this.cursor,
      trials: this.trials,
      t0: this.t0,
    });
  }
}
