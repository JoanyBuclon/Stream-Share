import { contextBridge, ipcRenderer } from 'electron';

// The bridge the web UI sees as `window.native` — its mere presence means "running in the desktop
// app". Beyond the origin (signaling target + share links), it exposes the capture routing the
// custom source picker needs: list what can be captured, then name the pick.
const config = ipcRenderer.sendSync('ss:config') as { appOrigin: string };
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
});
