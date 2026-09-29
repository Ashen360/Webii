export type CameraErrorKind = 'insecure' | 'unsupported' | 'denied' | 'not-found' | 'in-use' | 'unknown';

export class CameraError extends Error {
  constructor(
    public kind: CameraErrorKind,
    message: string,
  ) {
    super(message);
  }
}

function classify(err: unknown): CameraError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new CameraError('denied', msg);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new CameraError('not-found', msg);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('in-use', msg);
    default:
      return new CameraError('unknown', msg);
  }
}

export function checkCameraSupport(): CameraError | null {
  if (!window.isSecureContext) return new CameraError('insecure', 'Camera needs HTTPS.');
  if (!navigator.mediaDevices?.getUserMedia) return new CameraError('unsupported', 'getUserMedia unavailable.');
  if (typeof WebAssembly !== 'object') return new CameraError('unsupported', 'WebAssembly unavailable.');
  return null;
}

/** 'granted' lets us skip the explainer screen on return visits. */
export async function cameraPermission(): Promise<PermissionState | 'unknown'> {
  try {
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
    return status.state;
  } catch {
    return 'unknown';
  }
}

/**
 * Opens the camera at a modest resolution: hand landmarks don't need more than
 * ~640px, and smaller frames mean faster inference. A high frame rate matters
 * more than resolution, since every camera frame is latency.
 */
export async function openCamera(deviceId?: string): Promise<MediaStream> {
  const unsupported = checkCameraSupport();
  if (unsupported) throw unsupported;

  const video: MediaTrackConstraints = {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 60, max: 60 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    // A remembered camera that's since been unplugged: fall back to any camera.
    if (deviceId && err instanceof DOMException && err.name === 'OverconstrainedError') return openCamera();
    throw classify(err);
  }
}

export async function attachStream(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
  }
  try {
    await video.play();
  } catch (err) {
    throw classify(err);
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}
