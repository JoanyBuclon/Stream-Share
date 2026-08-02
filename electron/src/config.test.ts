import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAudioApps, createWakeLockToggle, type PowerBlocker } from './config.ts';

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
