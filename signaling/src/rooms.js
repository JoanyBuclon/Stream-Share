// Room-code generation + input normalization. Pure logic — unit-tested in rooms.test.js.
// See docs/rooms-and-codes.md.

import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, without I L O U

/** Generates a canonical 6-character code, absent from `existing`.
 *  `randomInt` (CSPRNG) and not `Math.random`: the code is the only secret protecting a
 *  room, a predictable PRNG would make it guessable without even scanning. */
export function newCode(existing) {
  let code;
  do {
    code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  } while (existing.has(code));
  return code;
}

/** Display: dash in the middle → "7K2QP9" becomes "7K2-QP9". */
export const format = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;

/** Input: strips dash/spaces, uppercases → canonical form.
 *  `String()` and not `input || ''`: the input comes from JSON.parse on the server side, so from
 *  any type. `{"code":123}` passed the `||` then threw on `.toUpperCase`. */
export const normalize = (input) => String(input ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/** Banned if the IP OR the token matches. The IP catches the one who changes token;
 *  the token (localStorage) catches the one who changes IP without clearing their storage
 *  (mobile/CGNAT where the IP ban is weak). Empty token → never a match. */
export function isBanned(room, ip, token) {
  return room.bannedIps.has(ip) || (!!token && room.bannedTokens.has(token));
}
