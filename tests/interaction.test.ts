// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { HandController, type HandDriver, type HandSample, type HandSource } from '../src/input/Hand';
import { Interaction, type HitTarget } from '../src/ui/interaction';

/** A hand we move by hand. */
class Script implements HandDriver {
  s: HandSample = { state: 'tracking', present: true, x: 0, y: 0, vx: 0, vy: 0, pinchStrength: 0, pressed: false };
  constructor(readonly source: HandSource = 'camera') {}
  sample() {
    return { ...this.s };
  }
  dispose() {}
}

function rig(source: HandSource = 'camera') {
  const drv = new Script(source);
  const hand = new HandController(() => ({ w: 1000, h: 800 }));
  hand.setDriver(drv);
  const ix = new Interaction(hand, {}, null);
  const log: string[] = [];
  const name = (t: HitTarget | null) => (t as { name?: string } | null)?.name ?? 'none';
  ix.on('hoverstart', (t) => log.push(`hover:${name(t)}`));
  ix.on('hoverend', (t) => log.push(`leave:${name(t)}`));
  ix.on('press', (t) => log.push(`press:${name(t)}`));
  ix.on('activate', (t) => log.push(`activate:${name(t)}`));
  ix.on('release', () => log.push('release'));
  let now = 0;
  const frame = (patch: Partial<HandSample> = {}) => {
    Object.assign(drv.s, patch);
    hand.update((now += 16));
    ix.update(now);
  };
  return { ix, hand, drv, log, frame };
}

/** A circular canvas-style target. */
function circle(name: string, x: number, y: number, r: number, extra: Partial<HitTarget> = {}) {
  return {
    name,
    contains: (px: number, py: number, slop: number) => Math.hypot(px - x, py - y) <= r + slop,
    center: () => ({ x, y }),
    ...extra,
  } as HitTarget & { name: string };
}

describe('Interaction', () => {
  it('acquires a target within the hit slop (+12 px)', () => {
    const r = rig();
    r.ix.register(circle('a', 100, 100, 30));
    r.frame({ x: 141, y: 100 }); // 41 px from centre: 11 px outside the edge
    expect(r.ix.hovered).not.toBeNull();
    r.frame({ x: 145, y: 100 }); // still hovered: sticky up to +20
    r.frame({ x: 200, y: 100 });
    expect(r.ix.hovered).toBeNull();
  });

  it('hover is sticky (hysteresis) so jitter at an edge does not flicker', () => {
    const r = rig();
    r.ix.register(circle('a', 100, 100, 30));
    r.frame({ x: 120, y: 100 });
    for (const x of [148, 139, 149, 141, 147]) r.frame({ x, y: 100 }); // wobbling 9–19 px outside
    expect(r.log.filter((l) => l.startsWith('hover')).length).toBe(1);
    expect(r.log).not.toContain('leave:a');
  });

  it('a target the cursor is exactly inside beats a sticky neighbour', () => {
    const r = rig();
    r.ix.register(circle('a', 100, 100, 30));
    r.ix.register(circle('b', 170, 100, 30));
    r.frame({ x: 110, y: 100 });
    r.frame({ x: 145, y: 100 }); // inside b's area, within a's sticky margin
    expect(r.log).toEqual(['hover:a', 'leave:a', 'hover:b']);
  });

  it('RELEASE SELECTS: pinch off-target, adjust onto it while held, release activates', () => {
    const r = rig();
    const onActivate = vi.fn();
    r.ix.register(circle('a', 100, 100, 30, { onActivate }));
    r.frame({ x: 300, y: 300 });
    r.frame({ pressed: true, pinchStrength: 1 });
    r.frame({ x: 105, y: 98 }); // corrected while holding
    r.frame({ pressed: false, pinchStrength: 0.3 });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(r.log).toEqual(['press:none', 'hover:a', 'activate:a']);
  });

  it('releasing away from every target activates nothing', () => {
    const r = rig();
    const onActivate = vi.fn();
    r.ix.register(circle('a', 100, 100, 30, { onActivate }));
    r.frame({ x: 100, y: 100 });
    r.frame({ pressed: true });
    r.frame({ x: 400, y: 400 });
    r.frame({ pressed: false });
    expect(onActivate).not.toHaveBeenCalled();
    expect(r.log.at(-1)).toBe('release');
  });

  it('losing the hand mid-pinch never activates', () => {
    const r = rig();
    const onActivate = vi.fn();
    r.ix.register(circle('a', 100, 100, 30, { onActivate }));
    r.frame({ x: 100, y: 100 });
    r.frame({ pressed: true });
    r.frame({ present: false, state: 'lost' });
    expect(onActivate).not.toHaveBeenCalled();
    expect(r.ix.hovered).toBeNull();
  });

  it('drag: a pinch starting on a draggable target captures it, and never activates it', () => {
    const r = rig();
    const onDrag = vi.fn();
    const onActivate = vi.fn();
    r.ix.register(circle('s', 100, 100, 30, { draggable: true, onDrag, onActivate }));
    r.frame({ x: 100, y: 100 });
    r.frame({ pressed: true });
    r.frame({ x: 400, y: 100 }); // far outside: still captured
    r.frame({ pressed: false });
    const phases = onDrag.mock.calls.map((c) => c[0].phase);
    expect(phases[0]).toBe('start');
    expect(phases.at(-1)).toBe('end');
    expect(phases.slice(1, -1).every((p) => p === 'move')).toBe(true);
    expect(onDrag.mock.calls.some((c) => c[0].phase === 'move' && c[0].x === 400)).toBe(true);
    expect(onDrag.mock.calls[2][0].completed).toBe(true);
    expect(onActivate).not.toHaveBeenCalled();
    expect(r.ix.state).not.toBe('dragging');
  });

  it('a drag cut short by losing the hand ends as not completed', () => {
    const r = rig();
    const onDrag = vi.fn();
    r.ix.register(circle('s', 100, 100, 30, { draggable: true, onDrag }));
    r.frame({ x: 100, y: 100 });
    r.frame({ pressed: true });
    r.frame({ present: false, state: 'lost' });
    expect(onDrag.mock.calls.at(-1)![0]).toMatchObject({ phase: 'end', completed: false });
  });

  it('disabled targets and a disabled layer are ignored', () => {
    const r = rig();
    r.ix.register(circle('a', 100, 100, 30, { disabled: () => true }));
    r.frame({ x: 100, y: 100 });
    expect(r.ix.hovered).toBeNull();
    const r2 = rig();
    const onActivate = vi.fn();
    r2.ix.register(circle('b', 100, 100, 30, { onActivate }));
    r2.ix.enabled = false;
    r2.frame({ x: 100, y: 100 });
    r2.frame({ pressed: true });
    r2.frame({ pressed: false });
    expect(r2.ix.hovered).toBeNull();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('magnetism: the drawn cursor leans toward the centre, eased in and capped at 14 px', () => {
    const r = rig();
    r.ix.register(circle('big', 500, 400, 200));
    r.frame({ x: 900, y: 50 }); // warm-up frame, outside
    r.frame({ x: 350, y: 400 }); // 150 px from centre
    const first = r.ix.display.x - 350;
    for (let i = 0; i < 30; i++) r.frame();
    const settled = r.ix.display.x - 350;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(settled); // eased, not a jump
    expect(settled).toBeCloseTo(14, 0); // 30% of 150 = 45, capped at 14
    expect(r.hand.position.x).toBe(350); // the real position is untouched
  });

  it('a press uses the hover at the moment of the press, not last frame’s', () => {
    const r = rig();
    const onDrag = vi.fn();
    const onActivate = vi.fn();
    r.ix.register(circle('slider', 100, 100, 30, { draggable: true, onDrag }));
    r.ix.register(circle('button', 400, 100, 30, { onActivate }));
    r.frame({ x: 100, y: 100 }); // hovering the slider…
    r.frame({ x: 400, y: 100, pressed: true }); // …moved AND pressed within one frame
    r.frame({ pressed: false });
    expect(onDrag).not.toHaveBeenCalled();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('reports interaction state', () => {
    const r = rig();
    r.ix.register(circle('a', 100, 100, 30));
    r.frame({ x: 500, y: 500 });
    expect(r.ix.state).toBe('idle');
    r.frame({ x: 100, y: 100 });
    expect(r.ix.state).toBe('hovering');
    r.frame({ pressed: true });
    expect(r.ix.state).toBe('pressing');
  });
});

describe('Interaction with DOM targets', () => {
  function domRig(source: HandSource) {
    document.body.innerHTML = '<button data-hit id="b">Go</button><div id="cover"></div>';
    const b = document.getElementById('b')!;
    b.getBoundingClientRect = () => ({ left: 50, top: 50, right: 150, bottom: 100, width: 100, height: 50, x: 50, y: 50, toJSON() {} }) as DOMRect;
    const r = rig(source);
    (r.ix as unknown as { root: ParentNode }).root = document;
    return { r, b };
  }

  it('activates a DOM target with a real click() when driven by a hand', () => {
    const { r, b } = domRig('camera');
    document.elementFromPoint = () => b;
    const click = vi.fn();
    b.addEventListener('click', click);
    r.frame({ x: 100, y: 75 });
    expect(b.classList.contains('is-hover')).toBe(true);
    r.frame({ pressed: true });
    expect(b.classList.contains('is-pressed')).toBe(true);
    r.frame({ pressed: false });
    expect(click).toHaveBeenCalledTimes(1);
    expect(b.classList.contains('is-activated')).toBe(true);
  });

  it('does not synthesize a second click when a real mouse already clicked', () => {
    const { r, b } = domRig('pointer');
    document.elementFromPoint = () => b;
    const click = vi.fn();
    b.addEventListener('click', click);
    r.frame({ x: 100, y: 75 });
    r.frame({ pressed: true });
    r.frame({ pressed: false });
    expect(click).not.toHaveBeenCalled(); // the browser's own click handles it
  });

  it('respects stacking: a target covered by an overlay cannot be hit', () => {
    const { r } = domRig('camera');
    document.elementFromPoint = () => document.getElementById('cover');
    r.frame({ x: 100, y: 75 });
    expect(r.ix.hovered).toBeNull();
  });
});
