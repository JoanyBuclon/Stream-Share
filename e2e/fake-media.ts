import { type Page } from '@playwright/test';

// Replace the native screen-picker with a synthetic animated canvas stream, so the whole WebRTC
// path runs for real (RTCPeerConnection, ICE, encode) but headless and without a user gesture.
// Lives outside the specs because Playwright forbids importing one test file from another.
export async function fakeDisplayMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      let hue = 0;
      setInterval(() => {
        if (!ctx) return;
        hue = (hue + 8) % 360;
        ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }, 66); // keep painting so the encoder has fresh frames
      return canvas.captureStream(15);
    };
  });
}

/** Sources the fake desktop shell reports; `thumbnail`/`icon` stay tiny so the grid renders. */
const FAKE_SOURCES = [
  { id: 'screen:0:0', name: 'Screen 1', kind: 'screen', meta: '2560×1440' },
  { id: 'screen:1:0', name: 'Screen 2', kind: 'screen', meta: '1920×1080' },
  { id: 'window:11:0', name: 'Google Chrome', kind: 'window', meta: '' },
  { id: 'window:12:0', name: 'Discord', kind: 'window', meta: '' },
];

/**
 * Pretend the page runs inside the Electron shell, so the desktop source picker takes over from
 * `getDisplayMedia`'s browser prompt. The picker markup ships in the web build, so everything but
 * the IPC is the real code path.
 *
 * `delaysMs` sets the latency of each successive `listSources` call (the real one measures
 * ~300-550 ms); the last entry repeats. Per-call rather than a single value so a test can make an
 * EARLIER call resolve after a later one — the ordering the staleness guard exists for, and which
 * equal delays can never produce. `fail` makes every call reject.
 */
export async function fakeNative(page: Page, opts: { delaysMs?: number[]; fail?: boolean } = {}): Promise<void> {
  await page.addInitScript(
    ([sources, { delaysMs = [0], fail = false }]) => {
      const px =
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      let call = 0;
      Object.defineProperty(window, 'native', {
        value: {
          // The signaling lives on :8080 in dev; app.ts derives the socket from this origin.
          appOrigin: 'http://localhost:8080',
          listSources: async () => {
            const delays = delaysMs as number[];
            const n = call++;
            await new Promise((r) => setTimeout(r, delays[n] ?? delays[delays.length - 1]));
            // Record completion so a test can await a specific call instead of guessing a
            // timeout — Playwright's own click latency on a <dialog> runs to ~1 s here, which
            // makes any "wait long enough" race unreliable.
            const w = window as unknown as { __listed: number[] };
            (w.__listed ??= []).push(n);
            if (fail) throw new Error('e2e: listSources refused');
            return (sources as Array<Record<string, string>>).map((s) => ({ ...s, thumbnail: px, icon: null }));
          },
          selectSource: async (id: string) => {
            (window as unknown as { __picked?: string }).__picked = id;
          },
        },
        configurable: true,
      });
    },
    [FAKE_SOURCES, opts] as const,
  );
}
