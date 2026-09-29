/**
 * The user asked their system for less motion. Checked live (not cached), so changing
 * the OS setting takes effect without a reload. CSS handles its own animations with
 * the same media query; this is for JS-driven motion (transitions, canvases, video).
 */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
