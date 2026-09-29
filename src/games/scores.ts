import { storage } from '../lib/storage';

/** Best score per game (higher is better), kept in localStorage. */
export function bestScore(id: string): number | null {
  const v = storage.get<number | null>(`best.${id}`, null);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Record a finished round; returns the best before it and whether this beat it. */
export function recordScore(id: string, score: number): { previous: number | null; isBest: boolean } {
  const previous = bestScore(id);
  const isBest = score > 0 && (previous === null || score > previous);
  if (isBest) storage.set(`best.${id}`, score);
  return { previous, isBest };
}
