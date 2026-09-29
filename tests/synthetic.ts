import type { Point3, TrackerFrame } from '../src/tracking/types';

/** Builds a TrackerFrame with the index tip at (nx, ny) and thumb–index distance `pinch` metres. */
export function frame(
  t: number,
  nx: number,
  ny: number,
  pinch: number,
  present = true,
  curl = 0.07,
  cam = { w: 640, h: 480 },
): TrackerFrame {
  if (!present) return { t, videoW: cam.w, videoH: cam.h, inferenceMs: 5, hand: null };
  const landmarks: Point3[] = Array.from({ length: 21 }, () => ({ x: nx, y: ny + 0.2, z: 0 }));
  const world: Point3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  landmarks[8] = { x: nx, y: ny, z: 0 };
  world[5] = { x: 0, y: -0.08 + curl, z: 0 }; // index knuckle; tip–knuckle = curl
  world[8] = { x: 0, y: -0.08, z: 0 };
  world[4] = { x: pinch, y: -0.08, z: 0 };
  return { t, videoW: cam.w, videoH: cam.h, inferenceMs: 5, hand: { landmarks, world, handedness: 'Right', score: 0.95 } };
}

/** A fake tracker: lets a test push frames into whatever subscribed. */
export function fakeTracker() {
  let sink: ((f: TrackerFrame) => void) | null = null;
  return {
    subscribe: (fn: (f: TrackerFrame) => void) => {
      sink = fn;
      return () => (sink = null);
    },
    push: (f: TrackerFrame) => sink?.(f),
  };
}

/** Deterministic pseudo-random noise in [-1, 1]. */
export function noise(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647) * 2 - 1;
  };
}
