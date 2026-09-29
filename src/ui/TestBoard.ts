import type { HitTarget, Interaction } from './interaction';

/**
 * Phase 2 test surface: every kind of target the interaction layer supports.
 * DOM buttons (3 sizes) use ordinary click handlers, so the same code serves mouse
 * and hand. Plus a round button, a canvas-drawn target and a draggable slider.
 * Replaced by the shell in Phase 3.
 */
export class TestBoard {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private canvasHits = 0;
  private canvasHover = false;
  private canvasFlash = 0;
  private off: () => void;

  constructor(parent: HTMLElement, interaction: Interaction) {
    this.el = document.createElement('main');
    this.el.className = 'board';
    this.el.innerHTML = `
      <p class="board-hint"><b>Point</b> · <b>pinch</b> · adjust · <b>release</b> to select</p>
      <div class="board-row">
        <button class="tb tb-l" data-hit>Large <span>0</span></button>
        <button class="tb tb-m" data-hit>Medium <span>0</span></button>
        <button class="tb tb-s" data-hit><span>0</span></button>
        <button class="tb tb-round" data-hit data-hit-shape="circle"><span>0</span></button>
      </div>
      <div class="board-row">
        <canvas class="tb-canvas" width="160" height="160"></canvas>
        <div class="tb-slider" data-hit data-hit-drag>
          <div class="tb-track"><div class="tb-fill"></div></div>
          <div class="tb-knob"></div>
          <output>50</output>
        </div>
      </div>`;
    parent.append(this.el);

    for (const b of this.el.querySelectorAll<HTMLButtonElement>('button.tb')) {
      const n = b.querySelector('span')!;
      b.addEventListener('click', () => (n.textContent = String(Number(n.textContent) + 1)));
    }

    // Slider: dragging sets the value from the cursor's x along the track.
    const slider = this.el.querySelector<HTMLElement>('.tb-slider')!;
    const out = slider.querySelector('output')!;
    const set = (x: number) => {
      const r = slider.querySelector('.tb-track')!.getBoundingClientRect();
      const v = Math.max(0, Math.min(1, (x - r.left) / r.width));
      slider.style.setProperty('--v', String(v));
      out.textContent = String(Math.round(v * 100));
    };
    slider.style.setProperty('--v', '0.5');
    slider.addEventListener('hitdrag', (e) => set((e as CustomEvent<{ x: number }>).detail.x));

    // Canvas target: not a DOM element, registered with a shape of its own.
    this.canvas = this.el.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    const c = this.canvas;
    const circle = () => {
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width * 0.36 };
    };
    const target: HitTarget = {
      contains: (x, y, slop) => {
        const k = circle();
        return Math.hypot(x - k.x, y - k.y) <= k.r + slop;
      },
      center: () => circle(),
      onActivate: () => {
        this.canvasHits++;
        this.canvasFlash = 1;
      },
    };
    this.off = interaction.register(target);
    interaction.on('hoverstart', (t) => t === target && (this.canvasHover = true));
    interaction.on('hoverend', (t) => t === target && (this.canvasHover = false));
  }

  update(dt: number): void {
    const { ctx, canvas } = this;
    const s = canvas.width;
    this.canvasFlash = Math.max(0, this.canvasFlash - dt * 3);
    ctx.clearRect(0, 0, s, s);
    const r = s * 0.36 * (1 + this.canvasFlash * 0.12 + (this.canvasHover ? 0.05 : 0));
    ctx.fillStyle = this.canvasFlash > 0 ? '#2fb67c' : this.canvasHover ? '#e8f1ff' : '#ffffff';
    ctx.strokeStyle = this.canvasHover ? '#2f7df6' : '#d9d8d1';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1e2330';
    ctx.font = '800 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(this.canvasHits), s / 2, s / 2 + 2);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillStyle = '#6b7080';
    ctx.fillText('canvas', s / 2, s / 2 + 26);
  }

  set enabled(on: boolean) {
    this.el.inert = !on;
  }

  dispose(): void {
    this.off();
    this.el.remove();
  }
}
