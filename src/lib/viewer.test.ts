// Validation des payloads relayés par un pair. Le relais signaling est aveugle (`data` est
// recopié tel quel), donc ces gardes sont la seule frontière de confiance côté viewer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isControl, isHeight, parseTier } from './viewer.ts';

test('isControl accepts the two known verbs', () => {
  assert.equal(isControl({ control: 'pause' }), true);
  assert.equal(isControl({ control: 'resume' }), true);
});

test('isControl rejects an unknown value instead of treating it as resume', () => {
  // Le piège : `onControl` fait `hostPaused = control === 'pause'`, donc tout ce qui n'est pas
  // 'pause' vaut resume. Un garde qui ne teste que la présence de la clé sort le viewer d'une
  // pause du host sur n'importe quelle valeur.
  assert.equal(isControl({ control: 'banana' }), false);
  assert.equal(isControl({ control: null }), false);
  assert.equal(isControl({ control: undefined }), false);
  assert.equal(isControl({ control: 0 }), false);
  assert.equal(isControl({ control: { toString: () => 'pause' } }), false);
});

test('isControl rejects anything that is not a control payload', () => {
  assert.equal(isControl({}), false);
  assert.equal(isControl(null), false);
  assert.equal(isControl(undefined), false);
  assert.equal(isControl('pause'), false);
  assert.equal(isControl({ height: 1080 }), false);
});

test('isHeight accepts a positive number and rejects the rest', () => {
  assert.equal(isHeight({ height: 1080 }), true);
  assert.equal(isHeight({ height: 0 }), false, 'a cap of 0 is not a real height');
  assert.equal(isHeight({ height: -720 }), false);
  assert.equal(isHeight({ height: '1080' }), false, 'string, not number');
  assert.equal(isHeight({ height: NaN }), false);
  assert.equal(isHeight({}), false);
  assert.equal(isHeight(null), false);
});

test('parseTier maps the dataset string back to a tier', () => {
  assert.equal(parseTier('auto'), 'auto');
  assert.equal(parseTier('source'), 'source');
  assert.equal(parseTier('1080'), 1080);
  assert.equal(parseTier('480'), 480);
});
