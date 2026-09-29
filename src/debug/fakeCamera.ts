/**
 * Dev-only stand-in for a webcam: a canvas stream built from real hand photos.
 *   ?fake        the hand roams on a Lissajous path and blanks out periodically
 *   ?fake=calib  scripted calibration: hold still → roam → alternate point/fist
 * Lets the whole live pipeline (rVFC → MediaPipe → controller) run without a camera.
 */
export async function fakeCameraStream(mode: string): Promise<MediaStream> {
  const load = async (name: string) => {
    const img = new Image();
    img.src = `/tests/fixtures/${name}.jpg`;
    await img.decode();
    return img;
  };
  const [point, fist] = await Promise.all([load('pointing_up'), load('fist')]);

  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 480;
  const ctx = c.getContext('2d')!;
  const t0 = performance.now();
  const size = 300;

  const roam = (t: number) => ({ x: 320 + Math.sin(t * 0.9) * 130, y: 240 + Math.sin(t * 1.3) * 80 });

  const draw = () => {
    const t = (performance.now() - t0) / 1000;
    ctx.fillStyle = '#8a8f98';
    ctx.fillRect(0, 0, c.width, c.height);
    let img: HTMLImageElement | null = point;
    let p = roam(t);
    if (mode === 'calib') {
      if (t < 3) p = { x: 320, y: 240 };
      else if (t >= 9) {
        p = { x: 320, y: 240 };
        img = (t - 9) % 1.4 < 0.8 ? point : fist;
      }
    } else if (t % 8 >= 6.5) {
      img = null; // tracking-loss test
    }
    if (img) ctx.drawImage(img, p.x - size / 2, p.y - size / 2, size, size);
    requestAnimationFrame(draw);
  };
  draw();
  return c.captureStream(30);
}
