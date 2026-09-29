import type { Hand } from '../input/Hand';
import { Emitter } from '../lib/emitter';
import { seededRandom } from '../lib/math';
import type { Game, GameEnv, GameResult, GameSpec } from './types';

/**
 * The game lifecycle as a pure state machine (no DOM, no audio): GameScene renders
 * it, tests drive it with synthetic hands.
 *
 *   intro ──hand held up──► countdown ──► play ──time up / game over──► result
 *                              ▲           │  ▲                         │
 *                              │     lost/user/hidden                    │
 *                              │           ▼  │ (resume)                 │
 *                              └─────── paused ◄──────────── retry ──────┘
 *
 * A lost hand pauses immediately (the Hand already absorbs short dropouts), and play
 * resumes only on an explicit Resume followed by a short countdown: a hand that
 * reappears mid-motion must not drop the player back into a running game.
 */

export type Phase = 'intro' | 'countdown' | 'play' | 'paused' | 'result';
export type PauseReason = 'lost' | 'user' | 'hidden';

export interface RunnerEvents extends Record<string, unknown> {
  phase: Phase;
  /** Countdown beats: 3, 2, 1, then 0 = go. */
  beat: number;
  /** Timed games: whole seconds left, for the final few. */
  warn: number;
  finish: GameResult;
}

/** The hand must stay up this long on the intro card before the countdown starts. */
export const INTRO_HOLD = 1.0;
/** The intro card is readable for at least this long. */
export const INTRO_MIN = 1.2;
export const BEAT = 0.75;
/** Resuming from a pause counts down faster: the player already knows the game. */
export const RESUME_BEAT = 0.55;
export const WARN_FROM = 3;

export class GameRunner {
  phase: Phase = 'intro';
  pauseReason: PauseReason | null = null;
  /** Seconds of play (pauses excluded). */
  time = 0;
  result: GameResult | null = null;
  readonly game: Game;

  private events = new Emitter<RunnerEvents>();
  private phaseTime = 0;
  private handUp = 0;
  private beatLen = BEAT;
  /** Remaining countdown beats to announce (3, 2, 1, go). */
  private nextBeat = 3;
  private lastWarn = Infinity;
  /** Seed of the current round; retry derives the next one. */
  private seed: number;

  constructor(
    readonly spec: GameSpec,
    private field: () => { w: number; h: number },
    private env: Omit<GameEnv, 'rng'> & { seed?: number },
  ) {
    this.game = spec.create();
    this.seed = env.seed ?? (Math.random() * 2 ** 32) >>> 0;
    this.startRound();
  }

  on<K extends keyof RunnerEvents>(e: K, fn: (p: RunnerEvents[K]) => void): () => void {
    return this.events.on(e, fn);
  }

  /** Seconds left in a timed game (null for untimed). */
  get timeLeft(): number | null {
    return this.spec.duration == null ? null : Math.max(0, this.spec.duration - this.time);
  }

  /** Countdown value on screen (3, 2, 1, 0 = "Go"), or null outside the countdown. */
  get countdown(): number | null {
    if (this.phase !== 'countdown') return null;
    return Math.max(0, 3 - Math.floor(this.phaseTime / this.beatLen));
  }

  /** 0..1 progress of the intro's hand-hold (for a filling ring). */
  get introProgress(): number {
    return Math.min(1, this.handUp / INTRO_HOLD);
  }

  update(dt: number, hand: Hand): void {
    this.phaseTime += dt;
    switch (this.phase) {
      case 'intro':
        this.handUp = hand.present ? this.handUp + dt : 0;
        if (this.handUp >= INTRO_HOLD && this.phaseTime >= INTRO_MIN) this.begin(BEAT);
        return;
      case 'countdown':
        if (!hand.present) return this.pause('lost');
        this.tickCountdown();
        return;
      case 'play':
        if (!hand.present) return this.pause('lost');
        this.time += dt;
        this.game.update(dt, hand, this.time);
        this.warnLastSeconds();
        if (this.game.over || (this.spec.duration != null && this.time >= this.spec.duration)) this.finish();
        return;
    }
  }

  pause(reason: PauseReason): void {
    if (this.phase !== 'play' && this.phase !== 'countdown') return;
    this.pauseReason = reason;
    this.set('paused');
  }

  /** Paused → a short countdown → play. */
  resume(): void {
    if (this.phase !== 'paused') return;
    this.pauseReason = null;
    this.begin(RESUME_BEAT);
  }

  /** A fresh round straight into the countdown (no intro: the player knows the game). */
  retry(): void {
    this.seed = (this.seed + 0x9e3779b9) >>> 0;
    this.startRound();
    this.begin(BEAT);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private startRound(): void {
    const { w, h } = this.field();
    this.time = 0;
    this.result = null;
    this.lastWarn = Infinity;
    const { seed: _seed, ...env } = this.env;
    this.game.start(w, h, { ...env, rng: seededRandom(this.seed) });
  }

  private begin(beatLen: number): void {
    this.beatLen = beatLen;
    this.nextBeat = 3;
    this.set('countdown');
    this.tickCountdown();
  }

  private tickCountdown(): void {
    // Announce every beat whose start has passed (a long frame can cross several).
    while (this.nextBeat >= 0 && this.phaseTime >= (3 - this.nextBeat) * this.beatLen) {
      this.events.emit('beat', this.nextBeat);
      this.nextBeat--;
    }
    // "Go" shows for a moment, but play starts on it: the round begins at the Go.
    if (this.nextBeat < 0) this.set('play');
  }

  private warnLastSeconds(): void {
    const left = this.timeLeft;
    if (left == null) return;
    const whole = Math.ceil(left);
    if (whole <= WARN_FROM && whole > 0 && whole < this.lastWarn) {
      this.lastWarn = whole;
      this.events.emit('warn', whole);
    }
  }

  private finish(): void {
    this.result = this.game.result();
    this.set('result');
    this.events.emit('finish', this.result);
  }

  private set(p: Phase): void {
    if (p === this.phase) return;
    this.phase = p;
    this.phaseTime = 0;
    this.handUp = 0;
    this.events.emit('phase', p);
  }
}
