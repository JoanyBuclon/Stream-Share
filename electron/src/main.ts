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
  nativeImage,
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
  safeExternalUrl,
  createWakeLockToggle,
  kindOf,
  pickerSources,
  approvedTargetFor,
  rendererSecurity,
  type AudioApp,
  type NativeDisplay,
  type NativeTarget,
  type Listing,
} from './config.ts';
import { loadCaptureAddon, type CaptureAddon } from './native-addon.ts';

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
// Single-window app: one selection for the whole process is enough — and the same goes for the
// listing below, more so: a second window listing its sources would overwrite the table the first
// one's consent is read from. Per-webContents state would be required the day a second window can
// capture.
let selectedSourceId: string | null = null;
/** The last thing the picker was shown, with the capture targets that never left main. The native
 *  capture path's consent gate reads from here — see `approvedTargetFor`. */
let lastListing: Listing | null = null;
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
    // Deliberately not spelled out here: the three flags form one invariant (sandbox is off so the
    // HDR addon can run in the preload, which makes the other two load-bearing). config.ts holds
    // the reasoning and a test that fails if any of them moves.
    webPreferences: rendererSecurity(path.join(__dirname, 'preload.cjs')),
  });

  // In-app navigation stays within our bundled content; every external link opens in the
  // system browser (it must never load with the privileged preload attached).
  //
  // Three outcomes, not two, and the third is the one that was missing: internal → allowed here,
  // external over an allow-listed scheme → system browser, ANYTHING ELSE → dropped. `isInternalUrl`
  // only answers "is this app://", so treating its negation as "safe to open" handed `file:`,
  // `smb:` and every registered protocol handler straight to `openExternal`. See `safeExternalUrl`.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The RETURNED href, never the raw string — see safeExternalUrl for the gap between them.
    const external = isInternalUrl(url) ? null : safeExternalUrl(url);
    if (external) void shell.openExternal(external);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    // preventDefault FIRST and unconditionally: a navigation we refuse to open externally is still
    // a navigation we must refuse to perform. Returning early before this line would have let the
    // window itself travel to the very URL we just judged unsafe.
    event.preventDefault();
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
  });

  // The native AUDIO capture and the wake lock must not outlive the page that asked for them.
  // (Native VIDEO capture is not main's to stop — it runs in the preload and is torn down by the
  // addon's own env cleanup hook when the renderer environment goes away. Saying "native capture"
  // here without that distinction made it look like main owned both.)
  // Registered here, once: doing it
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
    // The consent goes with the page that gave it. Without this, a reload — or a renderer that
    // navigated somewhere and came back — could start a native capture of the display picked in a
    // session that is over, without ever showing the picker.
    selectedSourceId = null;
    lastListing = null;
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
  watchDisplayChanges();
  // Main's addon instance is a different process from the preload's, so it has its own cold start:
  // ~115 ms (device, IsSupported, two shader compilations) the FIRST time it captures anything, and
  // that first time is now the picker re-shooting an HDR tile. Paid here instead — but AFTER first
  // paint, not inline: this is synchronous C++ on main's JS thread, the same thread that answers
  // the renderer's synchronous `ss:config`, so running it next to createWindow() would stall the
  // window coming up. Best effort; failing only means the picker pays what it used to.
  setTimeout(() => captureAddon()?.warmUpCapture?.(), 0);

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
  // `packaged` is here because the preload loads the capture addon itself and needs to know where
  // to look for it — `app.isPackaged` is main-only, and guessing from `__dirname` is how a build
  // works in dev and not once installed.
  event.returnValue = { appOrigin, packaged: app.isPackaged };
});

// --- native capture addon (HDR) ---


/** Displays in HDR mode, or [] when the addon is missing. Never throws: this sits on the path of
 *  "open the source picker", which must keep working whatever the native side is doing. */
const captureAddon = () => loadCaptureAddon(__dirname, app.isPackaged, process.resourcesPath);

function nativeDisplays(): NativeDisplay[] {
  try {
    return captureAddon()?.listDisplays() ?? [];
  } catch (err) {
    console.error('stream-share: querying displays failed', err);
    return [];
  }
}

// Everything the picker grid needs, already serialisable (NativeImage doesn't cross IPC). The
/**
 * Re-shoot the tiles of HDR screens through the addon, because Chromium's are burnt.
 *
 * Measured on the same screen with the same content, seconds apart: the desktopCapturer thumbnail
 * has 30-53% of its pixels with a channel pinned at 255 and a mean luma of 122-189; the addon's
 * tone-mapped readback has 0% at the ceiling and a mean of 70-84. That is the same [0,1] clamp
 * getDisplayMedia applies, so the highlight detail is already gone — no amount of scaling in the
 * renderer brings it back, which is why this has to be a second capture rather than a filter.
 *
 * Screens only: a WINDOW on an HDR screen measured clean (max 253, nothing at the ceiling), because
 * desktopCapturer grabs the window's own SDR surface rather than the composited HDR readback. The
 * condition is written as `hdr && kind === 'screen'` rather than by kind alone so that widening it
 * to a genuinely HDR app one day is a single clause.
 *
 * Best effort throughout: the picker must list whatever the native side is doing, so every failure
 * keeps Chromium's thumbnail and nothing rejects.
 */
let shooting = false; // one at a time: g_capture is a singleton in main too
async function tonemappedThumbnails(listing: Listing, sdrCorrection: number): Promise<void> {
  const addon = captureAddon();
  // `shooting` matters because the picker can be dismissed and reopened during the 300-550 ms
  // listing (source-picker.ts says so): two overlapping runs would have one stopCapture() kill the
  // other's session, or takeFrame() hand the wrong screen's pixels to a tile.
  if (!addon || shooting) return;
  shooting = true;
  // ONE budget for the whole listing, not one per screen. A still screen legitimately produces
  // nothing and costs the full wait, so per-screen ceilings multiply: three idle HDR panels would
  // have added 1.2 s to a listing the docs already call 300-550 ms, with the picker showing nothing
  // until it resolved. Whatever is left over keeps Chromium's tile, which is the pre-existing
  // behaviour and never worse than it.
  const deadline = Date.now() + 500;
  try {
    for (const source of listing.sources) {
      if (!source.hdr || source.kind !== 'screen') continue;
      const target = listing.devices.get(source.id);
      if (!target || !('deviceName' in target)) continue;
      // PER SCREEN, not around the loop: one display that refuses (a driver that dislikes a second
      // session, an output unplugged between the listing and here) must cost that tile its tone map
      // and nothing else. Wrapping the loop instead let the first failure skip every screen after
      // it — invisible with the single HDR panel this was written on.
      try {
        // fps 1: one tone-mapped frame instead of ~25. The named scenario is the host opening the
        // picker DURING a share, where the alternative is a second full-rate 1440p tone map running
        // against the live one. The cap is applied before the GPU work, so the rest costs nothing.
        //
        // Times the host's correction, exactly as the share computes it (host.ts's reference-white
        // control). Fixing only the clipping and leaving the exposure would have been half a fix:
        // that slider exists BECAUSE the reported white can be wrong by up to 6x, so a tile at the
        // raw value carries the very error the host moved it to cancel.
        const base = source.sdrWhiteMeasured ? source.sdrWhiteNits : 80;
        addon.startCapture(target.deviceName, Math.round(base * sdrCorrection), undefined, 1);
        const frame = await firstFrame(addon, deadline);
        if (!frame) continue; // WGC is change-driven: a perfectly still screen owes us nothing
        const shot = nativeImage
          // Safe to hand straight over: takeFrame memcpys into a fresh ArrayBuffer rather than
          // exposing the reused push buffer that native-addon.ts warns about, and the addon's BGRA8
          // is the byte order createFromBitmap wants on Windows.
          .createFromBitmap(Buffer.from(frame.data), { width: frame.width, height: frame.height })
          // Width only — pinning both axes distorts anything that is not 16:9.
          .resize({ width: 320 });
        source.thumbnail = `data:image/jpeg;base64,${shot.toJPEG(70).toString('base64')}`;
      } catch (err) {
        console.error(`stream-share: no tone-mapped tile for ${source.name}, keeping the clamped one`, err);
      } finally {
        // Runs on the `continue` above as well, which is the point: a screen that produced nothing
        // must not leave its session open for the next iteration to trip over.
        addon.stopCapture();
      }
    }
  } finally {
    // No catch out here any more — each screen owns its own. This exists solely so `shooting` is
    // released even if something unforeseen escapes the loop, because a stuck flag would silently
    // disable tone-mapped tiles for the rest of the session.
    shooting = false;
  }
}

/** Poll for the one frame the capture above was started for, until the listing's shared deadline. */
async function firstFrame(addon: CaptureAddon, deadline: number): Promise<ReturnType<CaptureAddon['takeFrame']> | null> {
  // Look BEFORE sleeping: this is additive on the picker's critical path and sleeping first charged
  // every screen 40 ms for a frame that may already be sitting there. On this HDR desktop one lands
  // in well under 100 ms.
  while (Date.now() < deadline) {
    const frame = addon.takeFrame();
    // BOTH, and not `if (frame)`: TakeFrame moves the pixel vector out but leaves width/height set,
    // so a second poll after a successful one reports a size with no bytes behind it.
    if (frame.width && frame.data.byteLength) return frame;
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

// mapping itself is pure and lives in config.ts — this is the IO around it.
ipcMain.handle('ss:sources', async (event, sdrCorrection: unknown) => {
  // Defence in depth: only our own bundle may enumerate windows. A thumbnail of every open
  // window is exactly the kind of thing that must not become reachable from foreign content.
  if (!isInternalUrl(event.senderFrame?.url ?? '')) return [];
  // Our own window is capturable and picking it is an infinite mirror. getMediaSourceId() gives
  // the exact id desktopCapturer will report, so no name heuristic.
  const own = BrowserWindow.fromWebContents(event.sender)?.getMediaSourceId();
  const sources = await desktopCapturer.getSources({
    types: SOURCE_TYPES,
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  // Kept for the consent gate, which reads the device name of whatever the user then picks out of
  // THIS listing rather than deriving it a second time. Only the `sources` half crosses IPC.
  // The addon resolves a window handle to the display it sits on; nothing else can, which is why
  // sharing an app on an HDR screen took the clamped path until now.
  const addon = captureAddon();
  const listing = pickerSources(sources, screen.getAllDisplays(), nativeDisplays(), own, (hwnd) => ({
    device: addon?.displayForWindow(hwnd) ?? null,
    pid: addon?.windowPid(hwnd) ?? null,
  }));
  lastListing = listing;
  // A LOCAL, not `lastListing`, and that is load-bearing now that there is an await below: the
  // picker can be dismissed and reopened mid-listing, and a second call would reassign the global
  // while this one is suspended — so this call would go on to return the OTHER listing's sources.
  // Harmless today because the consent gate reads the global too, but only by accident.
  //
  // After the pure mapping, never inside it: config.ts stays testable without a GPU. The correction
  // is validated here rather than trusted — it crosses IPC, and it ends up multiplying a divisor.
  const factor = typeof sdrCorrection === 'number' && sdrCorrection > 0 && sdrCorrection <= 8 ? sdrCorrection : 1;
  await tonemappedThumbnails(listing, factor);
  return listing.sources;
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
ipcMain.handle('ss:select-source', (event, id: unknown) => {
  // Shape-checked, not just typed: the empty string is a string AND falsy, so a bare
  // `typeof id === 'string'` would let `selectSource('')` through as "nothing selected".
  selectedSourceId =
    typeof id === 'string' && (id.startsWith('screen:') || id.startsWith('window:')) ? id : null;
  if (!isInternalUrl(event.senderFrame?.url ?? '')) selectedSourceId = null;
});

/**
 * What the renderer may capture natively, for the source it says it is capturing. The native path
 * does not go through setDisplayMediaRequestHandler — it drives the addon directly — so this is its
 * consent gate. See `approvedTargetFor`.
 *
 * **`expectId` is the caller naming the source it believes it holds, and it must equal the pick.**
 * Not ceremony. `selectedSourceId` moves the instant the picker confirms, while the capture behind
 * it can still fail — the host dismisses the getDisplayMedia prompt, the window closed since the
 * listing — leaving main approving a source the renderer never committed to. Harmless only while
 * every native start sat inside the click that made the pick. It stops being harmless the moment
 * one is started off a TIMER (the recovery restart, the HDR watcher): main would hand back the
 * refused source and it would be swapped into a live share with no click anywhere, relabelling the
 * stage on its way in. Echoing the id ties the two sides to the same source.
 *
 * One function for both replies below, so the check cannot drift between them.
 */
function approvedFor(frameUrl: string | undefined, expectId: unknown): NativeTarget | null {
  if (!isInternalUrl(frameUrl ?? '')) return null;
  if (typeof expectId !== 'string' || expectId !== selectedSourceId) return null;
  // The pid is re-read HERE, not trusted from the listing: that is the whole point of storing it.
  return approvedTargetFor(lastListing, selectedSourceId, (hwnd) => captureAddon()?.windowPid(hwnd) ?? null);
}

/** Reply to `ss:approved-device`: the ONE surface the preload may capture natively. */
ipcMain.on('ss:approved-device', (event, expectId: unknown) => {
  event.returnValue = approvedFor(event.senderFrame?.url, expectId);
});

/**
 * Reply to `ss:picked-hdr`: is the picked source on an HDR display RIGHT NOW, and at what white?
 *
 * The listing's `hdr` flag is a SNAPSHOT taken when the picker opened, and two ordinary things
 * invalidate it without anything being re-listed: a window dragged from the SDR monitor onto the
 * HDR one (desktopCapturer reports no display for a window at all, so only the addon can see it),
 * and HDR being switched on under a screen that was SDR when it was picked. Both left the share on
 * the clamped path for ever. This is what the renderer polls to find out — and it is also where a
 * capture being restarted reads the white, because with no session running the addon resolves no
 * display and `captureStats()` reports nothing measured.
 */
ipcMain.handle('ss:picked-hdr', (event, expectId: unknown) => {
  const target = approvedFor(event.senderFrame?.url, expectId);
  if (!target) return null;
  const addon = captureAddon();
  // A window is resolved through its HANDLE, live: which display it is on is the whole question.
  const device = 'hwnd' in target ? (addon?.displayForWindow(target.hwnd) ?? null) : target.deviceName;
  const display = device === null ? undefined : nativeDisplays().find((d) => d.deviceName === device);
  if (!display) return null; // minimised, gone, or an output that vanished — no verdict, not a false one
  return { hdr: display.hdr, sdrWhiteNits: display.sdrWhiteNits, sdrWhiteMeasured: display.sdrWhiteMeasured };
});

/**
 * A monitor came or went, so both the listing and the PICK are retired.
 *
 * The listing must not outlive the arrangement it described: device names are SLOT names, and after
 * an unplug `\\.\DISPLAY2` can be a different panel than the one whose tile the user clicked.
 * Dropping the pick with it is the other half — the picker re-lists as soon as it opens, before any
 * click, and the old id would then be approved against the new arrangement.
 *
 * **Not on `display-metrics-changed`, and that is now load-bearing rather than a nicety.** The set
 * of displays is unchanged there, so every id in the table still names the same panel — which is
 * exactly the reason the pick already survived it. Dropping the LISTING on the same event was the
 * inconsistent half: it left the pick alive with nothing to approve it against, so a native capture
 * could not be restarted after a mode change without the host reopening the picker. And a mode
 * change is precisely what the recovery in host.ts exists to survive. Measured
 * (tools/hdr-toggle-recovery.cjs): the only event this fires is `display-metrics-changed`.
 * Staleness in the listing's `hdr` flags is handled deliberately now, by the watcher in host.ts.
 */
const forgetPick = (): void => {
  lastListing = null;
  selectedSourceId = null;
};

/** Subscribed from `whenReady`, never at module scope: touching `screen` before the `ready` event
 *  THROWS, and an exception in the entry module means an error dialog and no window at all. Listed
 *  one by one rather than in a loop — each event has its own listener signature, and a union
 *  matches no overload. */
function watchDisplayChanges(): void {
  screen.on('display-added', forgetPick);
  screen.on('display-removed', forgetPick);
}

// Decision: close = quit. No tray, no background — including on macOS, against its usual
// convention, since the app is Windows-first and host-only.
app.on('window-all-closed', () => {
  app.quit();
});
