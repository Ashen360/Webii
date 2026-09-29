import type { Vec2 } from '../lib/math';
import type { HandDriver, HandSample } from './Hand';

/**
 * A "ghost hand" for attract mode: follows a scripted target with a critically damped
 * spring, so the motion has human-like acceleration and a real velocity (Slice reads
 * it). It speaks the same Hand contract as the camera, which proves that games really
 * don't depend on computer vision.
 */
export class ScriptDriver implements HandDriver {
  readonly source = 'script' as const;
  private x = 0;
  private y = 0;
  private vx = 0;
  private vy = 0;
  private last = 0;
  private placed = false;

  /**
   * @param target where the hand wants to be (null = no hand in view)
   * @param stiffness spring frequency (rad/s): higher follows tighter
   */
  constructor(
    private target: (now: number) => (Vec2 & { pressed?: boolean }) | null,
    private stiffness = 16,
  ) {}

  sample(now: number, view: { w: number; h: number }): HandSample {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 0;
    this.last = now;
    const t = this.target(now);
    if (!t) {
      this.placed = false;
      this.vx = this.vy = 0;
      return { state: 'searching', present: false, x: this.x, y: this.y, vx: 0, vy: 0, pinchStrength: 0, pressed: false };
    }
    if (!this.placed) {
      // A hand appearing starts where it is, like the camera's fade-in.
      this.placed = true;
      this.x = t.x;
      this.y = t.y;
    } else if (dt > 0) {
      // Semi-implicit critically damped spring.
      const w = this.stiffness;
      this.vx += (w * w * (t.x - this.x) - 2 * w * this.vx) * dt;
      this.vy += (w * w * (t.y - this.y) - 2 * w * this.vy) * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
    }
    this.x = Math.min(Math.max(this.x, 0), view.w);
    this.y = Math.min(Math.max(this.y, 0), view.h);
    const pressed = !!t.pressed;
    return { state: 'tracking', present: true, x: this.x, y: this.y, vx: this.vx, vy: this.vy, pinchStrength: pressed ? 1 : 0, pressed };
  }

  dispose(): void {}
}
