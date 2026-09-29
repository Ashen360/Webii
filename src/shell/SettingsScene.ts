import { CORNERS, CURSOR_SIZES, settings, THEMES, type Corner, type CursorSize, type ThemeName } from '../settings';
import { row, segmented, slider, toggle } from '../ui/controls';
import type { Scene } from './Shell';

/** What the Settings screen needs from the app (kept narrow on purpose). */
export interface SettingsApi {
  cameraActive(): boolean;
  cameras(): Promise<{ id: string; label: string }[]>;
  /** Guided re-calibration (ends with the "pinch the dot" try-out). */
  calibrate(): void;
  resetCalibration(): void;
  calibrationInfo(): string;
  /** Play a sound so volume changes can be heard. */
  sample(): void;
}

type Section = 'theme' | 'sound' | 'cursor' | 'camera' | 'hand';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'theme', label: 'Theme' },
  { id: 'sound', label: 'Sound' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'camera', label: 'Camera' },
  { id: 'hand', label: 'Hand' },
];

const THEME_INFO: Record<ThemeName, { label: string; bg: string; card: string; accent: string; ink: string }> = {
  paper: { label: 'Paper', bg: '#f3f2ee', card: '#ffffff', accent: '#2f7df6', ink: '#1e2330' },
  night: { label: 'Night', bg: '#11141b', card: '#1c212b', accent: '#5b9dff', ink: '#e8ecf3' },
  classic: { label: 'Classic', bg: '#dfe3e7', card: '#fbfcfd', accent: '#23a6de', ink: '#7d848e' },
};

const CURSOR_LABEL: Record<CursorSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };
const CORNER_LABEL: Record<Corner, string> = { 'top-left': '↖', 'top-right': '↗', 'bottom-left': '↙', 'bottom-right': '↘' };

/**
 * Settings: a rail of sections and one panel at a time. No scrolling, because
 * scrolling by hand is fiddly; every section fits on screen with big controls.
 */
export class SettingsScene implements Scene {
  readonly el = document.createElement('div');
  private panel: HTMLElement;
  private rail: HTMLElement;
  private section: Section = 'theme';

  constructor(
    private api: SettingsApi,
    onBack: () => void,
  ) {
    this.el.className = 'settings';
    this.el.innerHTML = `
      <header class="settings-head"><h1>Settings</h1></header>
      <div class="settings-body"><nav class="settings-rail"></nav><section class="settings-panel"></section></div>`;
    const back = document.createElement('button');
    back.className = 'btn-pill btn-back';
    back.dataset.hit = '';
    back.textContent = '‹ Back';
    back.addEventListener('click', onBack);
    this.el.querySelector('.settings-head')!.prepend(back);
    this.rail = this.el.querySelector('.settings-rail')!;
    this.panel = this.el.querySelector('.settings-panel')!;

    for (const s of SECTIONS) {
      const b = document.createElement('button');
      b.dataset.hit = '';
      b.dataset.section = s.id;
      b.textContent = s.label;
      b.addEventListener('click', () => this.show(s.id));
      this.rail.append(b);
    }
    this.show('theme');
  }

  onShow(): void {
    // Returning from calibration: refresh the info line.
    if (this.section === 'hand') this.show('hand');
  }

  private show(section: Section): void {
    this.section = section;
    this.rail.querySelectorAll<HTMLElement>('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.section === section)));
    this.panel.replaceChildren(...this.build(section));
    this.panel.animate?.([{ opacity: 0, translate: '12px 0' }, { opacity: 1, translate: '0 0' }], { duration: 220, easing: 'ease-out' });
  }

  private build(section: Section): HTMLElement[] {
    const s = settings.get();
    switch (section) {
      case 'theme':
        return [
          segmented(
            THEMES.map((t) => {
              const i = THEME_INFO[t];
              return {
                value: t,
                label: i.label,
                html: `<i class="swatch" style="--sb:${i.bg};--sc:${i.card};--sa:${i.accent};--si:${i.ink}"><b></b><b></b><b></b></i>`,
              };
            }),
            s.theme.name,
            (name) => settings.update('theme', { name }),
            'ctl-themes',
          ),
        ];
      case 'sound':
        return [
          row(
            'Volume',
            slider('Volume', s.audio.volume, (volume) => settings.update('audio', { volume }), () => this.api.sample()),
          ),
          row('Sound effects', toggle('Sound effects', s.audio.sfx, (sfx) => settings.update('audio', { sfx }))),
        ];
      case 'cursor':
        return [
          row(
            'Cursor size',
            segmented(
              CURSOR_SIZES.map((v) => ({ value: v, label: CURSOR_LABEL[v], html: `<i class="cursor-dot cursor-dot-${v}"></i>` })),
              s.cursor.size,
              (size) => settings.update('cursor', { size }),
            ),
          ),
        ];
      case 'camera': {
        const cams = document.createElement('div');
        cams.className = 'set-cams';
        cams.textContent = 'Looking for cameras…';
        void this.api.cameras().then((list) => {
          if (this.section !== 'camera') return;
          if (list.length <= 1) {
            cams.textContent = list[0]?.label || (this.api.cameraActive() ? 'Your camera' : 'Turn on the camera to choose one');
            return;
          }
          const current = s.camera.deviceId ?? list[0].id;
          cams.replaceChildren(
            segmented(
              list.map((c, i) => ({ value: c.id, label: c.label || `Camera ${i + 1}` })),
              current,
              (deviceId) => settings.update('camera', { deviceId }),
              'ctl-cams',
            ),
          );
        });
        return [
          row('Camera', cams),
          row('Camera preview', toggle('Camera preview', s.pip.enabled, (enabled) => settings.update('pip', { enabled })), 'A small window showing what the camera sees'),
          row(
            'Corner',
            segmented(
              CORNERS.map((c) => ({ value: c, label: CORNER_LABEL[c] })),
              s.pip.corner,
              (corner) => settings.update('pip', { corner }),
              'ctl-corners',
            ),
          ),
          row('Show video', toggle('Show video', s.pip.showVideo, (showVideo) => settings.update('pip', { showVideo }))),
          row('Show hand tracking', toggle('Show hand tracking', s.pip.showTracker, (showTracker) => settings.update('pip', { showTracker }))),
        ];
      }
      case 'hand': {
        const active = this.api.cameraActive();
        const calibrate = document.createElement('button');
        calibrate.className = 'btn-big btn-primary';
        calibrate.dataset.hit = '';
        calibrate.textContent = 'Calibrate again';
        calibrate.disabled = !active;
        calibrate.addEventListener('click', () => this.api.calibrate());
        const reset = document.createElement('button');
        reset.className = 'btn-big';
        reset.dataset.hit = '';
        reset.textContent = 'Reset';
        reset.disabled = !active;
        reset.addEventListener('click', () => {
          this.api.resetCalibration();
          this.show('hand');
        });
        const actions = document.createElement('div');
        actions.className = 'set-actions';
        actions.append(calibrate, reset);
        const info = document.createElement('p');
        info.className = 'set-info';
        info.textContent = active
          ? this.api.calibrationInfo()
          : 'Turn on the camera to calibrate. (You are using the mouse.)';
        const tip = document.createElement('p');
        tip.className = 'set-tip';
        tip.textContent = 'Calibrate again whenever you change how you sit. Webii works best about an arm’s length from the camera.';
        return [info, actions, tip];
      }
    }
  }
}
