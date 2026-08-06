import { type Page } from '@playwright/test';

// Replace the native screen-picker with a synthetic animated canvas stream, so the whole WebRTC
// path runs for real (RTCPeerConnection, ICE, encode) but headless and without a user gesture.
// Lives outside the specs because Playwright forbids importing one test file from another.
export async function fakeDisplayMedia(
  page: Page,
  opts: { sizes?: Array<[number, number]>; audio?: boolean; rejectFrom?: number } = {},
): Promise<void> {
  // `sizes` gives each successive capture its own dimensions (the last entry repeats). Needed to
  // exercise anything that reacts to the SOURCE height — the resolution cap in particular, whose
  // interesting case is switching from a small window to a big screen.
  //
  // `audio` hands back a real (silent oscillator) audio track when the caller asked for one. Off by
  // default deliberately: every capture in this suite requests system audio and has always got a
  // video-only stream back, so turning it on for everyone would put a system track through
  // AudioMixer in specs that are not about audio. The HDR path opts in — there, "the share is not
  // muted" is the assertion.
  await page.addInitScript(
    ([sizes, withAudio, rejectFrom]) => {
      let call = 0;
      navigator.mediaDevices.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions) => {
        // `rejectFrom` fails every call from that index on — the capture that goes wrong AFTER a
        // share is already running, which is the only way to test what happens to the old one.
        if (rejectFrom >= 0 && call >= rejectFrom) {
          call++;
          throw new DOMException('e2e: capture refused', 'NotAllowedError');
        }
        const [w, h] = sizes[Math.min(call++, sizes.length - 1)];
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        let hue = 0;
        setInterval(() => {
          if (!ctx) return;
          hue = (hue + 8) % 360;
          ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }, 66); // keep painting so the encoder has fresh frames
        const stream = canvas.captureStream(15);
        // Recorded because the native HDR path calls this for AUDIO ONLY and stops the video track
        // it is forced to ask for. Neither half is observable otherwise, and getting it wrong means
        // either a muted share or a second screen capture running for nothing.
        const entry = { audio: !!constraints?.audio, videoStopped: false };
        const w2 = window as unknown as { __gdm?: Array<typeof entry> };
        (w2.__gdm ??= []).push(entry);
        const video = stream.getVideoTracks()[0];
        const stop = video.stop.bind(video);
        video.stop = () => {
          entry.videoStopped = true;
          stop();
        };
        if (withAudio && constraints?.audio) {
          const audioCtx = new AudioContext();
          const dest = audioCtx.createMediaStreamDestination();
          audioCtx.createOscillator().connect(dest); // never started: a live track carrying silence
          stream.addTrack(dest.stream.getAudioTracks()[0]);
        }
        return stream;
      };
    },
    [opts.sizes ?? [[640, 360]], opts.audio ?? false, opts.rejectFrom ?? -1] as const,
  );
}

/**
 * Record native toasts into `window.__toasts` instead of showing them.
 *
 * `focused` drives `document.hasFocus()`, which is the gate host.ts checks. It has to be stubbed:
 * a Playwright run has two pages in two contexts and only one can hold the OS focus, so the real
 * value is a coin toss and the test would be flaky about the thing it is not even testing.
 *
 * Scope, so nobody reads more into a green suite than it says: this covers **which events notify**,
 * never that a toast reaches Windows. `Notification.permission` is not modelled at all — that was
 * measured by hand against the real shell (granted under app://, no prompt), and a packaged build
 * that stopped granting it would pass every test here. See docs/desktop.md § Contraintes Electron.
 */
export async function fakeNotifications(page: Page, opts: { focused?: boolean } = {}): Promise<void> {
  await page.addInitScript(([focused]) => {
    const w = window as unknown as { __toasts: string[] };
    w.__toasts = [];
    Object.defineProperty(document, 'hasFocus', { value: () => focused, configurable: true });
    Object.defineProperty(window, 'Notification', {
      value: class {
        constructor(title: string) {
          w.__toasts.push(title);
        }
      },
      configurable: true,
    });
  }, [opts.focused ?? false] as const);
}

/** Sources the fake desktop shell reports; `thumbnail`/`icon` stay tiny so the grid renders. */
const FAKE_SOURCES = [
  // Screen 1 is flagged HDR: the shell reports this per source, and a suite where nothing is ever
  // HDR could not tell "the flag is plumbed" from "the flag is always false". The SDR white level
  // rides along for the same reason — only the shell can read it, and the tone map needs it.
  // No device name: the shell keeps those, the page never sees one.
  { id: 'screen:0:0', name: 'Screen 1', kind: 'screen', meta: '2560×1440', hdr: true, sdrWhiteNits: 480, sdrWhiteMeasured: true },
  { id: 'screen:1:0', name: 'Screen 2', kind: 'screen', meta: '1920×1080', hdr: false, sdrWhiteNits: 80, sdrWhiteMeasured: true },
  // 4242 is the one whose owning process resolves (see setAudioCapture); the others stand in for
  // a window that is not its process's main window, where app-only sound is impossible.
  // It is also the HDR one: a window on an HDR screen takes the native path too, and the shell is
  // the only side that can know — desktopCapturer reports no display for a window at all. `meta`
  // stays empty: that column is the SCREEN's resolution, and a window is not its screen.
  { id: 'window:4242:0', name: 'Elden Ring', kind: 'window', meta: '', hdr: true, sdrWhiteNits: 480, sdrWhiteMeasured: true },
  { id: 'window:11:0', name: 'Google Chrome', kind: 'window', meta: '', hdr: false, sdrWhiteNits: 0, sdrWhiteMeasured: false },
  { id: 'window:12:0', name: 'Discord', kind: 'window', meta: '', hdr: false, sdrWhiteNits: 0, sdrWhiteMeasured: false },
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
 *
 * `nativeCapture` turns on the HDR path (see below). Absent, `canCaptureNative()` answers false and
 * every capture goes through getDisplayMedia, which is what the rest of the suite wants.
 */
export async function fakeNative(
  page: Page,
  opts: { delaysMs?: number[]; fail?: boolean; nativeCapture?: 'ok' | 'throw' | 'noport'; noSdrWhite?: boolean } = {},
): Promise<void> {
  await page.addInitScript(
    ([sources, { delaysMs = [0], fail = false, nativeCapture = null, noSdrWhite = false }]) => {
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

      // --- native HDR capture ---
      //
      // What the real shell does (electron/src/preload.ts): a C++ addon captures the screen in
      // scRGB, tone-maps it on the GPU, and the PRELOAD builds a VideoFrame per frame and
      // TRANSFERS it to the page over a MessagePort handed across by one synchronous
      // `window.postMessage`. Everything above that port is real code (src/lib/native-video.ts),
      // so imitating the port contract exercises the whole routing without an addon or Electron.
      //
      // Deliberately NOT modelled: the addon's own "capture already running", and the IPC wiring
      // (which listing main keeps, and when it drops it — covered in electron/src/config.test.ts).
      // The device names the SHELL holds. Deliberately not in the source payload: main keeps this
      // table and the page never sees one. HDR screens only, like the real table — the native path
      // is never offered for anything else, and a gate wider than the feature is a gate to close
      // again later.
      const DEVICE_BY_ID: Record<string, string> = {
        'screen:0:0': String.raw`\\.\DISPLAY1`,
        // A window resolves to a HANDLE, not a display name — WGC has a separate factory call for
        // each, and the shell is the only side that knows which the pick was.
        'window:4242:0': 'hwnd:4242',
      };
      const cap = window as unknown as {
        __native: {
          started: Array<{ device: string; sdrWhiteNits?: number; fps?: number }>;
          stopped: number;
          fps: number[];
          sdrWhite: number[];
        };
        /** The capture item went away and the addon says so. */
        __nativeClosed?: boolean;
        /** The frames stop while the addon keeps claiming everything is fine. */
        __nativeStall?: boolean;
        /** What the display under the capture reports — moved by a test to simulate a captured
         *  window being dragged to a screen with a different reference white. */
        __nativeWhite?: number;
        /** A captured window that is minimised: no frames, and NOT dead. */
        __nativeMinimized?: boolean;
      };
      cap.__native = { started: [], stopped: 0, fps: [], sdrWhite: [] };
      let framePort: MessagePort | null = null;
      let pump: ReturnType<typeof setInterval> | undefined;
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
            // `unknown`, not `string`: the source list is no longer all strings since `hdr` landed.
            return (sources as Array<Record<string, unknown>>).map((s) => ({ ...s, thumbnail: px, icon: null }));
          },
          // Explicit, not omitted: the suite exercises the getDisplayMedia path, and a fake that
          // returned true here would silently route every spec through the native branch.
          canCaptureNative: () => nativeCapture !== null,
          startNativeCapture: (sdrWhiteNits?: number, fps?: number) => {
            // The consent gate, resolved the way the shell resolves it: the caller says nothing
            // about WHICH display, the shell answers with the one the last confirmed pick approved.
            // A caller that never went through the picker gets nothing.
            const device = DEVICE_BY_ID[(window as unknown as { __picked?: string }).__picked ?? ''] ?? '';
            cap.__native.started.push({ device, sdrWhiteNits, fps });
            if (!device) throw new Error('e2e: no display was picked by the user');
            // Throw BEFORE the handover, like the real preload: everything that can refuse runs
            // before the port exists, so a refusal never leaves one behind.
            if (nativeCapture === 'throw') throw new Error('e2e: native capture refused');
            if (nativeCapture === 'noport') return; // the handover goes missing — the locked-picker case
            // Like the shell's closeFramePort(): a start with a session still open replaces it
            // rather than leaving a second pump posting into an abandoned port.
            clearInterval(pump);
            framePort?.close();
            const { port1, port2 } = new MessageChannel();
            framePort = port1;
            // 720p, not the 2560×1440 the picker advertises for this screen: the assertion that
            // matters is that the ladder reads the height of the frames actually arriving, and a
            // 1440p VideoFrame every 66 ms is 14 MB of copy per frame in headless for nothing.
            const canvas = document.createElement('canvas');
            canvas.width = 1280;
            canvas.height = 720;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.fillStyle = '#2563eb';
              ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
            // Synchronous, inside the call, exactly like the shell — native-video.ts registers its
            // listener first and would miss a handover posted any later.
            window.postMessage({ streamShare: 'frames' }, location.origin, [port2]);
            pump = setInterval(() => {
              // A dead capture stops producing. It does NOT close the port: WGC going away (HDR
              // switched off, monitor unplugged) is silent from the page's side, which is the whole
              // reason native-video.ts polls `closed`. `__nativeStall` is the nastier version — the
              // frames stop and the addon still reports itself healthy.
              if (cap.__nativeClosed || cap.__nativeStall || !framePort) return;
              // Microseconds, like the addon's `timestampUs` — the repeater adds to this value.
              const frame = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
              framePort.postMessage(frame, [frame]);
            }, 66);
          },
          setCaptureFps: (fps: number) => cap.__native.fps.push(fps),
          // `noSdrWhite` models an installer older than the web bundle: it can capture in HDR but
          // knows nothing about the reference white. The renderer must then hide the control rather
          // than offer a knob that does nothing — and rather than refuse HDR altogether, which is
          // what `canCaptureNative` does for a missing fps setter. See renderSdrWhite in host.ts.
          ...(noSdrWhite ? {} : { setSdrWhite: (nits: number) => cap.__native.sdrWhite.push(nits) }),
          stopNativeCapture: () => {
            cap.__native.stopped++;
            clearInterval(pump);
            framePort?.close();
            framePort = null;
            // The real addon does `stats_ = {}` at the end of Stop(), so `closed` goes back to
            // false. Without that here, a reader that consulted the stats AFTER stopping would
            // still see `closed` and the suite would go green on an ordering bug that shows the
            // wrong message in production.
            cap.__nativeClosed = false;
          },
          // Only `closed` is ever read (native-video.ts's repeater); the other twenty counters are
          // diagnostics with no caller in the page.
          nativeCaptureStats: () => ({
            closed: !!cap.__nativeClosed,
            // The display the capture is on, as the addon re-reads it. A test can move it to make
            // the page follow a window onto another screen.
            // A minimised window resolves to NO display in the real addon (MonitorFromWindow
            // returns null for an off-screen rect), so it reports nothing measured. Saying
            // otherwise here would leave the guard that keeps the divisor off zero untested.
            displaySdrWhiteNits: cap.__nativeMinimized ? 0 : (cap.__nativeWhite ?? 480),
            displaySdrWhiteMeasured: !cap.__nativeMinimized,
            minimized: !!cap.__nativeMinimized,
          }),
          selectSource: async (id: string) => {
            (window as unknown as { __picked?: string }).__picked = id;
          },
          // Every toggle is recorded, not just the last one: the bug that matters is a lock left
          // held after the session ends, which only shows up as a missing trailing `false`.
          setWakeLock: (on: boolean) => {
            const w = window as unknown as { __wakeLock: boolean[] };
            (w.__wakeLock ??= []).push(on);
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
