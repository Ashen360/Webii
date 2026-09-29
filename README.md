# Webii

A tiny console in your browser. Your webcam is the controller.

Raise a hand: your index finger moves a cursor and a pinch selects. Onboarding teaches the gesture, then a Wii-inspired menu offers **Games** (Catch, Slice, Memory Trace), **Portfolio**, and **Settings**. Everything runs client-side in a static site — no backend, no accounts.

## Overview

The hand cursor is the product. Tracking runs through a fixed pipeline:

```
webcam → tracking/ → input/ → ui/ → shell/ and games/
        MediaPipe     map, filter,   hit-testing,   scenes read the
        HandLandmarker pinch FSM,    hover, press,  hand contract only
                      loss handling  feedback, audio
```

Two rules keep it simple:

- Nothing outside `tracking/` knows MediaPipe exists.
- Nothing in `shell/` or `games/` reads landmarks — they read one `Hand` contract (position, velocity, pinch state, trail), so the mouse/touch fallback and the scripted test hands plug into the same interface.

The pipeline mirrors x, maps an inner "comfort box" of the camera frame to the whole viewport, smooths with a One Euro filter, extrapolates between detections so the cursor does not step across refresh rates, and treats pinch as a 3D distance between thumb and index with hysteresis so clicks do not flicker.

## Features

- **Hand cursor** — filtered, drift-corrected, with velocity and a short trail; `pinchStrength` rises before the click so the UI can anticipate it
- **Pinch-drift lock** — cursor motion is damped as a pinch closes, so the cursor does not slide off the target at the moment of the click
- **Loss handling** — short tracking gaps hold the cursor; longer ones cancel any active press so drags never stick
- **Onboarding** on first visit (replayable from Settings), which doubles as calibration
- **Console shell** with live animated canvas previews — game previews run the real game in attract mode
- **Three games** — Catch, Slice, and Memory Trace (single accuracy score: F1 of coverage and precision)
- **Settings** — camera picture-in-picture, audio, themes (Paper, Night, Classic), calibration
- **Portfolio channel** — plays a channel-exit transition, then opens the portfolio URL
- **Fallbacks** — mouse/touch through the same controller interface, plus a specific explanation screen for a missing camera, insecure context, or missing browser APIs; never a blank page
- **Synthesized audio** — Web Audio oscillators and envelopes, no sample files
- **Local persistence** — settings, onboarding flag, and best scores in `localStorage`

## Requirements

- A **secure context** (HTTPS, or `localhost` for development) — browsers only allow the camera there
- `getUserMedia`, WebAssembly, and WebGL2 (the GPU delegate; CPU works but is slower)
- Any webcam of 480p or better
- Current Chrome, Edge, Firefox, or Safari on **desktop or laptop** first; mobile is best-effort

## Installation

```bash
git clone https://github.com/Ashen360/Webii.git
cd Webii
npm install
```

The MediaPipe WASM runtime and hand model are self-hosted in `public/mediapipe/`, which is gitignored. `npm run setup` copies them from `node_modules` and downloads `hand_landmarker.task` (~7.5 MB) if it is missing. The `predev` and `prebuild` hooks run it automatically, so a first `npm run dev` does this for you.

## Usage

```bash
npm run dev               # http://localhost:5178  (strict port, model downloaded on first run)
npm test                  # Vitest unit tests for the signal logic
npm run typecheck         # tsc --noEmit
npm run build             # tsc --noEmit && vite build → dist/
npm run preview           # serve the production build
```

Start → onboarding on your first visit → the console menu: **Games · Portfolio · Settings**.

### Development tools

| Flag or path | Effect |
|--------------|--------|
| `` ` `` | Toggle the debug panel (live readouts and tuning sliders, saved locally) |
| `?debug` | Open the debug panel at startup |
| `?fake` | Dev only: replace the webcam with a moving hand photo, so the real pipeline runs without a camera |
| `?fake=calib` | Scripted calibration scenario for the simulated camera |
| `?calibrate` | Start in calibration; in dev, each run is saved to `calibration-data/` |
| `?clicktest` | Open the click-test harness (optional `?label=…`) |
| `?session` | Calibrate, then measure clicking with the new calibration |
| `?board` | Phase 2 interaction test board instead of the shell |
| `?game=demo` | Dev only: load the demo game |
| `/tools/verify.html` | Run the real tracker on the photos in `tests/fixtures/` |

Calibration is also reachable from the status pill and the debug panel.

## Configuration

| Setting | Where | Default |
|---------|-------|---------|
| Portfolio URL | `src/config.ts` → `PORTFOLIO_URL` | `https://ashens-web.netlify.app/` |
| Dev server port | `vite.config.ts` → `server.port` | `5178` (`strictPort`) |
| Calibration recordings | `vite.config.ts` dev middleware | saved to `calibration-data/` (gitignored; derived numbers only, never images) |

Settings, the onboarding flag, and best scores persist in `localStorage`.

To re-record the Portfolio channel preview video used in the menu:

```bash
npm run capture:portfolio                # defaults to PORTFOLIO_URL
npm run capture:portfolio -- <url>       # or pass your own
```

It uses Playwright's Chromium and its bundled ffmpeg, writing `public/media/portfolio-preview.webm` and a `.jpg` poster.

## Project Structure

```
webii/
├── src/
│   ├── main.ts             Boot: camera → tracker → controller → app loop
│   ├── config.ts           Portfolio URL and tuning defaults
│   ├── settings.ts         Persistent settings (localStorage)
│   ├── style.css           Shell styling and themes
│   ├── tracking/           camera, CameraView, HandTracker, types  (the only files that import MediaPipe)
│   ├── input/              Hand contract, CameraDriver, PointerDriver, ScriptDriver, OneEuro, pinch, mapping, calibration
│   ├── ui/                 Cursor, Status, Screen, controls, interaction (hit-testing), audio, Calibration, TestBoard
│   ├── shell/              Shell, scenes, channels, launch, painters, theme, SettingsScene
│   ├── games/              GameScene, runner, attract, scores, types, demo + catch/, slice/, memory/
│   ├── debug/              DebugPanel, fakeCamera, ClickTest, frameLog
│   └── lib/                loop, math, motion, storage, emitter
├── scripts/
│   ├── setup-mediapipe.mjs Copy WASM, download the model if missing
│   └── capture-portfolio.mjs  Record the Portfolio preview with Playwright
├── public/
│   ├── media/              portfolio preview (committed)
│   └── mediapipe/          WASM + hand model (gitignored, generated)
├── tests/                  Vitest unit tests and fixture photos
├── tools/                  verify.html + verify.ts — run the tracker over fixture photos
├── docs/                   SEED, PROJECT, PROGRESS, HANDOFF
├── index.html
├── vite.config.ts
└── package.json
```

## Documentation

| Document | Contents |
|----------|----------|
| [docs/SEED.md](docs/SEED.md) | Product specification |
| [docs/PROJECT.md](docs/PROJECT.md) | Architecture, technology choices, and decisions |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Phase-by-phase log and validation rounds |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Handover notes |

## Contributing

1. Fork and create a feature branch.
2. Run `npm install`, then `npm run dev`.
3. Keep the boundary intact: MediaPipe stays in `tracking/`, and `shell/`/`games/` read only the `Hand` contract.
4. Run `npm run typecheck` and `npm test` before opening a pull request.

## License

No license file has been added to this repository yet.
