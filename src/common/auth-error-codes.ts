/**
 * The field-error vocabulary for account creation and sign-in.
 *
 * Every rejection the auth surface can produce has a STABLE machine code and a
 * single owning field. The code is what crosses the wire; the human sentence is
 * chosen by whoever renders it. That split is the whole point: the web client
 * decides where the message appears (inline under the offending input) and how it
 * is worded, without parsing English out of a server response.
 *
 * Mirrored in the web client at `Lopay/utils/validation/codes.ts` — the two lists
 * must stay in step, and `AuthErrorCode` is deliberately a closed union so
 * adding a code here forces a compile error there until it is handled.
 *
 * Codes Better Auth itself emits (`USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`,
 * `PASSWORD_TOO_SHORT`, …) are NOT redefined here — they already have stable
 * names in the library, and the client maps them to a field alongside these. See
 * `Lopay/utils/validation/serverErrors.ts` for that mapping.
 */
export const AUTH_ERROR_CODES = {
  /** `name` was blank, or collapsed to blank once sanitized. */
  NAME_REQUIRED: 'NAME_REQUIRED',
  /** `name` is a single character, or longer than `MAX_NAME_LENGTH`. */
  NAME_LENGTH: 'NAME_LENGTH',
  /** Phone is present but isn't a recognisable Nigerian number. */
  PHONE_INVALID: 'PHONE_INVALID',
  /** Phone canonicalises to the same number as an existing account. */
  PHONE_ALREADY_REGISTERED: 'PHONE_ALREADY_REGISTERED',
} as const;

export type AuthErrorCode =
  (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/** Upper bound on a stored display name. Generous enough for real names,
 * small enough that the column can't be used as free storage. */
export const MAX_NAME_LENGTH = 80;

/**
 * Server-side default wording. The web client overrides these with its own
 * copy; these are the strings a non-browser caller (curl, the native shell's
 * error toast, an integration test) sees, so they must still read as sentences.
 */
export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  NAME_REQUIRED: 'Enter your full name.',
  NAME_LENGTH: `Your name must be between 2 and ${MAX_NAME_LENGTH} characters.`,
  // Ask for the plain 11-digit number. A `+234`/`234` number is still ACCEPTED
  // (canonicalizePhone folds all three spellings together) — but the copy must
  // not imply a country code is required, because most parents type the local
  // form and would read "+234" as an instruction to add something.
  PHONE_INVALID:
    'Enter your 11-digit phone number, starting with 0 (e.g. 08012345678).',
  PHONE_ALREADY_REGISTERED:
    'This phone number is already linked to another account.',
};

/** The input a code belongs to, so a client can attach it without a lookup table
 * of its own. Kept next to the codes so the two can't drift. */
export const AUTH_ERROR_FIELDS: Record<
  AuthErrorCode,
  'fullName' | 'email' | 'phoneNumber' | 'password'
> = {
  NAME_REQUIRED: 'fullName',
  NAME_LENGTH: 'fullName',
  PHONE_INVALID: 'phoneNumber',
  PHONE_ALREADY_REGISTERED: 'phoneNumber',
};
