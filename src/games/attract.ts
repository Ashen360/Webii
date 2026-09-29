import { HandController } from '../input/Hand';
import { ScriptDriver } from '../input/ScriptDriver';
import { seededRandom } from '../lib/math';
import { prefersReducedMotion } from '../lib/motion';
import { ghostCursor, type Painter } from '../shell/painters';
import { palette } from '../shell/theme';
import type { Game, GameSpec } from './types';

/**
 * Attract mode: the real game, playing itself in a channel tile or preview, driven by
 * a scripted hand through the Hand contract. Returns a fresh Painter (each canvas gets
 * its own game), so it drops into LiveCanvas like the placeholder painters it replaces.
 */

/** Timed games' attract rounds are cut short so the loop shows the start and the result often. */
const MAX_ROUND = 16;
/** Untimed games (with their own stages) play out fully, up to this safety cap. */
const MAX_UNTIMED = 30;
/** How long the finished round (with its score) stays up before the next one. */
const RESULT_HOLD = 2.2;
const MAX_DT = 0.05;

/** Reduced motion: instead of looping, show the game this far into a round, frozen. */
export const STILL_AT = 3.5;


export function attractPainter(spec: GameSpec, seed = 1, opts: { still?: boolean } = {}): Painter {
  let game: Game | null = null;
  let hand: HandController | null = null;
  let size = { w: 0, h: 0 };
  let time = 0;
  /** The scripted hand's own clock (ms): advances only with simulated time. */
  let clock = 0;
  let lastT: number | null = null;
  let heldFor = 0;
  let round = 0;
  let broken = false;
  const still = opts.still ?? prefersReducedMotion();

  const env = { rng: seededRandom(seed), cue: () => {}, attract: true };
  const restart = () => {
    time = 0;
    heldFor = 0;
    env.rng = seededRandom(seed + round++ * 7919);
    game!.start(size.w, size.h, env);
  };
  const limit = spec.duration != null ? Math.min(spec.duration, MAX_ROUND) : MAX_UNTIMED;
  const isFinished = () => game!.over || time >= limit;

  /** Advance the attract round by dt seconds. */
  const advance = (dt: number) => {
    clock += dt * 1000;
    hand!.update(clock);
    if (!isFinished()) {
      time += dt;
      game!.update(dt, hand!, time);
    } else if ((heldFor += dt) > RESULT_HOLD) restart();
  };

  return (ctx, w, h, t) => {
    if (broken) return;
    try {
      if (!game) {
        game = spec.create();
        hand = new HandController(() => size);
        hand.setDriver(new ScriptDriver(() => game!.autopilot(time)));
        size = { w, h };
        restart();
        if (still) for (let i = 0; i < STILL_AT * 60; i++) advance(1 / 60);
      } else if (Math.abs(w - size.w) > 1 || Math.abs(h - size.h) > 1) {
        size = { w, h };
        if (game.resize) game.resize(w, h);
        else restart();
      }
      if (!still) {
        // Shell time jumps when a scene comes back to the front: never simulate the gap.
        const dt = lastT == null ? 0 : Math.min(Math.max(t - lastT, 0), MAX_DT);
        lastT = t;
        advance(dt);
      }

      const finished = isFinished();
      game.draw(ctx, w, h, palette(), hand!);
      if (!spec.ownCursor && hand!.present && !finished) ghostCursor(ctx, hand!.position.x, hand!.position.y, Math.max(6, h * 0.035), hand!.pinchStrength);
      if (finished) badge(ctx, w, h, game.result().display, spec.color);
    } catch (err) {
      // A broken game must not take the menu down with it: its tile just goes blank.
      broken = true;
      console.error(`[webii] ${spec.id} attract mode stopped`, err);
    }
  };
}

/** The round's score, popped over the field while the attract loop rests. */
function badge(ctx: CanvasRenderingContext2D, w: number, h: number, text: string, color: string) {
  const s = Math.min(w, h);
  ctx.save();
  ctx.fillStyle = palette().card;
  ctx.shadowColor = palette().ink(0.2);
  ctx.shadowBlur = s * 0.06;
  ctx.beginPath();
  ctx.roundRect(w / 2 - s * 0.26, h / 2 - s * 0.14, s * 0.52, s * 0.28, s * 0.08);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.font = `900 ${s * 0.16}px 'Nunito Variable', system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + s * 0.01);
  ctx.restore();
}
