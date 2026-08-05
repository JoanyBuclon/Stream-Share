// Loading the capture addon, in one place because TWO processes need it: main (for the per-source
// HDR flag in `ss:sources`) and the preload (for the capture itself). esbuild bundles each of them
// separately, so the CODE is duplicated in the two outputs — the point is that it can no longer
// DIVERGE. What diverges silently otherwise is the packaged path: an addon that resolves in dev and
// not once installed is a feature that only ever works on the developer's machine.
//
// Which is exactly what happened until this increment — electron-builder shipped no
// streamshare_capture.node at all, so every installed build took the catch below and lost HDR
// without a word. See electron-builder.yml extraResources, and `pnpm dist`.

import type { NativeDisplay } from './config.ts';

/**
 * A tone-mapped frame, pushed from the WGC thread. `data` is BGRA8, tightly packed.
 *
 * **`data` is REUSED between frames and is only valid for the duration of the callback.** The addon
 * hands back the same ArrayBuffer every time (allocating a fresh 14.7 MB per frame was measured at
 * ~880 MB/s of garbage). Copy it synchronously — `new VideoFrame(data, …)` does — and never keep,
 * queue, or transfer it. Transferring it detaches it, which the addon detects and recovers from,
 * but keeping it just means watching it change underneath you.
 */
export interface NativeFrame {
  readonly width: number;
  readonly height: number;
  readonly timestampUs: number;
  readonly data: ArrayBuffer;
}

export interface CaptureStats {
  frames: number;
  failed: number;
  empty: number;
  dropped: number;
  undelivered: number;
  skipped: number;
  closed: boolean;
  recreated: number;
  width: number;
  height: number;
  gapAvgMs: number;
  gapMaxMs: number;
  gpuAvgMs: number;
  gpuMaxMs: number;
  copyAvgMs: number;
  copyMaxMs: number;
  running: boolean;
}

export interface CaptureAddon {
  listDisplays(): NativeDisplay[];
  /** `onFrame` is optional: without it the session only keeps the last frame for `takeFrame`. */
  startCapture(deviceName: string, sdrWhiteNits?: number, onFrame?: (frame: NativeFrame) => void, fps?: number): void;
  /** 0 = uncapped. Applied before the tone map, so a capped frame costs nothing. */
  setFps(fps: number): void;
  /** The tone map's divisor, live. Takes effect on the next frame the display produces — which on
   *  a perfectly still screen is not immediately. A non-positive or non-finite value is ignored. */
  setSdrWhite(nits: number): void;
  stopCapture(): void;
  captureStats(): CaptureStats;
  takeFrame(): { width: number; height: number; data: ArrayBuffer };
}

const ADDON = 'streamshare_capture.node';

let cached: CaptureAddon | null | undefined;

/**
 * The addon, or null.
 *
 * Optional by construction. It is absent off Windows, absent when `pnpm build:native` has not been
 * run, and absent on any machine whose build failed — none of which may stop the app from sharing a
 * screen. Every caller treats "no addon" as "no display is HDR", which is what ships today.
 *
 * `dirname` differs per process only in theory (both bundles land in electron/out), but it is
 * passed in rather than read from a bundler-rewritten `__dirname` here.
 */
export function loadCaptureAddon(dirname: string, packaged: boolean, resourcesPath: string): CaptureAddon | null {
  if (cached !== undefined) return cached;
  const from = packaged ? `${resourcesPath}/${ADDON}` : `${dirname}/../native/build/Release/${ADDON}`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require(from) as CaptureAddon;
  } catch (err) {
    // Once, at the first request: a missing addon is a permanent condition, not a transient one.
    console.error('stream-share: native capture addon unavailable, HDR capture is off', err);
    cached = null;
  }
  return cached;
}
