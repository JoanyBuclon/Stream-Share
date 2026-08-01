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

/** A running app whose audio the host can mute for viewers. */
interface NativeAudioApp {
  readonly pid: number;
  /** Executable name — the stable key: a restarted app keeps it, its pid changes. */
  readonly name: string;
  readonly title: string;
}

/** One live WASAPI session, as the shell reports it back. */
interface NativeCapturedApp {
  readonly pid: number;
  readonly name: string;
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
   * Replace the native audio capture, or stop it with `null`.
   *
   * `{ sourceId }` — the window being shared: capture that app's tree ALONE, resolved by window
   * handle so it can't hit another instance of the same executable.
   * `{ exclude }` — the whole machine except one app, named by executable so it survives that app
   * restarting under a new pid. The only mode that keeps up with the system: unlisted apps,
   * Windows' own sounds and anything started later are all still heard.
   * `{ include }` — one session per named app, and nothing else. Muting two or more apps needs
   * this, because WASAPI takes a single process tree per mode. The set is a SNAPSHOT: an app
   * started afterwards is silent until the caller sends a new list.
   *
   * Resolves to one entry per session actually started, or null when the shell could not do what
   * was asked (a window with no resolvable owner, an app that quit since it was listed, the addon
   * failing to load). An EMPTY ARRAY is a success, not a failure: it means "capture nothing", i.e.
   * silence. Callers must treat only null as "fall back to the ordinary loopback track" — treating
   * `[]` that way would un-mute every app the host just muted.
   */
  setAudioCapture(
    spec: { sourceId: string } | { exclude: string } | { include: string[] } | null,
  ): Promise<NativeCapturedApp[] | null>;
  /** Raw PCM (48 kHz, 16-bit, stereo, interleaved) in ~10 ms chunks, tagged with the name of the
   *  app it came from — sessions are independent streams. Returns an unsubscribe. */
  onAudioChunk(cb: (key: string, chunk: Uint8Array) => void): () => void;
}

interface Window {
  readonly native?: StreamShareNative;
}
