import type { Hand } from '../input/Hand';
import type { Scene } from '../shell/Shell';
import { palette } from '../shell/theme';
import type { Sfx } from '../ui/audio';
import { GameRunner, type Phase } from './runner';
import { recordScore } from './scores';
import type { GameCue, GameResult, GameSpec } from './types';
import { TINTS } from './util';
import { prefersReducedMotion } from '../lib/motion';

/**
 * A game on screen: a full-viewport HiDPI canvas plus the shared chrome every game gets
 * (intro card, countdown, HUD with score and timer, pause card, result tray). The
 * lifecycle lives in GameRunner; this class only renders it and routes input.
 *
 * Every button is a big `data-hit` target, so hand, mouse and keyboard all work. The
 * result sits in a bottom tray so the final field (e.g. Memory Trace's reveal) stays
 * visible above it.
 */

export interface GameSceneOptions {
  hand: Hand;
  play(sfx: Sfx): void;
  onExit(): void;
  /** Tests: fixed seed for reproducible rounds. */
  seed?: number;
}

const PAUSE_COPY = {
  lost: ['Hand lost', 'Bring your hand back into view, then pinch Resume.'],
  user: ['Paused', ''],
  hidden: ['Paused', ''],
} as const;

export class GameScene implements Scene {
  readonly el: HTMLElement;
  readonly runner: GameRunner;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private q: <T extends HTMLElement = HTMLElement>(sel: string) => T;
  private off: (() => void)[] = [];
  private lastHud = '';
  private lastTimer = '';
  private sized = false;

  constructor(
    readonly spec: GameSpec,
    private opts: GameSceneOptions,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'game';
    this.el.style.setProperty('--c', spec.color);
    this.el.innerHTML = `
      <canvas class="game-canvas"></canvas>
      <div class="game-hud">
        <button class="game-pause-btn" data-hit data-hit-shape="circle" aria-label="Pause"><i></i><i></i></button>
        <span class="game-score"></span>
        <span class="game-timer"><b></b></span>
      </div>
      <div class="game-card game-intro">
        <h1></h1>
        <p class="game-instruction"></p>
        <div class="game-ready"><span class="game-ready-ring"></span><span class="game-ready-text"></span></div>
        <button class="btn-link game-intro-back" data-hit>Back</button>
      </div>
      <div class="game-count" aria-live="assertive"></div>
      <div class="game-card game-paused">
        <h2></h2>
        <p></p>
        <div class="game-actions">
          <button class="btn-big btn-primary game-resume" data-hit>Resume</button>
          <button class="btn-big game-restart" data-hit>Restart</button>
          <button class="btn-big btn-back game-exit" data-hit>Exit</button>
        </div>
      </div>
      <div class="game-result">
        <div class="game-result-score"><b></b><span></span></div>
        <p class="game-result-detail"></p>
        <p class="game-result-best"></p>
        <div class="game-actions">
          <button class="btn-big btn-back game-exit" data-hit>Exit</button>
          <button class="btn-big btn-primary game-again" data-hit>Again</button>
        </div>
      </div>
      <div class="game-card game-error" role="alert">
        <h2>Something went wrong</h2>
        <p>This game hit a problem and stopped. Everything else still works.</p>
        <div class="game-actions">
          <button class="btn-big btn-primary game-exit" data-hit>Exit</button>
        </div>
      </div>`;
    this.q = <T extends HTMLElement>(sel: string) => this.el.querySelector<T>(sel)!;
    this.canvas = this.q<HTMLCanvasElement>('.game-canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.q('.game-intro h1').textContent = spec.title;
    this.q('.game-instruction').textContent = spec.instruction;

    const cue = (name: GameCue) => opts.play(name);
    this.runner = new GameRunner(spec, () => ({ w: innerWidth, h: innerHeight }), { cue, attract: false, seed: opts.seed });

    const click = (sel: string, fn: () => void) => this.el.querySelectorAll(sel).forEach((b) => b.addEventListener('click', fn));
    click('.game-pause-btn', () => this.runner.pause('user'));
    click('.game-resume', () => this.runner.resume());
    click('.game-restart, .game-again', () => this.runner.retry());
    click('.game-exit, .game-intro-back', () => opts.onExit());

    this.off.push(
      this.runner.on('phase', (p) => this.onPhase(p)),
      this.runner.on('beat', (n) => this.onBeat(n)),
      this.runner.on('warn', () => {
        opts.play('tick');
        this.pop(this.q('.game-timer'));
      }),
      this.runner.on('finish', (r) => this.onFinish(r)),
    );
    const onVis = () => document.visibilityState === 'hidden' && this.runner.pause('hidden');
    document.addEventListener('visibilitychange', onVis);
    this.off.push(() => document.removeEventListener('visibilitychange', onVis));
    this.onPhase(this.runner.phase);
  }

  /** Escape / Backspace: pause a running game; otherwise let the shell go back. */
  onBack(): boolean {
    if (this.failed) return false;
    const p = this.runner.phase;
    if (p === 'play' || p === 'countdown') {
      this.runner.pause('user');
      return true;
    }
    return false;
  }

  update(dt: number): void {
    if (this.failed) return;
    try {
      const { hand } = this.opts;
      if (this.resize()) this.runner.game.resize?.(innerWidth, innerHeight);
      this.runner.update(dt, hand);
      this.draw();
      this.renderChrome();
    } catch (err) {
      // A bug in one game must not freeze the console: stop it and offer the way out.
      this.failed = true;
      console.error(`[webii] ${this.spec.id} crashed`, err);
      this.el.dataset.phase = 'error';
      document.body.classList.remove('game-own-cursor');
      this.opts.play('error');
    }
  }

  /** The game threw and was stopped (the error card is showing). */
  failed = false;

  onDestroy(): void {
    for (const f of this.off) f();
    document.body.classList.remove('game-own-cursor');
  }

  // ─── rendering ────────────────────────────────────────────────────────────

  /** Match the backing store to the CSS size (HiDPI). True if the field changed size. */
  private resize(): boolean {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(innerWidth * dpr);
    const h = Math.round(innerHeight * dpr);
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    const changed = this.sized;
    this.sized = true;
    return changed;
  }

  private draw(): void {
    const dpr = this.canvas.width / Math.max(1, innerWidth);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, innerWidth, innerHeight);
    this.runner.game.draw(this.ctx, innerWidth, innerHeight, palette(), this.opts.hand);
  }

  private renderChrome(): void {
    const r = this.runner;
    const hud = r.game.hud?.() ?? '';
    if (hud !== this.lastHud) this.q('.game-score').textContent = this.lastHud = hud;

    // The round's timer, or the game's own stage timer (Memory Trace).
    const timer = r.timeLeft != null ? { left: r.timeLeft, total: r.spec.duration! } : (r.game.timer?.() ?? null);
    if (timer) {
      const text = String(Math.ceil(timer.left));
      if (text !== this.lastTimer) this.q('.game-timer b').textContent = this.lastTimer = text;
      this.q('.game-timer').style.setProperty('--p', (timer.left / timer.total).toFixed(4));
    }
    this.q('.game-timer').hidden = !timer;

    if (r.phase === 'intro') {
      this.q('.game-ready').style.setProperty('--p', r.introProgress.toFixed(3));
      this.q('.game-ready-text').textContent = this.opts.hand.present ? 'Get ready…' : 'Raise your hand to begin';
    }
  }

  private onPhase(p: Phase): void {
    this.el.dataset.phase = p;
    document.body.classList.toggle('game-own-cursor', p === 'play' && !!this.spec.ownCursor);
    if (p === 'paused') {
      const [title, hint] = PAUSE_COPY[this.runner.pauseReason ?? 'user'];
      this.q('.game-paused h2').textContent = title;
      this.q('.game-paused p').textContent = this.opts.hand.source === 'pointer' && hint ? 'Move the mouse back, then click Resume.' : hint;
      this.opts.play('pause');
    }
  }

  private onBeat(n: number): void {
    const el = this.q('.game-count');
    el.textContent = n > 0 ? String(n) : 'Go!';
    this.pop(el);
    this.opts.play(n > 0 ? 'tick' : 'go');
  }

  private onFinish(res: GameResult): void {
    const { previous, isBest } = recordScore(this.spec.id, res.score);
    this.q('.game-result-score b').textContent = res.display;
    this.q('.game-result-score span').textContent = res.label;
    this.q('.game-result-detail').textContent = res.detail ?? '';
    const best = this.q('.game-result-best');
    best.classList.toggle('is-new', isBest);
    best.textContent = isBest ? (previous === null ? 'First score!' : 'New best!') : `Best: ${previous === null ? '—' : format(this.spec, previous)}`;
    this.opts.play(isBest ? 'success' : 'finish');
    if (isBest && previous !== null) this.confetti();
  }

  /** A short burst from the result tray for a new best (not for the very first score). */
  private confetti(): void {
    if (prefersReducedMotion()) return;
    const tray = this.q('.game-result');
    tray.querySelector('.game-confetti')?.remove();
    const burst = document.createElement('div');
    burst.className = 'game-confetti';
    burst.setAttribute('aria-hidden', 'true');
    const tints = [this.spec.color, ...TINTS];
    for (let i = 0; i < 22; i++) {
      const bit = document.createElement('i');
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const d = 90 + Math.random() * 130;
      bit.style.cssText = `--dx:${(Math.cos(a) * d).toFixed(0)}px;--dy:${(Math.sin(a) * d).toFixed(0)}px;--r:${Math.round(Math.random() * 720 - 360)}deg;--t:${tints[i % tints.length]};--delay:${(Math.random() * 0.12).toFixed(2)}s`;
      burst.append(bit);
    }
    tray.append(burst);
    setTimeout(() => burst.remove(), 1600);
  }

  /** Restart a CSS pop animation. */
  private pop(el: HTMLElement): void {
    el.classList.remove('is-pop');
    void el.offsetWidth;
    el.classList.add('is-pop');
  }
}

const format = (spec: GameSpec, score: number) => spec.format?.(score) ?? String(score);
