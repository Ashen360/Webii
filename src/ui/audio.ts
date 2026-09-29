/**
 * Tiny synthesized sound effects (Web Audio): original by construction, no files.
 * Browsers only allow audio after a user gesture, so the context unlocks on the first
 * click / key / touch. A pinch is not a browser "user activation". Phase 3's
 * press-start screen provides that first click.
 */

export type Sfx =
  | 'hover'
  | 'press'
  | 'activate'
  | 'release'
  | 'back'
  | 'error'
  | 'startup'
  | 'launch'
  | 'open'
  // games (Phase 6)
  | 'tick'
  | 'go'
  | 'pause'
  | 'finish'
  | 'score'
  | 'miss'
  | 'swish'
  | 'success'
  | 'fail';

interface Tone {
  type: OscillatorType;
  /** Frequencies (Hz) played in sequence. */
  f: number[];
  /** Duration per note (s). */
  d: number;
  gain: number;
}

const TONES: Record<Sfx, Tone> = {
  hover: { type: 'sine', f: [1320], d: 0.035, gain: 0.05 },
  press: { type: 'triangle', f: [520], d: 0.05, gain: 0.12 },
  activate: { type: 'triangle', f: [660, 990], d: 0.07, gain: 0.14 },
  release: { type: 'sine', f: [440], d: 0.04, gain: 0.05 },
  back: { type: 'triangle', f: [700, 470], d: 0.07, gain: 0.12 },
  error: { type: 'square', f: [220, 180], d: 0.08, gain: 0.05 },
  startup: { type: 'sine', f: [523, 659, 784, 1047], d: 0.11, gain: 0.07 },
  launch: { type: 'sine', f: [392, 523, 784, 1047, 1568], d: 0.09, gain: 0.07 },
  // A soft rising pair under the zoom when a channel opens (the select click plays too).
  open: { type: 'sine', f: [392, 587], d: 0.12, gain: 0.06 },
  tick: { type: 'sine', f: [880], d: 0.09, gain: 0.09 },
  go: { type: 'triangle', f: [1175, 1760], d: 0.12, gain: 0.12 },
  pause: { type: 'triangle', f: [587, 440], d: 0.08, gain: 0.1 },
  finish: { type: 'triangle', f: [784, 659, 784, 1047], d: 0.1, gain: 0.1 },
  score: { type: 'sine', f: [988, 1319], d: 0.05, gain: 0.08 },
  miss: { type: 'sine', f: [330, 247], d: 0.08, gain: 0.07 },
  swish: { type: 'triangle', f: [1400, 2100], d: 0.04, gain: 0.05 },
  success: { type: 'sine', f: [523, 659, 784, 1047, 1319], d: 0.1, gain: 0.09 },
  fail: { type: 'triangle', f: [392, 330, 262], d: 0.12, gain: 0.08 },
};

export class Audio {
  /** 0..1, set from Settings (Phase 4). */
  volume = 0.7;
  enabled = true;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastPlay: Partial<Record<Sfx, number>> = {};

  constructor() {
    const unlock = () => {
      this.ensure();
      void this.ctx?.resume();
    };
    for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) addEventListener(ev, unlock, { passive: true });
  }

  play(name: Sfx): void {
    if (!this.enabled || this.volume <= 0) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running' || !this.master) return;
    // Rate-limit identical sounds (e.g. hover flicker at a target edge).
    const now = ctx.currentTime;
    if (now - (this.lastPlay[name] ?? -1) < 0.06) return;
    this.lastPlay[name] = now;

    const tone = TONES[name];
    this.master.gain.value = this.volume;
    tone.f.forEach((f, i) => {
      const t0 = now + i * tone.d * 0.85;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = tone.type;
      osc.frequency.value = f;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(tone.gain, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.d);
      osc.connect(g).connect(this.master!);
      osc.start(t0);
      osc.stop(t0 + tone.d + 0.02);
    });
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }
}
