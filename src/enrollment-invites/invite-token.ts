/**
 * The enrollment-invite claim token: how it is minted, stored, and recognised.
 *
 * ## The threat this shape is chosen against
 *
 * The token is a bearer credential. It is sent to a parent over WhatsApp, and
 * whoever holds it can see an invite's figures and — with the matching phone —
 * claim it. Two consequences drive everything below:
 *
 *  1. **It must be unguessable.** 32 bytes from `randomBytes` is 256 bits of
 *     entropy; the rate limiter on the claim route is a courtesy, not the
 *     defence. Nothing here derives from a timestamp, a row id, or a counter,
 *     all of which have been used for invite links elsewhere and all of which
 *     narrow the search to something enumerable.
 *
 *  2. **The database must not contain a usable copy.** Only the SHA-256 digest
 *     is persisted, so a dump — or a read-only SQL injection, or a leaked
 *     backup — yields hashes that cannot be replayed into a claim. This is the
 *     same reasoning as `phoneHash` in `common/phone.ts`, and the same reason a
 *     password is never stored in `Account.password` in the clear.
 *
 * ## Why a plain SHA-256 is right here, where it would be wrong for a password
 *
 * Password hashing needs to be slow because passwords are low-entropy and
 * therefore brute-forceable. This token is 256 uniformly random bits: there is
 * no dictionary to try and no amount of hardware that shortens the search, so a
 * work factor would buy nothing and would cost a KDF run on every lookup. The
 * digest also has to be *deterministic*, because the lookup is a single indexed
 * equality on `tokenHash` — a salted or randomised scheme would force a scan of
 * every invite and a comparison per row, which is both slower and a timing
 * side-channel.
 *
 * ## Why the shape is validated before hashing
 *
 * `hashInviteToken` returns null for anything that is not the exact shape we
 * mint. That keeps junk — an empty string, a truncated paste, a URL fragment,
 * an injection probe — from reaching the database at all, and means the service
 * answers "not found" from memory rather than from a query. It is a cheap guard
 * on an unauthenticated route.
 */

import { createHash, randomBytes } from 'crypto';

/** 256 bits. See the note above on why entropy, not rate limiting, is the defence. */
const TOKEN_BYTES = 32;

/**
 * Length of the base64url encoding of `TOKEN_BYTES` bytes: ceil(32 / 3) * 4 = 44
 * characters, minus the one '=' of padding that base64url omits. Derived rather
 * than hardcoded so the two cannot drift if the byte count ever changes.
 */
export const INVITE_TOKEN_LENGTH =
  Math.ceil(TOKEN_BYTES / 3) * 4 - ((3 - (TOKEN_BYTES % 3)) % 3);

/** base64url's alphabet, anchored — no padding, no '+', no '/'. */
const TOKEN_SHAPE = new RegExp(`^[A-Za-z0-9_-]{${INVITE_TOKEN_LENGTH}}$`);

export interface MintedInviteToken {
  /** Shown to the school owner exactly once, inside the share link. Never stored. */
  readonly token: string;
  /** What `EnrollmentInvite.tokenHash` holds. */
  readonly tokenHash: string;
}

/** Mint a fresh claim token and the digest to persist alongside it. */
export function mintInviteToken(): MintedInviteToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: digest(token) };
}

/**
 * Digest a token supplied by a caller, or null when it is not the shape we mint.
 *
 * Callers MUST treat null as "no such invite" and answer identically to a hash
 * that simply misses — a distinct error for a malformed token would tell a
 * prober when they had the format right, which is the only part of a 256-bit
 * secret they could otherwise learn.
 */
export function hashInviteToken(raw: unknown): string | null {
  if (typeof raw !== 'string' || !TOKEN_SHAPE.test(raw)) return null;
  return digest(raw);
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
