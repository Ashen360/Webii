import type { HandLandmarker, HandLandmarkerOptions } from '@mediapipe/tasks-vision';
import { Emitter } from '../lib/emitter';
import type { TrackerFrame } from './types';

/**
 * The only module that touches MediaPipe. Loads the model (GPU delegate, CPU
 * fallback), runs exactly one inference per camera frame, emits TrackerFrames.
 */

const BASE = import.meta.env.BASE_URL;
const WASM_PATH = `${BASE}mediapipe/wasm`;
const MODEL_PATH = `${BASE}mediapipe/hand_landmarker.task`;

export type Delegate = 'GPU' | 'CPU';
export interface LoadProgress {
  phase: 'runtime' | 'model' | 'init';
  /** 0..1 overall */
  fraction: number;
}

export class TrackerLoadError extends Error {}

/** GPU init can hang on some drivers; after this much *visible* time, use the CPU. */
const GPU_INIT_TIMEOUT_MS = 8000;

/**
 * Rejects if `p` hasn't settled after `ms` of time the page was actually visible.
 * GPU initialisation can stall while a tab is hidden; that must not count as a hang,
 * or a background tab would be downgraded to the slower CPU path forever.
 */
function visibleTimeout<T extends { close(): void }>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let visible = 0;
    let last = performance.now();
    let timedOut = false;
    const iv = setInterval(() => {
      const now = performance.now();
      if (document.visibilityState === 'visible') visible += now - last;
      last = now;
      if (visible > ms) {
        timedOut = true;
        clearInterval(iv);
        reject(new Error('GPU delegate initialisation timed out'));
      }
    }, 250);
    p.then(
      (v) => {
        clearInterval(iv);
        if (timedOut) v.close(); // arrived too late: we've moved on to the CPU
        else resolve(v);
      },
      (e) => {
        clearInterval(iv);
        reject(e);
      },
    );
  });
}

/**
 * Download progress across several files, weighted by bytes: the 11 MB WASM runtime
 * and the 7.5 MB model load in parallel, and the bar reflects both.
 */
export class ByteProgress {
  private files = new Map<string, { received: number; total: number }>();

  constructor(private onChange: (fraction: number) => void) {}

  /** `total` is the expected size (0 = unknown until the response says). */
  update(key: string, received: number, total: number): void {
    this.files.set(key, { received, total });
    let r = 0;
    let t = 0;
    for (const f of this.files.values()) {
      if (!f.total) continue; // unknown sizes can't be weighted yet
      r += Math.min(f.received, f.total);
      t += f.total;
    }
    this.onChange(t ? r / t : 0);
  }
}

async function fetchWithProgress(url: string, onProgress: (received: number, total: number) => void, what = 'Model'): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new TrackerLoadError(`${what} request failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  onProgress(0, total);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

export class HandTracker {
  /** Rolling stats for the debug overlay. */
  stats = { detectFps: 0, inferenceMs: 0 };

  private frames = new Emitter<{ frame: TrackerFrame }>();
  private video: VideoWithRVFC | null = null;
  private handle = 0;
  private usingRVFC = false;
  private lastTs = 0;
  private prevT = 0;
  private lastVideoTime = -1;
  private failures = 0;
  private switching = false;

  private constructor(
    private landmarker: HandLandmarker,
    public delegate: Delegate,
    private create: (d: Delegate) => Promise<HandLandmarker>,
  ) {}

  static async load(onProgress: (p: LoadProgress) => void = () => {}): Promise<HandTracker> {
    onProgress({ phase: 'runtime', fraction: 0 });
    let wasmUrl: string | null = null;
    let fileset: { wasmBinaryPath: string } | null = null;
    let wasmPath = '';
    try {
      const vision = await import('@mediapipe/tasks-vision');
      // Resolving the fileset only picks the SIMD or non-SIMD build; nothing is downloaded yet.
      const resolved = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
      fileset = resolved;
      wasmPath = resolved.wasmBinaryPath;
      // Download the WASM runtime ourselves, in parallel with the model, so the loading bar
      // covers both (~19 MB). The runtime then reads it from a blob URL: still one download.
      const bytes = new ByteProgress((f) => onProgress({ phase: 'model', fraction: 0.02 + f * 0.86 }));
      const [wasm, model] = await Promise.all([
        fetchWithProgress(wasmPath, (r, t) => bytes.update('wasm', r, t), 'Runtime'),
        fetchWithProgress(MODEL_PATH, (r, t) => bytes.update('model', r, t)),
      ]);
      wasmUrl = URL.createObjectURL(new Blob([wasm as BlobPart], { type: 'application/wasm' }));
      resolved.wasmBinaryPath = wasmUrl;
      onProgress({ phase: 'init', fraction: 0.9 });
      const options = (delegate: Delegate): HandLandmarkerOptions => ({
        // Copy: the buffer may be consumed by the runtime, and a CPU retry needs it again.
        baseOptions: { modelAssetBuffer: model.slice(), delegate },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.5,
      });
      const create = (d: Delegate) => vision.HandLandmarker.createFromOptions(resolved, options(d));

      let landmarker: HandLandmarker;
      let delegate: Delegate = 'GPU';
      try {
        landmarker = await visibleTimeout(create('GPU'), GPU_INIT_TIMEOUT_MS);
      } catch (err) {
        console.warn('[webii] GPU delegate unavailable, using CPU', err);
        delegate = 'CPU';
        landmarker = await create('CPU');
      }
      onProgress({ phase: 'init', fraction: 1 });
      return new HandTracker(landmarker, delegate, create);
    } catch (err) {
      if (err instanceof TrackerLoadError) throw err;
      throw new TrackerLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      // Every createFromOptions instantiates a fresh module, so a later CPU fallback must
      // not see a revoked blob: point the fileset back at the real (now HTTP-cached) file.
      if (wasmUrl) {
        if (fileset) fileset.wasmBinaryPath = wasmPath;
        URL.revokeObjectURL(wasmUrl);
      }
    }
  }

  onFrame(fn: (f: TrackerFrame) => void): () => void {
    return this.frames.on('frame', fn);
  }

  attach(video: HTMLVideoElement): void {
    this.detach();
    this.video = video as VideoWithRVFC;
    this.usingRVFC = typeof this.video.requestVideoFrameCallback === 'function';
    this.schedule();
  }

  detach(): void {
    if (!this.video) return;
    if (this.usingRVFC) this.video.cancelVideoFrameCallback?.(this.handle);
    else cancelAnimationFrame(this.handle);
    this.video = null;
  }

  /** Run detection on a still image (verification / tests). Uses a monotonic timestamp. */
  detectImage(image: TexImageSource & { width: number; height: number }): TrackerFrame {
    return this.run(image, image.width, image.height);
  }

  private schedule(): void {
    const v = this.video;
    if (!v) return;
    const step = () => {
      if (this.video !== v) return;
      this.process(v);
      this.schedule();
    };
    this.handle = this.usingRVFC ? v.requestVideoFrameCallback!(step) : requestAnimationFrame(step);
  }

  private process(v: HTMLVideoElement): void {
    if (this.switching || v.readyState < 2 || !v.videoWidth) return;
    // rAF fallback: only process genuinely new frames.
    if (!this.usingRVFC) {
      if (v.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = v.currentTime;
    }
    try {
      this.frames.emit('frame', this.run(v, v.videoWidth, v.videoHeight));
      this.failures = 0;
    } catch (err) {
      this.failures++;
      console.error('[webii] detection failed', err);
      if (this.failures >= 3 && this.delegate === 'GPU') void this.fallbackToCpu();
    }
  }

  private run(source: TexImageSource, w: number, h: number): TrackerFrame {
    let t = performance.now();
    if (t <= this.lastTs) t = this.lastTs + 0.01; // MediaPipe requires strictly increasing timestamps
    this.lastTs = t;

    const r = this.landmarker.detectForVideo(source as HTMLVideoElement, t);
    const inferenceMs = performance.now() - t;

    const s = this.stats;
    s.inferenceMs += (inferenceMs - s.inferenceMs) * 0.1;
    const frameDt = t - (this.prevT || t);
    if (frameDt > 0) s.detectFps += (1000 / frameDt - s.detectFps) * 0.1;
    this.prevT = t;

    const lm = r.landmarks[0];
    const world = r.worldLandmarks[0];
    const cat = r.handedness[0]?.[0];
    return {
      t,
      videoW: w,
      videoH: h,
      inferenceMs,
      hand:
        lm && world
          ? {
              landmarks: lm.map(({ x, y, z }) => ({ x, y, z })),
              world: world.map(({ x, y, z }) => ({ x, y, z })),
              handedness: cat?.categoryName === 'Left' ? 'Left' : 'Right',
              score: cat?.score ?? 0,
            }
          : null,
    };
  }

  private async fallbackToCpu(): Promise<void> {
    this.switching = true;
    try {
      const cpu = await this.create('CPU');
      this.landmarker.close();
      this.landmarker = cpu;
      this.delegate = 'CPU';
      this.failures = 0;
    } finally {
      this.switching = false;
    }
  }
}
