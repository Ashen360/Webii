/**
 * Leaving Webii for an external experience (the portfolio): the preview screen grows
 * to fill the display, the room fades out, then the page navigates in the SAME tab.
 * A new tab would need a real click; a pinch isn't a browser "user activation", so
 * window.open would be silently blocked for hand users. The browser's Back button
 * returns to Webii.
 */
import { prefersReducedMotion } from '../lib/motion';

const GROW_MS = 620;
const FADE_AT_MS = 380;
const NAVIGATE_AT_MS = 820;

let launching = false;
let grow: { el: HTMLElement; anim: Animation } | null = null;

export interface LaunchOptions {
  /** The element that grows to fill the screen (the preview screen). */
  from?: HTMLElement | null;
  /** Shown while leaving. */
  label?: string;
  /** Injected for tests; defaults to same-tab navigation. */
  navigate?: (url: string) => void;
}

export function launchExternal(url: string, opts: LaunchOptions = {}): boolean {
  if (launching) return false; // a second pinch mid-transition must not launch twice
  launching = true;
  const navigate = opts.navigate ?? ((u: string) => location.assign(u));
  const reduced = prefersReducedMotion();

  const overlay = document.createElement('div');
  overlay.className = 'launch-overlay';
  overlay.innerHTML = '<p></p><small></small>';
  overlay.querySelector('p')!.textContent = opts.label ?? 'Opening…';
  overlay.querySelector('small')!.textContent = new URL(url, location.href).host;
  document.body.append(overlay);

  const from = opts.from;
  if (from && !reduced && typeof from.animate === 'function') {
    const r = from.getBoundingClientRect();
    const scale = Math.max(innerWidth / r.width, innerHeight / r.height);
    const dx = innerWidth / 2 - (r.left + r.width / 2);
    const dy = innerHeight / 2 - (r.top + r.height / 2);
    from.style.position = 'relative';
    from.style.zIndex = '700';
    // The scene is a scroll container; let the screen grow past its edges.
    from.closest<HTMLElement>('.scene')?.style.setProperty('overflow', 'visible');
    const anim = from.animate([{ transform: 'none', borderRadius: '32px' }, { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, borderRadius: '0px' }], {
      duration: GROW_MS,
      easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
      fill: 'forwards',
    });
    grow = { el: from, anim };
  }

  const fadeAt = reduced ? 0 : FADE_AT_MS;
  setTimeout(() => overlay.classList.add('is-in'), fadeAt);
  setTimeout(
    () => {
      launching = false; // if navigation is cancelled (e.g. offline), allow a retry
      navigate(url);
    },
    reduced ? 250 : NAVIGATE_AT_MS,
  );
  return true;
}

/**
 * Undo a launch. Needed when the browser restores Webii from its back-forward cache
 * (Back from the portfolio): the page comes back exactly as it was left, mid-exit.
 */
export function resetLaunch(): void {
  launching = false;
  document.querySelectorAll('.launch-overlay').forEach((e) => e.remove());
  if (grow) {
    grow.anim.cancel();
    grow.el.style.removeProperty('position');
    grow.el.style.removeProperty('z-index');
    grow.el.closest<HTMLElement>('.scene')?.style.removeProperty('overflow');
    grow = null;
  }
}
