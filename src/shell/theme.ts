import type { ThemeName } from '../settings';

/**
 * Themes. The DOM is themed by CSS variables (`html[data-theme]`); canvas painters
 * can't read those cheaply, so they take their colours from these palettes, which
 * mirror the CSS tokens.
 */

export interface Palette {
  /** Surfaces (cards, tiles). */
  card: string;
  /** Ink with an alpha: text and outline marks. */
  ink(alpha?: number): string;
  accent: string;
  /** Browser UI colour (address bar on mobile). */
  chrome: string;
}

const make = (card: string, inkRgb: string, accent: string, chrome: string): Palette => ({
  card,
  ink: (a = 1) => `rgba(${inkRgb},${a})`,
  accent,
  chrome,
});

const PALETTES: Record<ThemeName, Palette> = {
  paper: make('#ffffff', '30,35,48', '#2f7df6', '#f3f2ee'),
  night: make('#1c212b', '232,236,243', '#5b9dff', '#11141b'),
  // Wii-era *feel* (pale greys, sky-blue selection); deliberately no Nintendo assets.
  classic: make('#fbfcfd', '74,80,89', '#23a6de', '#e6e9ec'),
};

let current: Palette = PALETTES.paper;

export function palette(): Palette {
  return current;
}

export function applyTheme(name: ThemeName): void {
  current = PALETTES[name];
  document.documentElement.dataset.theme = name;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', current.chrome);
}
