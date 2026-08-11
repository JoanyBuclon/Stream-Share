// Can the RENDERER tell whether it is on an HDR display, without the addon?
//
// This decides how the last HDR blind spot gets closed. `pickerSources` reports
// `hdr: output?.hdr ?? false`, which collapses two very different facts: "the addon resolved this
// output and it is SDR" and "nothing resolved it at all". The dominant case of the second is the
// capture addon failing to load — and then the whole HDR feature is silently absent, which is the
// exact failure that shipped once with a missing `extraResources` entry. Nothing on screen says so,
// because the "captured without HDR" chip is derived from that same `hdr` flag.
//
// If a CSS media query can answer, the renderer needs no addon and no IPC to know it should say
// something. docs/desktop.md claims `dynamic-range: high` reports the display's CAPABILITY rather
// than whether HDR is on right now — asserted, never measured. Both answers are useful and they
// lead to different designs:
//   - tracks the current mode  -> a complete witness; the blind spot closes with one media query
//   - capability only          -> still a good NOISE FILTER: say nothing on a machine whose panel
//                                 could never do HDR, speak up on one that could
//
// The test needs no human: this machine has one HDR-capable panel and one that is not, so moving a
// window between them and reading the query on each is enough to show whether it is per-display and
// whether it agrees with what DXGI reports.
//
// Run from electron/ (ELECTRON_RUN_AS_NODE must NOT be set):
//   pnpm exec electron ../tools/dynamic-range-probe.cjs
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, screen } = require('electron');

const addon = require(path.join(__dirname, '..', 'electron', 'native', 'build', 'Release', 'streamshare_capture.node'));

const OUT = path.join(__dirname, 'dynamic-range-probe.json');
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const out = { queries: [] };
  let win = null;
  try {
    const native = addon.listDisplays();
    out.native = native.map((d) => ({
      deviceName: d.deviceName,
      hdr: d.hdr,
      sdrWhiteNits: d.sdrWhiteNits,
      maxLuminanceNits: d.maxLuminanceNits,
      origin: `${d.left},${d.top}`,
    }));

    win = new BrowserWindow({ width: 400, height: 200, show: true, webPreferences: { offscreen: false } });
    await win.loadURL('data:text/html,<body>probe</body>');

    // Every dynamic-range-ish feature Chromium exposes, plus the colour depth, so the answer does
    // not hinge on one query name being the one that works.
    const read = () =>
      win.webContents.executeJavaScript(`({
        dynamicRangeHigh: matchMedia('(dynamic-range: high)').matches,
        dynamicRangeStandard: matchMedia('(dynamic-range: standard)').matches,
        videoDynamicRangeHigh: matchMedia('(video-dynamic-range: high)').matches,
        colorGamutP3: matchMedia('(color-gamut: p3)').matches,
        colorGamutRec2020: matchMedia('(color-gamut: rec2020)').matches,
        colorDepth: screen.colorDepth,
      })`);

    for (const d of native) {
      // Place the window on this output. The addon speaks physical pixels and Electron takes DIP,
      // so go through the Display whose nativeOrigin matches — the same bridge pickerSources uses.
      const dip = screen.getAllDisplays().find((e) => (e.nativeOrigin?.x ?? e.bounds.x) === d.left);
      if (!dip) {
        out.queries.push({ deviceName: d.deviceName, error: 'no Electron display matches this output' });
        continue;
      }
      win.setBounds({ x: dip.bounds.x + 60, y: dip.bounds.y + 60, width: 400, height: 200 });
      await settle(1200); // the media query re-evaluates on the move, not instantly
      out.queries.push({ deviceName: d.deviceName, hdrPerDxgi: d.hdr, ...(await read()) });
    }

    const hdrOut = out.queries.find((q) => q.hdrPerDxgi);
    const sdrOut = out.queries.find((q) => q.hdrPerDxgi === false);
    out.verdict = !hdrOut
      ? 'INCONCLUSIVE — no display is in HDR mode right now, so nothing distinguishes the two answers'
      : !sdrOut
        ? 'PARTIAL — only one output to look at; per-display behaviour cannot be shown'
        : hdrOut.dynamicRangeHigh && !sdrOut.dynamicRangeHigh
          ? 'PER-DISPLAY and agrees with DXGI — the renderer can tell, at least while HDR is on'
          : hdrOut.dynamicRangeHigh && sdrOut.dynamicRangeHigh
            ? 'NOT per-display — the query answers the same on both outputs, so it cannot name a source'
            : 'DISAGREES with DXGI — the query is not reporting what the compositor is doing';
  } catch (err) {
    out.error = String(err && err.stack ? err.stack : err);
  }
  if (win && !win.isDestroyed()) win.destroy();
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  app.exit(out.error ? 1 : 0);
});
