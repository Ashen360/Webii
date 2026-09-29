import type { Vec2 } from '../lib/math';
import { prefersReducedMotion } from '../lib/motion';

/**
 * The console shell: a stack of scenes with zoom transitions, a background that
 * drifts with the hand, and the bottom console bar. Scenes are plain DOM; anything
 * with `data-hit` inside them is hand-interactive through the interaction layer.
 */

export interface Scene {
  el: HTMLElement;
  /** Called every frame while the scene is on top. */
  update?(dt: number, t: number): void;
  /** The scene became the top of the stack. */
  onShow?(): void;
  /** The scene left the stack for good. */
  onDestroy?(): void;
  /** Escape / Backspace: return true if the scene handled it (e.g. a game pauses). */
  onBack?(): boolean;
}

interface Entry {
  scene: Scene;
  /** Where it zoomed out of (so BACK can zoom it back in). */
  origin: DOMRect | null;
}

const reduced = prefersReducedMotion;
/** The moment of a looping tile animation shown, frozen, under reduced motion. */
const STILL_T = 1.1;
const EASE_OUT = 'cubic-bezier(0.2, 0.9, 0.25, 1)';

export class Shell {
  readonly el: HTMLElement;
  readonly stage: HTMLElement;
  private bar: HTMLElement;
  private clock: HTMLElement;
  private handDot: HTMLElement;
  private stack: Entry[] = [];
  private t = 0;
  private clockText = '';
  /** Background parallax, eased. */
  private px = 0;
  private py = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'shell';
    this.el.innerHTML = `
      <div class="shell-bg"></div>
      <div class="shell-stage"></div>
      <footer class="shell-bar">
        <span class="wordmark wordmark-sm" aria-label="Webii">web<i></i><i></i></span>
        <span class="shell-clock"></span>
        <span class="shell-hand" title="Hand"></span>
      </footer>`;
    this.stage = this.el.querySelector('.shell-stage')!;
    this.bar = this.el.querySelector('.shell-bar')!;
    this.clock = this.el.querySelector('.shell-clock')!;
    this.handDot = this.el.querySelector('.shell-hand')!;
    parent.append(this.el);
  }

  get top(): Scene | null {
    return this.stack.at(-1)?.scene ?? null;
  }

  get depth(): number {
    return this.stack.length;
  }

  /** Clear the stack and show `scene` (fade). */
  replace(scene: Scene): void {
    for (const e of this.stack) this.destroy(e);
    this.stack = [{ scene, origin: null }];
    this.mount(scene);
    if (!reduced()) scene.el.animate([{ opacity: 0, scale: '0.98' }, { opacity: 1, scale: '1' }], { duration: 420, easing: EASE_OUT });
    scene.onShow?.();
  }

  /** Open `scene` on top, zooming out of `origin` (a tile's rect) when given. */
  push(scene: Scene, origin: DOMRect | null = null): void {
    const prev = this.stack.at(-1);
    this.stack.push({ scene, origin });
    this.mount(scene);
    if (prev) this.sendBack(prev.scene);
    if (!reduced()) {
      const from = origin ? this.fromRect(origin) : { transform: 'scale(0.96)' };
      scene.el.animate([{ ...from, opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: 440, easing: EASE_OUT });
    }
    scene.onShow?.();
  }

  /** Back one scene. Returns false at the root. */
  pop(): boolean {
    if (this.stack.length < 2) return false;
    const leaving = this.stack.pop()!;
    const prev = this.stack.at(-1)!;
    this.bringForward(prev.scene);
    prev.scene.onShow?.();
    const done = () => this.destroy(leaving);
    if (reduced()) done();
    else {
      leaving.scene.el.inert = true;
      const to = leaving.origin ? this.fromRect(leaving.origin) : { transform: 'scale(0.96)' };
      leaving.scene.el.animate([{ transform: 'none', opacity: 1 }, { ...to, opacity: 0 }], { duration: 320, easing: 'ease-in' }).finished.then(done, done);
    }
    return true;
  }

  /** Per frame: drive the top scene, the background drift and the console bar. */
  update(dt: number, hand: { present: boolean; position: Readonly<Vec2>; isPinching: boolean }): void {
    this.t += dt;
    this.top?.update?.(dt, this.t);

    // Background drifts gently against the hand: the room responds to you (not with reduced motion).
    const drift = hand.present && !reduced();
    const tx = drift ? (hand.position.x / innerWidth - 0.5) * -16 : 0;
    const ty = drift ? (hand.position.y / innerHeight - 0.5) * -12 : 0;
    this.px += (tx - this.px) * Math.min(1, dt * 3);
    this.py += (ty - this.py) * Math.min(1, dt * 3);
    this.el.style.setProperty('--bg-x', `${this.px.toFixed(2)}px`);
    this.el.style.setProperty('--bg-y', `${this.py.toFixed(2)}px`);

    this.handDot.dataset.state = hand.present ? (hand.isPinching ? 'pinch' : 'on') : 'off';
    const d = new Date();
    const text = `${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`;
    if (text !== this.clockText) this.clock.textContent = this.clockText = text;
  }

  set barVisible(on: boolean) {
    this.bar.classList.toggle('is-hidden', !on);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private mount(scene: Scene): void {
    scene.el.classList.add('scene');
    scene.el.inert = false;
    this.stage.append(scene.el);
  }

  private sendBack(scene: Scene): void {
    scene.el.inert = true; // not hittable, not focusable
    const hide = () => scene.el.classList.add('is-behind');
    if (reduced()) hide();
    else scene.el.animate([{ opacity: 1, scale: '1' }, { opacity: 0, scale: '0.94' }], { duration: 260, easing: 'ease-out' }).finished.then(hide, hide);
  }

  private bringForward(scene: Scene): void {
    scene.el.classList.remove('is-behind');
    scene.el.inert = false;
    if (!reduced()) scene.el.animate([{ opacity: 0, scale: '0.96' }, { opacity: 1, scale: '1' }], { duration: 360, easing: EASE_OUT });
  }

  private destroy(e: Entry): void {
    e.scene.onDestroy?.();
    e.scene.el.remove();
  }

  /** A transform that makes a full-stage element sit exactly on `r`. */
  private fromRect(r: DOMRect): Keyframe {
    const s = this.stage.getBoundingClientRect();
    const sx = r.width / s.width;
    const sy = r.height / s.height;
    const dx = r.left + r.width / 2 - (s.left + s.width / 2);
    const dy = r.top + r.height / 2 - (s.top + s.height / 2);
    return { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` };
  }
}

/** A canvas that paints a looping animation at its CSS size (HiDPI-aware). */
export class LiveCanvas {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(
    private paint: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number, color: string) => void,
    private color: string,
    className = '',
  ) {
    this.el = document.createElement('canvas');
    this.el.className = className;
    this.ctx = this.el.getContext('2d')!;
  }

  draw(t: number): void {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return;
    if (this.el.width !== Math.round(w * dpr) || this.el.height !== Math.round(h * dpr)) {
      this.el.width = Math.round(w * dpr);
      this.el.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    // Reduced motion: a still, representative frame instead of a loop.
    this.paint(this.ctx, w, h, reduced() ? STILL_T : t, this.color);
  }
}
