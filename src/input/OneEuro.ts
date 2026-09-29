import { lowPassAlpha } from '../lib/math';

/**
 * One Euro filter (Casiez et al., 2012): an adaptive low-pass whose cutoff rises
 * with speed. Slow hand → heavy smoothing (no jitter); fast hand → light smoothing (no lag).
 */
export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastT: number | null = null;

  constructor(
    public minCutoff = 1.0,
    public beta = 0.007,
    public dCutoff = 1.0,
  ) {}

  /** @param t seconds */
  filter(value: number, t: number): number {
    if (this.x === null || this.lastT === null) {
      this.x = value;
      this.lastT = t;
      return value;
    }
    const dt = t - this.lastT;
    if (dt <= 0) return this.x;
    this.lastT = t;

    const rawDx = (value - this.x) / dt;
    this.dx += lowPassAlpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += lowPassAlpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.lastT = null;
    this.dx = 0;
  }
}
