import type { DragEvent } from './interaction';

/**
 * Hand-friendly form controls. Every one is a `data-hit` target, so pinch (release
 * selects), mouse and keyboard all work the same way. Big hit areas; no tiny widgets.
 */

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const b = document.createElement('button');
  b.className = 'ctl-toggle';
  b.dataset.hit = '';
  b.setAttribute('role', 'switch');
  b.innerHTML = `<span class="ctl-label"></span><span class="ctl-switch"><i></i></span>`;
  b.querySelector('.ctl-label')!.textContent = label;
  const set = (v: boolean) => b.setAttribute('aria-checked', String(v));
  set(value);
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-checked') !== 'true';
    set(v);
    onChange(v);
  });
  return b;
}

export interface Option<T> {
  value: T;
  label: string;
  /** Optional extra content (e.g. a swatch) placed before the label. */
  html?: string;
}

export function segmented<T>(options: Option<T>[], value: T, onChange: (v: T) => void, className = ''): HTMLElement {
  const row = document.createElement('div');
  row.className = `ctl-seg ${className}`;
  row.setAttribute('role', 'radiogroup');
  const buttons = options.map((o) => {
    const b = document.createElement('button');
    b.dataset.hit = '';
    b.setAttribute('role', 'radio');
    b.innerHTML = `${o.html ?? ''}<span></span>`;
    b.querySelector('span')!.textContent = o.label;
    b.addEventListener('click', () => {
      select(o.value);
      onChange(o.value);
    });
    row.append(b);
    return b;
  });
  const select = (v: T) => buttons.forEach((b, i) => b.setAttribute('aria-checked', String(options[i].value === v)));
  select(value);
  return row;
}

/**
 * A slider driven by dragging: pinch on it and move (or press and drag the mouse).
 * `onChange` fires continuously; `onCommit` once when the drag ends.
 */
export function slider(
  label: string,
  value: number,
  onChange: (v: number) => void,
  onCommit: (v: number) => void = () => {},
  format: (v: number) => string = (v) => `${Math.round(v * 100)}`,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ctl-slider';
  wrap.dataset.hit = '';
  wrap.setAttribute('data-hit-drag', '');
  wrap.setAttribute('role', 'slider');
  wrap.tabIndex = 0;
  wrap.setAttribute('aria-label', label);
  // The visible label comes from the surrounding row; aria-label names it for assistive tech.
  wrap.innerHTML = `<div class="ctl-track"><div class="ctl-fill"></div><div class="ctl-knob"></div></div><output></output>`;
  const track = wrap.querySelector<HTMLElement>('.ctl-track')!;
  const out = wrap.querySelector('output')!;
  let v = value;
  const render = () => {
    wrap.style.setProperty('--v', String(v));
    out.textContent = format(v);
    wrap.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  };
  const setFromX = (x: number) => {
    const r = track.getBoundingClientRect();
    v = Math.max(0, Math.min(1, (x - r.left) / r.width));
    render();
    onChange(v);
  };
  wrap.addEventListener('hitdrag', (e) => {
    const d = (e as CustomEvent<DragEvent>).detail;
    setFromX(d.x);
    if (d.phase === 'end') onCommit(v);
  });
  wrap.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.05 : 0;
    if (!step) return;
    e.preventDefault();
    v = Math.max(0, Math.min(1, v + step));
    render();
    onChange(v);
    onCommit(v);
  });
  render();
  return wrap;
}

/** A labelled settings row. */
export function row(label: string, control: HTMLElement, note = ''): HTMLElement {
  const r = document.createElement('div');
  r.className = 'set-row';
  const l = document.createElement('div');
  l.className = 'set-row-label';
  l.textContent = label;
  if (note) {
    const n = document.createElement('small');
    n.textContent = note;
    l.append(n);
  }
  r.append(l, control);
  return r;
}
