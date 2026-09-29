import { attractPainter } from '../games/attract';
import { prefersReducedMotion } from '../lib/motion';
import { CHANNELS, GAMES, type ChannelDef } from './channels';
import type { Painter } from './painters';
import { LiveCanvas, type Scene } from './Shell';

/** Wordmark: the dots of "ii" are cursor rings (styled in CSS). */
const WORDMARK = (size: string) => `<span class="wordmark wordmark-${size}" aria-label="Webii">web<i></i><i></i></span>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  e.innerHTML = html;
  return e;
}

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, label);
  b.dataset.hit = '';
  b.addEventListener('click', onClick);
  return b;
}

// ─── start ──────────────────────────────────────────────────────────────────

export type StartState = 'idle' | 'starting' | 'ready' | 'found';

/**
 * Press-start. A real click (Start) also unlocks audio, which browsers don't allow
 * from a pinch. Raising a hand also proceeds once the camera is running (silently).
 */
export class StartScene implements Scene {
  readonly el = el('div', 'start');
  private msg: HTMLElement;
  private startBtn: HTMLButtonElement;

  constructor(opts: { onStart: () => void; onMouse: () => void }) {
    this.el.innerHTML = `
      ${WORDMARK('xl')}
      <p class="start-tag">Your webcam is the controller.</p>
      <div class="start-hand"><span></span></div>
      <p class="start-msg"></p>`;
    this.msg = this.el.querySelector('.start-msg')!;
    this.startBtn = button('btn-big btn-primary', 'Start', opts.onStart);
    const mouse = button('btn-link', 'Use mouse instead', opts.onMouse);
    const note = el('p', 'start-note', 'Video stays on this device. Nothing is recorded or uploaded.');
    this.el.append(this.startBtn, mouse, note);
    this.setState('idle');
  }

  setState(s: StartState, detail = ''): void {
    this.el.dataset.state = s;
    this.msg.textContent =
      s === 'idle'
        ? 'Press Start to turn on your camera.'
        : s === 'starting'
          ? detail || 'Waking up the camera…'
          : s === 'ready'
            ? 'Raise your hand so the camera can see it.'
            : 'There you are.';
    this.startBtn.hidden = s === 'starting' || s === 'found';
  }
}

// ─── tiles ──────────────────────────────────────────────────────────────────

/** A game plays itself (attract mode; a different seed in the preview than the tile). */
function painterFor(def: ChannelDef, where: 'tile' | 'preview'): Painter {
  if (def.game) return attractPainter(def.game, where === 'tile' ? 1 : 2);
  return (where === 'tile' ? def.tile : def.preview) ?? (() => {});
}

function tile(def: ChannelDef, onOpen: (def: ChannelDef, rect: DOMRect) => void): { el: HTMLElement; art: LiveCanvas } {
  const art = new LiveCanvas(painterFor(def, 'tile'), def.color, 'tile-art');
  const b = el('button', `tile tile-${def.kind}`);
  b.dataset.hit = '';
  b.style.setProperty('--c', def.color);
  b.append(art.el, el('span', 'tile-title', def.title), el('span', 'tile-blurb', def.blurb));
  b.addEventListener('click', () => onOpen(def, b.getBoundingClientRect()));
  return { el: b, art };
}

class TileGrid implements Scene {
  readonly el: HTMLElement;
  private arts: LiveCanvas[] = [];

  constructor(className: string, head: HTMLElement[], defs: ChannelDef[], onOpen: (def: ChannelDef, rect: DOMRect) => void, hint: string) {
    this.el = el('div', `grid-scene ${className}`);
    const header = el('header', 'grid-head');
    header.append(...head);
    const grid = el('div', 'tiles');
    for (const d of defs) {
      const t = tile(d, onOpen);
      grid.append(t.el);
      this.arts.push(t.art);
    }
    this.el.append(header, grid, el('p', 'grid-hint', hint));
  }

  update(_dt: number, t: number): void {
    for (const a of this.arts) a.draw(t);
  }
}

export class MenuScene extends TileGrid {
  constructor(onOpen: (def: ChannelDef, rect: DOMRect) => void) {
    super('menu', [el('div', 'menu-mark', WORDMARK('md'))], CHANNELS, onOpen, 'Point at a channel · pinch to open');
  }
}

export class ShelfScene extends TileGrid {
  constructor(onOpen: (def: ChannelDef, rect: DOMRect) => void, onBack: () => void) {
    super('shelf', [button('btn-pill btn-back', '‹ Back', onBack), el('h1', 'grid-title', 'Games')], GAMES, onOpen, 'Pick a game');
  }
}

// ─── preview ────────────────────────────────────────────────────────────────

/** The consistent BACK / START gate in front of anything that launches. */
export class PreviewScene implements Scene {
  readonly el = el('div', 'preview');
  private art: LiveCanvas | null = null;
  private video: HTMLVideoElement | null = null;

  constructor(def: ChannelDef, opts: { onBack: () => void; onStart: () => void }) {
    this.el.style.setProperty('--c', def.color);
    const screen = el('div', 'preview-screen');
    if (def.video) screen.append((this.video = previewVideo(def.video)));
    else {
      this.art = new LiveCanvas(painterFor(def, 'preview'), def.color, 'preview-art');
      screen.append(this.art.el);
    }
    const actions = el('div', 'preview-actions');
    actions.append(button('btn-big btn-back', 'Back', opts.onBack), button('btn-big btn-start', 'Start', opts.onStart));
    this.el.append(el('h1', 'preview-title', def.title), screen, el('p', 'preview-desc', def.description), actions);
  }

  update(_dt: number, t: number): void {
    this.art?.draw(t);
    // Browsers pause muted autoplay videos in background tabs; resume once visible.
    const v = this.video;
    if (v?.autoplay && v.paused && document.visibilityState === 'visible') void v.play().catch(() => {});
  }
}

/** Muted, looping showcase video. The poster shows while loading, with reduced motion, or if the format is unsupported. */
function previewVideo(v: { src: string; poster: string }): HTMLVideoElement {
  const video = document.createElement('video');
  video.className = 'preview-art preview-video';
  video.poster = v.poster;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('aria-hidden', 'true');
  if (!prefersReducedMotion()) {
    video.autoplay = true;
    video.src = v.src;
  }
  return video;
}
