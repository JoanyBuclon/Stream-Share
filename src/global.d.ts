// Injected by the Electron desktop shell's preload (absent in browsers). Its mere presence means
// "running in the desktop app". The preload and this bundle always ship together, so the methods
// are required, not optional — only `window.native` itself needs a guard.

/** One capturable surface, as the shell reports it to the source picker.
 *
 *  `camera` is the exception: those are NOT reported by the shell. The renderer enumerates video
 *  inputs itself (`listCameras` in source-picker.ts) and merges them into the same grid, so the
 *  picker has one shape for everything it can offer. Their ids are `camera:<deviceId>` and they are
 *  captured through getUserMedia, not getDisplayMedia. */
interface NativeSource {
  readonly id: string;
  readonly name: string;
  readonly kind: 'screen' | 'window' | 'camera';
  /** Physical resolution for a screen ("2560×1440"); empty for a window or a camera. */
  readonly meta: string;
  /** This screen is in HDR mode **right now** — the shell's live reading, not the panel's
   *  capability, and not something the web can answer. False for windows, cameras, non-Windows,
   *  and whenever the native addon is unavailable. */
  readonly hdr: boolean;
  /** Windows device name (`\\.\DISPLAY1`) — what `startNativeCapture` takes. Empty for windows and
   *  cameras, and for a screen the shell could not match to a DXGI output. */
  readonly deviceName: string;
  /** Reference white for SDR content, in nits — the tone map's divisor. Only trustworthy when
   *  `sdrWhiteMeasured`; 0 means the shell has nothing to report. */
  readonly sdrWhiteNits: number;
  readonly sdrWhiteMeasured: boolean;
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
  /** Keep the display awake while a session is live — a process-level `powerSaveBlocker`, which
   *  unlike `navigator.wakeLock` survives a hidden window (see src/lib/wakelock.ts). Repeats
   *  collapse in the shell, and it is dropped on reload, window close, crash and quit. */
  setWakeLock(on: boolean): void;
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

  // --- native HDR capture ---
  //
  // Optional, unlike everything above: these arrived after the shell shipped, and an older
  // installer paired with a newer web build would otherwise call an undefined function. They are
  // also genuinely absent off Windows and whenever the addon failed to load.

  /** Windows, and the addon actually loaded. False means there is no native path at all. */
  canCaptureNative?(): boolean;
  /**
   * Start pushing tone-mapped frames for a screen, by its Windows device name, and hand over the
   * MessagePort they arrive on — as a single `window.postMessage` tagged `{ streamShare: 'frames' }`,
   * posted SYNCHRONOUSLY from inside this call. Listen before calling. See src/lib/native-video.ts.
   *
   * Throws if `deviceName` is not the display the user last confirmed in the picker: this path does
   * not go through the OS consent handler, so the check lives here.
   */
  startNativeCapture?(deviceName: string, sdrWhiteNits?: number, knee?: number): void;
  stopNativeCapture?(): void;
  /** Capture counters, or null without the addon. `dropped` is the backpressure signal: frames
   *  tone-mapped but never handed to the page because it was behind. */
  nativeCaptureStats?(): NativeCaptureStats | null;
}

interface NativeCaptureStats {
  readonly frames: number;
  readonly failed: number;
  readonly empty: number;
  readonly dropped: number;
  /** Tone-mapped but never handed to JS — the failure that leaves every other counter green. */
  readonly undelivered: number;
  /** Frames produced while no page was listening. */
  readonly orphanedFrames: number;
  /** The capture item went away: monitor unplugged, RDP session, HDR switched off. */
  readonly closed: boolean;
  readonly recreated: number;
  readonly width: number;
  readonly height: number;
  readonly gapAvgMs: number;
  readonly gapMaxMs: number;
  readonly gpuAvgMs: number;
  readonly gpuMaxMs: number;
  readonly copyAvgMs: number;
  readonly copyMaxMs: number;
  readonly running: boolean;
}

interface Window {
  readonly native?: StreamShareNative;
}
