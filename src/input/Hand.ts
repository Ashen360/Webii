import { Emitter } from '../lib/emitter';
import type { Vec2 } from '../lib/math';

/**
 * The hand controller contract. This is the ONLY input surface the UI and games see:
 * no landmarks, no MediaPipe, no camera. A mouse or a scripted "ghost hand" can
 * drive it just as well as a webcam.
 */

export type HandSource = 'camera' | 'pointer' | 'script';
export type TrackingState = 'starting' | 'searching' | 'tracking' | 'lost';

export interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

export interface HandEvents extends Record<string, unknown> {
  pinchstart: Vec2;
  pinchend: Vec2 & { cancelled: boolean };
  found: undefined;
  lost: undefined;
}

export interface Hand {
  readonly source: HandSource;
  readonly state: TrackingState;
  /** Cursor should be drawn and can hit things. */
  readonly present: boolean;
  /** Viewport px: filtered, drift-corrected, clamped to the viewport. */
  readonly position: Readonly<Vec2>;
  /** px/s */
  readonly velocity: Readonly<Vec2>;
  /** Unit vector of motion; (0,0) when (nearly) still. */
  readonly direction: Readonly<Vec2>;
  readonly speed: number;
  readonly isPinching: boolean;
  /** 0..1: how closed the pinch is. Rises before the click so UI can anticipate it. */
  readonly pinchStrength: number;
  /** Recent trail, oldest first, ~TRAIL_MS long. */
  readonly path: readonly TrailPoint[];
  /** The hand is at the edge of what the sensor can see: tracking unreliable, pinch disabled. */
  readonly nearEdge: boolean;
  on<K extends keyof HandEvents>(event: K, fn: (payload: HandEvents[K]) => void): () => void;
}

/** What a driver reports each render frame. */
export interface HandSample {
  state: TrackingState;
  present: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinchStrength: number;
  pressed: boolean;
  nearEdge?: boolean;
}

export interface HandDriver {
  readonly source: HandSource;
  sample(now: number, view: { w: number; h: number }): HandSample;
  dispose(): void;
}

const TRAIL_MS = 500;
const STILL_SPEED = 40; // px/s below which direction is (0,0)

/**
 * Turns driver samples into the Hand contract and owns all event semantics,
 * so every driver gets identical pinch/found/lost behaviour for free.
 */
export class HandController implements Hand {
  source: HandSource = 'pointer';
  state: TrackingState = 'starting';
  present = false;
  position = { x: 0, y: 0 };
  velocity = { x: 0, y: 0 };
  direction = { x: 0, y: 0 };
  speed = 0;
  isPinching = false;
  pinchStrength = 0;
  path: TrailPoint[] = [];
  nearEdge = false;

  private driver: HandDriver | null = null;
  private events = new Emitter<HandEvents>();

  constructor(private viewport: () => { w: number; h: number } = () => ({ w: innerWidth, h: innerHeight })) {}

  on<K extends keyof HandEvents>(event: K, fn: (payload: HandEvents[K]) => void) {
    return this.events.on(event, fn);
  }

  get activeDriver(): HandDriver | null {
    return this.driver;
  }

  setDriver(driver: HandDriver | null): void {
    // Swapping drivers mid-pinch must never leave a press dangling.
    if (this.isPinching) this.endPinch(true);
    if (this.present) this.setPresent(false);
    this.driver?.dispose();
    this.driver = driver;
    this.source = driver?.source ?? 'pointer';
    this.state = 'starting';
    this.pinchStrength = 0;
    this.path = [];
  }

  /** Call once per render frame. */
  update(now: number): void {
    if (!this.driver) return;
    const s = this.driver.sample(now, this.viewport());

    this.state = s.state;
    this.position.x = s.x;
    this.position.y = s.y;
    this.velocity.x = s.vx;
    this.velocity.y = s.vy;
    this.speed = Math.hypot(s.vx, s.vy);
    if (this.speed > STILL_SPEED) {
      this.direction.x = s.vx / this.speed;
      this.direction.y = s.vy / this.speed;
    } else {
      this.direction.x = this.direction.y = 0;
    }
    this.pinchStrength = s.present ? s.pinchStrength : 0;
    this.nearEdge = s.present && !!s.nearEdge;

    // Order matters: a lost hand cancels its pinch before announcing the loss.
    if (this.isPinching && (!s.pressed || !s.present)) this.endPinch(!s.present);
    if (s.present !== this.present) this.setPresent(s.present);
    if (s.present && s.pressed && !this.isPinching) {
      this.isPinching = true;
      this.events.emit('pinchstart', { x: s.x, y: s.y });
    }

    if (s.present) {
      this.path.push({ x: s.x, y: s.y, t: now });
      while (this.path.length && now - this.path[0].t > TRAIL_MS) this.path.shift();
    }
  }

  private endPinch(cancelled: boolean) {
    this.isPinching = false;
    this.events.emit('pinchend', { x: this.position.x, y: this.position.y, cancelled });
  }

  private setPresent(present: boolean) {
    this.present = present;
    if (!present) this.path = [];
    this.events.emit(present ? 'found' : 'lost', undefined);
  }
}
