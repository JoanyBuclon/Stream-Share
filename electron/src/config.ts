// Pure configuration for the desktop shell — no electron import, so it runs under
// `node --test` without pulling in the electron binary. Consumed by main.ts (window origin,
// CSP, navigation) and mirrored by the `window.native.appOrigin` the preload injects into the
// renderer (read in src/lib/app.ts and src/lib/host.ts).

/** Production web origin the shell points at when no override is set. */
export const PROD_ORIGIN = 'https://stream.joanybuclon.com';

/** The slice of Electron's `powerSaveBlocker` the toggle below needs, so it can be faked in a test
 *  that never boots Electron. */
export interface PowerBlocker {
  start(type: 'prevent-display-sleep'): number;
  stop(id: number): void;
}

/**
 * Hold at most ONE power-save blocker, by id.
 *
 * Ten lines, extracted here rather than left inline in main.ts, because its only symptom when wrong
 * is "the machine stopped sleeping" — no error, no UI, nothing the user could trace back to us. And
 * it has a measured trap one keystroke wide: `powerSaveBlocker.start()` returns **0** for the first
 * blocker, so a `if (!id)` guard would decide nothing is held and stack a new blocker on every
 * request, leaving all but the last unstoppable. Hence `=== null`, and hence a test.
 */
export function createWakeLockToggle(blocker: PowerBlocker): (on: boolean) => void {
  let id: number | null = null;
  return (on: boolean): void => {
    if (on) {
      if (id === null) id = blocker.start('prevent-display-sleep');
    } else if (id !== null) {
      blocker.stop(id);
      id = null;
    }
  };
}

/** The security-relevant slice of Electron's webPreferences. Named so the invariant below has
 *  something to be checked against. */
export interface RendererSecurity {
  preload: string;
  contextIsolation: boolean;
  nodeIntegration: boolean;
  sandbox: boolean;
}

/**
 * How the renderer is locked down. A function with a test, not four literals inline, because one of
 * the three flags is deliberately OFF and the other two are now load-bearing because of it.
 *
 * **`sandbox: false` is a decision, taken 2026-08-03, and it is not free.** The HDR capture addon
 * has to hand raw frames to the renderer, and measurement settled where it can live: Electron's IPC
 * tops out around 102 MB/s, while 1080p60 NV12 needs 187 — so a main-process addon would cap native
 * capture at 720p60 or 1080p30, i.e. *less fluid than the getDisplayMedia path it replaces*
 * (measured at 119 fps in 1080p). Running the addon in the preload removes the boundary entirely.
 *
 * What that costs, stated plainly: the renderer loses its OS sandbox. The page is not the vector —
 * it only ever loads our own bundle over app://, navigation is locked by isInternalUrl, and every
 * external link opens in the system browser. The vector is what the renderer *parses*: SDP, ICE
 * candidates and `control` messages arriving from arbitrary viewers over WebRTC.
 *
 * Which is exactly why the other two flags stop being defaults and become the last line: with the
 * sandbox off, `contextIsolation: false` or `nodeIntegration: true` would hand that same parser's
 * process full Node to the page's main world — and our CSP still carries `unsafe-inline`. Flipping
 * either is what this function exists to make loud instead of silent.
 */
export function rendererSecurity(preload: string): RendererSecurity {
  return { preload, contextIsolation: true, nodeIntegration: false, sandbox: false };
}

/** One display as the native addon reports it (see electron/native/src/addon.cc). Coordinates are
 *  PHYSICAL pixels; `hdr` is the compositor's live state, not the panel's capability. */
export interface NativeDisplay {
  deviceName: string;
  hdr: boolean;
  sdrWhiteNits: number;
  /** False means `sdrWhiteNits` is the 80-nit fallback, not a reading. The distinction matters:
   *  the tone map divides by it, and on a real HDR desktop the fallback is wrong by up to 6x. */
  sdrWhiteMeasured: boolean;
  maxLuminanceNits: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The bits of an Electron `Display` this needs. `bounds` is in DIP; multiplying by `scaleFactor`
 *  gives the physical rectangle the addon speaks in — except for the origin, which is why
 *  `nativeOrigin` is here too. See `nativeDisplayFor`. */
export interface DipDisplay {
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  /** The display's origin in PHYSICAL pixels, straight from Chromium's own `MONITORINFO` rather
   *  than re-derived from DIP.
   *
   *  Optional HERE only. Electron 43 types it `nativeOrigin: Point`, non-optional, and its prose
   *  caveat ("X11-like systems only") is contradicted by measurement — populated and correct on
   *  Windows (tools/display-match-probe.cjs). So the `?` is ours: this interface is structural so
   *  it can be exercised without Electron, and the DIP fallback in `nativeDisplayFor` is a test
   *  path rather than a production one. Note the fallback triggers on the property being ABSENT,
   *  not on `{x: 0, y: 0}` — which is the primary display's honest origin, and would send it down
   *  the fallback for nothing. */
  nativeOrigin?: { x: number; y: number };
}

/**
 * The native display a given Electron `Display` refers to, or null.
 *
 * Electron never exposes a Display's Windows device name, and DXGI never reports Electron's display
 * id, so the desktop rectangle is the only thing both sides know. Matching on it is the whole
 * reason this function exists.
 *
 * Extracted and tested because **its failure mode is silent**: return null for a screen that IS in
 * HDR and the app quietly stays on the clamped path, with a correct-looking picker and no error
 * anywhere. Nobody would find that from a bug report saying "colours are still washed out".
 *
 * Origin only. Two displays cannot share one, whereas two identical monitors share a size —
 * matching on size would pick whichever came first and be wrong exactly half the time on the most
 * ordinary dual-monitor setup there is.
 *
 * **`nativeOrigin` first, and the multiplication only as a fallback.** `bounds.x * scaleFactor` is
 * not a display's physical left, and the difference is not rounding: Electron lays the desktop out
 * in DIP SPACE, so a secondary display's DIP origin is the accumulated *scaled* width of everything
 * to its left. Two monitors, primary 3840×2160 at 150% and secondary 1920×1080 at 100%: Windows
 * puts the secondary at physical x=3840, Electron reports DIP x=2560, and 2560×1 = 2560. No match,
 * `hdr: false`, an HDR screen silently on the clamped path — on the setup this whole file exists to
 * serve. Sizes never drift that way (a display's own width IS scaled by its own factor), but sizes
 * cannot identify. `nativeOrigin` is Chromium's own `MONITORINFO` rectangle, so it is right by
 * construction and needs no arithmetic from us.
 */
export function nativeDisplayFor(displays: readonly NativeDisplay[], display: DipDisplay): NativeDisplay | null {
  const scale = display.scaleFactor || 1;
  const origin = display.nativeOrigin;
  const x = origin ? origin.x : Math.round(display.bounds.x * scale);
  const y = origin ? origin.y : Math.round(display.bounds.y * scale);
  // A pixel of slack: DIP→physical rounds, and a 150% scaled 1707-DIP bound comes back as 2560 or
  // 2561 depending on which way the division fell. Demanding equality would drop such a display.
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
  return displays.find((d) => near(d.left, x) && near(d.top, y)) ?? null;
}

/** A desktopCapturer id says which kind it is; nothing else has to be consulted. */
export const kindOf = (id: string): 'screen' | 'window' => (id.startsWith('screen:') ? 'screen' : 'window');

/** The bits of an Electron `Display` this needs beyond the rectangle. */
export interface PickerDisplay extends DipDisplay {
  id: number;
}

/** The bits of a `DesktopCapturerSource` this needs. The two images are structural rather than
 *  `NativeImage` so the mapping below can be tested without Electron — same trick as DipDisplay. */
export interface CapturerSource {
  id: string;
  name: string;
  display_id: string;
  thumbnail: { toJPEG(quality: number): { toString(encoding: 'base64'): string } };
  appIcon: { isEmpty(): boolean; toDataURL(): string } | null;
}

/** One capturable surface as the picker receives it. Note what is NOT here: the Windows device
 *  name. The renderer never learns it — see `approvedTargetFor`. */
export interface PickerSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  meta: string;
  hdr: boolean;
  /** Whether `hdr` is a READING or a default. False means the shell never resolved which output
   *  this source is on — the addon did not load, DXGI enumerated nothing, or the source matched no
   *  display — so `hdr: false` is what we fell back to, not what we measured.
   *
   *  The two were indistinguishable, and that was the last HDR blind spot: an installation whose
   *  capture addon is missing reports every source as SDR, takes the clamped path, and shows no
   *  chip, because the chip is derived from `hdr` too. Exactly the failure that shipped once with a
   *  missing `extraResources` entry — HDR silently absent, every counter green. */
  hdrKnown: boolean;
  sdrWhiteNits: number;
  sdrWhiteMeasured: boolean;
  thumbnail: string;
  icon: string | null;
}

/**
 * What the addon should capture. A screen is named by its DXGI device, a window by its handle —
 * WGC has a separate factory call for each, and nothing above main needs to know which.
 *
 * A window carries its owning `pid` as well, and that is not bookkeeping: **Windows recycles window
 * handles.** The listing is taken when the picker opens; by the time the user confirms, the window
 * they clicked may have closed and something else may hold its number. `IsWindow()` would happily
 * say yes, and we would capture a window nobody chose — with no OS prompt behind this path to catch
 * it. The pid is what tells the two apart. (The neighbouring paths do the same thing differently:
 * `getDisplayMedia` re-lists before confirming, and per-app audio re-resolves on every call.)
 */
export type NativeTarget = { deviceName: string } | { hwnd: number; pid: number };

/** What the picker gets, plus the id→target table the consent gate reads. */
export interface Listing {
  sources: PickerSource[];
  /** Every source that could be RESOLVED to something the addon can capture, by picker id — not
   *  the set the native path is offered for, which is `hdr` on each source and is decided
   *  separately. See where this is built for why the two came apart. Kept in main and NEVER sent to
   *  the renderer: the page picks a source, it does not name a display or a window handle. */
  devices: Map<string, NativeTarget>;
}

/**
 * Turn a raw desktopCapturer listing into what the picker renders.
 *
 * Pure, and extracted for that reason: this is where a screen becomes "HDR, with this reference
 * white", and every mistake in it is silent — a source that loses its display match keeps a
 * plausible tile and quietly stops offering the native path.
 *
 * It also produces `devices`, which is the ONLY place a picker id is associated with a Windows
 * device name. `ss:select-source` used to re-derive that association by rebuilding the id string
 * (`screen:${display.id}:0`) and matching it against the pick — and that never matched anything.
 * Measured on Windows / Electron 43: `desktopCapturer` reports `screen:0:0` and `screen:4:0` while
 * the Display ids are 3646719705 and 3701595930, so the middle segment is a device index and not
 * the display id at all. The consent gate therefore answered '' for every screen, `startNativeCapture`
 * refused every time, and **the native HDR path was unreachable in the app** — every share fell
 * back to getDisplayMedia with a console line for evidence. It only ever ran under
 * tools/native-track.cjs, which approves itself.
 */
export function pickerSources(
  raw: readonly CapturerSource[],
  displays: readonly PickerDisplay[],
  native: readonly NativeDisplay[],
  ownId: string | undefined,
  /** Which display a WINDOW is on, by device name, and which process owns it — the addon's
   *  `displayForWindow` / `windowPid`. Injected rather than called from in here so this stays pure
   *  and testable without Electron or the addon. The default answers "nowhere", which is what every
   *  non-Windows build reports. */
  forWindow: (hwnd: number) => { device: string | null; pid: number | null } = () => ({ device: null, pid: null }),
): Listing {
  const devices = new Map<string, NativeTarget>();
  const sources = raw
    .filter((s) => s.id !== ownId) // our own window is capturable, and picking it is an infinite mirror
    .map((s) => {
      const kind = kindOf(s.id);
      // display_id is documented as possibly empty — no match just means no resolution label. It is
      // also EMPTY FOR EVERY WINDOW (measured: 0 of 4), which is the whole reason sharing an app on
      // an HDR screen used to wash out: nothing tied a window to an output, so `hdr` was false and
      // the share fell back to the clamped path. A window is resolved through its handle instead.
      const display = displays.find((d) => String(d.id) === s.display_id);
      const hwnd = kind === 'window' ? hwndFromSourceId(s.id) : null;
      const win = hwnd === null ? { device: null, pid: null } : forWindow(hwnd);
      const output =
        kind === 'screen'
          ? (display && nativeDisplayFor(native, display)) || null
          : (win.device !== null && native.find((d) => d.deviceName === win.device)) || null;
      // Every source that can be NAMED, not only the HDR ones. This is the id→target table; it is
      // not the decision to offer HDR, which is `hdr` below and is unchanged.
      //
      // It was HDR-only, on the grounds that a gate wider than the feature is a gate to close again
      // later. The feature is now genuinely wider: a window picked while it sat on the SDR monitor
      // has to become approvable once it is dragged onto the HDR one, without a re-pick, and a
      // capture restarting after HDR was switched OFF needs the same. And the narrowness never
      // bought a capability barrier — `setDisplayMediaRequestHandler` already hands the renderer
      // full video of whatever `selectedSourceId` names, with no HDR condition and no OS prompt
      // behind it. Same single pick, same surface, a different codec path. What bounds this is the
      // pick, which is set only by `ss:select-source` and must be echoed back by the caller (see
      // `approvedTargetFor` and the `expectId` check in main.ts).
      //
      // A window still needs its pid resolved, or there is nothing to re-check the handle against
      // later — see NativeTarget.
      if (output) {
        if (hwnd === null) devices.set(s.id, { deviceName: output.deviceName });
        else if (win.pid !== null) devices.set(s.id, { hwnd, pid: win.pid });
      }
      return {
        id: s.id,
        name: s.name,
        kind,
        // getAllDisplays() reports DIP: a 2560×1440 monitor at 150% would read 1707×960, a
        // resolution the user has never seen. scaleFactor brings it back to physical pixels.
        // The addon's rectangle when we have it — those ARE physical pixels. The DIP fallback
        // rounds, and a 1707-DIP display at 150% comes out as "2561×1440", a resolution nobody has
        // ever seen on a box. Same reason nativeDisplayFor carries a pixel of slack.
        // Screens only. A window now resolves to an `output` too, and printing its size here would
        // label the "Discord" tile with the resolution of the MONITOR it happens to sit on.
        meta:
          kind !== 'screen'
            ? ''
            : output
              ? `${output.right - output.left}×${output.bottom - output.top}`
              : display
                ? `${Math.round(display.bounds.width * display.scaleFactor)}×${Math.round(display.bounds.height * display.scaleFactor)}`
                : '',
        // Whether THIS screen is in HDR mode right now — the switch that decides between the
        // native capture path and getDisplayMedia. Per source, not per machine: sharing the SDR
        // monitor of a machine that also has an HDR one must not take the native path. It doubles
        // as "main holds a device name for this source", which is what lets the renderer ask for
        // the native path without ever naming a display.
        hdr: output?.hdr ?? false,
        // …and whether that `false` is a reading or a shrug. See the field.
        hdrKnown: output !== null,
        // The tone map's divisor, carried alongside so the renderer never has to guess it. Only
        // meaningful when `sdrWhiteMeasured`; the 80 fallback is a plausible-looking number that
        // would be wrong by up to 6x.
        sdrWhiteNits: output?.sdrWhiteNits ?? 0,
        sdrWhiteMeasured: output?.sdrWhiteMeasured ?? false,
        // JPEG, not toDataURL()'s lossless PNG: a real Windows session has 30-60 windows, and
        // each one is a synchronous encode on the main thread plus base64 through IPC. The tile
        // is a lossy preview anyway. The icon keeps PNG — it needs the alpha channel.
        thumbnail: `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString('base64')}`,
        // appIcon is null for screens, and can be a non-null EMPTY image for some windows —
        // whose data URL would render as a broken <img>.
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      };
    });
  return { sources, devices };
}

/**
 * The one surface the renderer may capture natively — a screen's device name or a window's
 * handle — or null for "none".
 *
 * Read straight out of the listing the user picked from, so what is approved is by construction the
 * same screen the picker showed. An id that was never listed — a renderer that skipped the picker,
 * or one calling after the listing was invalidated — is refused, which costs the HDR path and
 * nothing else: getDisplayMedia has its own gate and does its own fresh enumeration.
 */
export function approvedTargetFor(
  listing: Listing | null,
  id: string | null,
  /** Re-reads the owning process of a window handle, right now. See NativeTarget for why a handle
   *  alone is not enough. Screens skip it: a DXGI device name does not get recycled under us. */
  pidOf: (hwnd: number) => number | null = () => null,
): NativeTarget | null {
  const target = listing?.devices.get(id ?? '') ?? null;
  if (!target || !('hwnd' in target)) return target;
  // The window that was listed may have closed since, and its handle may now belong to something
  // the user never saw. Same pid, same window; anything else is refused rather than guessed at.
  return pidOf(target.hwnd) === target.pid ? target : null;
}

/** An app the user could exclude from the shared audio. `pid` is the ROOT process — WASAPI
 *  excludes a process *tree*, and a Chromium app renders its audio in a child service process. */
export interface AudioApp {
  pid: number;
  name: string;
  title: string;
}

/** The window handle inside a `desktopCapturer` window id (`window:<HWND>:<n>`), or null for a
 *  screen source or anything unparseable. Verified: that middle segment matches a process's
 *  `MainWindowHandle`, which is how a captured window is traced back to the app that plays its
 *  sound (6/6 open windows). Only the format is parsed here — the lookup lives in main.ts, which
 *  is the side that holds the authoritative source id. */
export function hwndFromSourceId(id: string): number | null {
  const [kind, handle] = id.split(':');
  if (kind !== 'window') return null;
  const n = Number(handle);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Parse the process list PowerShell hands back (see listAudioApps in main.ts).
 *
 *  Everything here is defensive on purpose: the payload is whatever a shell produced, and
 *  `ConvertTo-Json` collapses a single result to an object instead of a one-element array. Our
 *  own process is dropped — excluding StreamShare's own tree would mute the very thing that
 *  cannot be making noise, and picking it is only ever a mistake. */
export function parseAudioApps(json: string, ownPid: number): AudioApp[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const rows: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const apps: AudioApp[] = [];
  // Two windows of the same app (two Chrome profiles, two Notepads) are two root pids under one
  // name. One row per name, and the first pid wins: the checkbox UI is keyed on the name, so a
  // second row would offer no way to tell the two apart and would silence whichever the lookup
  // happened to find. Documented as a real limitation rather than papered over.
  // (Running several sessions at once is now possible, so a per-instance row is representable —
  // it just isn't nameable in the panel. That is the blocker, not the API.)
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { Id, ProcessName, MainWindowTitle } = row as Record<string, unknown>;
    if (typeof Id !== 'number' || !Number.isInteger(Id) || Id <= 0 || Id === ownPid) continue;
    if (typeof ProcessName !== 'string' || !ProcessName || seen.has(ProcessName)) continue;
    seen.add(ProcessName);
    apps.push({ pid: Id, name: ProcessName, title: typeof MainWindowTitle === 'string' ? MainWindowTitle : '' });
  }
  // Stable, name-ordered so the list doesn't reshuffle between two openings of the panel.
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/** Web origin to target: env override (dev/staging) else production. */
export function resolveAppOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.SS_APP_ORIGIN?.trim() || PROD_ORIGIN;
}

/** WS origin (scheme+host) derived from the app origin: https→wss, http→ws. Used for the CSP
 *  connect-src and for the Origin-rewrite match pattern in main.ts. */
export function wsOrigin(appOrigin: string): string {
  const u = new URL(appOrigin);
  return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
}

/** CSP for the packaged app: mirrors nginx-security-headers.conf, but connect-src must name the
 *  signaling socket explicitly — under app:// the WS is cross-origin, so 'self' would block it. */
export function contentSecurityPolicy(appOrigin: string): string {
  return [
    "default-src 'self'",
    `connect-src 'self' ${wsOrigin(appOrigin)}`,
    "media-src 'self' blob:",
    // No 'unsafe-inline' here, and it is not an aspiration — the build emits none. Measured on
    // dist/index.html and dist/download/index.html: zero <script> with a body, zero on* handlers.
    // Astro's only script is external and content-hashed. Carrying the permission bought nothing
    // and cost the difference between an XSS that is contained and one that executes — in the one
    // renderer that deliberately runs without an OS sandbox (see rendererSecurity).
    "script-src 'self'",
    // 'unsafe-inline' STAYS here, and removing it would break the page: Astro emits a real inline
    // <style> block (2511 bytes, the @font-face declarations) and viewer.ts writes element .style
    // directly. Verified before touching the line above — the two directives are not interchangeable.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** In-app navigation is confined to our bundled content; anything else opens in the system
 *  browser (an external page must never load with the preload attached). True only for app://. */
export function isInternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'app:';
  } catch {
    return false;
  }
}

/** Schemes the shell will hand to `shell.openExternal`. Everything else is dropped in silence.
 *
 *  `http:` as well as `https:` because a dev/staging shell runs against an http origin
 *  (`SS_APP_ORIGIN=http://localhost:4321`), and `mailto:` because that is the one non-web scheme
 *  the product has any reason to open. */
const EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

/**
 * Whether a URL may be handed to `shell.openExternal`.
 *
 * **"Not internal" was being treated as "safe to open", and those are not the same set.**
 * `isInternalUrl` answers only "is this app://", so `file:`, `smb:`, `ms-msdt:` and every
 * third-party protocol handler installed on the machine fell through to `openExternal` — where
 * `file:///C:/…/payload.exe` is not a navigation, it is an execution, performed by us with no
 * prompt.
 *
 * It matters here more than in a typical Electron app, and the reason is written two functions up:
 * `rendererSecurity` turns the OS sandbox OFF so the HDR addon can live in the preload, and names
 * the vector — what the renderer *parses*: SDP, ICE candidates and `control` messages from
 * arbitrary viewers. This is the exit that vector would reach for. An allow-list is what closes it;
 * a deny-list of known-bad schemes would not, since the interesting ones are whatever happens to be
 * registered on the victim's machine.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false; // unparseable is not openable
  }
}
