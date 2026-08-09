// Can main tie a picker tile back to the DXGI output it is showing?
//
// `pickerSources` decides "this screen is in HDR" by matching an Electron `Display`'s physical
// origin against the addon's DXGI rectangle (`nativeDisplayFor`). That match is the only bridge
// between the two enumerations, and **its failure is silent**: no match means `hdr: false`, which
// means the clamped getDisplayMedia path, a normal-looking tile and no error anywhere.
//
// This dumps all three enumerations side by side and reports whether the bridge holds on THIS
// machine — plus the candidate that would not need geometry at all:
//
//   desktopCapturer reports screen ids like `screen:0:0` and `screen:4:0`. Sparse, non-contiguous
//   numbering is the signature of webrtc's GDI screen capturer, whose SourceId is the
//   `EnumDisplayDevices(NULL, index, …)` device index — i.e. a value that resolves EXACTLY to a
//   `\\.\DISPLAYn` device name with no rectangles involved. (The DirectX capturer numbers its
//   sources 0..n-1 instead, and those are DXGI ordinals; the two are not interchangeable, which is
//   why the numbering itself is reported below.)
//
// Run from electron/ (ELECTRON_RUN_AS_NODE must NOT be set):
//   pnpm exec electron ../tools/display-match-probe.cjs
const path = require('node:path');
const { app, desktopCapturer, screen } = require('electron');

const addon = require(path.join(__dirname, '..', 'electron', 'native', 'build', 'Release', 'streamshare_capture.node'));

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const out = {};
  try {
    const native = addon.listDisplays();
    const dips = screen.getAllDisplays();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });

    out.native = native.map((d) => ({
      deviceName: d.deviceName,
      hdr: d.hdr,
      sdrWhiteNits: d.sdrWhiteNits,
      rect: `${d.left},${d.top} ${d.right - d.left}x${d.bottom - d.top}`,
    }));
    out.electron = dips.map((d) => ({
      id: d.id,
      label: d.label,
      scaleFactor: d.scaleFactor,
      dip: `${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height}`,
      physical: `${Math.round(d.bounds.x * d.scaleFactor)},${Math.round(d.bounds.y * d.scaleFactor)} ${Math.round(d.bounds.width * d.scaleFactor)}x${Math.round(d.bounds.height * d.scaleFactor)}`,
      // The field that would make the whole geometric bridge unnecessary: Electron documents it as
      // "the display's origin in pixel coordinates", with an "only on X11-like systems" caveat that
      // is a doc note and not a measurement. If it is populated here, `nativeDisplayFor` is one line
      // and the DIP→physical multiplication — the thing that breaks under mixed DPI — goes away.
      nativeOrigin: d.nativeOrigin ?? null,
      // A second, independent HDR witness, for free while we are here.
      colorSpace: d.colorSpace ?? null,
      depthPerComponent: d.depthPerComponent ?? null,
    }));
    out.capturer = sources.map((s) => ({ id: s.id, name: s.name, display_id: s.display_id }));

    // The match as pickerSources performs it today: origin first (two displays cannot share one),
    // with a pixel of slack for the DIP→physical rounding.
    const near = (a, b) => Math.abs(a - b) <= 1;
    out.geometric = dips.map((d) => {
      const s = d.scaleFactor || 1;
      const x = Math.round(d.bounds.x * s);
      const y = Math.round(d.bounds.y * s);
      const hit = native.find((n) => near(n.left, x) && near(n.top, y)) ?? null;
      const bySize = native.filter(
        (n) => near(n.right - n.left, Math.round(d.bounds.width * s)) && near(n.bottom - n.top, Math.round(d.bounds.height * s)),
      );
      return {
        id: d.id,
        wanted: `${x},${y}`,
        matched: hit ? hit.deviceName : null,
        // What a size-only fallback would find if the origin match failed. One candidate is a usable
        // fallback; two identical monitors give two, and guessing there is worse than not matching.
        sizeCandidates: bySize.map((n) => n.deviceName),
      };
    });

    const ids = sources.map((s) => Number(s.id.split(':')[1]));
    const contiguous = ids.every((n, i) => n === i);
    out.screenIdNumbering = {
      ids,
      contiguous,
      reading: contiguous
        ? 'ambiguous — 0..n-1 fits both the GDI device index and a DXGI ordinal'
        : 'sparse — GDI capturer, so the id IS an EnumDisplayDevices device index',
    };

    // Would `nativeOrigin` carry the match on its own? Reported separately from the verdict: it is
    // only interesting when it AGREES with the geometric match on a machine where geometry works,
    // because that is the evidence that it can be trusted where geometry does not.
    out.byNativeOrigin = dips.map((d) => {
      const o = d.nativeOrigin;
      const hit = o ? (native.find((n) => near(n.left, o.x) && near(n.top, o.y)) ?? null) : null;
      return { id: d.id, origin: o ? `${o.x},${o.y}` : null, matched: hit ? hit.deviceName : null };
    });
    out.nativeOriginUsable =
      out.byNativeOrigin.every((b) => b.matched) &&
      out.byNativeOrigin.every((b) => b.matched === out.geometric.find((g) => g.id === b.id)?.matched);

    const unmatched = out.geometric.filter((g) => !g.matched);
    out.verdict = !native.length
      ? 'INCONCLUSIVE — the addon reported no displays'
      : unmatched.length
        ? `BLIND SPOT — ${unmatched.length}/${dips.length} Electron displays match no DXGI output; those screens can never take the HDR path`
        : `geometry holds — all ${dips.length} displays matched by origin`;
  } catch (err) {
    out.error = String(err && err.stack ? err.stack : err);
  }
  console.log(JSON.stringify(out, null, 2));
  app.exit(out.error ? 1 : 0);
});
