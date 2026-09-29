import { CATCH_GAME } from '../games/catch/catch';
import { MEMORY_GAME } from '../games/memory/memory';
import { SLICE_GAME } from '../games/slice/slice';
import type { GameSpec } from '../games/types';
import { gamesTile, portfolioTile, settingsTile, type Painter } from './painters';

/**
 * Everything the shell shows, as data. Games is a folder (opens a shelf); every other
 * channel shows a preview (BACK / START) before launching.
 */
export interface ChannelDef {
  id: string;
  title: string;
  /** One line under the tile title. */
  blurb: string;
  /** Preview screen copy: short, no walls of text. */
  description: string;
  color: string;
  /** Placeholder animations; a `game` replaces both with its attract mode. */
  tile?: Painter;
  preview?: Painter;
  kind: 'folder' | 'launch';
  /** A real video for the preview screen instead of the painter (poster = still frame). */
  video?: { src: string; poster: string };
  /** A playable game: launches it, and its attract mode replaces the tile/preview painters. */
  game?: GameSpec;
}

const MEDIA = `${import.meta.env.BASE_URL}media/`;

export const GAMES: ChannelDef[] = [
  {
    id: 'catch',
    title: 'Catch',
    blurb: 'Hand under, catch it',
    description: 'Things fall from the sky. Move your hand underneath to catch as many as you can.',
    color: '#ff8a3d',
    kind: 'launch',
    game: CATCH_GAME,
  },
  {
    id: 'slice',
    title: 'Slice',
    blurb: 'Swipe straight through',
    description: 'Shapes fly across the screen. Swipe your hand through them: speed and direction count.',
    color: '#f0527a',
    kind: 'launch',
    game: SLICE_GAME,
  },
  {
    id: 'memory',
    title: 'Memory Trace',
    blurb: 'See it, then draw it',
    description: 'Memorize a shape for 5 seconds. Draw it from memory in 10. See how close you got.',
    color: '#7c5cff',
    kind: 'launch',
    game: MEMORY_GAME,
  },
];

export const CHANNELS: ChannelDef[] = [
  {
    id: 'games',
    title: 'Games',
    blurb: 'Three hand-tracking games',
    description: '',
    color: '#ff6b4a',
    tile: gamesTile,
    preview: gamesTile,
    kind: 'folder',
  },
  {
    id: 'portfolio',
    title: 'Portfolio',
    blurb: 'Who built this',
    description: 'The work of the person who built Webii. Start opens their portfolio site.',
    color: '#12a594',
    tile: portfolioTile,
    preview: portfolioTile,
    // Recorded from the live site by `npm run capture:portfolio`.
    video: { src: `${MEDIA}portfolio-preview.webm`, poster: `${MEDIA}portfolio-preview.jpg` },
    kind: 'launch',
  },
  {
    id: 'settings',
    title: 'Settings',
    blurb: 'Sound, camera, cursor',
    description: 'Volume and sound effects, camera and picture-in-picture, and hand calibration.',
    color: '#6b7a99',
    tile: settingsTile,
    preview: settingsTile,
    kind: 'launch',
  },
];
