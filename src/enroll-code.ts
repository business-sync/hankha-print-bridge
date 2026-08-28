/**
 * The one place a pairing code is put into the shape the API expects.
 *
 * The code is hashed server-side to find its row, so `dnfv-as68`, `DNFV AS68` and `DNFVAS68`
 * are three different SHA-256s and all three come back as the API's deliberately vague "not
 * valid, already used, or expired" — wording that exists so the endpoint cannot be used as an
 * oracle, and which is actively misleading when the code was right and only the case was not.
 *
 * The pairing page has folded case since it shipped; `--enroll` passed argv straight through,
 * so the terminal path — the one an operator reaches for when the page has not worked — was
 * the one that punished a lowercase paste. One shared function, so a fix cannot land on only
 * one of them again.
 */

/**
 * `XXXX-XXXX` over the alphabet the API mints from, which drops O/0/I/1 because the code gets
 * read off a tablet and retyped on another machine. Mirrors `CODE_ALPHABET` in the backend's
 * `print.service.ts` — a character accepted here that it never mints is a guaranteed round
 * trip for nothing.
 */
export const ENROLL_CODE_RE =
  /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

/**
 * Fold the ways a correct code arrives wrong.
 *
 * Operators paste from a tablet or copy it off a screen by hand: leading spaces, lowercase,
 * a hyphen typed as a space, and a missing hyphen are all routine, and none of them are the
 * operator being wrong. Anything else is left alone so `isValidEnrollCode` can reject it.
 */
export function normalizeEnrollCode(raw: string): string {
  const trimmed = raw.trim().toUpperCase();
  const bare = trimmed.replace(/[\s-]+/g, '');
  return /^[A-Z0-9]{8}$/.test(bare) ? `${bare.slice(0, 4)}-${bare.slice(4)}` : trimmed;
}

export function isValidEnrollCode(code: string): boolean {
  return ENROLL_CODE_RE.test(code);
}

/**
 * Said in both places a code is rejected before it is sent, so the terminal and the pairing
 * page describe the same problem the same way.
 */
export const ENROLL_CODE_HINT =
  'A pairing code is eight characters, like XXXX-XXXX. Check it against the one shown in the POS.';
