type Tick = (now: number, dt: number) => void;

/** One shared requestAnimationFrame loop so every system sees the same `now`. */
export class Loop {
  private ticks: Tick[] = [];
  private last = 0;
  private raf = 0;

  add(fn: Tick): () => void {
    this.ticks.push(fn);
    return () => {
      this.ticks = this.ticks.filter((t) => t !== fn);
    };
  }

  start(): void {
    const frame = (now: number) => {
      // Schedule first: an exception in one system must never stop the whole app.
      this.raf = requestAnimationFrame(frame);
      this.step(now);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** One frame (exported for tests). Each tick is isolated: a failing one is reported once. */
  step(now: number): void {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 1 / 60;
    this.last = now;
    for (const t of this.ticks) {
      try {
        t(now, dt);
      } catch (err) {
        if (!this.failed.has(t)) {
          this.failed.add(t);
          console.error('[webii] frame error (reported once per system)', err);
        }
      }
    }
  }

  private failed = new WeakSet<Tick>();

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.last = 0;
  }
}
