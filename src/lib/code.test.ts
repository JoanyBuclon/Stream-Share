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

test('isValidCode accepte exactement l’alphabet que le serveur génère (miroir de rooms.js)', () => {
  // rooms.js `ALPHABET`, tenu en phase à la main (code.ts:1-2 explique pourquoi pas de module
  // partagé). Ce test est le fil-piège : un code que le serveur peut émettre DOIT valider côté
  // client — retirer une lettre d’un seul des deux le casse ici.
  const SERVER_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  assert.equal(SERVER_ALPHABET.length, 32, 'Crockford base32 : 10 chiffres + 22 lettres, sans I L O U');
  for (const c of SERVER_ALPHABET) assert.equal(isValidCode(c.repeat(6)), true, `caractère ${c}`);
  for (const c of 'ILOU') assert.equal(isValidCode(c.repeat(6)), false, `exclu ${c}`);
});
