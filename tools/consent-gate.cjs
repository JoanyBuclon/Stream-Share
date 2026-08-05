// Does the native HDR path actually work in the app — and does its consent gate actually refuse?
//
// This is the check the project did not have, and its absence cost the feature: `ss:select-source`
// rebuilt `screen:${display.id}:0` to find the picked display, which on Windows never matches
// anything (desktopCapturer reports `screen:0:0` while Display.id is 3646719705), so the gate
// answered '' for every screen and native HDR was unreachable in the app. Every share fell back to
// getDisplayMedia with a console line. Unit tests could not see it: the bug was in the IPC wiring,
// and nothing in this repo loaded electron/src/main.ts.
//
// So this loads the REAL built main.cjs, lets it open its REAL window on app://bundle, and drives
// the REAL preload from the page. Nothing here reimplements the code under test.
//
// Needs: `pnpm build` at the root (the shell serves dist/), `pnpm build` and `pnpm build:native`
// in electron/. Run from electron/ (ELECTRON_RUN_AS_NODE must NOT be set):
//   pnpm exec electron ../tools/consent-gate.cjs
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const OUT = path.join(__dirname, 'consent-gate.json');

require(path.join(__dirname, '..', 'electron', 'out', 'main.cjs'));

/** Run an expression in the page and get a value back. Anything that throws comes back as its
 *  message: what the gate REFUSES is half of what this measures, so a refusal is data, not an
 *  error. */
const evaluate = (win, expr) =>
  win.webContents.executeJavaScript(
    `(async () => { try { return { ok: await (${expr}) }; } catch (e) { return { err: String(e && e.message ? e.message : e) }; } })()`,
  );

const START = `(() => { window.native.startNativeCapture(undefined, undefined, 30); return 'started'; })()`;

/**
 * One attempt, and ALWAYS stop afterwards.
 *
 * Not hygiene — correctness. A capture left running makes every later attempt fail with "capture
 * already running", which reads exactly like a refusal: caught while mutation-testing this file,
 * where a deliberately broken gate turned two of the refusal gates green.
 */
async function attempt(win) {
  const res = await evaluate(win, START);
  await evaluate(win, 'window.native.stopNativeCapture()');
  return res;
}

app.whenReady().then(async () => {
  const result = {};
  try {
    const win = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const poll = () => {
        const [w] = BrowserWindow.getAllWindows();
        if (w && !w.webContents.isLoading() && w.webContents.getURL().startsWith('app://')) return resolve(w);
        if (Date.now() > deadline) return reject(new Error('main never opened a loaded app:// window'));
        setTimeout(poll, 200);
      };
      poll();
    });

    result.canCaptureNative = (await evaluate(win, 'window.native.canCaptureNative()')).ok;

    // 1. No pick at all. This is the XSS shape: call the capture API without ever going near the
    //    picker. It must refuse before the addon is touched.
    result.beforeAnyPick = await attempt(win);

    // 2. The listing, straight from the real desktopCapturer + the real addon.
    const listed = await evaluate(
      win,
      `window.native.listSources().then((s) => s.map(({ id, name, kind, hdr, meta, sdrWhiteNits, sdrWhiteMeasured }) => ({ id, name, kind, hdr, meta, sdrWhiteNits, sdrWhiteMeasured })))`,
    );
    result.sources = listed.ok ?? listed;
    const screens = (result.sources ?? []).filter((s) => s.kind === 'screen');
    const hdrScreen = screens.find((s) => s.hdr) ?? null;
    const window0 = (result.sources ?? []).find((s) => s.kind === 'window') ?? null;
    result.hdrScreen = hdrScreen;
    // The whole point of the payload change: the page is handed no device names.
    result.payloadHasDeviceName = JSON.stringify(result.sources ?? []).includes('DISPLAY');

    // 3. An id that was never listed.
    await evaluate(win, `window.native.selectSource('screen:99999:0')`);
    result.afterBogusPick = await attempt(win);

    // 4. A window. It has no DXGI output, so the native path must stay shut — otherwise a click on
    //    a window would start a full-SCREEN capture.
    if (window0) {
      await evaluate(win, `window.native.selectSource(${JSON.stringify(window0.id)})`);
      result.afterWindowPick = await attempt(win);
    }

    // 5. The real thing: pick the HDR screen and capture it. This is the first time in the project
    //    that the native path runs through main's own consent gate rather than a harness that
    //    approves itself.
    if (hdrScreen) {
      await evaluate(win, `window.native.selectSource(${JSON.stringify(hdrScreen.id)})`);
      // Not `attempt`: this one has to stay running long enough to produce frames. Approval is not
      // capture — the gate could hand over a name the addon cannot use — so the counters are read
      // from the session this very call started.
      result.afterHdrPick = await evaluate(win, START);
      await new Promise((r) => setTimeout(r, 1500));
      result.stats = (await evaluate(win, 'window.native.nativeCaptureStats()')).ok;
      await evaluate(win, 'window.native.stopNativeCapture()');
    }

    // 6. The consent must not outlive the page that gave it. Reload, then ask again with no pick.
    win.webContents.reload();
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await new Promise((r) => setTimeout(r, 300));
    result.afterReload = await attempt(win);
  } catch (err) {
    result.error = String(err && err.stack ? err.stack : err);
  }
  result.verdict = verdict(result);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  for (const v of result.verdict) console.log(`${v.pass ? 'OK  ' : 'FAIL'}  ${v.gate} — ${v.value}`);
  if (result.error) console.error(result.error);
  app.exit(result.error || result.verdict.some((v) => !v.pass) ? 1 : 0);
});

/** Written so that absence of data fails: a run that captured nothing must not read as a run where
 *  every refusal worked. */
function verdict(r) {
  const refused = (step) => typeof r[step]?.err === 'string' && r[step].err.length > 0;
  const gates = [
    { gate: 'the addon loaded in the preload', pass: r.canCaptureNative === true, value: String(r.canCaptureNative) },
    {
      gate: 'the listing reaches the page',
      pass: Array.isArray(r.sources) && r.sources.length > 0,
      value: Array.isArray(r.sources) ? `${r.sources.length} sources` : JSON.stringify(r.sources),
    },
    {
      gate: 'no device name is handed to the page',
      pass: r.payloadHasDeviceName === false,
      value: r.payloadHasDeviceName ? 'a DXGI name is in the payload' : 'none',
    },
    { gate: 'refused with no pick', pass: refused('beforeAnyPick'), value: r.beforeAnyPick?.err ?? `started: ${r.beforeAnyPick?.ok}` },
    { gate: 'refused for an unlisted id', pass: refused('afterBogusPick'), value: r.afterBogusPick?.err ?? `started: ${r.afterBogusPick?.ok}` },
    {
      gate: 'refused for a window',
      pass: r.afterWindowPick === undefined || refused('afterWindowPick'),
      value: r.afterWindowPick === undefined ? 'skipped — no window to pick' : (r.afterWindowPick.err ?? `started: ${r.afterWindowPick.ok}`),
    },
    { gate: 'the consent does not survive a reload', pass: refused('afterReload'), value: r.afterReload?.err ?? `started: ${r.afterReload?.ok}` },
  ];
  // The two that prove the feature is REACHABLE, not merely well guarded. Skipped rather than
  // failed with no HDR screen: that is a property of the machine, and a red gate would only say
  // "this was not run on the dev box".
  if (!r.hdrScreen) {
    gates.push({ gate: 'an HDR screen actually captures', pass: true, value: 'skipped — no screen is in HDR mode right now' });
    return gates;
  }
  gates.push(
    {
      gate: 'an HDR screen is approved and starts',
      pass: r.afterHdrPick?.ok === 'started',
      value: r.afterHdrPick?.err ?? String(r.afterHdrPick?.ok),
    },
    {
      // Approval is not capture: the gate could pass a name the addon cannot use.
      gate: 'and frames actually come out of it',
      pass: (r.stats?.frames ?? 0) > 0 && r.stats?.closed === false,
      value: r.stats ? `${r.stats.frames} frames, ${r.stats.width}x${r.stats.height}, closed=${r.stats.closed}` : 'no stats',
    },
    {
      gate: 'the SDR white level is measured, not guessed',
      pass: r.hdrScreen.sdrWhiteMeasured === true && r.hdrScreen.sdrWhiteNits > 0,
      value: `${r.hdrScreen.sdrWhiteNits} nits, measured=${r.hdrScreen.sdrWhiteMeasured}`,
    },
  );
  return gates;
}
