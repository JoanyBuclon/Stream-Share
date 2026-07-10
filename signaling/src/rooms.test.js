// Self-check for the pure code helpers. Run: node src/rooms.test.js
import assert from 'node:assert/strict';
import { newCode, format, normalize, isBanned } from './rooms.js';

// newCode: 6 caractères, alphabet Crockford (pas de I L O U), pas de collision.
const seen = new Set();
for (let i = 0; i < 2000; i++) {
  const c = newCode(seen);
  assert.equal(c.length, 6);
  assert.match(c, /^[0-9A-HJKMNP-TV-Z]{6}$/, `alphabet invalide: ${c}`);
  assert.ok(!seen.has(c), 'collision');
  seen.add(c);
}

// newCode évite un code déjà pris (anti-collision effective).
const taken = new Set(['AAA111']);
assert.notEqual(newCode(taken), 'AAA111');

// format : tiret au milieu.
assert.equal(format('7K2QP9'), '7K2-QP9');

// normalize : tolérant tiret / espaces / casse.
assert.equal(normalize('7k2-qp9'), '7K2QP9');
assert.equal(normalize('  7K2 QP9 '), '7K2QP9');
assert.equal(normalize(''), '');
assert.equal(normalize(undefined), '');

// isBanned : match sur l'IP OU le token, jamais sur un token vide.
const room = { bannedIps: new Set(['1.1.1.1']), bannedTokens: new Set(['tokX']) };
assert.equal(isBanned(room, '1.1.1.1', 'autre'), true); // IP attrape le change-token
assert.equal(isBanned(room, '9.9.9.9', 'tokX'), true); // token attrape le change-IP
assert.equal(isBanned(room, '9.9.9.9', 'autre'), false); // innocent
assert.equal(isBanned(room, '9.9.9.9', ''), false); // token vide non matché
assert.equal(isBanned(room, '9.9.9.9', undefined), false);

console.log('rooms.test.js OK');
