// Where do the ~210 ms of `startCaptureNative` actually go, and how much of it is paid ONCE per
// process rather than on every start?
//
// That distinction decides the fix. If D3D11CreateDevice is expensive only the first time (driver
// DLLs loading), caching the device buys nothing on a source switch and the answer is to get the
// call off the renderer thread. If it is expensive every time, caching it is a far smaller change
// than moving a COM + WGC + threadsafe-function start onto a worker.
//
// Run from electron/ (ELECTRON_RUN_AS_NODE must NOT be set):
//   pnpm exec electron ../tools/start-cost.cjs
const fs = require('node:fs');
const path = require('node:path');
const { app, screen } = require('electron');

// Destroying the last window quits the app before anything is written.
app.on('window-all-closed', () => {});

const ADDON = path.join(__dirname, '..', 'electron', 'native', 'build', 'Release', 'streamshare_capture.node');
const OUT = path.join(__dirname, 'start-cost.json');
const ROUNDS = Number(process.env.SS_ROUNDS) > 0 ? Number(process.env.SS_ROUNDS) : 4;

const breakdown = (s) =>
  Object.fromEntries(
    Object.keys(s)
      .filter((k) => k.startsWith('startup'))
      .map((k) => [k.replace(/^startup|Ms$/g, '').replace(/^./, (c) => c.toLowerCase()), +s[k].toFixed(1)]),
  );

app.whenReady().then(async () => {
  const result = { rounds: [] };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const addon = require(ADDON);
    const displays = addon.listDisplays();
    const target = displays.find((d) => d.hdr) ?? displays[0];
    result.target = target?.deviceName ?? null;
    if (!target) throw new Error('no display reported');

    for (let i = 0; i < ROUNDS; i++) {
      // The sink is required, and its frames are irrelevant here — only the start cost is.
      addon.startCapture(target.deviceName, target.sdrWhiteMeasured ? target.sdrWhiteNits : 80);
      const stats = addon.captureStats();
      result.rounds.push(breakdown(stats));
      addon.stopCapture();
      // A beat between rounds so a lingering teardown is not billed to the next start.
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (err) {
    result.error = String((err && err.stack) || err);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  const keys = ['total', 'apartment', 'supported', 'device', 'compileVs', 'compilePs', 'item', 'session', 'buffer', 'pool'];
  console.log('round  ' + keys.map((k) => k.padStart(10)).join(''));
  result.rounds.forEach((r, i) => console.log(String(i).padEnd(7) + keys.map((k) => String(r[k] ?? '-').padStart(10)).join('')));
  if (result.error) console.log('ERROR', result.error);
  app.exit(0);
});
