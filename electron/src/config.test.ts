import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAudioApps,
  createWakeLockToggle,
  nativeDisplayFor,
  rendererSecurity,
  type PowerBlocker,
  type NativeDisplay,
} from './config.ts';

// The wake-lock bookkeeping fails silently by construction: get it wrong and the only symptom is a
// machine that stopped sleeping, with nothing on screen tying it back to us. Hence tests on ten
// lines. `start()` returning 0 for the first blocker is measured, not hypothetical.
function fakeBlocker(firstId = 0) {
  const log: string[] = [];
  let next = firstId;
  const blocker: PowerBlocker = {
    start: () => {
      const id = next++;
      log.push(`start->${id}`);
      return id;
    },
    stop: (id) => log.push(`stop(${id})`),
  };
  return { blocker, log };
}

test('createWakeLockToggle holds exactly one blocker, even though the first id is 0', () => {
  // The trap: `if (!id)` reads id 0 as "nothing held" and stacks a new blocker on every request,
  // leaving all but the last with no id anyone can stop.
  const { blocker, log } = fakeBlocker(0);
  const setWakeLock = createWakeLockToggle(blocker);
  setWakeLock(true);
  setWakeLock(true);
  setWakeLock(true);
  assert.deepEqual(log, ['start->0'], 'repeats must collapse onto the id already held');
  setWakeLock(false);
  assert.deepEqual(log, ['start->0', 'stop(0)'], 'and it must stop THAT id, not a truthy stand-in');
});

test('createWakeLockToggle releasing what it never took is a no-op', () => {
  const { blocker, log } = fakeBlocker();
  const setWakeLock = createWakeLockToggle(blocker);
  setWakeLock(false);
  setWakeLock(false);
  assert.deepEqual(log, [], 'teardown paths fire on sessions that never asked for a lock');
});

test('createWakeLockToggle can be re-taken after release, with the new id', () => {
  // Reload, then a fresh session: the second blocker gets a different id and must be the one
  // stopped. Tracking the first id forever would leak it.
  const { blocker, log } = fakeBlocker();
  const setWakeLock = createWakeLockToggle(blocker);
  setWakeLock(true);
  setWakeLock(false);
  setWakeLock(true);
  setWakeLock(false);
  assert.deepEqual(log, ['start->0', 'stop(0)', 'start->1', 'stop(1)']);
});

// The payload is stdout from a PowerShell process — a trust boundary of its own kind: the shape
// depends on the shell, the locale and how many processes matched. Its pid then goes straight to
// a WASAPI call that mutes an app for every viewer.
test('parseAudioApps reads the normal multi-app array', () => {
  const json = JSON.stringify([
    { Id: 20688, ProcessName: 'Discord', MainWindowTitle: '@someone - Discord' },
    { Id: 5544, ProcessName: 'Code', MainWindowTitle: 'host.ts - Stream-Share' },
  ]);
  assert.deepEqual(parseAudioApps(json, 999), [
    { pid: 5544, name: 'Code', title: 'host.ts - Stream-Share' },
    { pid: 20688, name: 'Discord', title: '@someone - Discord' }, // sorted by name
  ]);
});

test('parseAudioApps accepts the single-result object ConvertTo-Json emits', () => {
  // PowerShell collapses a one-element pipeline to a bare object. Treating that as "no apps" would
  // silently empty the list on a machine with a single windowed app.
  const json = JSON.stringify({ Id: 42, ProcessName: 'Discord', MainWindowTitle: 'x' });
  assert.deepEqual(parseAudioApps(json, 999), [{ pid: 42, name: 'Discord', title: 'x' }]);
});

test('parseAudioApps drops our own process', () => {
  const json = JSON.stringify([{ Id: 777, ProcessName: 'StreamShare', MainWindowTitle: 'StreamShare' }]);
  assert.deepEqual(parseAudioApps(json, 777), []);
});

test('parseAudioApps survives garbage instead of throwing into the IPC handler', () => {
  assert.deepEqual(parseAudioApps('', 1), []);
  assert.deepEqual(parseAudioApps('not json', 1), []);
  assert.deepEqual(parseAudioApps('null', 1), []);
  assert.deepEqual(parseAudioApps('[]', 1), []);
});

test('parseAudioApps rejects rows that could not name a real process', () => {
  const json = JSON.stringify([
    { Id: '20688', ProcessName: 'StringPid' }, // pid must be a number, not a string
    { Id: 0, ProcessName: 'ZeroPid' },
    { Id: -3, ProcessName: 'NegativePid' },
    { Id: 1.5, ProcessName: 'FloatPid' },
    { Id: 10, ProcessName: '' },
    { Id: 11 },
    null,
    'nope',
    { Id: 12, ProcessName: 'Good' }, // missing title is fine — it becomes ''
  ]);
  assert.deepEqual(parseAudioApps(json, 999), [{ pid: 12, name: 'Good', title: '' }]);
});
import { resolveAppOrigin, wsOrigin, contentSecurityPolicy, isInternalUrl, PROD_ORIGIN } from './config.ts';

test('wsOrigin: https→wss, http→ws, keeps host, no path', () => {
  assert.equal(wsOrigin('https://stream.joanybuclon.com'), 'wss://stream.joanybuclon.com');
  assert.equal(wsOrigin('http://localhost:4321'), 'ws://localhost:4321');
});

test('resolveAppOrigin: env override wins, blank falls back to production', () => {
  assert.equal(resolveAppOrigin({}), PROD_ORIGIN);
  assert.equal(resolveAppOrigin({ SS_APP_ORIGIN: '' }), PROD_ORIGIN);
  assert.equal(resolveAppOrigin({ SS_APP_ORIGIN: '   ' }), PROD_ORIGIN);
  assert.equal(resolveAppOrigin({ SS_APP_ORIGIN: 'http://localhost:4321' }), 'http://localhost:4321');
});

test('contentSecurityPolicy: names the (cross-origin) signaling socket in connect-src', () => {
  const csp = contentSecurityPolicy('https://stream.joanybuclon.com');
  assert.match(csp, /connect-src 'self' wss:\/\/stream\.joanybuclon\.com(?![\w.])/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /media-src 'self' blob:/);
  // dev origin keeps its port and downgrades to ws:
  assert.match(contentSecurityPolicy('http://localhost:4321'), /connect-src 'self' ws:\/\/localhost:4321/);
});

test('isInternalUrl: only app:// is internal, everything else opens externally', () => {
  assert.equal(isInternalUrl('app://bundle/index.html'), true);
  assert.equal(isInternalUrl('app://bundle/download/'), true);
  assert.equal(isInternalUrl('https://stream.joanybuclon.com'), false);
  assert.equal(isInternalUrl('https://evil.example/'), false);
  assert.equal(isInternalUrl('file:///etc/passwd'), false);
  assert.equal(isInternalUrl('not a url'), false);
});

// The real layout of the machine this was developed on: a 2560x1440 HDR primary at the origin and
// a 1920x1080 SDR secondary to its right. Both were verified against the addon's own output.
const DISPLAYS: NativeDisplay[] = [
  { deviceName: String.raw`\\.\DISPLAY1`, hdr: true, sdrWhiteNits: 480, sdrWhiteMeasured: true, maxLuminanceNits: 760, left: 0, top: 0, right: 2560, bottom: 1440 },
  { deviceName: String.raw`\\.\DISPLAY5`, hdr: false, sdrWhiteNits: 80, sdrWhiteMeasured: true, maxLuminanceNits: 270, left: 2560, top: 0, right: 4480, bottom: 1080 },
];

test('nativeDisplayFor: associe par origine physique, pas par ordre', () => {
  const primary = nativeDisplayFor(DISPLAYS, { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 });
  const second = nativeDisplayFor(DISPLAYS, { bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 });
  assert.equal(primary?.deviceName, String.raw`\\.\DISPLAY1`);
  assert.equal(primary?.hdr, true);
  assert.equal(second?.deviceName, String.raw`\\.\DISPLAY5`);
  assert.equal(second?.hdr, false, 'le second écran ne doit pas hériter du HDR du premier');
});

// Le piège du scaling : Electron rend des DIP, DXGI des pixels physiques. Sans la multiplication
// par scaleFactor, un écran à 150 % ne serait jamais retrouvé — et l'app resterait silencieusement
// sur le chemin clampé alors que l'écran est bien en HDR.
test('nativeDisplayFor: convertit les DIP en pixels physiques', () => {
  const scaled = { bounds: { x: 0, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 };
  assert.equal(nativeDisplayFor(DISPLAYS, scaled)?.deviceName, String.raw`\\.\DISPLAY1`);
  // 2560 DIP à 150 % = 3840 physiques : aucune origine ne correspond, et inventer une association
  // serait pire que n'en rendre aucune.
  const nowhere = { bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5 };
  assert.equal(nativeDisplayFor(DISPLAYS, nowhere), null);
});

test('nativeDisplayFor: tolère un pixel d écart, et rend null sans correspondance', () => {
  // 1706.67 DIP x 1.5 = 2560.005 → l arrondi peut tomber à 1 près dans un sens ou dans l autre.
  const rounded = { bounds: { x: 1706.67, y: 0, width: 100, height: 100 }, scaleFactor: 1.5 };
  assert.equal(nativeDisplayFor(DISPLAYS, rounded)?.deviceName, String.raw`\\.\DISPLAY5`);
  assert.equal(nativeDisplayFor([], { bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1 }), null);
  // scaleFactor 0 ne doit pas écraser toutes les origines sur 0 et faire matcher le premier écran.
  assert.equal(nativeDisplayFor(DISPLAYS, { bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 0 })?.deviceName, String.raw`\\.\DISPLAY5`);
});

// The renderer's sandbox is OFF (so the HDR addon can run in the preload), which promotes the other
// two flags from Electron defaults to the last thing standing between a hostile SDP and Node. This
// test exists to make a future "just flip contextIsolation to debug something" loud.
test('rendererSecurity: sandbox off, mais isolation et nodeIntegration verrouillés', () => {
  const prefs = rendererSecurity('C:/app/preload.cjs');
  assert.equal(prefs.preload, 'C:/app/preload.cjs');
  assert.equal(prefs.sandbox, false, 'délibéré : l addon HDR tourne dans le preload');
  assert.equal(prefs.contextIsolation, true, 'sans bac à sable, c est ce qui sépare le preload de la page');
  assert.equal(prefs.nodeIntegration, false, 'sinon la page — et notre CSP a unsafe-inline — obtient Node');
});
