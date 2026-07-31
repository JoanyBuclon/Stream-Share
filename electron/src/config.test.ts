import { test } from 'node:test';
import assert from 'node:assert/strict';
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
