// Why do the picker's thumbnails of an HDR screen look burnt, and is it fixable from our side?
//
// The question that decides the fix, and it has exactly two answers:
//  - CLIPPED: Chromium clamped scRGB to [0,1] the way getDisplayMedia does, so the highlight detail
//    is already gone. Nothing in the renderer can bring it back; the thumbnail would have to come
//    from the addon instead.
//  - SCALED: the pixels are merely too bright, nothing pinned at the ceiling. Then dividing by the
//    same reference white the tone map uses is a few lines and it is exact.
//
// "% of pixels at 255" alone cannot tell them apart — a white browser window is 255 on an SDR
// screen too. So the control is the SAME SCREEN, SAME CONTENT, captured both ways seconds apart:
// desktopCapturer (what the picker shows) against the addon's tone-mapped readback (what the share
// shows). Whatever differs between those two IS the clamp.
//
// Kept after the fix landed, as the RE-MEASUREMENT tool: the regression is held by a gate in
// tools/native-track.cjs ("main can shoot the same screen while the page is sharing it"), so this
// is what you run when the panel, the driver or Chromium's capture path changes and the numbers
// quoted in docs/desktop.md need to be taken again — not part of the routine suite.
//
// Run from electron/ (ELECTRON_RUN_AS_NODE must NOT be set):
//   pnpm exec electron ../tools/thumb-probe.cjs        # the two capture paths, side by side
//   SS_E2E=1 pnpm exec electron ../tools/thumb-probe.cjs   # what the real picker hands back
const fs = require('node:fs');
const path = require('node:path');
const { app, screen, desktopCapturer } = require('electron');

app.on('window-all-closed', () => {});

// SS_E2E=1 boots the REAL shell. Required at module scope, never inside whenReady: main.cjs calls
// protocol.registerSchemesAsPrivileged as it loads, and that throws once the app is ready.
if (process.env.SS_E2E === '1') require(path.join(__dirname, '..', 'electron', 'out', 'main.cjs'));

const ADDON = path.join(__dirname, '..', 'electron', 'native', 'build', 'Release', 'streamshare_capture.node');
const OUT = path.join(__dirname, 'thumb-probe.json');

/** BGRA → the numbers that separate "clipped" from "just bright". */
function analyseBgra(buf, label) {
  const px = buf.length / 4;
  if (!px) return { empty: true };
  let sum = 0;
  let atCeiling = 0; // any channel pinned at 255 — the signature of a clamp
  let maxSeen = 0;
  const hist = new Array(16).fill(0);
  for (let i = 0; i < buf.length; i += 4) {
    const b = buf[i], g = buf[i + 1], r = buf[i + 2];
    const y = 0.0722 * b + 0.7152 * g + 0.2126 * r;
    sum += y;
    if (r === 255 || g === 255 || b === 255) atCeiling++;
    if (y > maxSeen) maxSeen = y;
    hist[Math.min(15, Math.floor(y / 16))]++;
  }
  return {
    label,
    pixels: px,
    meanLuma: +(sum / px).toFixed(1),
    maxLuma: Math.round(maxSeen),
    pctAtCeiling: +((100 * atCeiling) / px).toFixed(2),
    // The top two buckets: where a clamp piles everything it could not represent.
    pctTopTwoBuckets: +(((hist[14] + hist[15]) * 100) / px).toFixed(1),
    histogram16: hist.map((n) => +((100 * n) / px).toFixed(1)),
  };
}

/** END TO END: boot the REAL main and ask it for the picker listing the way the page does, then
 *  measure the thumbnail it actually hands back. Everything above proves the two capture paths
 *  differ; only this proves the picker now uses the right one. Enabled with SS_E2E=1, because it
 *  loads main.cjs and that owns the whole app. */
async function throughRealMain() {
  await new Promise((r) => setTimeout(r, 2500)); // main creates its window inside its own whenReady
  const win = require('electron').BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('main opened no window');
  const sources = await win.webContents.executeJavaScript('window.native.listSources()');
  const out = [];
  for (const s of sources) {
    if (s.kind !== 'screen') continue;
    // The tile carries a data: URL, which is what the grid renders.
    const image = require('electron').nativeImage.createFromDataURL(s.thumbnail);
    out.push({ name: s.name, hdr: s.hdr, ...analyseBgra(image.toBitmap(), `tile ${s.name}`) });
  }
  return out;
}

app.whenReady().then(async () => {
  const result = {};
  try {
    if (process.env.SS_E2E === '1') {
      result.tiles = await throughRealMain();
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
      console.log('\nWHAT THE PICKER ACTUALLY RENDERS');
      for (const t of result.tiles) {
        console.log(
          `  ${String(t.name).padEnd(12)} hdr=${String(t.hdr).padEnd(5)} mean=${String(t.meanLuma).padStart(6)} max=${String(t.maxLuma).padStart(4)} atCeiling=${String(t.pctAtCeiling).padStart(6)}%`,
        );
      }
      app.exit(0);
      return;
    }
    const addon = require(ADDON);
    const outputs = addon.listDisplays();
    result.displays = outputs;
    const hdr = outputs.find((d) => d.hdr);
    if (!hdr) throw new Error('no HDR output to compare against');
    result.target = hdr;

    // Which Electron display is that output, so its thumbnail can be found by display_id.
    const match = screen
      .getAllDisplays()
      .find((d) => Math.abs(Math.round(d.bounds.x * d.scaleFactor) - hdr.left) <= 1 && Math.abs(Math.round(d.bounds.y * d.scaleFactor) - hdr.top) <= 1);
    result.displayId = match ? String(match.id) : null;

    // 1. What the PICKER shows. Full-size thumbnail rather than the picker's 320px one: scaling
    //    averages neighbouring pixels and would soften exactly the clipping being measured.
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: hdr.right - hdr.left, height: hdr.bottom - hdr.top },
    });
    const picked = sources.find((s) => s.display_id === result.displayId) ?? sources[0];
    result.thumbnail = analyseBgra(picked.thumbnail.toBitmap(), `desktopCapturer ${picked.name}`);

    // 2. What the SHARE shows, same screen, seconds later. WGC is change-driven, so give it a
    //    moment and something to notice; a still desktop can legitimately hand back nothing.
    addon.startCapture(hdr.deviceName, hdr.sdrWhiteMeasured ? hdr.sdrWhiteNits : 80);
    await new Promise((r) => setTimeout(r, 2000));
    const frame = addon.takeFrame();
    addon.stopCapture();
    result.toneMapped =
      frame.width && frame.data.byteLength ? analyseBgra(Buffer.from(frame.data), 'addon tone-mapped') : { empty: true };

    // 3. And the WINDOWS. desktopCapturer reports no display_id for them (measured: 0 of 4), so the
    //    addon resolves it by HANDLE — the same call the native path uses. This decides the scope of
    //    any fix: one HDR screen, or every window sitting on it.
    const wins = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 640, height: 360 } });
    result.windows = wins.map((s) => {
      const hwnd = Number(s.id.split(':')[1]);
      const device = addon.displayForWindow(hwnd);
      return {
        name: s.name.slice(0, 30),
        onHdrScreen: device === hdr.deviceName,
        device,
        ...analyseBgra(s.thumbnail.toBitmap(), s.name.slice(0, 30)),
      };
    });
  } catch (err) {
    result.error = String((err && err.stack) || err);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  const row = (e) =>
    e && !e.empty
      ? `${e.label.padEnd(34)} mean=${String(e.meanLuma).padStart(6)} max=${String(e.maxLuma).padStart(4)} atCeiling=${String(e.pctAtCeiling).padStart(6)}% top2buckets=${String(e.pctTopTwoBuckets).padStart(5)}%`
      : 'no frame';
  console.log('\nSAME SCREEN, SAME CONTENT, TWO PATHS');
  console.log(' ', row(result.thumbnail));
  console.log(' ', row(result.toneMapped));
  console.log('\nWINDOWS, by the screen they sit on');
  for (const w of result.windows ?? []) {
    if (w.empty) continue;
    console.log(
      `  ${w.name.padEnd(32)} onHDR=${String(w.onHdrScreen).padEnd(5)} mean=${String(w.meanLuma).padStart(6)} max=${String(w.maxLuma).padStart(4)} atCeiling=${String(w.pctAtCeiling).padStart(6)}%`,
    );
  }
  if (result.error) console.log('ERROR', result.error);
  app.exit(0);
});
