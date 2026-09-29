import { lowPassAlpha } from '../lib/math';
import type { HandDriver, HandSample } from './Hand';

/**
 * Mouse / touch / pen fallback speaking the same Hand contract.
 * Mouse: present while inside the window. Touch: present while touching.
 */
export class PointerDriver implements HandDriver {
  readonly source = 'pointer' as const;
  private x = innerWidth / 2;
  private y = innerHeight / 2;
  private lastX = this.x;
  private lastY = this.y;
  private vx = 0;
  private vy = 0;
  private lastNow = 0;
  private present = false;
  private pressed = false;
  /** A press that began since the last sample. Quick taps can go down and up
   * within a single frame; the latch guarantees they're still seen as a click. */
  private latched = false;
  /** Touch lift: stay present for this many more samples so press → release → leave
   * are seen in order (otherwise a tap would look like a cancelled press). */
  private leaveIn = 0;
  private strength = 0;
  private off: () => void;

  constructor() {
    const move = (e: PointerEvent) => {
      this.x = e.clientX;
      this.y = e.clientY;
      this.present = true;
    };
    const down = (e: PointerEvent) => {
      move(e);
      this.leaveIn = 0;
      if (e.button === 0) this.pressed = this.latched = true;
    };
    const up = (e: PointerEvent) => {
      move(e);
      this.pressed = false;
      if (e.pointerType === 'touch') this.leaveIn = 2;
    };
    const leave = () => {
      this.present = false;
      this.pressed = false;
    };
    const release = () => (this.pressed = false);
    const root = document.documentElement;
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointerup', up, { passive: true });
    window.addEventListener('pointercancel', leave);
    root.addEventListener('pointerleave', leave);
    window.addEventListener('blur', release);
    this.off = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', leave);
      root.removeEventListener('pointerleave', leave);
      window.removeEventListener('blur', release);
    };
  }

  sample(now: number): HandSample {
    const dt = this.lastNow ? (now - this.lastNow) / 1000 : 0;
    this.lastNow = now;
    if (dt > 0) {
      const a = lowPassAlpha(10, dt);
      this.vx += a * ((this.x - this.lastX) / dt - this.vx);
      this.vy += a * ((this.y - this.lastY) / dt - this.vy);
      // Animate strength so clicks get the same squeeze feedback as a pinch.
      const target = this.pressed ? 1 : 0;
      const rate = this.pressed ? 14 : 8;
      this.strength += Math.sign(target - this.strength) * Math.min(Math.abs(target - this.strength), dt * rate);
    }
    this.lastX = this.x;
    this.lastY = this.y;
    const sample: HandSample = {
      state: this.present ? 'tracking' : 'searching',
      present: this.present,
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      pinchStrength: this.strength,
      pressed: this.pressed || this.latched,
    };
    this.latched = false;
    if (this.leaveIn > 0 && --this.leaveIn === 0) this.present = false;
    return sample;
  }

  dispose(): void {
    this.off();
  }
}
