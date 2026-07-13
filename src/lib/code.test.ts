import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCode, isValidCode, formatCode } from './code.ts';

test('normalizeCode: retire tirets/espaces, met en majuscules', () => {
  assert.equal(normalizeCode('7k2-qp9'), '7K2QP9');
  assert.equal(normalizeCode('  7K2 QP9 '), '7K2QP9');
  assert.equal(normalizeCode(''), '');
});

test('isValidCode: 6 chars Crockford, rejette I L O U et mauvaise longueur', () => {
  assert.equal(isValidCode('7K2QP9'), true);
  assert.equal(isValidCode('7K2QP'), false); // trop court
  assert.equal(isValidCode('7K2QP90'), false); // trop long
  assert.equal(isValidCode('7K2QPI'), false); // I interdit
  assert.equal(isValidCode('7K2QPO'), false); // O interdit
});

test('formatCode: tiret au milieu pour 6 chars, sinon inchangé', () => {
  assert.equal(formatCode('7K2QP9'), '7K2-QP9');
  assert.equal(formatCode('7K2'), '7K2');
});
