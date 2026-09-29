# Webii

A tiny console in your browser. Your webcam is the controller.

```bash
npm install
npm run dev        # http://localhost:5178  (downloads the hand model on first run)
npm test           # signal-logic unit tests
npm run build      # static site in dist/
npm run capture:portfolio   # re-record the Portfolio preview video from the live site
```

Start → (first visit) onboarding → the console menu: Games · Portfolio · Settings. `?board` shows the Phase 2 interaction test board.

Dev tools:
- **`?debug`** or the <kbd>`</kbd> key opens live readouts and tuning sliders (saved locally).
- **`?fake`** (dev only) replaces the webcam with a moving hand photo, so the live pipeline runs without a camera.
- **Calibrate** (status pill, debug panel, or `?calibrate`): in dev, each run is saved to `calibration-data/`.
- **`?fake=calib`**: a scripted calibration scenario for the simulated camera.
- **`/tools/verify.html`** runs the real tracker on the photos in `tests/fixtures/`.

Docs: [SEED.md](docs/SEED.md) (product), [PROJECT.md](docs/PROJECT.md) (architecture and decisions), [PROGRESS.md](docs/PROGRESS.md) (phase log).
