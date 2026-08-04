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

/** One display as the native addon reports it (see electron/native/src/addon.cc). Coordinates are
 *  PHYSICAL pixels; `hdr` is the compositor's live state, not the panel's capability. */
export interface NativeDisplay {
  deviceName: string;
  hdr: boolean;
  sdrWhiteNits: number;
  maxLuminanceNits: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The bits of an Electron `Display` this needs. `bounds` is in DIP; multiplying by `scaleFactor`
 *  gives the physical rectangle the addon speaks in. */
export interface DipDisplay {
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
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
 * Origin first, size second. Two displays cannot share an origin, whereas two identical monitors
 * share a size — matching on size alone would pick whichever came first and be wrong exactly half
 * the time on the most ordinary dual-monitor setup there is.
 */
export function nativeDisplayFor(displays: readonly NativeDisplay[], display: DipDisplay): NativeDisplay | null {
  const scale = display.scaleFactor || 1;
  const x = Math.round(display.bounds.x * scale);
  const y = Math.round(display.bounds.y * scale);
  // A pixel of slack: DIP→physical rounds, and a 150% scaled 1707-DIP bound comes back as 2560 or
  // 2561 depending on which way the division fell. Demanding equality would drop such a display.
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
  return displays.find((d) => near(d.left, x) && near(d.top, y)) ?? null;
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
    "script-src 'self' 'unsafe-inline'",
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
