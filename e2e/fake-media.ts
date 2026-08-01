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
  // 4242 is the one whose owning process resolves (see setAudioCapture); the others stand in for
  // a window that is not its process's main window, where app-only sound is impossible.
  { id: 'window:4242:0', name: 'Elden Ring', kind: 'window', meta: '' },
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
      // The fake process table. A test mutates it to simulate an app launching, restarting under
      // a new pid, or minimising to tray. `Ghost` is listed but unresolvable (pid 0): the app that
      // quits between the listing and the click.
      (window as unknown as { __apps: unknown[] }).__apps = [
        { pid: 4444, name: 'Elden Ring', title: 'ELDEN RING' },
        { pid: 4001, name: 'Discord', title: '@someone - Discord' },
        { pid: 4002, name: 'Spotify', title: 'Spotify Premium' },
        { pid: 0, name: 'Ghost', title: 'about to exit' },
      ];
      // Explicitly null, not undefined: a refusal leaves `__audio` untouched, so before the first
      // successful capture the tests must still be able to read "nothing is running".
      (window as unknown as { __audio: unknown }).__audio = null;
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
          // Per-app audio. The PCM stream itself isn't faked — there is nothing to assert about it
          // in a browser — but the capture handshake drives the whole checkbox UI.
          //
          // `window.__apps` is the process table, MUTABLE from a test: an app can be added
          // (launched), removed (minimised to tray, which drops it from the real
          // `Get-Process | Where MainWindowHandle`) or given a new pid (restarted). `pid: 0` means
          // "listed but no longer resolvable" — the app that quits between the listing and the
          // click. `window.__audioFail` forces a refusal.
          //
          // `__audio` mirrors what the shell is actually running: null = the ordinary loopback
          // track, an object = live WASAPI sessions (empty `names` = a capture of nothing, i.e.
          // silence). A refusal leaves it untouched, because main resolves everything before it
          // stops what is live.
          listAudioApps: async () => (window as unknown as { __apps: unknown[] }).__apps,
          setAudioCapture: async (spec: { sourceId?: string; exclude?: string; include?: string[] } | null) => {
            const w = window as unknown as {
              __apps: Array<{ pid: number; name: string }>;
              __audioFail?: boolean;
              __audio?: { mode: string; names: string[]; pids: number[] } | null;
            };
            const pidOf = (n: string): number | undefined => w.__apps.find((a) => a.name === n && a.pid > 0)?.pid;
            const record = (mode: string, got: Array<{ pid: number; name: string }>) => {
              w.__audio = { mode, names: got.map((g) => g.name), pids: got.map((g) => g.pid) };
              return got;
            };
            if (!spec) { w.__audio = null; return null; }
            if (w.__audioFail) return null; // refused: whatever was running still is
            if (spec.sourceId) {
              // Only window:4242:* resolves to an owner — the others stand in for a window that
              // is not its process's main window, where app-only sound is impossible.
              if (!spec.sourceId.startsWith('window:4242:')) return null;
              return record('include', [{ pid: 4444, name: 'Elden Ring' }]);
            }
            if (spec.include) {
              const got = spec.include.flatMap((n) => {
                const pid = pidOf(n);
                return pid === undefined ? [] : [{ pid, name: n }];
              });
              return record('include', got); // possibly [] — a success, not a refusal
            }
            const pid = pidOf(spec.exclude!);
            if (pid === undefined) return null;
            return record('exclude', [{ pid, name: spec.exclude! }]);
          },
          // The renderer subscribes iff it considers a native capture live — which is also when it
          // routes viewers onto the native track instead of the loopback one. That decision is
          // invisible from the page otherwise, and it is the whole point of an empty include, so
          // the stub records it.
          onAudioChunk: () => {
            const w = window as unknown as { __chunkSub?: boolean };
            w.__chunkSub = true;
            return () => {
              w.__chunkSub = false;
            };
          },
        },
        configurable: true,
      });
    },
    [FAKE_SOURCES, opts] as const,
  );
}
