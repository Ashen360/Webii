import type { Hand } from '../input/Hand';
import { Emitter } from '../lib/emitter';
import type { Vec2 } from '../lib/math';

/**
 * The interaction layer: turns the Hand into hover / press / activate / drag on
 * targets. Anything becomes hand-interactive by being a target:
 *   - DOM: add `data-hit` (optionally `data-hit-shape="circle"`, `data-hit-drag`).
 *     Activation calls el.click(), so the same handler serves mouse and hand.
 *   - Canvas / custom: `interaction.register({ contains, center, onActivate, ... })`.
 *
 * Semantics (validated on real click tests, see docs/PROGRESS.md):
 *   - RELEASE SELECTS: pinch, adjust while holding, release over a target. Users
 *     correct their aim mid-hold; "press and release on the same target" scored 44%
 *     vs 65% for release-selects on the same data.
 *   - Hit slop: +12 px (lifted hits by ~10% in the same data). Hover is sticky until
 *     +20 px, so jitter at an edge doesn't flicker.
 */

export interface HitTarget {
  /** Point containment in viewport px, with the area inflated by `slop`. */
  contains(x: number, y: number, slop: number): boolean;
  center(): Vec2;
  /** DOM targets only. */
  el?: HTMLElement;
  disabled?(): boolean;
  /** If true, a pinch that starts on this target drags it instead of activating. */
  draggable?: boolean;
  onActivate?(): void;
  onDrag?(e: DragEvent): void;
}

export interface DragEvent {
  phase: 'start' | 'move' | 'end';
  x: number;
  y: number;
  /** false when the hand was lost mid-drag. */
  completed: boolean;
}

export interface InteractionEvents extends Record<string, unknown> {
  hoverstart: HitTarget;
  hoverend: HitTarget;
  /** A pinch began (target = what was hovered, if anything). */
  press: HitTarget | null;
  activate: HitTarget;
  /** A pinch ended without activating anything. */
  release: undefined;
  dragstart: HitTarget;
  dragend: HitTarget;
}

export interface InteractionOptions {
  /** Extra hit margin to acquire a target (px). */
  slop: number;
  /** Margin to keep an already-hovered target (px); ≥ slop. */
  leaveSlop: number;
  /** Fraction of the distance to the target centre the drawn cursor leans in… */
  magnet: number;
  /** …capped at this many px, so big targets don't yank the cursor. */
  magnetMax: number;
}

const DEFAULTS: InteractionOptions = { slop: 12, leaveSlop: 20, magnet: 0.3, magnetMax: 14 };

export type InteractionState = 'idle' | 'hovering' | 'pressing' | 'dragging';

export class Interaction {
  /** Off while an overlay owns the hand (calibration, click test). */
  enabled = true;
  /** When set, only DOM targets inside this element are hittable. */
  scope: HTMLElement | null = null;
  readonly opts: InteractionOptions;

  hovered: HitTarget | null = null;
  state: InteractionState = 'idle';
  /** Where to draw the cursor: the hand position, leaning into the hovered target. */
  readonly display: Vec2 = { x: 0, y: 0 };

  private registered = new Set<HitTarget>();
  private domTargets = new WeakMap<HTMLElement, HitTarget>();
  private dragging: HitTarget | null = null;
  private pressed = false;
  private magnetW = 0;
  private lastNow = 0;
  private events = new Emitter<InteractionEvents>();

  constructor(
    private hand: Hand,
    opts: Partial<InteractionOptions> = {},
    private root: ParentNode | null = typeof document !== 'undefined' ? document : null,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    hand.on('pinchstart', () => this.onPinchStart());
    hand.on('pinchend', ({ cancelled }) => this.onPinchEnd(cancelled));
    hand.on('lost', () => this.setHovered(null));
  }

  on<K extends keyof InteractionEvents>(event: K, fn: (p: InteractionEvents[K]) => void): () => void {
    return this.events.on(event, fn);
  }

  register(t: HitTarget): () => void {
    this.registered.add(t);
    return () => {
      this.registered.delete(t);
      if (this.hovered === t) this.setHovered(null);
      if (this.dragging === t) this.dragging = null;
    };
  }

  /** Call once per frame, after hand.update(). */
  update(now: number): void {
    const dt = this.lastNow ? Math.min((now - this.lastNow) / 1000, 0.1) : 0;
    this.lastNow = now;
    const { x, y } = this.hand.position;

    if (!this.enabled || !this.hand.present) {
      this.setHovered(null);
    } else if (this.dragging) {
      this.dragging.onDrag?.({ phase: 'move', x, y, completed: true });
    } else {
      this.setHovered(this.pick(x, y));
    }

    // Feedback: anticipation squeeze on the hovered element.
    const el = this.hovered?.el;
    if (el) el.style.setProperty('--pinch', this.hand.pinchStrength.toFixed(3));

    // Magnetism eases in/out (~120 ms) so the cursor never jumps.
    const target = this.hovered && !this.dragging ? 1 : 0;
    this.magnetW += (target - this.magnetW) * Math.min(1, dt * 8);
    let mx = 0;
    let my = 0;
    if (this.hovered && this.magnetW > 0.001) {
      const c = this.hovered.center();
      const dx = c.x - x;
      const dy = c.y - y;
      const d = Math.hypot(dx, dy);
      const pull = Math.min(d * this.opts.magnet, this.opts.magnetMax) * this.magnetW;
      if (d > 0) {
        mx = (dx / d) * pull;
        my = (dy / d) * pull;
      }
    }
    this.display.x = x + mx;
    this.display.y = y + my;

    this.state = this.dragging ? 'dragging' : this.pressed ? 'pressing' : this.hovered ? 'hovering' : 'idle';
  }

  // ─── hit testing ──────────────────────────────────────────────────────────

  private pick(x: number, y: number): HitTarget | null {
    const { slop, leaveSlop } = this.opts;
    const candidates = this.candidates();
    // Anything the point is exactly inside wins (topmost first), even over a sticky hover.
    const exact = candidates.find((t) => t.contains(x, y, 0) && this.usable(t));
    if (exact) return exact;
    // Sticky: keep the current target within the wider leave margin.
    if (this.hovered && this.usable(this.hovered) && this.hovered.contains(x, y, leaveSlop)) return this.hovered;
    // Otherwise the nearest target whose slop area contains the point.
    let best: HitTarget | null = null;
    let bestD = Infinity;
    for (const t of candidates) {
      if (!t.contains(x, y, slop) || !this.usable(t)) continue;
      const c = t.center();
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  /** Registered targets first (in registration order), then DOM targets. */
  private candidates(): HitTarget[] {
    const out = [...this.registered];
    const root = this.scope ?? this.root;
    if (root) {
      for (const el of root.querySelectorAll<HTMLElement>('[data-hit]')) out.push(this.domTarget(el));
    }
    return out;
  }

  private usable(t: HitTarget): boolean {
    if (t.disabled?.()) return false;
    const el = t.el;
    if (!el) return true;
    if (!el.isConnected || (el as HTMLButtonElement).disabled || el.closest('[inert],[aria-hidden="true"]')) return false;
    // Stacking: the element must actually be on top at its own centre (not under an overlay).
    if (typeof document.elementFromPoint !== 'function') return true;
    const c = t.center();
    const top = document.elementFromPoint(c.x, c.y);
    return !!top && (top === el || el.contains(top) || top.closest('.cursor') !== null);
  }

  private domTarget(el: HTMLElement): HitTarget {
    let t = this.domTargets.get(el);
    if (t) return t;
    const circle = el.dataset.hitShape === 'circle';
    t = {
      el,
      draggable: el.hasAttribute('data-hit-drag'),
      contains(x, y, slop) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        if (circle) return Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) <= r.width / 2 + slop;
        return x >= r.left - slop && x <= r.right + slop && y >= r.top - slop && y <= r.bottom + slop;
      },
      center() {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      },
      onDrag: (e) => el.dispatchEvent(new CustomEvent('hitdrag', { detail: e })),
    };
    this.domTargets.set(el, t);
    return t;
  }

  // ─── state transitions ────────────────────────────────────────────────────

  private setHovered(t: HitTarget | null): void {
    if (t === this.hovered) return;
    const prev = this.hovered;
    this.hovered = t;
    if (prev) {
      prev.el?.classList.remove('is-hover', 'is-pressed');
      prev.el?.style.removeProperty('--pinch');
      this.events.emit('hoverend', prev);
    }
    if (t) {
      t.el?.classList.add('is-hover');
      if (this.pressed) t.el?.classList.add('is-pressed');
      this.events.emit('hoverstart', t);
    }
  }

  private onPinchStart(): void {
    if (!this.enabled) return;
    this.pressed = true;
    // Pinch events fire inside hand.update(), before this frame's update(): re-pick so
    // a press never uses last frame's hover (a quick move-and-click could otherwise
    // start dragging whatever was under the cursor a frame ago).
    if (this.hand.present) this.setHovered(this.pick(this.hand.position.x, this.hand.position.y));
    const t = this.hovered;
    if (t?.draggable) {
      this.dragging = t;
      const { x, y } = this.hand.position;
      t.el?.classList.add('is-dragging');
      t.onDrag?.({ phase: 'start', x, y, completed: true });
      this.events.emit('dragstart', t);
    }
    t?.el?.classList.add('is-pressed');
    this.events.emit('press', t);
  }

  private onPinchEnd(cancelled: boolean): void {
    if (!this.pressed) return;
    this.pressed = false;
    const { x, y } = this.hand.position;

    if (this.dragging) {
      const t = this.dragging;
      this.dragging = null;
      t.el?.classList.remove('is-dragging', 'is-pressed');
      t.onDrag?.({ phase: 'end', x, y, completed: !cancelled });
      this.events.emit('dragend', t);
      return;
    }

    const t = this.hovered;
    t?.el?.classList.remove('is-pressed');
    if (cancelled || !this.enabled || !t) {
      this.events.emit('release', undefined);
      return;
    }
    this.activate(t);
  }

  private activate(t: HitTarget): void {
    const el = t.el;
    if (el) {
      el.classList.remove('is-activated');
      void el.offsetWidth; // restart the animation
      el.classList.add('is-activated');
      // With a real mouse, the browser already delivers a native click to DOM
      // targets; synthesizing another would double-activate.
      if (this.hand.source !== 'pointer') el.click();
    }
    t.onActivate?.();
    this.events.emit('activate', t);
  }
}
