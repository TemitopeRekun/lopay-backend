import { Logger } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client';
import {
  AUTH_ERROR_CODES,
  AUTH_ERROR_FIELDS,
  AUTH_ERROR_MESSAGES,
  MAX_NAME_LENGTH,
  type AuthErrorCode,
} from '../common/auth-error-codes';
import { canonicalizePhone, phoneBlindIndex } from '../common/phone';
import { AUTH_EVENTS, logAuthEvent } from '../common/logger/auth-events';

/**
 * Server-side sanitizing, validation and uniqueness enforcement for user
 * creation, run from Better Auth's `user.create.before` database hook.
 *
 * ## Why this lives on the server at all
 *
 * The web client validates the same rules before submitting, and that is the
 * layer that produces good UX. It is NOT a security boundary: the browser talks
 * to `/api/auth/sign-up/email` directly, so anyone can `curl` it with a blank
 * name, a zero-width-padded phone number, or a number that already belongs to
 * someone else. Client-side validation is a courtesy to honest users; this is
 * the rule.
 *
 * ## Why the hook, rather than a controller
 *
 * Sign-up is handled inside Better Auth, not by a Nest controller, so there is no
 * request pipeline of ours to hang a `ValidationPipe` off. `user.create.before`
 * is the one place every creation path funnels through — email sign-up, Google
 * sign-in, and the admin school-owner provisioning that calls `signUpEmail`
 * server-side — which is exactly the property a constraint needs.
 *
 * Throwing an `APIError` from the hook aborts the create and propagates verbatim:
 * Better Auth's sign-up route re-throws anything that is already an `APIError`
 * (`if (isAPIError(e)) throw e`), so our `code` survives to the client instead of
 * being flattened into a generic `FAILED_TO_CREATE_USER`.
 */

/**
 * Wire-compatible stand-in for better-call's `APIError`, declared here rather
 * than imported from `better-auth/api`.
 *
 * Two reasons, in order of importance:
 *
 *  1. `better-auth/api` is ESM-only. Importing it pulls an `import` statement
 *     into a module that Jest loads as CommonJS, which fails outright — so the
 *     guard could not be unit-tested at all without ESM-transforming a large
 *     dependency tree in the Jest config.
 *  2. It keeps the validation rules free of a framework dependency.
 *
 * This is safe because the framework identifies its errors by DUCK TYPE, not by
 * `instanceof`: both `@better-auth/core`'s and better-call's `isAPIError` accept
 * anything whose `name` is `'APIError'`. The response builder then reads `body`,
 * `statusCode` and `headers` off it. All four are provided below, and
 * `signup-guard.spec.ts` pins that contract so a future upgrade that tightens
 * the check fails loudly here instead of silently degrading every coded
 * rejection into a generic 500.
 */
export class AuthApiError extends Error {
  readonly name = 'APIError';
  readonly status: string;
  readonly statusCode: number;
  readonly body: { code: string; message: string };
  readonly headers: Record<string, string> = {};

  constructor(
    status: 'UNPROCESSABLE_ENTITY' | 'CONFLICT',
    body: { code: string; message: string },
  ) {
    super(body.message);
    this.status = status;
    this.statusCode = status === 'CONFLICT' ? 409 : 422;
    this.body = body;
  }
}

/** The subset of the create payload this guard reads and rewrites. */
export interface UserCreateData {
  name?: string;
  fullName?: string;
  email?: string;
  phoneNumber?: string;
  phoneHash?: string;
  [key: string]: unknown;
}

const logger = new Logger('AuthSignup');

/**
 * Reject with a coded, field-scoped error.
 *
 * `422 Unprocessable Entity` matches what Better Auth already returns for a
 * duplicate email, so the client sees one consistent status for "your input was
 * understood and refused" across every sign-up rejection.
 */
function reject(code: AuthErrorCode, fields: Record<string, unknown>): never {
  logAuthEvent(logger, AUTH_EVENTS.SIGNUP_REJECTED, 'rejected', {
    reason: code,
    field: AUTH_ERROR_FIELDS[code],
    ...fields,
  });
  throw new AuthApiError('UNPROCESSABLE_ENTITY', {
    code,
    message: AUTH_ERROR_MESSAGES[code],
  });
}

/**
 * Collapse a display name to what should actually be stored.
 *
 * Strips Unicode control/format characters and collapses runs of whitespace, so
 * `"  Ada   Lovelace \n"` stores as `"Ada Lovelace"`. This is sanitizing in
 * the sense that matters for a value that will be rendered back into the UI and
 * into receipts: no invisible characters, no smuggled newlines, no padding used
 * to impersonate another parent's name.
 *
 * Note this is NOT escaping — React escapes on render, and escaping at the
 * storage layer would double-encode. The job here is normalisation.
 */
export function sanitizeName(raw: string): string {
  return (
    raw
      .split('')
      .filter((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        // Zero-width characters are invisible padding: delete them outright, so
        // `Ada<ZWSP>Lovelace` cannot masquerade as a distinct name from
        // `AdaLovelace`.
        if ([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].includes(code)) {
          return false;
        }
        // Control characters that are NOT whitespace (NUL, bell, escape, the C1
        // range) carry no legible meaning: delete them.
        //
        // Whitespace controls — tab, newline, CR, VT, FF — are deliberately KEPT
        // so the collapse below turns them into a single space. Deleting them
        // instead would join the parts of a name typed across a line break:
        // `"Ada\nLovelace"` must become `"Ada Lovelace"`, never `"AdaLovelace"`.
        const isWhitespaceControl = [0x09, 0x0a, 0x0b, 0x0c, 0x0d].includes(
          code,
        );
        if (isWhitespaceControl) return true;
        return !(code <= 0x1f || (code >= 0x7f && code <= 0x9f));
      })
      .join('')
      // Collapse every run of whitespace (now including any surviving newline)
      // to one space.
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Sanitize and validate a user-creation payload, returning the data to persist.
 *
 * Mutates nothing: returns a new object for Better Auth to merge, so the hook
 * stays a pure function of its input plus the uniqueness lookup.
 *
 * @throws APIError with a stable `code` from `AUTH_ERROR_CODES`
 */
export async function guardUserCreate(
  prisma: PrismaClient,
  user: UserCreateData,
): Promise<UserCreateData> {
  const data: UserCreateData = { ...user };

  // ─── Display name ────────────────────────────────────────────────────────────
  // `name` is what Better Auth's schema requires; `fullName` is our domain mirror.
  // Sanitize once and write both, so the two can never disagree.
  const rawName = data.fullName ?? data.name;
  if (typeof rawName === 'string') {
    const name = sanitizeName(rawName);
    if (!name) {
      reject(AUTH_ERROR_CODES.NAME_REQUIRED, { email: data.email });
    }
    if (name.length < 2 || name.length > MAX_NAME_LENGTH) {
      reject(AUTH_ERROR_CODES.NAME_LENGTH, {
        email: data.email,
        nameLength: name.length,
      });
    }
    data.name = name;
    data.fullName = name;
  } else {
    // Google sign-in can arrive without a name; fall back to the mirror rather
    // than rejecting a legitimate social sign-up.
    data.fullName = data.fullName ?? data.name;
  }

  // ─── Phone number ────────────────────────────────────────────────────────────
  // Optional: Google sign-in and admin-provisioned school owners have none. Only
  // validate and index when one was actually supplied.
  const rawPhone = data.phoneNumber;
  if (typeof rawPhone === 'string' && rawPhone.trim()) {
    const canonical = canonicalizePhone(rawPhone);
    if (!canonical) {
      reject(AUTH_ERROR_CODES.PHONE_INVALID, { email: data.email });
    }

    const phoneHash = phoneBlindIndex(canonical);
    if (!phoneHash) {
      // Unreachable: canonical is non-null here, and phoneBlindIndex only returns
      // null for input it cannot canonicalise. Guarded rather than asserted so a
      // future change to either function fails closed instead of storing NULL and
      // silently opting the row out of the uniqueness constraint.
      reject(AUTH_ERROR_CODES.PHONE_INVALID, { email: data.email });
    }

    // The unique index on `phoneHash` is the actual guarantee; this lookup exists
    // to turn the violation into a coded, field-scoped message instead of a
    // Prisma P2002. Two concurrent sign-ups with the same number can still race
    // past this read — the constraint then rejects the loser, which Better Auth
    // surfaces as FAILED_TO_CREATE_USER and the client renders as a generic
    // "try again". Rare enough to accept; the data stays correct either way.
    const existing = await prisma.user.findUnique({
      where: { phoneHash },
      select: { id: true },
    });
    if (existing) {
      reject(AUTH_ERROR_CODES.PHONE_ALREADY_REGISTERED, {
        email: data.email,
        phoneNumber: rawPhone,
      });
    }

    // Store the number as the canonical +234 form. Display formatting is the
    // client's job; keeping one shape in the column means the value the user sees
    // on their profile always matches the one the uniqueness check was made
    // against.
    data.phoneNumber = canonical;
    data.phoneHash = phoneHash;
  }

  logAuthEvent(logger, AUTH_EVENTS.SIGNUP_SUCCEEDED, 'succeeded', {
    email: data.email,
    phoneNumber: data.phoneNumber,
    hasPhone: Boolean(data.phoneHash),
  });

  return data;
}

/**
 * Keep `phoneHash` consistent with `phoneNumber` on any Better Auth-driven user
 * update (e.g. `/update-user`, where `phoneNumber` is a writable additional
 * field).
 *
 * Without this, changing a number through that route would leave the old hash
 * behind: the account would keep reserving a number it no longer has, and its new
 * number would be free for someone else to claim. The hook signature gives us no
 * `where` clause, so we cannot do an "excluding myself" duplicate check here —
 * the unique index catches a genuine collision, and the coded, user-facing path
 * for profile edits is `PATCH /users/me` (see `UsersService.updateProfile`).
 */
export function guardUserUpdate(user: UserCreateData): UserCreateData {
  const data: UserCreateData = { ...user };

  if (typeof data.name === 'string') {
    const name = sanitizeName(data.name);
    if (name) {
      data.name = name;
      data.fullName = name;
    }
  }

  if (typeof data.phoneNumber === 'string' && data.phoneNumber.trim()) {
    const canonical = canonicalizePhone(data.phoneNumber);
    if (!canonical) {
      throw new AuthApiError('UNPROCESSABLE_ENTITY', {
        code: AUTH_ERROR_CODES.PHONE_INVALID,
        message: AUTH_ERROR_MESSAGES.PHONE_INVALID,
      });
    }
    data.phoneNumber = canonical;
    data.phoneHash = phoneBlindIndex(canonical) ?? undefined;
  }

  return data;
}
