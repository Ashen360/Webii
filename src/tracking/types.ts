/** Tracker output, in our own types so nothing downstream depends on MediaPipe. */

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface TrackedHand {
  /** 21 points, normalized to the video frame (0..1), NOT mirrored. */
  landmarks: Point3[];
  /** 21 points in metres, hand-centred (scale-invariant w.r.t. camera distance). */
  world: Point3[];
  handedness: 'Left' | 'Right';
  score: number;
}

export interface TrackerFrame {
  /** performance.now() when the frame was processed. */
  t: number;
  videoW: number;
  videoH: number;
  inferenceMs: number;
  hand: TrackedHand | null;
}

/** Bone pairs for drawing a hand skeleton. */
export const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
