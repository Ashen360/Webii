// Dev-only: runs the real HandTracker on still photos and reports what it sees.
import { HandTracker } from '../src/tracking/HandTracker';
import { HAND_BONES } from '../src/tracking/types';

const IMAGES = ['pointing_up', 'pointing_up_rotated', 'thumb_up', 'victory', 'fist', 'right_hands'];
const summary = document.getElementById('summary')!;
const grid = document.getElementById('grid')!;

const load = (src: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });

const results: Record<string, unknown> = {};
try {
  const t0 = performance.now();
  const tracker = await HandTracker.load();
  const loadMs = performance.now() - t0;

  for (const name of IMAGES) {
    const img = await load(`/tests/fixtures/${name}.jpg`);
    // Run a few times: VIDEO mode tracks across calls, so later runs exercise the tracking path.
    let f = tracker.detectImage(img);
    for (let i = 0; i < 3; i++) f = tracker.detectImage(img);

    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    let caption = `${name}\nno hand`;
    if (f.hand) {
      const P = f.hand.landmarks.map((p) => [p.x * img.width, p.y * img.height]);
      ctx.strokeStyle = '#2f7df6';
      ctx.lineWidth = 3;
      for (const [a, b] of HAND_BONES) {
        ctx.beginPath();
        ctx.moveTo(P[a][0], P[a][1]);
        ctx.lineTo(P[b][0], P[b][1]);
        ctx.stroke();
      }
      const w4 = f.hand.world[4];
      const w8 = f.hand.world[8];
      const pinchCm = Math.hypot(w4.x - w8.x, w4.y - w8.y, w4.z - w8.z) * 100;
      const w0 = f.hand.world[0];
      const w9 = f.hand.world[9];
      const palmCm = Math.hypot(w0.x - w9.x, w0.y - w9.y, w0.z - w9.z) * 100;
      caption = `${name}\n${f.hand.handedness} ${f.hand.score.toFixed(2)}  ${f.inferenceMs.toFixed(1)}ms\npinch ${pinchCm.toFixed(1)}cm  palm ${palmCm.toFixed(1)}cm`;
      const d = (a: number, b: number) => { const A = f.hand!.world[a], B = f.hand!.world[b]; return +(Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z) * 100).toFixed(1); };
      results[name] = { found: true, pinchCm: +pinchCm.toFixed(1), palmCm: +palmCm.toFixed(1), score: +f.hand.score.toFixed(2),
        indexTipWrist: d(8, 0), indexTipMcp: d(8, 5), thumbTipWrist: d(4, 0) };
    } else {
      results[name] = { found: false };
    }
    const fig = document.createElement('figure');
    const cap = document.createElement('figcaption');
    cap.textContent = caption;
    fig.append(c, cap);
    grid.append(fig);
  }
  summary.textContent = `delegate ${tracker.delegate} · load ${loadMs.toFixed(0)}ms`;
  Object.assign(window, { __verify: { delegate: tracker.delegate, loadMs, results } });
} catch (err) {
  summary.textContent = `FAILED: ${err}`;
  Object.assign(window, { __verify: { error: String(err) } });
}
