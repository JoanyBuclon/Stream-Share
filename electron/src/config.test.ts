import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAudioApps } from './config.ts';

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
