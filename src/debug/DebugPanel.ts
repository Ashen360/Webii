import type { CameraDriver, CameraTuning } from '../input/CameraDriver';
import type { Hand } from '../input/Hand';
import { CORNERS, settings, type Corner } from '../settings';
import type { HandTracker } from '../tracking/HandTracker';

/**
 * Developer overlay: live numbers + tuning sliders. Toggle with the ` key or ?debug.
 * Tuning edits persist so a good setting survives reloads while we dial it in.
 */

interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  get: (t: CameraTuning) => number;
  set: (t: CameraTuning, v: number) => void;
}

const SLIDERS: SliderSpec[] = [
  { label: 'filter · min cutoff', min: 0.1, max: 5, step: 0.05, get: (t) => t.minCutoff, set: (t, v) => (t.minCutoff = v) },
  { label: 'filter · beta', min: 0, max: 0.06, step: 0.001, get: (t) => t.beta, set: (t, v) => (t.beta = v) },
  { label: 'predict ms', min: 0, max: 60, step: 1, get: (t) => t.predictMs, set: (t, v) => (t.predictMs = v) },
  { label: 'pinch · press (m)', min: 0.01, max: 0.07, step: 0.001, get: (t) => t.pinch.pressAt, set: (t, v) => (t.pinch.pressAt = v) },
  { label: 'pinch · release (m)', min: 0.015, max: 0.09, step: 0.001, get: (t) => t.pinch.releaseAt, set: (t, v) => (t.pinch.releaseAt = v) },
  { label: 'pinch · confirm frames', min: 1, max: 4, step: 1, get: (t) => t.pinch.confirmFrames, set: (t, v) => (t.pinch.confirmFrames = v) },
  { label: 'drift · damp start', min: 0, max: 0.95, step: 0.01, get: (t) => t.dampStart, set: (t, v) => (t.dampStart = v) },
  { label: 'drift · damp max', min: 0, max: 1, step: 0.01, get: (t) => t.dampMax, set: (t, v) => (t.dampMax = v) },
  { label: 'drift · decay ms', min: 30, max: 600, step: 10, get: (t) => t.offsetDecayMs, set: (t, v) => (t.offsetDecayMs = v) },
  { label: 'anchor · knuckle blend', min: 0, max: 1, step: 0.05, get: (t) => t.anchorBlend, set: (t, v) => (t.anchorBlend = v) },
  { label: 'hold · radius (px)', min: 0, max: 40, step: 1, get: (t) => t.holdRadius, set: (t, v) => (t.holdRadius = v) },
  { label: 'box · x-stretch', min: 1, max: 1.35, step: 0.01, get: (t) => t.box.stretch ?? 1, set: (t, v) => (t.box.stretch = v) },
  { label: 'box · size', min: 0.25, max: 0.95, step: 0.01, get: (t) => t.box.size, set: (t, v) => (t.box.size = v) },
  { label: 'box · centre y', min: 0.25, max: 0.75, step: 0.01, get: (t) => t.box.cy, set: (t, v) => (t.box.cy = v) },
  { label: 'fist · curl below (m)', min: 0, max: 0.07, step: 0.001, get: (t) => t.curlAt, set: (t, v) => (t.curlAt = v) },
  { label: 'grace ms', min: 0, max: 600, step: 10, get: (t) => t.graceMs, set: (t, v) => (t.graceMs = v) },
];

export class DebugPanel {
  readonly el: HTMLElement;
  private readout: HTMLElement;
  private sliders: HTMLElement;
  private renderFps = 60;
  private lastNow = 0;
  private driver: CameraDriver | null = null;
  private tracker: HandTracker | null = null;

  constructor(
    private hand: Hand,
    private onTuningChange: (t: CameraTuning) => void,
    private onReset: () => void,
    private onCalibrate: () => void,
    private onClickTest: () => void,
  ) {
    this.el = document.createElement('aside');
    this.el.className = 'debug';
    this.el.hidden = true;
    this.el.innerHTML =
      '<header>debug <kbd>`</kbd></header><pre class="debug-readout"></pre><div class="debug-pip"></div><div class="debug-sliders"></div>';
    this.readout = this.el.querySelector('.debug-readout')!;
    this.sliders = this.el.querySelector('.debug-sliders')!;
    this.buildPipControls(this.el.querySelector('.debug-pip')!);
    document.body.append(this.el);

    addEventListener('keydown', (e) => {
      if (e.key === '`') this.toggle();
    });
    if (new URLSearchParams(location.search).has('debug')) this.toggle(true);
  }

  /** Temporary home for the PiP settings until the Settings screen exists (Phase 4). */
  private buildPipControls(box: HTMLElement): void {
    const check = (label: string, key: 'enabled' | 'showVideo' | 'showTracker') => {
      const row = document.createElement('label');
      row.className = 'debug-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = settings.get().pip[key];
      input.addEventListener('change', () => settings.update('pip', { [key]: input.checked }));
      row.append(input, document.createTextNode(label));
      return row;
    };
    const corner = document.createElement('select');
    for (const c of CORNERS) corner.add(new Option(c, c, false, c === settings.get().pip.corner));
    corner.addEventListener('change', () => settings.update('pip', { corner: corner.value as Corner }));
    const head = document.createElement('div');
    head.className = 'debug-sub';
    head.textContent = 'camera pip';
    box.append(head, check('show pip', 'enabled'), check('camera feed', 'showVideo'), check('hand tracker', 'showTracker'), corner);
  }

  toggle(force?: boolean): void {
    this.el.hidden = !(force ?? this.el.hidden);
  }

  bind(driver: CameraDriver | null, tracker: HandTracker | null): void {
    this.driver = driver;
    this.tracker = tracker;
    this.sliders.replaceChildren();
    if (!driver) return;

    const calib = document.createElement('button');
    calib.className = 'btn';
    calib.textContent = 'run calibration';
    calib.addEventListener('click', () => this.onCalibrate());
    const ct = document.createElement('button');
    ct.className = 'btn';
    ct.textContent = 'click test';
    ct.addEventListener('click', () => this.onClickTest());
    this.sliders.append(calib, ct);

    for (const s of SLIDERS) {
      const row = document.createElement('label');
      const name = document.createElement('span');
      const val = document.createElement('output');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(s.min);
      input.max = String(s.max);
      input.step = String(s.step);
      input.value = String(s.get(driver.tuning));
      name.textContent = s.label;
      val.textContent = input.value;
      input.addEventListener('input', () => {
        s.set(driver.tuning, Number(input.value));
        val.textContent = input.value;
        driver.applyTuning();
        this.onTuningChange(driver.tuning);
      });
      row.append(name, val, input);
      this.sliders.append(row);
    }
    const reset = document.createElement('button');
    reset.className = 'btn';
    reset.textContent = 'reset tuning';
    reset.addEventListener('click', () => this.onReset());
    this.sliders.append(reset);
  }

  update(now: number): void {
    if (this.lastNow) this.renderFps += (1000 / Math.max(1, now - this.lastNow) - this.renderFps) * 0.05;
    this.lastNow = now;
    if (this.el.hidden) return;

    const h = this.hand;
    const d = this.driver;
    const t = this.tracker;
    const lines = [
      `source     ${h.source}   state ${h.state}`,
      `render     ${this.renderFps.toFixed(0)} fps`,
      t ? `detect     ${t.stats.detectFps.toFixed(0)} fps · ${t.stats.inferenceMs.toFixed(1)} ms · ${t.delegate}` : 'detect     —',
      `cursor     ${h.position.x.toFixed(0)}, ${h.position.y.toFixed(0)}   ${h.speed.toFixed(0)} px/s`,
      `pinch      ${h.isPinching ? 'DOWN' : 'up  '}  strength ${h.pinchStrength.toFixed(2)}`,
      d ? `distance   ${(d.pinchDistance * 100).toFixed(1)} cm  ${d.pinch.armed ? 'armed' : 'DISARMED'}` : '',
      d ? `index curl ${(d.indexCurl * 100).toFixed(1)} cm ${d.indexCurl < d.tuning.curlAt ? '(fist)' : ''}` : '',
      d?.atEdge ? 'hand at FRAME EDGE: pinch not trusted' : '',
      d ? `hand scale ${d.handScale.toFixed(3)}${d.tuning.calibratedScale ? ` (calibrated ${d.tuning.calibratedScale.toFixed(3)})` : ''}` : '',
    ];
    this.readout.textContent = lines.join('\n');
  }
}
