// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, sanitize, SettingsStore } from '../src/settings';
import { segmented, slider, toggle } from '../src/ui/controls';

beforeEach(() => localStorage.clear());

describe('settings store', () => {
  it('sanitizes anything into valid settings', () => {
    expect(sanitize(null)).toEqual(DEFAULTS);
    expect(sanitize('garbage')).toEqual(DEFAULTS);
    const s = sanitize({
      theme: { name: 'hotdog' },
      audio: { volume: 7, sfx: 'yes' },
      cursor: { size: 'huge' },
      camera: { deviceId: 42 },
      pip: { corner: 'middle', enabled: false },
    });
    expect(s.theme.name).toBe('paper');
    expect(s.audio.volume).toBe(1); // clamped
    expect(s.audio.sfx).toBe(true); // non-boolean → default
    expect(s.cursor.size).toBe('medium');
    expect(s.camera.deviceId).toBeNull();
    expect(s.pip.corner).toBe('bottom-right');
    expect(s.pip.enabled).toBe(false); // valid values are kept
  });

  it('persists updates and notifies watchers', () => {
    const a = new SettingsStore('t1');
    const seen = vi.fn();
    a.watch(seen);
    a.update('theme', { name: 'night' });
    expect(seen).toHaveBeenCalledTimes(2); // immediately + on change
    expect(new SettingsStore('t1').get().theme.name).toBe('night');
  });

  it('rejects invalid updates', () => {
    const a = new SettingsStore('t2');
    a.update('audio', { volume: -3 });
    expect(a.get().audio.volume).toBe(0);
  });

  it('migrates the old cameraId key', () => {
    localStorage.setItem('webii:cameraId', JSON.stringify('cam-123'));
    expect(new SettingsStore('t3').get().camera.deviceId).toBe('cam-123');
    expect(localStorage.getItem('webii:cameraId')).toBeNull();
  });
});

describe('controls', () => {
  it('toggle flips and reports', () => {
    const fn = vi.fn();
    const t = toggle('Sound', true, fn);
    t.click();
    expect(fn).toHaveBeenLastCalledWith(false);
    expect(t.getAttribute('aria-checked')).toBe('false');
    expect(t.hasAttribute('data-hit')).toBe(true);
  });

  it('segmented selects exactly one option', () => {
    const fn = vi.fn();
    const seg = segmented(
      [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      'a',
      fn,
    );
    const [a, b] = seg.querySelectorAll('button');
    b.click();
    expect(fn).toHaveBeenCalledWith('b');
    expect(a.getAttribute('aria-checked')).toBe('false');
    expect(b.getAttribute('aria-checked')).toBe('true');
  });

  it('slider follows a hand drag along the track, commits on release', () => {
    const change = vi.fn();
    const commit = vi.fn();
    const s = slider('Volume', 0.5, change, commit);
    document.body.append(s);
    s.querySelector<HTMLElement>('.ctl-track')!.getBoundingClientRect = () =>
      ({ left: 100, width: 200, top: 0, right: 300, bottom: 10, height: 10, x: 100, y: 0, toJSON() {} }) as DOMRect;
    const drag = (phase: string, x: number) => s.dispatchEvent(new CustomEvent('hitdrag', { detail: { phase, x, y: 0, completed: true } }));
    drag('start', 150);
    drag('move', 250);
    drag('move', 999); // beyond the track clamps
    drag('end', 999);
    expect(change).toHaveBeenLastCalledWith(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(s.querySelector('output')!.textContent).toBe('100');
  });

  it('slider works from the keyboard', () => {
    const change = vi.fn();
    const s = slider('Volume', 0.5, change);
    s.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(change).toHaveBeenLastCalledWith(0.55);
  });
});

describe('SettingsScene', () => {
  const api = (active: boolean) => ({
    cameraActive: () => active,
    cameras: async () => [
      { id: 'a', label: 'Built-in' },
      { id: 'b', label: 'USB cam' },
    ],
    calibrate: vi.fn(),
    resetCalibration: vi.fn(),
    calibrationInfo: () => 'Calibrated 28 Sep.',
    sample: vi.fn(),
  });

  it('Hand: calibrate and reset go to the app when the camera is on', async () => {
    const { SettingsScene } = await import('../src/shell/SettingsScene');
    const a = api(true);
    const s = new SettingsScene(a, () => {});
    s.el.querySelector<HTMLButtonElement>('[data-section=hand]')!.click();
    const [calibrate, reset] = s.el.querySelectorAll<HTMLButtonElement>('.set-actions button');
    expect(calibrate.disabled).toBe(false);
    calibrate.click();
    reset.click();
    expect(a.calibrate).toHaveBeenCalledTimes(1);
    expect(a.resetCalibration).toHaveBeenCalledTimes(1);
    expect(s.el.querySelector('.set-info')!.textContent).toBe('Calibrated 28 Sep.');
  });

  it('Hand: disabled (with an explanation) in mouse mode', async () => {
    const { SettingsScene } = await import('../src/shell/SettingsScene');
    const s = new SettingsScene(api(false), () => {});
    s.el.querySelector<HTMLButtonElement>('[data-section=hand]')!.click();
    expect(s.el.querySelector<HTMLButtonElement>('.set-actions button')!.disabled).toBe(true);
    expect(s.el.querySelector('.set-info')!.textContent).toMatch(/Turn on the camera/);
  });

  it('Camera: lists multiple cameras as a choice and stores the pick', async () => {
    const { SettingsScene } = await import('../src/shell/SettingsScene');
    const { settings } = await import('../src/settings');
    const s = new SettingsScene(api(true), () => {});
    s.el.querySelector<HTMLButtonElement>('[data-section=camera]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    const choices = [...s.el.querySelectorAll<HTMLButtonElement>('.ctl-cams button')];
    expect(choices.map((b) => b.textContent)).toEqual(['Built-in', 'USB cam']);
    choices[1].click();
    expect(settings.get().camera.deviceId).toBe('b');
  });

  it('Theme: picking a theme updates the setting', async () => {
    const { SettingsScene } = await import('../src/shell/SettingsScene');
    const { settings } = await import('../src/settings');
    const s = new SettingsScene(api(true), () => {});
    [...s.el.querySelectorAll<HTMLButtonElement>('.ctl-themes button')].find((b) => b.textContent === 'Night')!.click();
    expect(settings.get().theme.name).toBe('night');
  });
});
