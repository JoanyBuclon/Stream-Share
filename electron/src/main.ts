import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  shell,
  ipcMain,
  desktopCapturer,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  resolveAppOrigin,
  contentSecurityPolicy,
  isInternalUrl,
  wsOrigin,
  parseAudioApps,
  hwndFromSourceId,
  createWakeLockToggle,
  nativeDisplayFor,
  type AudioApp,
  type NativeDisplay,
} from './config.ts';

const execFile = promisify(execFileCb);

const APP_SCHEME = 'app';
const appOrigin = resolveAppOrigin();

// --- wake lock ---

/** Hold the display awake at the PROCESS level, unlike the renderer's document-scoped
 *  `navigator.wakeLock` — which is granted under app:// but released the moment the window hides.
 *  See docs/desktop.md § Confort système for the measurement and the reasoning.
 *
 *  ponytail: one blocker for the whole process. Host and viewer are mutually exclusive (app.ts
 *  teardown() destroys one synchronously before the other is built) and the app is single-window,
 *  so nothing can want it on and off at once. Refcount the day a second window can hold a session.
 *  The bookkeeping itself lives in config.ts, where it is unit-tested without booting Electron. */
const setWakeLock = createWakeLockToggle(powerSaveBlocker);

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

  // A native capture must not outlive the page that asked for it. Registered here, once: doing it
  // inside the IPC handler added a pair per click, which trips MaxListenersExceededWarning after a
  // handful of checkbox toggles. A reload keeps the SAME WebContents, so isDestroyed() stays false
  // and the sessions would go on feeding a page that has lost its listener and its state — but
  // `isSameDocument` must be honoured, or our own `history.replaceState` of the room code would
  // kill the capture while the renderer still believes it is live (silence, with nothing to see).
  // The wake lock rides along: a blocker that outlives the page holding it keeps the machine awake
  // with nothing left to turn it off, and there is no UI that would ever show it. (This also fires
  // on the initial loadURL, which is a no-op only because setWakeLock tracks the id explicitly.)
  const dropNativeState = (): void => {
    stopCapture();
    setWakeLock(false);
  };
  win.webContents.on('destroyed', dropNativeState);
  // A crashed renderer leaves the WebContents alive, so neither of the other two fire — and the
  // blocker would be held against a blank page for as long as the app stays open.
  win.webContents.on('render-process-gone', dropNativeState);
  // `isMainFrame` as well as `isSameDocument`: a subframe navigating is not our session ending. It
  // also keeps this off the path of an external `<a href>` without target=_blank, which would fire
  // here BEFORE will-navigate cancels it — tearing down the capture and the lock under a session
  // that carries on, with no way for the renderer to know.
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) dropNativeState();
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
  // show under the app's name rather than being dropped. Packaged, it MUST equal electron-builder's
  // appId, which is what the installer stamps on the Start Menu shortcut. No-op off Windows.
  //
  // A separate id unpackaged, and this is not cosmetic. Windows resolves a toast's sender through a
  // Start Menu shortcut carrying that id, so an unpackaged run showing a notification makes Electron
  // create one — pointing into node_modules, named and iconed "Electron". Sharing the id with the
  // installed app would let a `pnpm desktop` session speak for it in the shell: taskbar grouping,
  // pinning, and the Start Menu entry. The stray shortcut still appears in dev; it just can no
  // longer be confused with the real app, and deleting it is safe.
  app.setAppUserModelId(app.isPackaged ? 'com.joanybuclon.streamshare' : 'com.joanybuclon.streamshare.dev');

  // No File/Edit/View/Window bar: it's Electron's default menu, not something the product uses.
  // Windows/Linux keep the native editing shortcuts (Chromium handles Ctrl+C/V/X/A in inputs on
  // its own). macOS is the exception — those accelerators come FROM the menu there, so shipping
  // macOS later means restoring a minimal menu with the `editMenu` role rather than null.
  Menu.setApplicationMenu(null);

  createWindow();

  // Auto-update only makes sense on an installed build (dev has no publish channel).
  if (app.isPackaged) {
    // Without a listener, an 'error' on a Node EventEmitter is re-thrown — and this one emits on a
    // 404 feed, a bad signature or a flaky network, none of which should be able to take the app
    // down mid-share. It also gives the only trace there is: no electron-log in the tree, so a
    // silent updater is diagnosed from latest.yml and the cache (cf. docs/desktop.md).
    autoUpdater.on('error', (err) => console.error('stream-share: auto-update failed', err));
    // checkForUpdatesAndNotify already toasts once the download is READY to install. This is the
    // earlier moment — "there is a new version, it is coming down" — which is the one that
    // explains why a restart will be worth it. Not focus-gated, unlike the viewer toasts: the
    // check runs once per launch, so this is at most one toast per start of the app.
    autoUpdater.on('update-available', (info) => {
      if (!Notification.isSupported()) return;
      new Notification({
        title: 'StreamShare update available',
        body: `Version ${info.version} is downloading. It installs the next time you quit.`,
      }).show();
    });
    void autoUpdater.checkForUpdatesAndNotify();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// The renderer asks (synchronously, once, from the preload) for the web origin it should target.
ipcMain.on('ss:config', (event) => {
  event.returnValue = { appOrigin };
});

// --- native capture addon (HDR) ---

/** The half of the capture addon that exists today: which displays are in HDR mode right now.
 *
 *  Optional by construction. It is absent off Windows, absent when `pnpm build:native` has not been
 *  run, and will be absent on any machine whose build failed — none of which may stop the app from
 *  sharing a screen. Every caller treats "no addon" as "no display is HDR", which is the behaviour
 *  that ships today. */
interface CaptureAddon {
  listDisplays(): NativeDisplay[];
}
const CAPTURE_ADDON = 'streamshare_capture.node';
let captureAddon: CaptureAddon | null | undefined;
function loadCaptureAddon(): CaptureAddon | null {
  if (captureAddon !== undefined) return captureAddon;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    captureAddon = require(
      app.isPackaged
        ? path.join(process.resourcesPath, CAPTURE_ADDON)
        : path.join(__dirname, '..', 'native', 'build', 'Release', CAPTURE_ADDON),
    ) as CaptureAddon;
  } catch (err) {
    // Once, at the first request: a missing addon is a permanent condition, not a transient one.
    console.error('stream-share: native capture addon unavailable, HDR detection is off', err);
    captureAddon = null;
  }
  return captureAddon;
}

/** Displays in HDR mode, or [] when the addon is missing. Never throws: this sits on the path of
 *  "open the source picker", which must keep working whatever the native side is doing. */
function nativeDisplays(): NativeDisplay[] {
  try {
    return loadCaptureAddon()?.listDisplays() ?? [];
  } catch (err) {
    console.error('stream-share: querying displays failed', err);
    return [];
  }
}

// Everything the picker grid needs, already serialisable (NativeImage doesn't cross IPC).
ipcMain.handle('ss:sources', async (event) => {
  // Defence in depth: only our own bundle may enumerate windows. A thumbnail of every open
  // window is exactly the kind of thing that must not become reachable from foreign content.
  if (!isInternalUrl(event.senderFrame?.url ?? '')) return [];
  // Our own window is capturable and picking it is an infinite mirror. getMediaSourceId() gives
  // the exact id desktopCapturer will report, so no name heuristic.
  const own = BrowserWindow.fromWebContents(event.sender)?.getMediaSourceId();
  const displays = screen.getAllDisplays();
  const native = nativeDisplays();
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
        // Whether THIS screen is in HDR mode right now — the switch that decides between the
        // native capture path and getDisplayMedia. Per source, not per machine: sharing the SDR
        // monitor of a machine that also has an HDR one must not take the native path.
        hdr: display ? (nativeDisplayFor(native, display)?.hdr ?? false) : false,
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

// --- per-app audio (WASAPI process loopback) ---

// The bare .node, loaded by absolute path. NOT `require('loopback-capture')`: its dist/index.cjs
// goes through the `bindings` package to find this same file, which would mean shipping a
// node_modules tree into the installer. electron-builder copies the single binary via
// extraResources instead (electron-builder.yml), keeping app.asar down to our own three files.
interface LoopbackAddon {
  LoopbackCapture: new () => {
    start(processId: number, includeProcessTree: boolean, cb: (chunk: Buffer) => void): void;
    startSystemAudio(cb: (chunk: Buffer) => void): void;
    stop(): void;
  };
}
type Capture = InstanceType<LoopbackAddon['LoopbackCapture']>;
/** One process tree to run a WASAPI session against — and, sent back, one live session. */
interface CaptureTarget {
  pid: number;
  name: string;
}

const ADDON_FILE = 'loopback_capture_addon.node';
let addon: LoopbackAddon | null = null;
function loadAddon(): LoopbackAddon {
  // A .node binary can only be loaded by require, and esbuild emits this file as CJS anyway —
  // an import would be rewritten and lose the runtime path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  addon ??= require(
    app.isPackaged
      ? path.join(process.resourcesPath, ADDON_FILE)
      : path.join(__dirname, '..', 'node_modules', 'loopback-capture', 'build', 'Release', ADDON_FILE),
  ) as LoopbackAddon;
  return addon;
}

// Every live session. Muting two or more apps means one WASAPI client per app left audible, so
// this is a list, not a slot — and every instance lands in it the moment it starts, because the
// only thing that can stop an orphan is this array.
let captures: Capture[] = [];
// Bumped by every call to ss:audio-capture AND by stopCapture, so a call still resolving its
// targets can tell it has been superseded and start nothing.
let captureEpoch = 0;

function stopCapture(): void {
  // Cancels anything in flight too. Without this, a reload during the ~240 ms lookup would clear
  // the list and the resolving call would then start sessions feeding a page that no longer has a
  // listener — nothing left holding them but the next call or app quit.
  captureEpoch++;
  for (const c of captures) {
    try {
      c.stop();
    } catch {
      // Already stopped, or the device went away. Nothing to recover — just don't take the app down.
    }
  }
  captures = [];
}

/** Apps the user could exclude, with their ROOT pid.
 *
 *  `MainWindowHandle -ne 0` is what makes this correct AND cheap: only the process owning a
 *  visible top-level window matches, which for a multi-process app is exactly the root — verified
 *  on Discord, whose windowed pid is the parent of its five other processes. No parent-walking.
 *  `tasklist /V` would do the same job but takes ~15 s (it resolves account names); this is
 *  ~240 ms. OutputEncoding is forced or non-ASCII window titles come back mojibake. */
/** Absolute path, never the bare name: CreateProcess searches the executable's directory and the
 *  CWD before PATH, so a planted powershell.exe would run from this privileged process. */
function powershellPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function listAudioApps(): Promise<AudioApp[]> {
  if (process.platform !== 'win32') return []; // WASAPI-only feature; don't spawn a shell for nothing
  const script =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
    '$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle }; ' +
    'ConvertTo-Json -Compress -InputObject @($p | Select-Object Id,ProcessName,MainWindowTitle)';
  try {
    const { stdout } = await execFile(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
    });
    return parseAudioApps(stdout, process.pid);
  } catch (err) {
    console.error('stream-share: listing audio apps failed', err);
    return [];
  }
}

ipcMain.handle('ss:audio-apps', async (event): Promise<AudioApp[]> => {
  if (!isInternalUrl(event.senderFrame?.url ?? '')) return []; // window titles leak documents, chats…
  return listAudioApps();
});

/** The app owning a captured window, found by its window handle.
 *
 *  Queried directly rather than looked up in `listAudioApps()`: that list is deduplicated by
 *  process name (one row per app), so a second window of an already-listed app would be missing
 *  from it — and a name-keyed lookup would then resolve the WRONG instance's tree.
 *  Null when the window isn't a process's main window, which is common: `MainWindowHandle` names
 *  one window per process, so a second top-level window (a Chrome popout, a second VS Code) has
 *  no match. Callers must fall back to full system audio and say so. */
async function appForWindow(hwnd: number): Promise<{ pid: number; name: string } | null> {
  if (process.platform !== 'win32') return null;
  const script =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
    `$p = Get-Process | Where-Object { [int64]$_.MainWindowHandle -eq ${hwnd} } | Select-Object -First 1; ` +
    'ConvertTo-Json -Compress -InputObject @($p | Select-Object Id,ProcessName)';
  try {
    const { stdout } = await execFile(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
    });
    const [app] = parseAudioApps(stdout, process.pid);
    return app ? { pid: app.pid, name: app.name } : null;
  } catch (err) {
    console.error('stream-share: resolving the window owner failed', err);
    return null;
  }
}

/** Replace the per-app capture, or stop it with `null`. See `setAudioCapture` in src/global.d.ts
 *  for the three specs and what the return value means.
 *
 *  Name for exclude and include, handle for the shared window, and that asymmetry is deliberate.
 *  A named app (Discord) auto-updates and restarts under a new pid — the name is what survives,
 *  and the panel re-arms on reopen. The shared window is one exact window, where a name would
 *  resolve the first instance of that executable and could capture the wrong one.
 *
 *  ponytail: no process-death watcher. Measured what happens when the target dies mid-capture:
 *  the WASAPI session survives and the rest of the system audio keeps flowing, so viewers never
 *  fall silent. Add polling only if that turns out to bite.
 *  ponytail: no cap on the number of sessions. Measured 16 concurrent ones — 5 ms to start all of
 *  them, 4 MB RSS, 3 ms to stop — against 8 windowed apps on a real desktop. Cap it if a machine
 *  ever shows up with an order of magnitude more. */
ipcMain.handle('ss:audio-capture', async (event, spec: unknown): Promise<CaptureTarget[] | null> => {
  if (!isInternalUrl(event.senderFrame?.url ?? '')) return null;
  // ipcMain.handle does NOT serialize, and there is a ~240 ms lookup below. Two quick clicks
  // would otherwise both reach start(), and only the second would be remembered — the first
  // sessions would stream on unstoppably, summing into the renderer and making a muted app
  // audible again, which is the one outcome this feature exists to prevent.
  const mine = ++captureEpoch;
  if (!spec || typeof spec !== 'object') {
    stopCapture(); // `null` is how the renderer asks for "stop everything"
    return null;
  }
  const { sourceId, exclude, include } = spec as { sourceId?: unknown; exclude?: unknown; include?: unknown };

  // Resolve EVERY target before stopping or starting anything, for two reasons. It leaves no await
  // between the starts below, so a second click — which bumps the epoch — cannot interleave and
  // strand half of this call's sessions. And it makes a refusal NON-DESTRUCTIVE: every `return
  // null` below happens with the previous capture still running, so the renderer's checkboxes stay
  // true instead of a failed click quietly un-muting everything.
  let targets: CaptureTarget[];
  let includeTree: boolean;
  if (typeof sourceId === 'string') {
    const hwnd = hwndFromSourceId(sourceId);
    const owner = hwnd === null ? null : await appForWindow(hwnd);
    if (!owner) return null;
    targets = [owner];
    includeTree = true;
  } else if (typeof exclude === 'string' && exclude) {
    const app = (await listAudioApps()).find((a) => a.name === exclude);
    if (!app) return null;
    targets = [{ pid: app.pid, name: app.name }];
    includeTree = false;
  } else if (Array.isArray(include)) {
    // One listing for the whole set: each costs a ~240 ms PowerShell spawn, and N of them would
    // also be N different snapshots of the process table.
    const byName = new Map((await listAudioApps()).map((a) => [a.name, a.pid]));
    targets = include.flatMap((n: unknown) => {
      const pid = typeof n === 'string' ? byName.get(n) : undefined;
      return pid === undefined ? [] : [{ pid, name: n as string }];
    });
    includeTree = true;
  } else {
    return null;
  }
  if (mine !== captureEpoch) return null;

  const sender = event.sender;
  const started: CaptureTarget[] = [];
  const replacing = captures;
  captures = []; // the old sessions are still running; they are stopped once this call commits
  for (const t of targets) {
    try {
      // Inside the try: a missing/incompatible .node throws here, and the handler must answer
      // rather than reject — the renderer's catch can't tell the two apart.
      const instance = new (loadAddon().LoopbackCapture)();
      captures.push(instance); // before start(), so a throw mid-start still leaves it stoppable
      // A chunk is tagged with the source it belongs to, so the renderer can schedule each one on
      // its own cursor. Under exclusion there is a single session and it carries everything BUT
      // the named app — tagging it with that app's name would read as its exact opposite.
      const key = includeTree ? t.name : 'system';
      // true = INCLUDE_TARGET_PROCESS_TREE (that app alone), false = EXCLUDE (everything but it).
      // Tree either way, which is what covers a Chromium app's separate audio-service child.
      instance.start(t.pid, includeTree, (chunk) => {
        // Delivered on the JS loop via a threadsafe function (not the native thread itself),
        // ~100×/s per audible session — the addon drops silent buffers, so a session for an app
        // that isn't making noise costs nothing. The window can still go away mid-stream, which
        // the listeners in createWindow cover.
        if (!sender.isDestroyed()) sender.send('ss:audio-chunk', key, chunk);
      });
      started.push(t);
    } catch (err) {
      console.error('stream-share: starting the per-app capture failed', err);
    }
  }
  // Nothing started when something was asked for = a refusal. Roll back to what was already
  // running rather than leaving the machine unmuted. An empty `targets` is different: it means
  // "capture nothing" (every app muted), and returning [] keeps the renderer on the silent
  // native track.
  if (!started.length && targets.length) {
    stopCapture();
    captures = replacing;
    return null;
  }
  for (const c of replacing) {
    try {
      c.stop();
    } catch {
      // Already stopped, or the device went away.
    }
  }
  return started;
});

// One-way: the renderer holds the display awake for as long as a session is live. No reply to
// wait for, so `on` rather than `handle`.
ipcMain.on('ss:wake-lock', (event, on: unknown) => {
  if (!isInternalUrl(event.senderFrame?.url ?? '')) return;
  setWakeLock(on === true);
});

// A native capture thread would outlive the window and hold the audio device. The power request is
// a per-process handle so exiting releases it anyway — this is belt and braces on an existing line.
app.on('before-quit', () => {
  stopCapture();
  setWakeLock(false);
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
