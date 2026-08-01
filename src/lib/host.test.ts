// Trust boundary: a viewer's quality request arrives as opaque `data` over the signal relay. A bad
// value reaching scaleResolutionDownBy as Infinity/NaN breaks that viewer's sender, so isQualityRequest
// must reject everything outside the allowed tier set. parseRes converts our own button dataset.
// audioSpecFor is the other half: it decides what viewers actually hear, and getting it wrong is
// inaudible to the host — the failure mode is a room that hears what was supposed to be muted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQualityRequest, parseRes, audioSpecFor, isAudible, audioRowNames } from './host.ts';

const APPS = ['Discord', 'Spotify', 'chrome'];

test('isAudible: with no capture the loopback track carries everything', () => {
  assert.equal(isAudible(null, 'Discord'), true);
});

test('isAudible: exclusion silences exactly one app and nothing else', () => {
  assert.equal(isAudible({ exclude: 'Discord' }, 'Discord'), false);
  assert.equal(isAudible({ exclude: 'Discord' }, 'Spotify'), true);
  // The point of keeping exclusion for the single-mute case: an app nobody has listed is heard.
  assert.equal(isAudible({ exclude: 'Discord' }, 'SomethingLaunchedLater'), true);
});

test('isAudible: inclusion silences everything it does not name', () => {
  assert.equal(isAudible({ include: ['Spotify'] }, 'Spotify'), true);
  assert.equal(isAudible({ include: ['Spotify'] }, 'Discord'), false);
  // An app started after the capture was armed has no session, so its box must render unticked —
  // which is the truth, and is why nothing needs to re-arm behind the host's back.
  assert.equal(isAudible({ include: ['Spotify'] }, 'SomethingLaunchedLater'), false);
  assert.equal(isAudible({ include: [] }, 'Spotify'), false, 'muting everything really is silence');
});

test('audioRowNames keeps a row for a muted app that dropped out of the listing', () => {
  // Discord minimised to tray leaves `Get-Process | Where MainWindowHandle` while its exclusion
  // keeps running. Without its row the host can neither see nor undo the mute — and tray is
  // Discord's most common state.
  assert.deepEqual(audioRowNames(['Spotify'], { exclude: 'Discord' }), ['Spotify', 'Discord']);
  assert.deepEqual(audioRowNames(['Spotify', 'Discord'], { exclude: 'Discord' }), ['Spotify', 'Discord'], 'no dupe');
  assert.deepEqual(audioRowNames(['Spotify'], { include: ['Spotify', 'chrome'] }), ['Spotify', 'chrome']);
  assert.deepEqual(audioRowNames(APPS, null), APPS);
});

test('nothing muted asks for no native capture at all', () => {
  // The loopback track getDisplayMedia already handed us carries everything, for free.
  assert.equal(audioSpecFor(APPS, new Set()), null);
});

test('one muted app uses exclusion, not an include of the others', () => {
  // Exclusion is the only mode with no blind spot: windowless apps, Windows' own sounds and
  // anything launched later stay audible. The common case must not lose that.
  assert.deepEqual(audioSpecFor(APPS, new Set(['Discord'])), { exclude: 'Discord' });
});

test('two muted apps flip to including the rest', () => {
  assert.deepEqual(audioSpecFor(APPS, new Set(['Discord', 'chrome'])), { include: ['Spotify'] });
});

test('muting EVERY app is an empty include, never null', () => {
  // The regression this test exists for: null means "use the loopback track", so returning it here
  // would un-mute all three apps the host just muted — the worst outcome, reached by the most
  // natural gesture (untick everything). An empty include is a live capture of nothing: silence.
  assert.deepEqual(audioSpecFor(APPS, new Set(APPS)), { include: [] });
});

test('a muted app that is no longer running is ignored', () => {
  // `muted` is intent and outlives the listing. Counting a dead app would push a single mute into
  // inclusion — losing exclusion's coverage — to silence something that is already silent.
  assert.equal(audioSpecFor(APPS, new Set(['Ghost'])), null);
  assert.deepEqual(audioSpecFor(APPS, new Set(['Discord', 'Ghost'])), { exclude: 'Discord' });
});

test('isQualityRequest accepts each allowed tier', () => {
  for (const q of ['auto', 'source', 1440, 1080, 720, 480]) {
    assert.equal(isQualityRequest({ quality: q }), true, `tier ${String(q)}`);
  }
});

test('isQualityRequest rejects values outside the tier set', () => {
  assert.equal(isQualityRequest({ quality: 2160 }), false, 'above the ladder');
  assert.equal(isQualityRequest({ quality: '1080' }), false, 'string, not number');
  assert.equal(isQualityRequest({ quality: Infinity }), false);
  assert.equal(isQualityRequest({ quality: NaN }), false);
  assert.equal(isQualityRequest({ quality: 0 }), false);
  assert.equal(isQualityRequest({ quality: null }), false);
});

test('isQualityRequest rejects non-payloads', () => {
  assert.equal(isQualityRequest(null), false);
  assert.equal(isQualityRequest(undefined), false);
  assert.equal(isQualityRequest('auto'), false);
  assert.equal(isQualityRequest({}), false);
  assert.equal(isQualityRequest({ height: 1080 }), false);
});

test('isQualityRequest rejects a __proto__ payload from the wire', () => {
  // The only source is JSON.parse of relayed signal data. JSON turns "__proto__" into an OWN key
  // (it doesn't invoke the setter), so the object keeps Object.prototype and `.quality` is
  // undefined → rejected. A prototype-chain spoof (Object.create) can't come off the wire, so the
  // `'quality' in data` + Set.has pair is enough here; no hasOwn hardening needed.
  const fromWire = JSON.parse('{"__proto__":{"quality":"auto"}}');
  assert.equal(isQualityRequest(fromWire), false);
});

test('parseRes converts the numeric ladder values', () => {
  assert.equal(parseRes('2160'), 2160);
  assert.equal(parseRes('480'), 480);
});

test('parseRes on a non-numeric string is NaN (known trap: callers must pass a real data-res)', () => {
  // Documents the edge the audit flagged: `parseRes(dataset.res ?? 'source')` would yield NaN if a
  // res button ever shipped without data-res. Pinned so a future "harden parseRes" has a baseline.
  assert.ok(Number.isNaN(parseRes('source')));
});
