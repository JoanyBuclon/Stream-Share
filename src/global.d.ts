// Injected by the Electron desktop shell's preload (absent in browsers). Its mere presence means
// "running in the desktop app". The preload and this bundle always ship together, so the methods
// are required, not optional — only `window.native` itself needs a guard.

/** One capturable surface, as the shell reports it to the source picker. */
interface NativeSource {
  readonly id: string;
  readonly name: string;
  readonly kind: 'screen' | 'window';
  /** Physical resolution for a screen ("2560×1440"); empty for a window. */
  readonly meta: string;
  /** data: URL. A still taken when the list was requested — not a live preview. */
  readonly thumbnail: string;
  /** data: URL of the app icon, when the OS exposes one. */
  readonly icon: string | null;
}

/** A running app whose audio can be excluded from the shared mix. */
interface NativeAudioApp {
  readonly pid: number;
  /** Executable name — the stable key: a restarted app keeps it, its pid changes. */
  readonly name: string;
  readonly title: string;
}

interface StreamShareNative {
  /** Web origin the shell targets — drives the signaling URL and shareable links. */
  readonly appOrigin: string;
  /** Screens and windows the shell can capture (its own window excluded). */
  listSources(): Promise<NativeSource[]>;
  /** Names the source the next getDisplayMedia call must capture. */
  selectSource(id: string): Promise<void>;
  /** Apps with a visible window, each with its root pid. */
  listAudioApps(): Promise<NativeAudioApp[]>;
  /**
   * Start the native audio capture, or stop it with `null`.
   *
   * `{ sourceId }` — the window being shared: capture that app's tree ALONE, so viewers hear it
   * and nothing else. `{ exclude }` — a screen is being shared: capture everything except that
   * app, named by executable so it survives the app restarting under a new pid.
   *
   * Resolves to the app actually captured, or null — a window whose owner couldn't be resolved
   * (it isn't a process's main window), or an app that quit since it was listed. Callers must
   * treat null as "no native audio" and fall back to the ordinary loopback track.
   */
  setAudioCapture(spec: { sourceId: string } | { exclude: string } | null): Promise<{ pid: number; name: string } | null>;
  /** Raw PCM (48 kHz, 16-bit, stereo, interleaved) in ~10 ms chunks. Returns an unsubscribe. */
  onAudioChunk(cb: (chunk: Uint8Array) => void): () => void;
}

interface Window {
  readonly native?: StreamShareNative;
}
