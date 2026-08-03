// The picker's only real logic is the search filter — everything else is DOM wiring. A source
// list on Windows is dozens of window titles, so a filter that is case-sensitive, or that treats
// a blank query as "match nothing", hides sources the user can see on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery, cameraDeviceId } from './source-picker.ts';

test('a blank query matches everything', () => {
  assert.equal(matchesQuery('Screen 1', ''), true);
  assert.equal(matchesQuery('Screen 1', '   '), true);
});

test('matching is case-insensitive and on any substring', () => {
  assert.equal(matchesQuery('Google Chrome', 'chrome'), true);
  assert.equal(matchesQuery('Google Chrome', 'GOOGLE'), true);
  assert.equal(matchesQuery('Visual Studio Code', 'studio'), true);
  assert.equal(matchesQuery('Discord', 'steam'), false);
});

test('the query is trimmed, the name is not', () => {
  // Window titles arrive from the OS and often carry padding; trimming the query alone keeps a
  // trailing space in a typed name from emptying the grid.
  assert.equal(matchesQuery('Elden Ring', '  elden '), true);
  assert.equal(matchesQuery(' Steam ', 'steam'), true);
});

// This is what routes a pick to getUserMedia instead of getDisplayMedia. Getting it wrong in
// either direction is silent: a camera sent down the display path fails the capture, and a screen
// sent down the camera path would ask getUserMedia for a deviceId that does not exist.
test('cameraDeviceId ne reconnaît que le préfixe caméra', () => {
  assert.equal(cameraDeviceId('camera:abc123'), 'abc123');
  assert.equal(cameraDeviceId('screen:0:0'), null);
  assert.equal(cameraDeviceId('window:4242:0'), null);
});

test('cameraDeviceId: un deviceId contenant un ":" survit intact', () => {
  // Real deviceIds are long base64-ish hashes; nothing forbids a colon in one, and slicing by
  // prefix length rather than splitting on ':' is what keeps them whole. A split would hand
  // getUserMedia a truncated id and fail with OverconstrainedError on a perfectly valid camera.
  assert.equal(cameraDeviceId('camera:a:b:c'), 'a:b:c');
});
