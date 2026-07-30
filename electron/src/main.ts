import { app, BrowserWindow, protocol, session, shell, ipcMain, desktopCapturer } from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAppOrigin, contentSecurityPolicy, isInternalUrl, wsOrigin } from './config.ts';

const APP_SCHEME = 'app';
const appOrigin = resolveAppOrigin();
// The local build carries no CSP (nginx sets it in prod), so we attach the mirrored policy to
// every app:// response — more robust than a webRequest listener, which doesn't reliably see
// protocol.handle responses across Electron versions.
const CSP = contentSecurityPolicy(appOrigin);

// The Astro build (dist/) sits at the project root in dev and is copied into the app
// resources at package time (electron-builder extraResources: ../dist → dist).
const distDir = app.isPackaged
  ? path.join(process.resourcesPath, 'dist')
  : path.join(__dirname, '..', '..', 'dist');

// Only the few types the Astro build emits — no full mime library for a fixed asset set.
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// The custom scheme must be privileged (standard + secure) BEFORE app.ready, otherwise the
// renderer gets an opaque origin and getDisplayMedia / clipboard / localStorage all break —
// the exact reason we don't serve dist/ over file://.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/** Maps a request path to a file inside dist/, expanding directory requests to index.html
 *  (Astro's directory build format). Returns null on path traversal. */
function resolveDistFile(pathname: string): string | null {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  else if (!path.extname(rel)) rel += '/index.html'; // e.g. /download → /download/index.html
  const full = path.normalize(path.join(distDir, rel));
  if (path.relative(distDir, full).startsWith('..')) return null;
  return full;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0a0a0a', // --color-ink, avoids a white flash before first paint
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // In-app navigation stays within our bundled content; every external link opens in the
  // system browser (it must never load with the privileged preload attached).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  void win.loadURL(`${APP_SCHEME}://bundle/`);
}

app.whenReady().then(() => {
  // Serve dist/ over app://. The whole body is guarded: a malformed percent-encoding makes
  // resolveDistFile throw (URIError), which must surface as 404, not a rejected handler.
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const file = resolveDistFile(new URL(request.url).pathname);
      if (!file) return new Response('Forbidden', { status: 403 });
      const body = await readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      return new Response(new Uint8Array(body), {
        headers: { 'content-type': type, 'content-security-policy': CSP },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // The signaling server rejects WebSocket upgrades whose Origin isn't allow-listed (anti-CSWSH,
  // signaling/src/index.js). Under app:// the browser sends Origin: app://… which the server 401s,
  // so we present the canonical web origin for the signaling socket. Not a CSWSH vector: in-app
  // navigation is locked to app:// and external links open in the system browser.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${wsOrigin(appOrigin)}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, Origin: appOrigin } });
  });

  // Windows has no built-in getDisplayMedia picker (useSystemPicker is macOS-15+ only), so the
  // shell must supply the source. Phase 1: capture the primary screen (+ system audio if the page
  // asked for it). The visual source picker — screens AND windows, feature #2 — is phase 2
  // (docs/desktop.md). On macOS 15+ the OS picker is used instead and this handler isn't called.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          const screen = sources[0];
          if (!screen) return callback({}); // no capturable screen → getDisplayMedia rejects
          callback({ video: screen, audio: request.audioRequested ? 'loopback' : undefined });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: true },
  );

  createWindow();

  // Auto-update only makes sense on an installed build (dev has no publish channel).
  if (app.isPackaged) void autoUpdater.checkForUpdatesAndNotify();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// The renderer asks (synchronously, once, from the preload) for the web origin it should target.
ipcMain.on('ss:config', (event) => {
  event.returnValue = { appOrigin };
});

// Decision: close = quit. No tray, no background — including on macOS, against its usual
// convention, since the app is Windows-first and host-only.
app.on('window-all-closed', () => {
  app.quit();
});
