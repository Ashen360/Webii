// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { HandController } from '../src/input/Hand';
import { PointerDriver } from '../src/input/PointerDriver';

function rig() {
  const hand = new HandController(() => ({ w: 800, h: 600 }));
  hand.setDriver(new PointerDriver());
  const log: string[] = [];
  hand.on('pinchstart', () => log.push('start'));
  hand.on('pinchend', (e) => log.push(e.cancelled ? 'cancel' : 'end'));
  hand.on('lost', () => log.push('lost'));
  let t = 0;
  const frame = () => hand.update((t += 16));
  const fire = (type: string, pointerType = 'mouse') =>
    window.dispatchEvent(new PointerEvent(type, { clientX: 100, clientY: 100, button: 0, pointerType }));
  return { hand, log, frame, fire };
}

describe('PointerDriver', () => {
  it('a click shorter than one frame still registers', () => {
    const r = rig();
    r.fire('pointermove');
    r.frame();
    r.fire('pointerdown');
    r.fire('pointerup');
    r.frame();
    r.frame();
    expect(r.log).toEqual(['start', 'end']);
  });

  it('a touch tap is a click, not a cancelled press', () => {
    const r = rig();
    r.fire('pointerdown', 'touch');
    r.fire('pointerup', 'touch');
    for (let i = 0; i < 4; i++) r.frame();
    expect(r.log).toEqual(['start', 'end', 'lost']);
    expect(r.hand.present).toBe(false);
  });
});
