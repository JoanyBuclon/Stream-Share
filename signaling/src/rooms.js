// Room-code generation + input normalization. Pure logic — unit-tested in rooms.test.js.
// Cf. docs/rooms-and-codes.md.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, sans I L O U

/** Génère un code canonique 6 caractères, absent de `existing`. */
export function newCode(existing) {
  let code;
  do {
    code = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  } while (existing.has(code));
  return code;
}

/** Affichage : tiret au milieu → "7K2QP9" devient "7K2-QP9". */
export const format = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;

/** Saisie : retire tiret/espaces, majuscules → forme canonique. */
export const normalize = (input) => (input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/** Banni si l'IP OU le token correspond. L'IP attrape celui qui change de token ;
 *  le token (localStorage) attrape celui qui change d'IP sans vider son storage
 *  (mobile/CGNAT où le ban IP est faible). Token vide → jamais un match. */
export function isBanned(room, ip, token) {
  return room.bannedIps.has(ip) || (!!token && room.bannedTokens.has(token));
}
