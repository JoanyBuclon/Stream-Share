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

interface StreamShareNative {
  /** Web origin the shell targets — drives the signaling URL and shareable links. */
  readonly appOrigin: string;
  /** Screens and windows the shell can capture (its own window excluded). */
  listSources(): Promise<NativeSource[]>;
  /** Names the source the next getDisplayMedia call must capture. */
  selectSource(id: string): Promise<void>;
}

interface Window {
  readonly native?: StreamShareNative;
}
