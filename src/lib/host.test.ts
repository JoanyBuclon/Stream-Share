// Trust boundary: a viewer's quality request arrives as opaque `data` over the signal relay. A bad
// value reaching scaleResolutionDownBy as Infinity/NaN breaks that viewer's sender, so isQualityRequest
// must reject everything outside the allowed tier set. parseRes converts our own button dataset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQualityRequest, parseRes } from './host.ts';

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
