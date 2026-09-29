// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Shell, type Scene } from '../src/shell/Shell';

// Reduced motion → transitions are instant, so structure can be asserted directly.
beforeEach(() => {
  window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q })) as unknown as typeof matchMedia;
  document.body.innerHTML = '';
});

function scene(name: string): Scene & { name: string; shown: number; destroyed: number } {
  const s = {
    name,
    el: document.createElement('div'),
    shown: 0,
    destroyed: 0,
    onShow() {
      s.shown++;
    },
    onDestroy() {
      s.destroyed++;
    },
    update: vi.fn(),
  };
  return s;
}

describe('Shell scene stack', () => {
  it('replace shows a single root scene', () => {
    const shell = new Shell(document.body);
    const a = scene('a');
    shell.replace(a);
    expect(shell.top).toBe(a);
    expect(shell.depth).toBe(1);
    expect(a.shown).toBe(1);
    expect(shell.pop()).toBe(false); // can't go back past the root
  });

  it('push keeps the previous scene alive but un-hittable, pop restores it', () => {
    const shell = new Shell(document.body);
    const menu = scene('menu');
    const preview = scene('preview');
    shell.replace(menu);
    shell.push(preview);
    expect(menu.el.inert).toBe(true); // interaction layer skips [inert]
    expect(menu.el.classList.contains('is-behind')).toBe(true);
    expect(preview.el.isConnected).toBe(true);

    expect(shell.pop()).toBe(true);
    expect(shell.top).toBe(menu);
    expect(menu.el.inert).toBe(false);
    expect(menu.el.classList.contains('is-behind')).toBe(false);
    expect(menu.shown).toBe(2);
    expect(preview.destroyed).toBe(1);
    expect(preview.el.isConnected).toBe(false);
  });

  it('replace destroys the whole stack', () => {
    const shell = new Shell(document.body);
    const a = scene('a');
    const b = scene('b');
    const c = scene('c');
    shell.replace(a);
    shell.push(b);
    shell.replace(c);
    expect(a.destroyed + b.destroyed).toBe(2);
    expect(shell.depth).toBe(1);
  });

  it('only the top scene is updated each frame', () => {
    const shell = new Shell(document.body);
    const a = scene('a');
    const b = scene('b');
    shell.replace(a);
    shell.push(b);
    shell.update(0.016, { present: false, position: { x: 0, y: 0 }, isPinching: false });
    expect(b.update).toHaveBeenCalled();
    expect(a.update).not.toHaveBeenCalled();
  });
});
