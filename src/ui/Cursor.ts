import type { Hand } from '../input/Hand';
import type { Vec2 } from '../lib/math';

/**
 * The on-screen hand cursor. Pure presentation: reads Hand each frame.
 * Squeezes as the pinch closes so the user can *see* the click coming.
 */
export class Cursor {
  readonly el: HTMLElement;
  private visible = false;
  private pressed = false;
  private over = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'cursor';
    this.el.innerHTML = '<div class="cursor-ring"></div><div class="cursor-core"></div><div class="cursor-pulse"></div>';
    parent.append(this.el);
  }

  /**
   * @param at where to draw (the interaction layer's magnetized position)
   * @param over the cursor is over a target (grows, Wii-style)
   */
  render(hand: Hand, at: Readonly<Vec2> = hand.position, over = false): void {
    const { x, y } = at;
    if (over !== this.over) {
      this.over = over;
      this.el.classList.toggle('is-over', over);
    }
    this.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    this.el.style.setProperty('--pinch', hand.pinchStrength.toFixed(3));

    if (hand.present !== this.visible) {
      this.visible = hand.present;
      this.el.classList.toggle('is-visible', this.visible);
    }
    if (hand.isPinching !== this.pressed) {
      this.pressed = hand.isPinching;
      this.el.classList.toggle('is-pressed', this.pressed);
      if (this.pressed) this.pulse();
    }
  }

  private pulse(): void {
    const p = this.el.querySelector<HTMLElement>('.cursor-pulse')!;
    p.classList.remove('go');
    void p.offsetWidth; // restart the animation
    p.classList.add('go');
  }
}
