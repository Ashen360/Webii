import '@fontsource-variable/nunito';
import './style.css';
import { DebugPanel } from './debug/DebugPanel';
import { CameraDriver, DEFAULT_TUNING, type CameraTuning } from './input/CameraDriver';
import { HandController } from './input/Hand';
import { PointerDriver } from './input/PointerDriver';
import { settings } from './settings';
import { Loop } from './lib/loop';
import { storage } from './lib/storage';
import {
  attachStream,
  cameraPermission,
  CameraError,
  checkCameraSupport,
  listCameras,
  openCamera,
  stopStream,
  type CameraErrorKind,
} from './tracking/camera';
import { CameraView } from './tracking/CameraView';
import { HandTracker, type LoadProgress } from './tracking/HandTracker';
import { ClickTest } from './debug/ClickTest';
import { FrameLog } from './debug/frameLog';
import { Calibration } from './ui/Calibration';
import { Audio } from './ui/audio';
import { Cursor } from './ui/Cursor';
import { Interaction } from './ui/interaction';
import { TestBoard } from './ui/TestBoard';
import type { ChannelDef } from './shell/channels';
import { MenuScene, PreviewScene, ShelfScene, StartScene } from './shell/scenes';
import { Shell } from './shell/Shell';
import { SettingsScene } from './shell/SettingsScene';
import { applyTheme } from './shell/theme';
import { launchExternal, resetLaunch } from './shell/launch';
import { GameScene } from './games/GameScene';
import type { GameSpec } from './games/types';
import { PORTFOLIO_URL } from './config';
import { closeScreen, showScreen } from './ui/Screen';
import { Status } from './ui/Status';

// ─── systems ────────────────────────────────────────────────────────────────
const loop = new Loop();
const hand = new HandController();
const camView = new CameraView();
document.body.append(camView.el);
settings.watch((s) => camView.configure(s.pip));
const interaction = new Interaction(hand);
const audio = new Audio();
const PARAMS = new URLSearchParams(location.search);
const shell = new Shell(document.body);
/** Dev: `?board` shows the Phase 2 interaction test board instead of the shell. */
const board = PARAMS.has('board') ? new TestBoard(document.body, interaction) : null;
if (board) shell.el.hidden = true;
const status = new Status(document.body);
const cursor = new Cursor(document.body);

// Audio hooks: every interaction has a sound.
interaction.on('hoverstart', () => audio.play('hover'));
interaction.on('press', (t) => audio.play(t ? 'press' : 'release'));
interaction.on('activate', () => audio.play('activate'));

/** Overlays (calibration, click test) own the hand; the rest of the UI steps aside. */
function setUiEnabled(on: boolean): void {
  interaction.enabled = on;
  interaction.scope = null;
  if (board) board.enabled = on;
}

// ─── shell navigation ───────────────────────────────────────────────────────
const start = new StartScene({ onStart: onStartPressed, onMouse: () => usePointer() });
let proceeded = false;

function onStartPressed(): void {
  // This click is also what lets the browser play sound from now on.
  audio.play('activate');
  if (mode === 'idle') void startCamera();
  else if (mode === 'camera' && hand.present) proceed();
}

/** Leave the start screen: onboarding on the first visit, straight to the menu after. */
function proceed(): void {
  if (proceeded) return;
  proceeded = true;
  start.setState('found');
  setTimeout(() => {
    if (mode === 'camera' && !storage.get('onboarded', false)) {
      openCalibration({
        onboarding: true,
        onDone: () => {
          storage.set('onboarded', true);
          enterMenu();
        },
      });
    } else enterMenu();
  }, 700);
}

function enterMenu(): void {
  proceeded = true;
  shell.replace(new MenuScene(openChannel));
  audio.play('startup');
  // Dev: `?game=demo` opens the Phase 6 framework demo straight away.
  if (import.meta.env.DEV && PARAMS.get('game') === 'demo') void import('./games/demo').then((m) => openGame(m.DEMO_GAME));
}

function openChannel(def: ChannelDef, rect: DOMRect): void {
  audio.play('open');
  if (def.kind === 'folder') shell.push(new ShelfScene(openChannel, back), rect);
  else shell.push(new PreviewScene(def, { onBack: back, onStart: () => launch(def) }), rect);
}

function launch(def: ChannelDef): void {
  if (def.game) return openGame(def.game, shell.top?.el.querySelector('.preview-screen')?.getBoundingClientRect() ?? null);
  if (def.id === 'settings') return shell.push(new SettingsScene(settingsApi, back));
  if (def.id === 'portfolio') {
    if (launchExternal(PORTFOLIO_URL, { from: shell.top?.el.querySelector('.preview-screen'), label: 'Opening portfolio…' })) {
      audio.play('launch');
      interaction.enabled = false; // nothing else is selectable while leaving
    }
    return;
  }
}

/** A game zooms out of the preview's live screen, where its attract mode was playing. */
function openGame(spec: GameSpec, from: DOMRect | null = null): void {
  audio.play('launch');
  shell.push(new GameScene(spec, { hand, play: (s) => audio.play(s), onExit: back }), from);
}

// ─── settings ───────────────────────────────────────────────────────────────
const CURSOR_SCALE = { small: 0.8, medium: 1, large: 1.3 } as const;
let appliedCamera: string | null | undefined;
settings.watch((s) => {
  applyTheme(s.theme.name);
  audio.volume = s.audio.volume;
  audio.enabled = s.audio.sfx;
  cursor.el.style.setProperty('--cursor-scale', String(CURSOR_SCALE[s.cursor.size]));
  // A different camera was chosen while one is running: switch to it.
  if (appliedCamera !== undefined && s.camera.deviceId !== appliedCamera && mode === 'camera') void startCamera();
  appliedCamera = s.camera.deviceId;
});

const settingsApi = {
  cameraActive: () => mode === 'camera',
  cameras: async () => {
    try {
      return (await listCameras()).map((d) => ({ id: d.deviceId, label: d.label }));
    } catch {
      return [];
    }
  },
  calibrate: () => openCalibration({ onboarding: true }),
  resetCalibration: () => {
    storage.remove(TUNING_KEY);
    storage.remove('calibration');
    const d = hand.activeDriver;
    if (d instanceof CameraDriver) {
      Object.assign(d.tuning, structuredClone(DEFAULT_TUNING));
      d.applyTuning();
      debug.bind(d, tracker);
    }
  },
  calibrationInfo: () => {
    const at = storage.get<{ at?: string }>('calibration', {}).at;
    return at
      ? `Calibrated ${new Date(at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.`
      : 'Using the default settings (not calibrated yet).';
  },
  sample: () => audio.play('activate'),
};

function back(): void {
  if (shell.pop()) audio.play('back');
}

// Back from the portfolio via the back-forward cache: undo the exit transition.
addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  resetLaunch();
  interaction.enabled = !calibration && !clickTest;
});

addEventListener('keydown', (e) => {
  if ((e.key === 'Escape' || e.key === 'Backspace') && !calibration && !clickTest && !e.defaultPrevented) {
    if (!shell.top?.onBack?.()) back();
  }
});

/**
 * Bump when the meaning of saved tuning changes, so stale values are dropped.
 * v2: pinch defaults and calibration estimator revised from real recordings.
 */
const TUNING_KEY = 'tuning.v2';
storage.remove('tuning');

function loadTuning(): CameraTuning {
  const saved = storage.get<Partial<CameraTuning>>(TUNING_KEY, {});
  const base = structuredClone(DEFAULT_TUNING);
  return { ...base, ...saved, box: { ...base.box, ...saved.box }, pinch: { ...base.pinch, ...saved.pinch } };
}

const debug = new DebugPanel(
  hand,
  (t) => storage.set(TUNING_KEY, t),
  () => {
    storage.remove(TUNING_KEY);
    storage.remove('calibration');
    location.reload();
  },
  () => openCalibration(),
  () => openClickTest(),
);

// ─── tracker lifecycle ──────────────────────────────────────────────────────
let progress: LoadProgress | null = null;
let trackerPromise: Promise<HandTracker> | null = null;
let tracker: HandTracker | null = null;
let stream: MediaStream | null = null;
let mode: 'idle' | 'camera-starting' | 'loading' | 'camera' | 'pointer' = 'idle';
const FAKE_CAMERA = new URLSearchParams(location.search).has('fake');

function loadTracker(): Promise<HandTracker> {
  trackerPromise ??= HandTracker.load((p) => (progress = p)).catch((err) => {
    trackerPromise = null; // allow retry
    throw err;
  });
  return trackerPromise;
}

const COPY: Record<CameraErrorKind | 'model' | 'ended', { title: string; body: string }> = {
  insecure: { title: 'Needs a secure connection', body: 'Browsers only allow the camera on HTTPS pages. Open Webii over https:// (or localhost).' },
  unsupported: { title: 'This browser can’t run hand tracking', body: 'Try a recent version of Chrome, Edge, Firefox or Safari.' },
  denied: { title: 'Camera access is blocked', body: 'Allow the camera from your browser’s address bar, then try again.' },
  'not-found': { title: 'No camera found', body: 'Connect a webcam and try again.' },
  'in-use': { title: 'Your camera is busy', body: 'Another app or tab might be using it. Close it and try again.' },
  unknown: { title: 'The camera didn’t start', body: 'Something went wrong while starting the camera. Try again?' },
  model: { title: 'Hand tracking didn’t load', body: 'Check your connection and try again.' },
  ended: { title: 'Camera disconnected', body: 'The camera stopped sending video. Reconnect it and try again.' },
};

function showProblem(kind: keyof typeof COPY): void {
  calibration?.close();
  clickTest?.close();
  stopCamera();
  mode = 'idle';
  hand.setDriver(null);
  const retryable = kind !== 'insecure' && kind !== 'unsupported';
  showScreen({
    ...COPY[kind],
    actions: [
      ...(retryable ? [{ label: 'Try again', primary: true, onClick: startCamera }] : []),
      { label: 'Use mouse instead', primary: !retryable, onClick: usePointer },
    ],
  });
}

function stopCamera(): void {
  tracker?.detach();
  stopStream(stream);
  stream = null;
  camView.setActive(false);
}

async function startCamera(): Promise<void> {
  closeScreen();
  stopCamera();
  hand.setDriver(null);
  mode = 'camera-starting';
  void loadTracker().catch(() => {}); // make sure the model is downloading in parallel

  try {
    stream =
      import.meta.env.DEV && FAKE_CAMERA
        ? await (await import('./debug/fakeCamera')).fakeCameraStream(new URLSearchParams(location.search).get('fake') ?? '')
        : await openCamera(settings.get().camera.deviceId ?? undefined);
    await attachStream(camView.video, stream);
  } catch (err) {
    showProblem(err instanceof CameraError ? err.kind : 'unknown');
    return;
  }
  const track = stream.getVideoTracks()[0];
  track?.addEventListener('ended', () => mode === 'camera' && showProblem('ended'));
  camView.setActive(true);

  mode = 'loading';
  try {
    tracker = await loadTracker();
  } catch (err) {
    console.error(err);
    showProblem('model');
    return;
  }
  if (mode !== 'loading') return; // user switched away while loading

  const t = tracker;
  const driver = new CameraDriver((fn) => t.onFrame(fn), loadTuning(), { w: innerWidth, h: innerHeight });
  t.attach(camView.video);
  hand.setDriver(driver);
  debug.bind(driver, t);
  mode = 'camera';
  // Dev entry points skip the start screen.
  if (PARAMS.has('calibrate') || PARAMS.has('session') || PARAMS.has('clicktest')) {
    enterMenu();
    if (PARAMS.has('clicktest')) openClickTest();
    else openCalibration();
  }
}

// ─── calibration ────────────────────────────────────────────────────────────
let calibration: Calibration | null = null;

function openCalibration(opts: { onboarding?: boolean; onDone?: () => void } = {}): void {
  const driver = hand.activeDriver;
  if (mode !== 'camera' || !(driver instanceof CameraDriver) || calibration) return;
  setUiEnabled(false);
  startFrameLog();
  calibration = new Calibration({
    driver,
    hand,
    video: camView.video,
    onboarding: opts.onboarding,
    setInteractive: (scope) => {
      interaction.scope = scope;
      interaction.enabled = scope !== null;
    },
    onFinish: (outcome, record) => {
      // Apply live: the next pinch already uses the new thresholds.
      Object.assign(driver.tuning, outcome.tuning);
      driver.applyTuning();
      storage.set(TUNING_KEY, driver.tuning);
      storage.set('calibration', { at: record.createdAt });
      debug.bind(driver, tracker);
      console.info(`[webii] calibration\n${outcome.notes.join('\n')}`);
      if (import.meta.env.DEV) {
        void saveRecording(record); // takes the current landmark log synchronously
        startFrameLog(); // a fresh one in case the user presses Redo
      }
    },
    onClose: () => {
      calibration = null;
      setUiEnabled(true);
      opts.onDone?.();
      // ?session = calibrate, then measure clicking with the new calibration.
      if (PARAMS.has('session')) openClickTest();
    },
  });
}

// ─── click test (dev) ───────────────────────────────────────────────────────
let clickTest: ClickTest | null = null;

function openClickTest(): void {
  const driver = hand.activeDriver;
  if (mode !== 'camera' || !(driver instanceof CameraDriver) || clickTest || calibration) return;
  setUiEnabled(false);
  startFrameLog();
  clickTest = new ClickTest({
    driver,
    hand,
    onDone: (record) => import.meta.env.DEV && void saveRecording(record),
    onClose: () => {
      clickTest = null;
      setUiEnabled(true);
    },
  });
}

/** Dev only: full landmarks for the recording in progress (see FrameLog). */
let frameLog: FrameLog | null = null;
function startFrameLog(): void {
  if (!import.meta.env.DEV || !tracker) return;
  frameLog?.stop();
  const t = tracker;
  frameLog = new FrameLog((fn) => t.onFrame(fn));
}

/** Dev only: the Vite server writes this to ./calibration-data/ (tagged with ?label=…). */
async function saveRecording(record: object): Promise<void> {
  if (FAKE_CAMERA) return; // simulated hands must never mix with real recordings
  const label = new URLSearchParams(location.search).get('label') ?? '';
  const frames = frameLog?.stop() ?? [];
  frameLog = null;
  try {
    const res = await fetch('/__webii/calibration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...record, label, frames }),
    });
    if (res.ok) console.info('[webii] recording saved →', (await res.json()).file);
  } catch (err) {
    console.warn('[webii] could not save calibration recording', err);
  }
}

function usePointer(): void {
  calibration?.close();
  clickTest?.close();
  closeScreen();
  stopCamera();
  hand.setDriver(new PointerDriver());
  debug.bind(null, null);
  mode = 'pointer';
  if (!proceeded) enterMenu(); // mouse users skip the hand onboarding
}

// Camera skeleton overlay (subscribes once; frames only arrive while attached).
void loadTracker()
  .then((t) => t.onFrame((f) => camView.draw(f, hand.pinchStrength)))
  .catch(() => {});

// ─── status ─────────────────────────────────────────────────────────────────
let trackingSince = 0;
/**
 * Hand wider than this fraction of the frame height (wrist → middle knuckle): the frame
 * can't fit ~3 hand-lengths of travel plus the hand, so precision suffers (recorded
 * sessions: 0.24 → 67% hits; 0.10 → 92%).
 */
const TOO_CLOSE = 0.2;
/** Relative change in apparent hand size that invalidates a calibration. */
const POSTURE_CHANGE = 0.35;
function updateStatus(now: number): void {
  document.body.dataset.mode = mode;
  // The start screen tells its own story (starting, raise your hand).
  if (shell.top === start && !(mode === 'camera' && hand.state === 'tracking')) return status.set('', 'idle');
  switch (mode) {
    case 'idle':
      return status.set('', 'idle');
    case 'camera-starting':
      return status.set('Waking up the camera…', 'busy');
    case 'loading':
      return status.set(`Loading hand tracking… ${Math.round((progress?.fraction ?? 0) * 100)}%`, 'busy');
    case 'pointer':
      return status.set('Mouse mode', 'mouse', { label: 'Use camera', onClick: startCamera }, true);
  }
  if (hand.state !== 'tracking') trackingSince = 0;
  switch (hand.state) {
    case 'starting':
      return status.set('Starting…', 'busy');
    case 'searching':
      return status.set('Raise your hand', 'idle');
    case 'lost':
      return status.set('Hand lost — bring it back into view', 'warn');
    case 'tracking':
      trackingSince ||= now;
      if (hand.nearEdge) return status.set('Move your hand away from the edge of the camera view', 'warn');
      {
        const d = hand.activeDriver instanceof CameraDriver ? hand.activeDriver : null;
        const cal = d?.tuning.calibratedScale;
        if (d && cal && Math.abs(d.handScale / cal - 1) > POSTURE_CHANGE) {
          return status.set('Your position changed', 'idle', { label: 'Calibrate again', onClick: openCalibration });
        }
        if (d && d.handScale > TOO_CLOSE) return status.set('Lean back a little for more precise control', 'idle');
      }
      // All good: say nothing (after a brief confirmation).
      return status.set(now - trackingSince < 1200 ? 'Hand tracked' : '', 'ok');
  }
}

// ─── frame loop ─────────────────────────────────────────────────────────────
loop.add((now, dt) => {
  hand.update(now);
  interaction.update(now);
  cursor.render(hand, interaction.display, interaction.hovered !== null);
  shell.update(dt, hand);
  board?.update(dt);
  updateStart(now);
  calibration?.update();
  clickTest?.update(now);
  updateStatus(now);
  debug.update(now);
});
loop.start();

/** Drives the start screen: camera progress, "raise your hand", and hand-raise to proceed. */
let handSince = 0;
function updateStart(now: number): void {
  if (shell.top !== start || proceeded) return;
  if (mode === 'idle') start.setState('idle');
  else if (mode === 'camera-starting') start.setState('starting');
  else if (mode === 'loading') start.setState('starting', `Loading hand tracking… ${Math.round((progress?.fraction ?? 0) * 100)}%`);
  else if (mode === 'camera') {
    if (!hand.present) {
      handSince = 0;
      start.setState('ready');
    } else {
      handSince ||= now;
      if (now - handSince > 600) proceed();
    }
  }
}

// ─── boot ───────────────────────────────────────────────────────────────────
async function boot(): Promise<void> {
  const unsupported = checkCameraSupport();
  if (unsupported) return showProblem(unsupported.kind);

  if (!board) shell.replace(start);
  // Returning visitors (permission already granted) don't need to press anything.
  if ((import.meta.env.DEV && FAKE_CAMERA) || (await cameraPermission()) === 'granted') void startCamera();
}
void boot();

if (import.meta.env.DEV) {
  Object.assign(window, {
    __webii: { hand, loop, interaction, audio, shell, openCalibration, get tracker() { return tracker; }, get driver() { return hand.activeDriver; }, get calibration() { return calibration; }, get clickTest() { return clickTest; } },
  });
}
