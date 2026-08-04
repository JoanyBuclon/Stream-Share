// G3: what does a frame cost to cross from the preload into the page?
//
// The HDR addon runs in the preload (that is what `sandbox: false` bought us — see
// docs/desktop.md). But `contextIsolation: true` is still on, deliberately, so the preload and the
// page are two V8 contexts and every value between them is STRUCTURED-CLONED. No process boundary,
// so this is not the ~102 MB/s IPC ceiling G2 measured — but it is not free either, and a frame is
// 8.3 MB at 1080p, 14.7 at 1440p. At 60 fps that is 498 and 885 MB/s of pure copying.
//
// Measuring before designing, because the answer changes the design: fast enough and the renderer
// just receives bytes; too slow and the frames have to be produced somewhere the page can see them.
//
// Each phase runs as its own executeJavaScript with its own timeout. That is not tidiness: the
// transfer phase wedged the renderer's main thread hard enough that an in-page setTimeout never
// fired, and a single script would have lost the clone measurements with it.
//
// Needs the dev server (`astro dev --background`): MediaStreamTrackGenerator wants a secure
// context, and a data: URL is an opaque origin. Run from electron/:
//   pnpm exec electron ../tools/bridge-bench.cjs
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const OUT = path.join(__dirname, 'bridge-bench.json');
const PAGE = process.env.SS_BENCH_URL || 'http://localhost:4321/';

/** What the isolated world has at all — an absent API and a broken one look identical otherwise. */
const PROBE = `JSON.stringify(window.bench.probe())`;

const CLONE = `(() => {
  const SIZES = [
    { label: '1080p BGRA', bytes: 1920 * 1080 * 4 },
    { label: '1440p BGRA', bytes: 2560 * 1440 * 4 },
  ];
  const ITER = 60;
  const time = (fn) => {
    fn(); // warm up: first call pays for JIT and the first allocation of that size
    const t0 = performance.now();
    for (let i = 0; i < ITER; i++) fn();
    return (performance.now() - t0) / ITER;
  };
  return JSON.stringify(SIZES.map(({ label, bytes }) => {
    // Baseline: the same allocation entirely inside the page, so the crossing can be separated
    // from the cost of producing the bytes at all.
    const local = time(() => new Uint8Array(bytes));
    const alloc = time(() => window.bench.alloc(bytes));
    const reuse = time(() => window.bench.reuse(bytes));
    const mine = new Uint8Array(bytes);
    const sink = time(() => window.bench.sink(mine));
    const mb = bytes / 1e6;
    return {
      label, mb: +mb.toFixed(1),
      localMs: +local.toFixed(3),
      crossOutMs: +alloc.toFixed(3), crossOutMBs: Math.round(mb / (alloc / 1000)),
      reuseMs: +reuse.toFixed(3), reuseMBs: Math.round(mb / (reuse / 1000)),
      crossInMs: +sink.toFixed(3), crossInMBs: Math.round(mb / (sink / 1000)),
      neededMBs: Math.round(mb * 60), // what a 60 fps stream has to sustain
    };
  }));
})()`;

/** One message, one kind. The zero-copy candidate: postMessage takes a transfer list, which
 *  contextBridge cannot. */
const transferOnce = (kind) => `(async () => {
  const bytes = 1920 * 1080 * 4;
  const arrived = new Promise((resolve) => {
    const onMsg = (e) => {
      if (e.data?.bench !== '${kind}') return;
      window.removeEventListener('message', onMsg);
      // Close on arrival: a VideoFrame holds a hardware buffer and leaking them wedges the renderer.
      e.data.frame?.close?.();
      resolve({ ok: true, bytes: e.data.buf?.byteLength ?? null });
    };
    window.addEventListener('message', onMsg);
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve({ ok: false, why: 'never arrived' }); }, 2000);
  });
  const t0 = performance.now();
  const sent = window.bench.blast(bytes, 1, '${kind}');
  const sendMs = +(performance.now() - t0).toFixed(3);
  return JSON.stringify({ sent, sendMs, ...(await arrived) });
})()`;

/** 120 frames at 60 fps, transferred and written to a real track — the production shape. */
const SUSTAINED = `(async () => {
  const N = 120, bytes = 1920 * 1080 * 4;
  const gen = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = gen.writable.getWriter();
  let n = 0, sendSum = 0, writeSum = 0, worstWrite = 0, first = 0;
  const finished = new Promise((resolve) => {
    const onMsg = async (e) => {
      if (e.data?.bench !== 'paced') return;
      if (!n) first = performance.now();
      sendSum += e.data.sendMs;
      const t = performance.now();
      // The frame arrived transferred; writing it hands ownership to the track, which closes it.
      if (e.data.frame) await writer.write(e.data.frame);
      const dt = performance.now() - t;
      writeSum += dt;
      if (dt > worstWrite) worstWrite = dt;
      if (++n === N) { window.removeEventListener('message', onMsg); resolve(performance.now() - first); }
    };
    window.addEventListener('message', onMsg);
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(-1); }, 15000);
  });
  window.bench.pace(bytes, N, 'frame', 16, () => {});
  const elapsed = await finished;
  writer.releaseLock();
  return JSON.stringify({
    received: n,
    fps: elapsed > 0 ? +(((n - 1) * 1000) / elapsed).toFixed(1) : null,
    avgSendMs: +(sendSum / Math.max(n, 1)).toFixed(3),
    avgWriteMs: +(writeSum / Math.max(n, 1)).toFixed(3),
    worstWriteMs: +worstWrite.toFixed(3),
    readyState: gen.readyState,
  });
})()`;

const TRACK = `(async () => {
  try {
    const data = new Uint8Array(1920 * 1080 * 4);
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    const writer = gen.writable.getWriter();
    const N = 60;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      await writer.write(new VideoFrame(data, {
        format: 'BGRA', codedWidth: 1920, codedHeight: 1080, timestamp: i * 16666,
      }));
    }
    const perFrameMs = +((performance.now() - t0) / N).toFixed(3);
    writer.releaseLock();
    return JSON.stringify({ perFrameMs, readyState: gen.readyState });
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
})()`;

app.whenReady().then(async () => {
  const result = { phases: {} };
  let win = null;
  const run = async (name, script, ms = 20_000) => {
    try {
      const out = await Promise.race([
        win.webContents.executeJavaScript(script),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
      ]);
      result.phases[name] = JSON.parse(out);
    } catch (err) {
      result.phases[name] = { error: String(err.message || err) };
    }
  };
  try {
    win = new BrowserWindow({
      width: 400,
      height: 300,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'bridge-bench-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // same posture as the real window (see electron/src/config.ts)
        backgroundThrottling: false,
      },
    });
    await win.loadURL(PAGE);
    await run('probe', PROBE);
    await run('clone', CLONE);
    await run('transferBuffer', transferOnce('buffer'), 8_000);
    await run('transferFrame', transferOnce('frame'), 8_000);
    await run('sustained', SUSTAINED, 25_000);
    await run('track', TRACK);
  } catch (err) {
    result.error = String(err && err.stack ? err.stack : err);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  win?.destroy();
  app.exit(0);
});
