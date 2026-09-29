// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchExternal, resetLaunch } from '../src/shell/launch';

beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof matchMedia;
});
afterEach(() => {
  resetLaunch();
  vi.useRealTimers();
});

describe('launchExternal', () => {
  it('shows the exit overlay, then navigates in the same tab', () => {
    const navigate = vi.fn();
    expect(launchExternal('https://ashens-web.netlify.app/', { navigate, label: 'Opening portfolio…' })).toBe(true);
    const overlay = document.querySelector('.launch-overlay')!;
    expect(overlay.textContent).toContain('Opening portfolio…');
    expect(overlay.textContent).toContain('ashens-web.netlify.app');
    expect(navigate).not.toHaveBeenCalled(); // the transition plays first
    vi.advanceTimersByTime(900);
    expect(overlay.classList.contains('is-in')).toBe(true);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('https://ashens-web.netlify.app/');
  });

  it('a second START during the transition does not launch twice', () => {
    const navigate = vi.fn();
    launchExternal('https://example.com/', { navigate });
    expect(launchExternal('https://example.com/', { navigate })).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.launch-overlay').length).toBe(1);
  });

  it('resetLaunch (back-forward cache return) clears the exit state', () => {
    launchExternal('https://example.com/', { navigate: vi.fn() });
    resetLaunch();
    expect(document.querySelector('.launch-overlay')).toBeNull();
    expect(launchExternal('https://example.com/', { navigate: vi.fn() })).toBe(true); // usable again
  });

  it('reduced motion: no grow animation, quick navigate', () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q })) as unknown as typeof matchMedia;
    const navigate = vi.fn();
    const from = document.createElement('div');
    from.animate = vi.fn() as unknown as typeof from.animate;
    launchExternal('https://example.com/', { navigate, from });
    expect(from.animate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
