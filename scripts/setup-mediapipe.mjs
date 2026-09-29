// Copies MediaPipe's WASM runtime into /public and downloads the hand model once.
// Self-hosting both keeps the runtime and model versions pinned to package.json.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const outDir = join(root, 'public/mediapipe');
const wasmOut = join(outDir, 'wasm');
const modelOut = join(outDir, 'hand_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

mkdirSync(wasmOut, { recursive: true });
// Only the SIMD build and its no-SIMD fallback are loaded by FilesetResolver;
// the *_module_* variant is for useModule=true, which we don't use.
for (const f of readdirSync(wasmSrc).filter((f) => !f.includes('_module_'))) {
  const src = join(wasmSrc, f);
  const dst = join(wasmOut, f);
  if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) copyFileSync(src, dst);
}

if (!existsSync(modelOut) || statSync(modelOut).size < 1_000_000) {
  console.log('[webii] downloading hand_landmarker.task …');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  writeFileSync(modelOut, Buffer.from(await res.arrayBuffer()));
}
console.log('[webii] mediapipe assets ready');
