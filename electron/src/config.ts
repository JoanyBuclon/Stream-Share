// Pure configuration for the desktop shell — no electron import, so it runs under
// `node --test` without pulling in the electron binary. Consumed by main.ts (window origin,
// CSP, navigation) and mirrored by the `window.native.appOrigin` the preload injects into the
// renderer (read in src/lib/app.ts and src/lib/host.ts).

/** Production web origin the shell points at when no override is set. */
export const PROD_ORIGIN = 'https://stream.joanybuclon.com';

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
