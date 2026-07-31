import { app, BrowserWindow, Menu, protocol, screen, session, shell, ipcMain, desktopCapturer } from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAppOrigin, contentSecurityPolicy, isInternalUrl, wsOrigin } from './config.ts';

const APP_SCHEME = 'app';
const appOrigin = resolveAppOrigin();

// --- source picker (renderer-side UI, main-side capture routing) ---

const SOURCE_TYPES: Array<'screen' | 'window'> = ['screen', 'window'];
const kindOf = (id: string): 'screen' | 'window' => (id.startsWith('screen:') ? 'screen' : 'window');
// Single-window app: one selection for the whole process is enough. Per-webContents state would
// be required the day a second window can capture.
let selectedSourceId: string | null = null;
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
    // Packaged, the window and taskbar icons come from the .exe resource (electron-builder embeds
    // build/icon.png). Unpackaged (`pnpm desktop`) there is no such resource, so point at the same
    // source file or the run shows Electron's default icon.
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, '..', 'build', 'icon.png') }),
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
  // shell supplies the source: the renderer's own picker names it through `ss:select-source` just
  // before capturing. No `useSystemPicker` — now that we own a picker, every platform gets the
  // same one instead of macOS 15+ diverging to the OS sheet.
  //
  // This handler IS the consent gate: whatever it hands back is shared with no OS prompt. So it
  // only ever answers a source the user explicitly picked. There is deliberately no
  // "nothing selected → primary screen" fallback: nothing in the app can reach it (capture()
  // always runs behind the picker), which leaves it useful only to code that isn't ours, and its
  // outcome would be the largest possible share. `request.userGesture` is NOT used as a second
  // gate — measured on Electron 43, it reports true even for a call with no user activation.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const wanted = selectedSourceId;
    if (!wanted) return callback({}); // → getDisplayMedia rejects; the picker surfaces it
    // Fresh lookup rather than reusing the objects `ss:sources` returned: a window can close
    // between listing and confirming, and a stale DesktopCapturerSource yields a dead track.
    // thumbnailSize 0×0 makes Electron skip the (expensive) image capture entirely, and the id
    // already says which kind to enumerate — no need to walk every window to find a screen.
    desktopCapturer
      .getSources({ types: [kindOf(wanted)], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const picked = sources.find((s) => s.id === wanted);
        // The chosen source vanished. Failing is the point: falling back to the whole desktop
        // would share far more than the user asked for.
        if (!picked) return callback({});
        callback({ video: picked, audio: request.audioRequested ? 'loopback' : undefined });
      })
      .catch(() => callback({}));
  });

  // Windows identity for taskbar grouping — and a hard requirement for toast notifications to
  // show under the app's name rather than being dropped (phase 2 announces viewers joining).
  // Must match electron-builder's appId. No-op on other platforms.
  app.setAppUserModelId('com.joanybuclon.streamshare');

  // No File/Edit/View/Window bar: it's Electron's default menu, not something the product uses.
  // Windows/Linux keep the native editing shortcuts (Chromium handles Ctrl+C/V/X/A in inputs on
  // its own). macOS is the exception — those accelerators come FROM the menu there, so shipping
  // macOS later means restoring a minimal menu with the `editMenu` role rather than null.
  Menu.setApplicationMenu(null);

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

// Everything the picker grid needs, already serialisable (NativeImage doesn't cross IPC).
ipcMain.handle('ss:sources', async (event) => {
  // Defence in depth: only our own bundle may enumerate windows. A thumbnail of every open
  // window is exactly the kind of thing that must not become reachable from foreign content.
  if (!isInternalUrl(event.senderFrame?.url ?? '')) return [];
  // Our own window is capturable and picking it is an infinite mirror. getMediaSourceId() gives
  // the exact id desktopCapturer will report, so no name heuristic.
  const own = BrowserWindow.fromWebContents(event.sender)?.getMediaSourceId();
  const displays = screen.getAllDisplays();
  const sources = await desktopCapturer.getSources({
    types: SOURCE_TYPES,
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((s) => s.id !== own)
    .map((s) => {
      // display_id is documented as possibly empty — no match just means no resolution label.
      const display = displays.find((d) => String(d.id) === s.display_id);
      return {
        id: s.id,
        name: s.name,
        kind: kindOf(s.id),
        // getAllDisplays() reports DIP: a 2560×1440 monitor at 150% would read 1707×960, a
        // resolution the user has never seen. scaleFactor brings it back to physical pixels.
        meta: display
          ? `${Math.round(display.size.width * display.scaleFactor)}×${Math.round(display.size.height * display.scaleFactor)}`
          : '',
        // JPEG, not toDataURL()'s lossless PNG: a real Windows session has 30-60 windows, and
        // each one is a synchronous encode on the main thread plus base64 through IPC. The tile
        // is a lossy preview anyway. The icon keeps PNG — it needs the alpha channel.
        thumbnail: `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString('base64')}`,
        // appIcon is null for screens, and can be a non-null EMPTY image for some windows —
        // whose data URL would render as a broken <img>.
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      };
    });
});

// handle (awaited), not send: the id and the getDisplayMedia call travel on different IPC pipes,
// so nothing orders them — fire-and-forget would capture the previous source now and then.
ipcMain.handle('ss:select-source', (_event, id: unknown) => {
  // Shape-checked, not just typed: the empty string is a string AND falsy, so a bare
  // `typeof id === 'string'` would let `selectSource('')` through as "nothing selected".
  selectedSourceId =
    typeof id === 'string' && (id.startsWith('screen:') || id.startsWith('window:')) ? id : null;
});

// Decision: close = quit. No tray, no background — including on macOS, against its usual
// convention, since the app is Windows-first and host-only.
app.on('window-all-closed', () => {
  app.quit();
});
