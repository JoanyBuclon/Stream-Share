// Does the desktop shell still start?
//
// Nothing else in this repo loads electron/src/main.ts. The e2e suite runs against browser fakes,
// tools/native-track.cjs is its own main process, and the unit tests only reach config.ts — so the
// one file holding every IPC handler, the consent state and the global listeners had no check of
// any kind. A `screen.on()` moved to module scope (it throws before `app.ready`) got the full suite
// green while the packaged app died at launch with an error dialog and no window.
//
// This is not a test of behaviour. It answers one question: does requiring main.cjs, letting it
// reach `ready` and open its window, work at all.
//
// Run from electron/ (ELECTRON_RUN_AS_NODE must NOT be set):
//   pnpm exec electron ../tools/main-boots.cjs
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const fail = (why) => {
  console.error(`BOOT FAIL: ${why}`);
  process.exit(1);
};

try {
  // The BUILT bundle, the same artifact `electron .` runs. A throw here is the P0 this exists for.
  require(path.join(__dirname, '..', 'electron', 'out', 'main.cjs'));
} catch (err) {
  fail(`main.cjs threw at load — ${err && err.stack ? err.stack : err}`);
}

app.whenReady().then(() => {
  // main's own whenReady handler registers the protocol, opens the window and subscribes to the
  // screen events. Ours runs after it, but the window is created synchronously in there, so a
  // short settle is enough — this is a smoke test, not a race to instrument.
  setTimeout(() => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length !== 1) fail(`expected one window, got ${windows.length}`);
    const url = windows[0].webContents.getURL();
    if (!url.startsWith('app://')) fail(`the window is not on the bundle (${url || 'nothing loaded'})`);
    console.log(`BOOT OK — ${url}`);
    process.exit(0);
  }, 2500);
});
