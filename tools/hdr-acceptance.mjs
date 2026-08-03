// HDR pilot, clean room. Measures the SAME frame statistics for both paths:
//   baseline : Chromium capturing the HDR screen directly (what we ship today)
//   obs      : the OBS Virtual Camera, i.e. WGC scRGB + OBS's BT.2390 tone map
//
// Runs in real Chrome rather than our Electron shell for one reason: the measuring window must not
// be ON the screen being measured. Chrome honours --window-position, Electron ignores it and does
// not implement Browser.setWindowBounds — the first attempt at this measured a frame containing the
// shell's own UI and an infinite mirror, and the number it produced was worthless.
//
// The camera path is equivalent to what our app would receive: a getUserMedia track is a
// getUserMedia track. Throwaway.
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 9352;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const mode = process.argv[2] ?? 'obs'; // 'obs' | 'baseline'
const label = process.argv[3] ?? mode;

const screens = execFileSync('powershell', ['-NoProfile', '-Command',
  'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "{0};{1};{2};{3};{4}" -f $_.Primary, $_.Bounds.X, $_.Bounds.Y, $_.Bounds.Width, $_.Bounds.Height }',
]).toString().trim().split('\n').map((l) => {
  const [primary, x, y, w, h] = l.trim().split(';');
  return { primary: primary === 'True', x: +x, y: +y, w: +w, h: +h };
});
const park = screens.find((s) => !s.primary) ?? screens[0];

const profile = await mkdtemp(path.join(tmpdir(), 'ss-hdr-'));
const args = [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  `--window-position=${park.x + 30},${park.y + 30}`, '--window-size=900,600',
  '--use-fake-ui-for-media-stream', // auto-grant camera / capture, no dialog to click
  'http://localhost:4321/', // a secure context: navigator.mediaDevices is undefined on about:blank
];
// Chrome's own test switch: picks a desktop capture source by name, so getDisplayMedia resolves
// with no picker. The name must match what Chrome lists — "Écran 1" on a French Windows.
if (mode === 'baseline') args.unshift('--auto-select-desktop-capture-source=Écran 1');

const child = spawn(CHROME, args, { stdio: 'ignore' });

async function attach() {
  for (let i = 0; i < 80; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = targets.find((x) => x.type === 'page');
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
        let id = 10;
        const pending = new Map();
        ws.addEventListener('message', (ev) => {
          const m = JSON.parse(ev.data);
          if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        });
        return {
          ws,
          call: (expression) => new Promise((res, rej) => {
            const n = id++;
            pending.set(n, (m) => (m.result?.exceptionDetails
              ? rej(new Error(JSON.stringify(m.result.exceptionDetails.exception ?? m.result.exceptionDetails)))
              : res(m.result.result.value)));
            ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
          }),
        };
      }
    } catch { /* not up */ }
    await sleep(500);
  }
  throw new Error('no chrome target');
}

const GRAB = (kind) => `(async () => {
  const stream = ${kind === 'baseline'
    ? `await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60 } } })`
    : `await (async () => {
         const devs = await navigator.mediaDevices.enumerateDevices();
         const cam = devs.filter((d) => d.kind === 'videoinput').find((d) => /obs/i.test(d.label)) || devs.find((d) => d.kind === 'videoinput');
         if (!cam) throw new Error('no OBS virtual camera — is it started in OBS?');
         return navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
       })()`};
  const track = stream.getVideoTracks()[0];
  const v = document.createElement('video');
  v.srcObject = stream; v.muted = true; await v.play();
  await new Promise((r) => setTimeout(r, 4000)); // let a few real frames land

  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);

  let clipped = 0, bright = 0, sum = 0, max = 0, n = 0;
  const lum = new Set();
  const hist = new Array(16).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    hist[Math.min(15, y >> 4)]++;
    sum += y; n++;
    if (y > max) max = y;
    if (y >= 235) { bright++; lum.add(y); if (r === 255 && g === 255 && b === 255) clipped++; }
  }
  const t = document.createElement('canvas');
  t.width = 560; t.height = Math.round(560 * c.height / c.width);
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  const out = {
    label: track.label, size: c.width + 'x' + c.height,
    highlightPixels: bright, clippedPixels: clipped,
    clippedPctOfHighlights: bright ? +(clipped / bright * 100).toFixed(1) : 0,
    clippedPctOfFrame: +(clipped / n * 100).toFixed(2),
    distinctHighlightLuma: lum.size, meanLuma: Math.round(sum / n), maxLuma: max,
    histogram16: hist.map((x) => +(x / n * 100).toFixed(1)),
    thumbnail: t.toDataURL('image/jpeg', 0.85),
  };
  stream.getTracks().forEach((x) => x.stop());
  return JSON.stringify(out);
})()`;

const chrome = await attach();
try {
  const out = JSON.parse(await chrome.call(GRAB(mode)));
  const { thumbnail, histogram16, ...row } = out;
  console.log(`\n=== ${label} (${mode}) ===`);
  console.table([row]);
  console.log('luma histogram, % of frame:');
  console.log(histogram16.map((v, i) => `${String(i * 16).padStart(3)}-${String(i * 16 + 15).padEnd(3)} ${'#'.repeat(Math.round(v / 2))} ${v}%`).join('\n'));
  await writeFile(`hdr-${label}.jpg`, Buffer.from(thumbnail.split(',')[1], 'base64'));
  console.log(`\nframe written to hdr-${label}.jpg`);
} catch (e) {
  console.error('failed:', e.message);
} finally {
  chrome.ws.close();
  child.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
process.exit(0);
