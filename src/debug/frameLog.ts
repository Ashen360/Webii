import type { TrackerFrame } from '../tracking/types';

/**
 * Dev only: logs every tracker frame's full landmarks while a recording is running,
 * so alternative cursor anchors and pinch features can be evaluated offline on real
 * hands. Row: [t (absolute ms), ...21 × (x, y) image, ...21 × (x, y, z) world] or [t]
 * when no hand. Image x is NOT mirrored (raw MediaPipe convention).
 */
export class FrameLog {
  readonly frames: number[][] = [];
  private off: () => void;

  constructor(subscribe: (fn: (f: TrackerFrame) => void) => () => void) {
    const r = (v: number) => Math.round(v * 1e4) / 1e4;
    this.off = subscribe((f) => {
      if (!f.hand) {
        this.frames.push([Math.round(f.t * 10) / 10]);
        return;
      }
      const row = [Math.round(f.t * 10) / 10];
      for (const p of f.hand.landmarks) row.push(r(p.x), r(p.y));
      for (const p of f.hand.world) row.push(r(p.x), r(p.y), r(p.z));
      this.frames.push(row);
    });
  }

  stop(): number[][] {
    this.off();
    return this.frames;
  }
}
