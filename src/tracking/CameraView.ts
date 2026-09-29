import { HAND_BONES, type TrackerFrame } from './types';

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface PipOptions {
  /** Show the picture-in-picture window at all. */
  enabled: boolean;
  corner: Corner;
  /** Show the live camera image. Off = tracker-only view on a dark panel. */
  showVideo: boolean;
  /** Draw the hand skeleton the tracker sees. */
  showTracker: boolean;
}

/**
 * The picture-in-picture "the machine is watching" window: live mirrored video
 * and/or the skeleton the tracker sees, pinned to a user-chosen corner.
 *
 * It also hosts the <video> element the tracker reads from, so "hidden" never means
 * display:none. Some browsers stop delivering frames for non-rendered videos,
 * so hiding just fades it out.
 */
export class CameraView {
  readonly el: HTMLElement;
  readonly video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private active = false;
  private opts: PipOptions | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'camview';
    this.el.setAttribute('aria-hidden', 'true');
    this.video = document.createElement('video');
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.el.append(this.video, this.canvas);
    this.render();
  }

  /** Camera running or not (independent of the user's PiP preference). */
  setActive(active: boolean): void {
    this.active = active;
    this.render();
  }

  configure(opts: PipOptions): void {
    this.opts = opts;
    if (!opts.showTracker) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.render();
  }

  private get visible(): boolean {
    const o = this.opts;
    return this.active && !!o && o.enabled && (o.showVideo || o.showTracker);
  }

  private render(): void {
    const o = this.opts;
    this.el.classList.toggle('is-shown', this.visible);
    this.el.classList.toggle('no-video', !!o && !o.showVideo);
    if (o) this.el.dataset.corner = o.corner;
  }

  draw(f: TrackerFrame, pinchStrength: number): void {
    if (!this.visible || !this.opts?.showTracker) return;
    const { canvas, ctx } = this;
    const w = this.el.clientWidth * devicePixelRatio;
    const h = this.el.clientHeight * devicePixelRatio;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    if (!f.hand) return;

    // object-fit: cover mapping from video space to the window.
    const scale = Math.max(w / f.videoW, h / f.videoH);
    const ox = (w - f.videoW * scale) / 2;
    const oy = (h - f.videoH * scale) / 2;
    const P = f.hand.landmarks.map((p) => ({ x: ox + p.x * f.videoW * scale, y: oy + p.y * f.videoH * scale }));

    ctx.lineCap = 'round';
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    for (const [a, b] of HAND_BONES) {
      ctx.moveTo(P[a].x, P[a].y);
      ctx.lineTo(P[b].x, P[b].y);
    }
    ctx.stroke();

    const r = 2.5 * devicePixelRatio;
    ctx.fillStyle = '#fff';
    for (const p of P) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Highlight the two points that matter: pointer and pinch.
    ctx.fillStyle = `hsl(${205 - pinchStrength * 170} 95% 58%)`;
    for (const i of [4, 8]) {
      ctx.beginPath();
      ctx.arc(P[i].x, P[i].y, r * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
