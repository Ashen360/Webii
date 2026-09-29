import type { Hand } from '../input/Hand';
import type { Vec2 } from '../lib/math';
import type { Palette } from '../shell/theme';

/**
 * The game contract. A game is a small simulation in a w×h field (CSS px, origin top
 * left) that reads ONLY the Hand contract. The framework owns everything around it:
 * intro, countdown, timer, pause on hand loss, result, retry, best score, attract mode.
 *
 * Sizes and speeds should be relative to the field (e.g. `h * 0.05`), because the same
 * game runs full screen and inside a 300 px channel tile (attract mode).
 */

/** Sound cues games may trigger (mapped onto the shared synth). Silent in attract mode. */
export type GameCue = 'score' | 'miss' | 'swish' | 'success' | 'fail' | 'tick' | 'go';

export interface GameEnv {
  /** Seeded randomness: identical seeds give identical rounds. */
  rng: () => number;
  cue(name: GameCue): void;
  /** Running in a tile/preview with a scripted hand (no sound, loops forever). */
  attract: boolean;
}

export interface GameResult {
  /** Comparable score, higher is better (stored as the best). */
  score: number;
  /** What the big number says, e.g. "24" or "87%". */
  display: string;
  /** Under the number, e.g. "caught" or "accurate". */
  label: string;
  /** Optional small line, e.g. "3 missed". */
  detail?: string;
}

export interface Game {
  /** Begin a fresh round (called before the countdown, and on every retry). */
  start(w: number, h: number, env: GameEnv): void;
  /** The field changed size mid-round. */
  resize?(w: number, h: number): void;
  /**
   * Advance one frame of PLAY. `time` = seconds since play began (pauses excluded).
   * Never called during intro, countdown, pause or result.
   */
  update(dt: number, hand: Hand, time: number): void;
  /** Paint the field. Called every frame in every phase (a paused game is drawn frozen). */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette, hand: Hand): void;
  /** The game ended itself (lives out, reveal finished…). Timed games may also just run out. */
  readonly over: boolean;
  result(): GameResult;
  /** HUD text shown top left during play (e.g. the running score); '' hides it. */
  hud?(): string;
  /**
   * Untimed games with their own stages (Memory Trace: memorize, draw) can drive the
   * HUD's timer ring: seconds left of `total`, or null to hide it.
   */
  timer?(): { left: number; total: number } | null;
  /**
   * Attract mode: where a skilled player's hand would be now (field px), or null
   * for "no hand". The framework eases a scripted hand toward it.
   */
  autopilot(time: number): Vec2 | null;
}

export interface GameSpec {
  id: string;
  title: string;
  /** One short line on the intro card. */
  instruction: string;
  color: string;
  /** Play length in seconds, shown as a countdown; omit when the game ends itself. */
  duration?: number;
  /** The game draws its own hand avatar; hide the normal cursor during play. */
  ownCursor?: boolean;
  /** How a stored score reads (e.g. "87%"); defaults to the plain number. */
  format?(score: number): string;
  create(): Game;
}
