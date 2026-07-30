import { contextBridge, ipcRenderer } from 'electron';

// Phase 1: the shell injects only the web origin, so the renderer (loaded under app://)
// targets the real signaling server and builds correct share links. No native capability
// yet — window.native gains capture/audio methods in phase 2. Its mere presence already
// tells the web UI it runs inside the desktop app.
const config = ipcRenderer.sendSync('ss:config') as { appOrigin: string };
contextBridge.exposeInMainWorld('native', { appOrigin: config.appOrigin });
