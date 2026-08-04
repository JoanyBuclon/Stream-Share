// What the native HDR path costs, and whether its picture is actually fixed.
//
// Two questions in one run, because they share a capture session:
//
//  1. **Does it fit the frame budget?** The whole chain has one frame at 60 Hz (16.7 ms). `gpu` is
//     tone map + copy + GPU sync (Map() blocks until the GPU is done), `copy` is the memcpy out of
//     the staging texture. What is left is the encoder's.
//  2. **Is the clipping gone?** Same metrics as tools/hdr-acceptance.mjs, deliberately: the OBS
//     pilot measured 81.1% of highlights clipped on the getDisplayMedia path and 0% through OBS's
//     tone map, on this same source. Those are the numbers to beat.
//
// Run from electron/: pnpm exec electron ../tools/wgc-latency.cjs
// (ELECTRON_RUN_AS_NODE must NOT be set — this needs the real main process.)
// Electron on Windows is a GUI binary, so stdout never reaches the parent shell — results go to
// tools/wgc-latency.json, and a downscaled BMP next to it for eyeballing.
//
// It opens a small window that animates at the refresh rate on the captured display, and that is
// not incidental: WGC is CHANGE-driven, so on an idle desktop it delivers ~24 fps or fewer and the
// chain is timed under no load at all. Without a mover, every number here describes a screen that
// was not doing anything. The window paints dark greys so it cannot pollute the highlight metrics.
const fs = require('node:fs');
const path = require('node:path');
const { app, screen, BrowserWindow } = require('electron');

// A NaN here would make setTimeout fire immediately, capture nothing, and — before the gates were
// made to fail on absence of data — report success.
const SECONDS = Number(process.env.SS_PROBE_SECONDS) > 0 ? Number(process.env.SS_PROBE_SECONDS) : 5;
const OUT = path.join(__dirname, 'wgc-latency.json');
const BMP = path.join(__dirname, 'wgc-frame.bmp');

/** Same luma metrics tools/hdr-acceptance.mjs computes, so the two runs are comparable. */
function analyse(data, width, height) {
  let clipped = 0, bright = 0, sum = 0, max = 0;
  const distinct = new Set();
  const hist = new Array(16).fill(0);
  const n = width * height;
  for (let i = 0; i < data.length; i += 4) {
    const b = data[i], g = data[i + 1], r = data[i + 2]; // BGRA
    const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    hist[Math.min(15, y >> 4)]++;
    sum += y;
    if (y > max) max = y;
    if (y >= 235) {
      bright++;
      distinct.add(y);
      if (r === 255 && g === 255 && b === 255) clipped++;
    }
  }
  return {
    size: `${width}x${height}`,
    highlightPixels: bright,
    clippedPixels: clipped,
    clippedPctOfHighlights: bright ? +((clipped / bright) * 100).toFixed(1) : 0,
    clippedPctOfFrame: +((clipped / n) * 100).toFixed(2),
    distinctHighlightLuma: distinct.size,
    meanLuma: Math.round(sum / n),
    maxLuma: max,
    histogram16: hist.map((x) => +((x / n) * 100).toFixed(1)),
  };
}

/** Nearest-neighbour downscale to a 32-bit BMP. A BMP because BGRA8 IS its pixel layout — an
 *  encoder dependency for a debug artefact would be the tail wagging the dog. */
function writeBmp(file, data, width, height, outWidth = 720) {
  const w = Math.min(outWidth, width);
  const h = Math.max(1, Math.round((w * height) / width));
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / w));
      // BMP rows run bottom-up.
      data.copy(pixels, ((h - 1 - y) * w + x) * 4, (sy * width + sx) * 4, (sy * width + sx) * 4 + 4);
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(w, 18);
  header.writeInt32LE(h, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(pixels.length, 34);
  fs.writeFileSync(file, Buffer.concat([header, pixels]));
}

/**
 * The stop conditions, as gates rather than prose.
 *
 * Every one of them is written so that ABSENCE OF DATA FAILS. The first version of this function
 * did the opposite — with zero frames captured, `gpuAvgMs + copyAvgMs` was 0 (under budget),
 * `failed` was 0 (no failures) and `!image` short-circuited the clipping gate to true. Three green
 * lights on a run that captured nothing, and that is exactly the run it green-lit.
 */
function verdict({ stats, image, target }) {
  const gates = [];

  // Gate zero, because everything below is vacuous without it. WGC is change-driven, so this also
  // fails on an idle desktop — which is the honest outcome: an idle desktop cannot tell us whether
  // the chain keeps up.
  const wanted = SECONDS * 20;
  gates.push({
    gate: 'enough frames to conclude',
    pass: stats.frames >= wanted,
    value: `${stats.frames} in ${SECONDS}s (need ${wanted}; move something on screen)`,
  });

  // Without this the harness happily measures an SDR screen, where the tone map is the identity and
  // every image gate passes for the wrong reason.
  gates.push({
    gate: 'target is in HDR mode',
    pass: target?.hdr === true,
    value: target ? `${target.deviceName} hdr=${target.hdr}` : 'no display',
  });

  // MAX, not average: a per-frame budget is blown by one 40 ms frame, and a mean of 6 ms hides it.
  const worstMs = stats.gpuMaxMs + stats.copyMaxMs;
  gates.push({
    gate: 'worst frame within budget',
    pass: stats.frames > 0 && worstMs < 16.7,
    value: `${worstMs.toFixed(2)} ms of 16.7 (avg ${(stats.gpuAvgMs + stats.copyAvgMs).toFixed(2)})`,
  });

  gates.push({
    gate: 'no GPU-path failures',
    pass: stats.failed === 0 && stats.empty === 0,
    value: `${stats.failed} failed, ${stats.empty} empty`,
  });

  // The drop mode this design actually has: a 2-buffer pool while the handler blocks in Map(). Such
  // frames never reach the handler, so no counter sees them — but they leave a gap that is a
  // multiple of the vsync interval. 40 ms allows one skipped 60 Hz frame plus jitter.
  gates.push({
    gate: 'no frame skipped by the pool',
    pass: stats.frames > 0 && stats.gapMaxMs <= 40,
    value: `worst gap ${stats.gapMaxMs.toFixed(1)} ms`,
  });

  gates.push({ gate: 'capture item still open', pass: stats.closed === false, value: `closed=${stats.closed}` });

  if (image) {
    // 81.1% was the getDisplayMedia baseline, 0% was OBS.
    gates.push({
      gate: 'highlights not clipped',
      pass: image.clippedPctOfHighlights <= 1,
      value: `${image.clippedPctOfHighlights}% of ${image.highlightPixels}`,
    });
    // The one that can actually fail. Zero clipping is close to arithmetic here: the shoulder only
    // reaches 255 above ~1.96x SDR white (940 nits on this panel, which peaks at 760), so ANY
    // monotone compressive curve passes the gate above — including one that crushes every highlight
    // into two adjacent codes. Counting distinct highlight values is what distinguishes "not
    // clipped" from "detail survived"; the Chromium baseline scored 21 with 81% of them at 255.
    gates.push({
      gate: 'highlight detail survived',
      pass: image.highlightPixels === 0 || image.distinctHighlightLuma >= 8,
      value: `${image.distinctHighlightLuma} distinct values over ${image.highlightPixels} px`,
    });
  } else {
    gates.push({ gate: 'a frame was read back', pass: false, value: 'none' });
  }
  return gates;
}

/** A window on the captured display that repaints every frame, so WGC has something to deliver. */
async function openMover(target) {
  // This one is worth an explicit check: with ELECTRON_RUN_AS_NODE set — and it is, ambiently, in
  // some shells here — `require('electron')` returns the path to the exe instead of the API, and
  // the failure reads as "Cannot read properties of undefined" fifty lines from the cause.
  if (!app) throw new Error('running as plain node: unset ELECTRON_RUN_AS_NODE and re-run');
  // requestAnimationFrame in a window Windows considers occluded or backgrounded gets throttled to
  // 1 Hz, which would silently reproduce the idle-desktop measurement this exists to avoid.
  for (const s of ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows']) {
    app.commandLine.appendSwitch(s);
  }
  await app.whenReady();
  // Electron speaks DIP, the addon speaks physical pixels — same origin match as nativeDisplayFor.
  const display =
    screen.getAllDisplays().find((d) => {
      const scale = d.scaleFactor || 1;
      return Math.abs(Math.round(d.bounds.x * scale) - target.left) <= 1 && Math.abs(Math.round(d.bounds.y * scale) - target.top) <= 1;
    }) ?? screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: display.bounds.x + 40,
    y: display.bounds.y + 40,
    width: 480,
    height: 270,
    frame: false,
    skipTaskbar: true,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadURL(
    'data:text/html,' +
      encodeURIComponent(`<body style="margin:0;background:#101014;overflow:hidden">
<canvas id="c" width="480" height="270"></canvas><script>
const x=document.getElementById('c').getContext('2d');let t=0;
// Dark greys only: a bright mover would add its own highlight pixels to the clipping statistics.
(function f(){t+=4;x.fillStyle='#101014';x.fillRect(0,0,480,270);
x.fillStyle='#3a3a44';x.fillRect((t%520)-40,0,40,270);requestAnimationFrame(f)})();
</script></body>`),
  );
  return win;
}

void (async () => {
  const result = { seconds: SECONDS };
  let addon = null;
  let mover = null;
  try {
    try {
      addon = require('../electron/native/build/Release/streamshare_capture.node');
    } catch {
      throw new Error('addon not built — run `pnpm build:native` from electron/');
    }
    const displays = addon.listDisplays();
    result.displays = displays;
    // The HDR display if there is one. Falling back to the first is deliberate but never silent:
    // the "target is in HDR mode" gate fails, rather than measuring an identity tone map.
    const target = displays.find((d) => d.hdr) ?? displays[0];
    if (!target) throw new Error('no display reported');
    result.target = target;

    // SS_SDR overrides the measured SDR white level — the one knob worth sweeping by hand, since
    // it is the divisor the whole curve hangs on.
    const sdrWhite = Number(process.env.SS_SDR) > 0 ? Number(process.env.SS_SDR) : target.sdrWhiteNits;
    result.usedSdrWhiteNits = sdrWhite;
    result.sdrWhiteMeasured = target.sdrWhiteMeasured;

    mover = await openMover(target);
    // Let the compositor settle at the refresh rate before the clock starts, so the first frames
    // (window fade-in, first paint) do not land in the timings as if they were steady state.
    await new Promise((r) => setTimeout(r, 700));

    // startCapture is synchronous: D3D device, two runtime HLSL compilations, pool, session. It
    // will run on the renderer thread in the preload, so the click that starts a share pays it.
    const t0 = process.hrtime.bigint();
    addon.startCapture(target.deviceName, sdrWhite, Number(process.env.SS_KNEE) || 0.75);
    result.startMs = +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1);
    await new Promise((r) => setTimeout(r, SECONDS * 1000));
    result.stats = addon.captureStats();
    result.fps = +(result.stats.frames / SECONDS).toFixed(1);

    const frame = addon.takeFrame();
    if (frame.width && frame.data.byteLength) {
      const data = Buffer.from(frame.data);
      result.image = analyse(data, frame.width, frame.height);
      writeBmp(BMP, data, frame.width, frame.height);
      result.bmp = BMP;
    } else {
      result.image = null;
    }
    result.verdict = verdict(result);

    // Teardown stress. The bug this targets — Stop() releasing the D3D context while a WGC pool
    // thread is inside Map() — is a use-after-free, so its symptom is the process dying: no JSON,
    // no verdict, non-zero exit. Stopping at a random point mid-frame is the whole test; a tidy
    // stop after the frames have drained would never reach the window.
    result.teardownCycles = 0;
    addon.stopCapture(); // the measurement session; the loop below owns the next ones
    for (let i = 0; i < 8; i++) {
      addon.startCapture(target.deviceName, sdrWhite, 0.75);
      await new Promise((r) => setTimeout(r, 30 + i * 17)); // land at varied points in the frame
      addon.stopCapture();
      addon.stopCapture(); // idempotent, and the double call is itself a teardown path
      result.teardownCycles++;
    }
    result.verdict.push({ gate: 'survives stop mid-frame', pass: result.teardownCycles === 8, value: `${result.teardownCycles}/8 cycles` });
  } catch (err) {
    result.error = String(err && err.stack ? err.stack : err);
  } finally {
    // In a finally, so a throw in analyse() does not leave the capture running against the GPU
    // while we write the report.
    try {
      addon?.stopCapture();
      mover?.destroy();
    } catch {
      /* already down */
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  // Non-zero when a gate fails, so this is a check and not just a report. Stdout is invisible under
  // Electron on Windows; the exit code is not.
  process.exit(result.error || result.verdict?.some((v) => !v.pass) ? 1 : 0);
})();
