import { contextBridge, ipcRenderer } from 'electron';
import { loadCaptureAddon, type NativeFrame } from './native-addon.ts';

/**
 * Native HDR capture, and why it lives HERE rather than in the main process.
 *
 * Measured (docs/desktop.md § G2): Electron's IPC tops out near 102 MB/s and 1080p60 needs 187, so
 * an addon in main would cap native capture below the getDisplayMedia path it replaces. The addon
 * therefore runs in the renderer's process, which is what `sandbox: false` bought us.
 *
 * That still leaves one boundary: `contextIsolation: true` means the preload and the page are two
 * V8 contexts, and contextBridge structured-CLONES everything across. Measured (G3): 7.98 ms per
 * 1080p frame, 11.55 at 1440p — most of a frame budget, spent on a memcpy.
 *
 * `postMessage` takes a transfer list, which contextBridge does not. So the VideoFrame is built
 * here and MOVED to the page: 1.17 ms per frame sustained at 60 fps, and the write into the track
 * costs 0.019. A dedicated MessagePort rather than `window.postMessage`, so 60 frames a second do
 * not wake every message listener on the page.
 */
// Defaulted rather than trusted: with no handler on the other side this returns undefined, and the
// resulting throw fails the whole page load with a bare ERR_FAILED. A shell that loses its config
// should degrade, not show a blank window.
const config = (ipcRenderer.sendSync('ss:config') as { appOrigin: string; packaged: boolean } | undefined) ?? {
  appOrigin: '',
  packaged: true,
};
// `process.platform`, not just "the addon loaded": the addon is compiled on macOS and Linux too and
// loads there with no-op stubs (see the #else branch in addon.cc), so a non-null addon is NOT the
// same question as "native capture can run".
const addon = process.platform === 'win32' ? loadCaptureAddon(__dirname, config.packaged, process.resourcesPath) : null;

let framePort: MessagePort | null = null;
/** Frames produced with nobody to hand them to. A silent zero here would read as "working". */
let orphanedFrames = 0;

function closeFramePort(): void {
  framePort?.close();
  framePort = null;
}

function pushFrame(frame: NativeFrame): void {
  if (!framePort) {
    orphanedFrames++;
    return;
  }
  // VideoFrame copies the buffer on construction — which is also what makes reusing the addon's
  // ArrayBuffer safe, and why that copy must stay SYNCHRONOUS here. Awaiting anything before this
  // line would let the next frame overwrite the bytes underneath us, silently.
  const video = new VideoFrame(new Uint8Array(frame.data), {
    format: 'BGRA',
    codedWidth: frame.width,
    codedHeight: frame.height,
    timestamp: frame.timestampUs,
  });
  // Transferred, so ownership moves to the page — which must close it, or the hardware buffers it
  // holds pile up until the renderer wedges. Measured: 30 unreleased frames is enough.
  framePort.postMessage(video, [video]);
}

// The bridge the web UI sees as `window.native` — its mere presence means "running in the desktop
// app". Beyond the origin (signaling target + share links), it exposes the capture routing the
// custom source picker needs: list what can be captured, then name the pick.
contextBridge.exposeInMainWorld('native', {
  appOrigin: config.appOrigin,
  listSources: () => ipcRenderer.invoke('ss:sources'),
  // Awaited by the renderer: main must hold the id before getDisplayMedia is called.
  selectSource: (id: string) => ipcRenderer.invoke('ss:select-source', id),

  // Fire-and-forget: main collapses repeats, and there is nothing for the caller to do about a
  // failure — the display sleeping is a degradation, not an error.
  setWakeLock: (on: boolean) => ipcRenderer.send('ss:wake-lock', on),

  listAudioApps: () => ipcRenderer.invoke('ss:audio-apps'),
  setAudioCapture: (spec: { sourceId: string } | { exclude: string } | { include: string[] } | null) =>
    ipcRenderer.invoke('ss:audio-capture', spec),
  // ~100 chunks/s of raw PCM per live session, each tagged with its app name. Returns its own
  // unsubscribe: the host controller is recreated per session and a stacked listener would double
  // every sample.
  onAudioChunk: (cb: (key: string, chunk: Uint8Array) => void) => {
    const handler = (_e: unknown, key: string, chunk: Uint8Array): void => cb(key, chunk);
    ipcRenderer.on('ss:audio-chunk', handler);
    return () => ipcRenderer.removeListener('ss:audio-chunk', handler);
  },

  /** Whether native HDR capture can run at all: Windows, and the addon actually loaded. */
  canCaptureNative: () => addon !== null,

  /**
   * Start pushing tone-mapped frames for the display the user picked, and hand the page the port
   * they arrive on.
   *
   * **The caller does not say which display.** `setDisplayMediaRequestHandler` — which main
   * documents as THE consent gate — is never consulted when frames come from the addon, so this
   * path carries its own: main answers with the display the last confirmed pick approved.
   *
   * Be precise about what that is worth. It is NOT a stronger barrier against a compromised
   * renderer: `selectSource(id)` is still exposed, so hostile code in our own bundle can name a
   * source from the last listing and then call this — by id instead of by device name. What it
   * removes is a second derivation of the id→device association that could silently disagree with
   * the listing's, and the DXGI names themselves, which the page has no use for.
   *
   * One call, not a connect/start pair, and that is a bug fix rather than tidiness: the pair closed
   * the live port BEFORE the call that can fail, so picking a second source while one was running
   * killed the first capture's channel and then threw "capture already running" — leaving a track
   * that was live and frozen, with the error blamed on the new source. Here nothing is torn down
   * until `startCapture` has succeeded.
   *
   * The page must already be listening for `{ streamShare: 'frames' }` when it calls this.
   */
  startNativeCapture: (sdrWhiteNits?: number, knee?: number, fps?: number) => {
    if (!addon) throw new Error('native capture unavailable');
    const approved = ipcRenderer.sendSync('ss:approved-device') as string;
    if (!approved) throw new Error('no display was picked by the user');
    addon.startCapture(approved, sdrWhiteNits, knee, pushFrame, fps);
    closeFramePort();
    const channel = new MessageChannel();
    framePort = channel.port1;
    // `location.origin`, not '*': the handover carries the only handle to the frame stream, and any
    // script that grabbed it first would both see every frame and strand the real consumer.
    window.postMessage({ streamShare: 'frames' }, location.origin, [channel.port2]);
  },
  setCaptureFps: (fps: number) => addon?.setFps(fps),
  stopNativeCapture: () => {
    addon?.stopCapture();
    // Not optional: leaving the port open leaks it per session, and a later start would push 60
    // frames a second into a channel whose other end the page has already dropped.
    closeFramePort();
  },
  /** Counters for the stats overlay and for diagnosing a stalled capture. Null without the addon. */
  nativeCaptureStats: () => (addon ? { ...addon.captureStats(), orphanedFrames } : null),
});
