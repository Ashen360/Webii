import { clamp } from '../lib/math';

export interface PinchConfig {
  /** Thumb–index distance (metres, world space) at or below which a pinch presses. */
  pressAt: number;
  /** Distance above which a held pinch releases. Must be > pressAt (hysteresis). */
  releaseAt: number;
  /** Distance treated as a fully open hand (strength 0). */
  openAt: number;
  /** Consecutive frames required to confirm a press or release. */
  confirmFrames: number;
}

/**
 * Defaults from real recordings: fingertip landmarks never meet. Touching tips read
 * 2.4–3.4 cm, so 3.0 cm caught only 2 of 12 real pinches. At 4.0/5.0 cm, 10 of 10
 * deliberate pinches were caught with zero false clicks during natural movement.
 * Calibration refines these per user.
 */
export const DEFAULT_PINCH: PinchConfig = {
  pressAt: 0.04,
  releaseAt: 0.05,
  openAt: 0.09,
  confirmFrames: 2,
};

export type PinchTransition = 'press' | 'release' | null;

/**
 * Debounced pinch state machine with hysteresis and arming.
 * A detector starts disarmed: a hand that enters the frame already pinched must
 * open once before it can click, so re-acquiring a hand never fires a stray click.
 */
export class PinchDetector {
  pressed = false;
  armed = false;
  strength = 0;
  private streak = 0;

  constructor(public config: PinchConfig = { ...DEFAULT_PINCH }) {}

  update(distance: number): PinchTransition {
    const { pressAt, releaseAt, openAt, confirmFrames } = this.config;
    this.strength = 1 - clamp((distance - pressAt) / (openAt - pressAt), 0, 1);

    if (!this.armed) {
      if (distance > releaseAt) this.armed = true;
      return null;
    }

    const wantsChange = this.pressed ? distance > releaseAt : distance < pressAt;
    this.streak = wantsChange ? this.streak + 1 : 0;
    if (this.streak < confirmFrames) return null;

    this.streak = 0;
    this.pressed = !this.pressed;
    return this.pressed ? 'press' : 'release';
  }

  /** Forget everything; the next pinch requires the hand to open first. */
  reset(): void {
    this.pressed = false;
    this.armed = false;
    this.strength = 0;
    this.streak = 0;
  }
}
