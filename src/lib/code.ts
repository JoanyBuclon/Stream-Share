// Client-side room-code helpers. Mirrors signaling/src/rooms.js (format/normalize) —
// two packages, three lines, not worth a shared module.

// Crockford base32 without I L O U, exactly 6 chars.
const VALID = /^[0-9A-HJKMNP-TV-Z]{6}$/;

/** Strip cosmetics (dashes/spaces) and upper-case — tolerant of what the user types. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** True for a canonical 6-char code in the Crockford alphabet. */
export function isValidCode(code: string): boolean {
  return VALID.test(code);
}

/** Cosmetic dash in the middle: "7K2QP9" → "7K2-QP9". */
export function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}
