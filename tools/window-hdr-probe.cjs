// Does WGC hand back scRGB for a WINDOW, or already-composited SDR pixels?
//
// Sharing an app on an HDR screen still washes out: `desktopCapturer` reports no `display_id` for
// windows, so nothing ties one to an HDR output, `hdr` is false, and the share falls back to
// getDisplayMedia — which clamps. The fix would be WGC's per-window capture, but only if it
// delivers the same scRGB the monitor path does. That is what this measures, before anything is
// built on top of it.
//
// THE TEST. Put a mid-grey (#808080) window on the HDR display and capture it both ways, through
// the same tone map with the same divisor:
//   - sRGB 128 is linear 0.216. On an HDR desktop, SDR white sits at the display's reference white
//     (480 nits here), i.e. scRGB 6.0 — so that grey arrives as 0.216 x 6 = 1.296.
//   - the shader divides by 480/80 = 6, giving 0.216 back, which re-encodes to 128.
//   => scRGB in, and the capture reads ~128, the colour we asked for.
//   => SDR-referred in (0.216, already composited), and the same divide gives 0.036 => ~53.
// A 2.4x gap with no saturation at either end.
//
// The control is the SAME window moved to the SDR display: if the colour space follows the display,
// the grey must come back ~2.4x darker there. (A first version sampled the window's rectangle out
// of a MONITOR capture instead. That measured the desktop, not the window — WGC hands back a
// window's own surface whether or not it is visible on screen, so geometry proves nothing here.)
//
// MEASURED 2026-08-06 on .DISPLAY1 (480 nits): 128 on the HDR display, 53 on the SDR one.
// Window capture is scRGB, anchored on the white of whichever display the window is on — so the
// tone map needs no change, and the divisor has to follow the window across screens.
//
// Run from electron/ (ELECTRON_RUN_AS_NODE must NOT be set):
//   pnpm exec electron ../tools/window-hdr-probe.cjs
const path = require('node:path');
const { app, BrowserWindow, screen } = require('electron');

const addon = require(path.join(__dirname, '..', 'electron', 'native', 'build', 'Release', 'streamshare_capture.node'));

/** Mean of the BGRA bytes over a rectangle, ignoring alpha. */
function meanOf(frame, x0, y0, w, h) {
  const { width, height, data } = frame;
  const px = new Uint8Array(data);
  const x1 = Math.min(x0 + w, width);
  const y1 = Math.min(y0 + h, height);
  let sum = 0;
  let n = 0;
  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < x1; x++) {
      const i = (y * width + x) * 4;
      sum += px[i] + px[i + 1] + px[i + 2];
      n += 3;
    }
  }
  return n ? sum / n : NaN;
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// The close test destroys the only window, and Electron's default is to quit the app when the last
// one goes — taking the results with it. (Which is how this probe first came back silent.)
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const out = {};
  let win = null;
  try {
    const displays = addon.listDisplays();
    const target = displays.find((d) => d.hdr);
    out.target = target ?? null;
    if (!target) throw new Error('no display is in HDR mode — nothing to probe');
    const white = target.sdrWhiteNits;
    out.sdrWhiteNits = white;
    out.expected = { scRgb: 128, sdrReferred: Math.round(255 * (0.216 / (white / 80)) ** (1 / 2.2)) };

    // The Electron Display whose physical origin matches the addon's, so the window lands on the
    // HDR panel and not merely somewhere.
    const dip = screen.getAllDisplays().find((d) => {
      const s = d.scaleFactor || 1;
      return Math.abs(Math.round(d.bounds.x * s) - target.left) <= 1 && Math.abs(Math.round(d.bounds.y * s) - target.top) <= 1;
    });
    if (!dip) throw new Error('no Electron display matches the HDR output');

    const w = 600;
    const h = 400;
    win = new BrowserWindow({
      x: dip.bounds.x + 80,
      y: dip.bounds.y + 80,
      width: w,
      height: h,
      frame: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#808080',
    });
    await win.loadURL('data:text/html,<body style="margin:0;background:%23808080"></body>');
    await settle(900); // painted, composited, and still

    const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE());
    out.hwnd = hwnd;
    // Inset so the window border and any rounding stay out of the sample.
    const inset = 40;

    // The question: the grey, captured as a window on the HDR display.
    addon.startCaptureWindow(hwnd, white);
    await settle(1200);
    const windowFrame = addon.takeFrame();
    const stats = addon.captureStats();
    addon.stopCapture();
    out.window = {
      size: `${windowFrame.width}x${windowFrame.height}`,
      frames: stats.frames,
      mean: meanOf(windowFrame, inset, inset, windowFrame.width - inset * 2, windowFrame.height - inset * 2),
    };

    // The control that actually decides it. The monitor sample above turned out to measure the
    // desktop rather than the window (WGC captures a window's own surface, visible or not), so
    // geometry proves nothing. This does: move the SAME window to the SDR display and capture it
    // again. If the colour space follows the display, the grey must come back ~2.4x darker there —
    // composited against 80 nits instead of 480, then divided by the same 6.
    const other = screen.getAllDisplays().find((d) => d.id !== dip.id);
    if (other) {
      win.setBounds({ x: other.bounds.x + 80, y: other.bounds.y + 80, width: w, height: h });
      await settle(1200);
      addon.startCaptureWindow(hwnd, white);
      await settle(1200);
      const sdrFrame = addon.takeFrame();
      addon.stopCapture();
      out.windowOnSdrDisplay = {
        size: `${sdrFrame.width}x${sdrFrame.height}`,
        mean: meanOf(sdrFrame, inset, inset, sdrFrame.width - inset * 2, sdrFrame.height - inset * 2),
      };
    }

    // --- what a window does that a monitor never does ---
    //
    // Both of these decide product behaviour, so they are measured rather than assumed. MINIMISED:
    // a monitor always changes eventually, a minimised window can be still for ever — and
    // native-video gives up after MAX_REPEATS (2 min) and ends the share. CLOSED: if
    // GraphicsCaptureItem::Closed fires, the host is told and the share ends cleanly; if not, the
    // viewers watch a frozen frame until that same 2-minute timer.
    win.setBounds({ x: dip.bounds.x + 80, y: dip.bounds.y + 80, width: w, height: h });
    await settle(600);
    addon.startCaptureWindow(hwnd, white);
    await settle(900);
    const beforeMin = addon.captureStats();
    win.minimize();
    await settle(1800);
    const whileMin = addon.captureStats();
    out.minimised = {
      framesWhile: whileMin.frames - beforeMin.frames,
      closed: whileMin.closed,
      size: `${whileMin.width}x${whileMin.height}`,
    };
    win.restore();
    await settle(1200);
    const afterRestore = addon.captureStats();
    out.restored = { framesAfter: afterRestore.frames - whileMin.frames, closed: afterRestore.closed };
    addon.stopCapture();

    addon.startCaptureWindow(hwnd, white);
    await settle(900);
    win.destroy();
    win = null;
    await settle(1800);
    const afterClose = addon.captureStats();
    out.afterClose = { closed: afterClose.closed, running: afterClose.running, frames: afterClose.frames };
    addon.stopCapture();

    const m = out.window.mean;
    out.verdict =
      !(m > 0)
        ? 'INCONCLUSIVE — the window capture produced nothing to measure'
        : Math.abs(m - out.expected.scRgb) < Math.abs(m - out.expected.sdrReferred)
          ? 'scRGB — window capture is in the same space as the monitor path, the feature is buildable'
          : 'SDR-REFERRED — window capture is already composited, the divisor cannot be the same';
  } catch (err) {
    out.error = String(err && err.stack ? err.stack : err);
  }
  if (win && !win.isDestroyed()) win.destroy();
  console.log(JSON.stringify(out, null, 2));
  app.exit(out.error ? 1 : 0);
});
