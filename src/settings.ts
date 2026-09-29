import { Emitter } from './lib/emitter';
import { clamp } from './lib/math';
import { storage } from './lib/storage';
import type { Corner, PipOptions } from './tracking/CameraView';

export type { Corner };

/**
 * User settings: small, typed, persisted, and sanitized on load, so a corrupt or
 * outdated saved value can never break the app. Hand calibration lives with the
 * camera tuning, not here.
 */

export const CORNERS: readonly Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const THEMES = ['paper', 'night', 'classic'] as const;
export type ThemeName = (typeof THEMES)[number];
export const CURSOR_SIZES = ['small', 'medium', 'large'] as const;
export type CursorSize = (typeof CURSOR_SIZES)[number];

export interface Settings {
  theme: { name: ThemeName };
  audio: { volume: number; sfx: boolean };
  cursor: { size: CursorSize };
  /** null = the browser's default (front) camera. */
  camera: { deviceId: string | null };
  pip: PipOptions;
}

export const DEFAULTS: Settings = {
  theme: { name: 'paper' },
  audio: { volume: 0.7, sfx: true },
  cursor: { size: 'medium' },
  camera: { deviceId: null },
  pip: { enabled: true, corner: 'bottom-right', showVideo: true, showTracker: true },
};

const oneOf = <T>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** Any stored shape → valid Settings. */
export function sanitize(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const d = DEFAULTS;
  const vol = Number(r.audio?.volume);
  return {
    theme: { name: oneOf(r.theme?.name, THEMES, d.theme.name) },
    audio: { volume: Number.isFinite(vol) ? clamp(vol, 0, 1) : d.audio.volume, sfx: bool(r.audio?.sfx, d.audio.sfx) },
    cursor: { size: oneOf(r.cursor?.size, CURSOR_SIZES, d.cursor.size) },
    camera: { deviceId: typeof r.camera?.deviceId === 'string' && r.camera.deviceId ? r.camera.deviceId : null },
    pip: {
      enabled: bool(r.pip?.enabled, d.pip.enabled),
      corner: oneOf(r.pip?.corner, CORNERS, d.pip.corner),
      showVideo: bool(r.pip?.showVideo, d.pip.showVideo),
      showTracker: bool(r.pip?.showTracker, d.pip.showTracker),
    },
  };
}

export class SettingsStore {
  private value: Settings;
  private events = new Emitter<{ change: Settings }>();

  constructor(private key = 'settings') {
    const saved = storage.get<unknown>(key, {});
    // Migrate the pre-Phase-4 camera id key.
    const legacyCamera = storage.get<string | undefined>('cameraId', undefined);
    this.value = sanitize(saved);
    if (legacyCamera && !this.value.camera.deviceId) this.value.camera.deviceId = legacyCamera;
    storage.remove('cameraId');
  }

  get(): Readonly<Settings> {
    return this.value;
  }

  /** Shallow-merge a section, sanitize, persist, notify. */
  update<K extends keyof Settings>(section: K, patch: Partial<Settings[K]>): void {
    this.value = sanitize({ ...this.value, [section]: { ...this.value[section], ...patch } });
    storage.set(this.key, this.value);
    this.events.emit('change', this.value);
  }

  /** Calls `fn` now and on every change. */
  watch(fn: (s: Readonly<Settings>) => void): () => void {
    fn(this.value);
    return this.events.on('change', fn);
  }
}

export const settings = new SettingsStore();
