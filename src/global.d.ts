// Injected by the Electron desktop shell's preload (absent in browsers). Its mere presence means
// "running in the desktop app"; phase 2 adds native capture/audio methods to this object.
interface StreamShareNative {
  /** Web origin the shell targets — drives the signaling URL and shareable links. */
  readonly appOrigin: string;
}

interface Window {
  readonly native?: StreamShareNative;
}
