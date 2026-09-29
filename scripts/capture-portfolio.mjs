// Records a short scrolling showcase of the portfolio for its channel preview:
//   npm run capture:portfolio [-- <url>]
// Output: public/media/portfolio-preview.webm (+ .jpg poster). Re-run whenever the
// portfolio changes. Uses Playwright's Chromium and its bundled ffmpeg (for trimming).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL = process.argv[2] ?? 'https://ashens-web.netlify.app/';
const OUT = join(root, 'public', 'media');
const TMP = join(root, 'node_modules', '.cache', 'portfolio-capture');
const W = 1280;
const H = 720;
const DWELL_MS = 1200; // pause at the top and bottom
const SPEED = 520; // px per second while scrolling
const MAX_SCROLL_MS = 11000;

const pwDir = join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '', '.cache'), 'ms-playwright');
const newest = (prefix) =>
  existsSync(pwDir)
    ? readdirSync(pwDir)
        .filter((d) => d.startsWith(prefix))
        .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()))[0]
    : undefined;

/** Playwright's expected Chromium, else the newest installed one (avoids a 170 MB download). */
function chromiumPath() {
  if (existsSync(chromium.executablePath())) return undefined;
  const d = newest('chromium-');
  const exe = d && [join(pwDir, d, 'chrome-win64', 'chrome.exe'), join(pwDir, d, 'chrome-linux', 'chrome'), join(pwDir, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')].find(existsSync);
  if (!exe) throw new Error('No Chromium found. Run: npx playwright install chromium');
  return exe;
}

function ffmpegPath() {
  const d = newest('ffmpeg-');
  return d && ['ffmpeg-win64.exe', 'ffmpeg-linux', 'ffmpeg-mac'].map((f) => join(pwDir, d, f)).find(existsSync);
}

/** Scroll top → bottom smoothly. Uses the wheel if the site hijacks window scrolling. */
async function showcase(page, height) {
  const native = await page.evaluate(() => {
    window.scrollTo(0, 120);
    const ok = Math.abs(window.scrollY - 120) < 2;
    window.scrollTo(0, 0);
    return ok;
  });
  const dist = Math.max(0, height - H);
  const ms = Math.min(MAX_SCROLL_MS, Math.max(4000, (dist / SPEED) * 1000));
  await page.waitForTimeout(DWELL_MS);
  if (native) {
    await page.evaluate(
      ([dist, ms]) =>
        new Promise((done) => {
          const t0 = performance.now();
          const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
          const step = (now) => {
            const t = Math.min(1, (now - t0) / ms);
            window.scrollTo(0, ease(t) * dist);
            if (t < 1) requestAnimationFrame(step);
            else done();
          };
          requestAnimationFrame(step);
        }),
      [dist, ms],
    );
  } else {
    const steps = Math.ceil(ms / 40);
    await page.mouse.move(W / 2, H / 2);
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, dist / steps);
      await page.waitForTimeout(40);
    }
  }
  await page.waitForTimeout(DWELL_MS);
  return { native, ms };
}

const browser = await chromium.launch({ executablePath: chromiumPath() });

// 1. Warm-up: load everything (fonts, images, lazy sections) and measure the page.
const warm = await browser.newContext({ viewport: { width: W, height: H } });
const wp = await warm.newPage();
await wp.goto(URL, { waitUntil: 'networkidle' });
await wp.waitForTimeout(1500);
for (let y = 0; y < 40000; y += H) {
  await wp.mouse.wheel(0, H);
  await wp.waitForTimeout(120);
  if (await wp.evaluate((y) => window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2 && y > 0, y)) break;
}
const height = await wp.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
await warm.close();

// 2. Recording pass.
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: TMP, size: { width: W, height: H } } });
const created = Date.now();
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500); // intro animations settle
await page.screenshot({ path: join(OUT, 'portfolio-preview.jpg'), type: 'jpeg', quality: 82 });
const startSec = (Date.now() - created) / 1000;
const { native, ms } = await showcase(page, height);
const video = page.video();
await ctx.close();
await browser.close();
const raw = await video.path();

// 3. Trim the loading frames; re-encode at a sensible bitrate.
const out = join(OUT, 'portfolio-preview.webm');
const ff = ffmpegPath();
try {
  if (!ff) throw new Error('no ffmpeg');
  execFileSync(ff, ['-y', '-ss', startSec.toFixed(2), '-i', raw, '-an', '-c:v', 'libvpx', '-b:v', '1800k', '-deadline', 'good', '-cpu-used', '2', out], { stdio: 'pipe' });
} catch (e) {
  console.warn('[capture] trim/re-encode unavailable, keeping the raw recording:', e.message.split('\n')[0]);
  copyFileSync(raw, out);
}
console.log(
  `[capture] ${URL}\n  page height ${height}px · ${native ? 'native' : 'wheel'} scroll over ${(ms / 1000).toFixed(1)}s\n  → public/media/portfolio-preview.webm (${(statSync(out).size / 1e6).toFixed(2)} MB) + .jpg poster`,
);
