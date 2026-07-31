import { createHmac } from 'crypto';
import { deriveSubkey } from './encryption';

/**
 * Nigerian phone-number handling for the server, and the blind index that makes
 * "is this number already registered?" answerable at all.
 *
 * ## Why a blind index
 *
 * `User.phoneNumber` is encrypted at rest with RANDOMIZED AES-256-GCM (see
 * `pii-crypto.ts`), so the same number encrypts to a different ciphertext every
 * time. Two consequences that shape everything here:
 *
 *   - A unique index on `phoneNumber` would never collide, so it would enforce
 *     nothing.
 *   - `where: { phoneNumber }` cannot match, so the number cannot be looked up.
 *
 * `User.phoneHash` is therefore a *deterministic* keyed digest of the canonical
 * number: `HMAC-SHA256(hkdf(ENCRYPTION_KEY, 'phone-blind-index/v1'), '+234…')`.
 * It carries a UNIQUE constraint, which is what actually enforces one-account-per
 * -number, and it is queryable by equality.
 *
 * HMAC rather than a bare SHA-256 because the search space is tiny — ten digits
 * behind a fixed `+234` prefix is a few billion candidates, which an attacker
 * holding a stolen database could exhaust to recover every number. Keying the
 * digest makes the dump useless without the key.
 *
 * ## Operational caveats
 *
 *   - The key is derived from `ENCRYPTION_KEY`. Rotating it invalidates every
 *     stored hash — rotation must be followed by `scripts/backfill-phone-hash.ts`
 *     (the same backfill that a key rotation already requires for the encrypted
 *     columns themselves). See `docs/runbooks/phone-blind-index.md`.
 *   - Rows written before the column existed have `phoneHash = NULL` and are
 *     exempt from the constraint until backfilled (Postgres permits many NULLs
 *     in a unique index).
 */

/** Ten significant digits behind an optional `0` or `+234` / `234` prefix. */
const NIGERIA_LOCAL = /^0(\d{10})$/;
const NIGERIA_INTERNATIONAL = /^(?:\+?234)(\d{10})$/;

/**
 * Unicode control/format characters plus the zero-width set. Built from explicit
 * codepoints rather than written as a character class, because a literal
 * zero-width character in this source line would be invisible to every reviewer
 * of the very code meant to strip it.
 *
 * `\p{C}` covers Cc/Cf/Co/Cs; U+200B is Zs in some Unicode versions rather
 * than Cf, so the zero-width set is listed rather than assumed. ZWSP, ZWNJ, ZWJ,
 * word-joiner, BOM:
 */
const ZERO_WIDTH_CODEPOINTS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];
const INVISIBLE_CHARS = new RegExp(
  `[\\p{C}${ZERO_WIDTH_CODEPOINTS.map((c) => String.fromCodePoint(c)).join('')}]`,
  'gu',
);

/** HKDF label. Versioned: bumping it re-keys every hash and needs a backfill. */
const BLIND_INDEX_LABEL = 'lopay/phone-blind-index/v1';

/**
 * Used only when `ENCRYPTION_KEY` is unset, which the Joi schema permits in
 * dev/test but never in production. Dev hashes are consequently not comparable
 * with production hashes — correct, since dev stores phone numbers in plaintext
 * anyway and the two databases share no rows.
 */
const DEV_FALLBACK_KEY = Buffer.from(
  'lopay-development-phone-blind-index-fallback',
  'utf8',
);

/**
 * Drop the characters people type for legibility but that carry no meaning:
 * spaces, dashes, dots, and the parentheses around an area code.
 *
 * Also strips Unicode control and zero-width characters, which is the sanitizing
 * step that matters for a value we are about to store and index — a zero-width
 * joiner inside a number would otherwise produce a *different* hash for what a
 * human reads as the same number, quietly defeating the uniqueness check.
 */
export function stripPhoneFormatting(raw: string): string {
  return raw.replace(/[\s\-.()]/g, '').replace(INVISIBLE_CHARS, '');
}

/**
 * Reduce any accepted spelling of a Nigerian number to ONE representation, so
 * that two users cannot occupy the same real-world number by typing it
 * differently. Returns `null` when the input isn't a valid Nigerian number.
 *
 * @example canonicalizePhone('08012345678')     // '+2348012345678'
 * @example canonicalizePhone('0801 234-5678')   // '+2348012345678'
 * @example canonicalizePhone('+2348012345678')  // '+2348012345678'
 * @example canonicalizePhone('2348012345678')   // '+2348012345678'
 * @example canonicalizePhone('801234567')       // null
 */
export function canonicalizePhone(raw: string): string | null {
  const stripped = stripPhoneFormatting(raw);
  const significant =
    NIGERIA_LOCAL.exec(stripped)?.[1] ??
    NIGERIA_INTERNATIONAL.exec(stripped)?.[1];
  return significant ? `+234${significant}` : null;
}

/** @example isValidPhone('+234 801 234 5678') // true */
export function isValidPhone(raw: string): boolean {
  return canonicalizePhone(raw) !== null;
}

function blindIndexKey(): Buffer {
  return deriveSubkey(BLIND_INDEX_LABEL) ?? DEV_FALLBACK_KEY;
}

/**
 * Deterministic keyed digest of a phone number, for the unique `User.phoneHash`
 * column. Canonicalises first, so every spelling of one number yields one hash.
 *
 * Returns `null` for an invalid number rather than hashing the raw string —
 * hashing garbage would let two different invalid inputs occupy the unique index
 * and would make the column meaningless.
 */
export function phoneBlindIndex(raw: string): string | null {
  const canonical = canonicalizePhone(raw);
  if (!canonical) return null;
  return createHmac('sha256', blindIndexKey()).update(canonical).digest('hex');
}
