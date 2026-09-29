import { clamp, type Vec2 } from '../lib/math';

/**
 * The comfort box: the region of the (mirrored) camera frame that maps onto the
 * whole viewport. Smaller box → less arm travel, more sensitivity.
 */
export interface ComfortBox {
  /** Centre in normalized, mirrored camera coordinates. */
  cx: number;
  cy: number;
  /** Box height as a fraction of camera height. */
  size: number;
  /**
   * Horizontal gain relative to vertical (1 = isotropic, up to MAX_STRETCH).
   * On wide screens, a user's comfortable side-to-side reach is narrower than the
   * screen's aspect: stretching x lets the box stay tall (less vertical gain, so a
   * calmer cursor) instead of shrinking both axes to fit the width.
   */
  stretch?: number;
}

/** A bounded, barely noticeable anisotropy. */
export const MAX_STRETCH = 1.35;

export const DEFAULT_BOX: ComfortBox = { cx: 0.5, cy: 0.5, size: 0.55, stretch: 1 };

/** Box width in normalized camera-x units. */
export function boxWidth(box: ComfortBox, cam: { w: number; h: number }, view: { w: number; h: number }): number {
  const stretch = clamp(box.stretch ?? 1, 1, MAX_STRETCH);
  return clamp((box.size * (view.w / view.h) * (cam.h / cam.w)) / stretch, 0.1, 1);
}

/**
 * Maps a normalized landmark (0..1, un-mirrored, as MediaPipe reports it) to viewport px.
 * With stretch 1 the box's physical aspect matches the viewport's: 5 cm of hand
 * movement moves the cursor equally far in any direction. The result is NOT clamped;
 * callers clamp after filtering so the filter never sees an artificial wall.
 */
export function mapToViewport(
  nx: number,
  ny: number,
  box: ComfortBox,
  cam: { w: number; h: number },
  view: { w: number; h: number },
): Vec2 {
  const h = box.size;
  const w = boxWidth(box, cam, view);
  const mx = 1 - nx; // mirror: move right → cursor right
  const u = (mx - (box.cx - w / 2)) / w;
  const v = (ny - (box.cy - h / 2)) / h;
  return { x: u * view.w, y: v * view.h };
}
