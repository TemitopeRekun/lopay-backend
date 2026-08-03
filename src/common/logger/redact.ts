import { createHash } from 'crypto';

/**
 * Redaction for values that must never reach a log sink in the clear.
 *
 * Logs travel further than the database: Render's log stream, Sentry breadcrumbs,
 * and anyone with dashboard access. An email or phone number written verbatim to
 * stdout has effectively left the encrypted-at-rest boundary that `pii-crypto.ts`
 * establishes, which would make the encryption theatre. Everything here is
 * one-way — these helpers exist to make a log line *diagnosable*, never
 * reversible.
 *
 * The masked forms deliberately keep just enough shape for a human to correlate a
 * support report ("I signed up with ada@…") with a log line, and no more.
 */

/**
 * `ada.lovelace@gmail.com` → `a***e@gmail.com`
 *
 * Keeps the domain (useful signal: which provider, is it a corporate address, is
 * a bot hammering one domain) and the first/last local-part character. Short
 * local parts collapse to `***` rather than leaking the whole thing.
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '<none>';
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return '<malformed>';
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const maskedLocal =
    local.length <= 2 ? '***' : `${local[0]}***${local[local.length - 1]}`;
  return `${maskedLocal}@${domain}`;
}

/**
 * `08012345678` → `***5678`
 *
 * Last four digits only — the standard "is this the number you gave us?"
 * affordance, which a support agent can confirm against a caller without the log
 * itself identifying anyone.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '<none>';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

/**
 * Stable short fingerprint for correlating log lines about the same value without
 * storing the value. UNKEYED sha256 — so this is NOT safe for low-entropy inputs
 * (an email or phone number could be recovered by brute force). Use it for
 * high-entropy identifiers, or alongside a masked form purely as a join key
 * within one log stream.
 */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * Email-shaped substrings anywhere in free text. Intentionally loose on the local
 * part (anything but whitespace, `@` and a trailing `'`/`"`/`,`) because the goal is
 * to catch what a *logger* emitted, not to validate an address — a near-miss that
 * still identifies a person is exactly what must not survive.
 */
const EMAIL_IN_TEXT = /[^\s@'"<>,;]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Mask every email inside an arbitrary string.
 *
 * `redactFields` can only protect a bag of keys we assembled ourselves. Third-party
 * code does not cooperate: Better Auth logs `User not found` with the raw address
 * attached, at error level, on every failed sign-in — which put plaintext parent
 * emails into the Render log stream and straight past the discipline the rest of
 * this module enforces. So text from outside gets scanned rather than trusted.
 *
 * `'ada@x.com' is taken` → `'a***a@x.com' is taken`
 */
export function redactText(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (match) => maskEmail(match));
}

/** Field names whose values are replaced wholesale by `redactFields`. */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'token',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'secret',
  'authorization',
  'cookie',
  'accountNumber',
]);

/** Keys masked into a partial form rather than dropped entirely. */
const MASKED_KEYS: Record<string, (v: string) => string> = {
  email: maskEmail,
  ownerEmail: maskEmail,
  phone: maskPhone,
  phoneNumber: maskPhone,
};

/**
 * Shallow-redact a bag of log fields: secrets become `[redacted]`, contact
 * details become their masked form, everything else passes through.
 *
 * Shallow by design — log payloads assembled by hand are flat, and a deep walk
 * would invite passing whole request bodies or ORM entities into a logger, which
 * is how PII leaks in the first place. Build the bag explicitly.
 */
export function redactFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEYS.has(key)) {
      out[key] = '[redacted]';
      continue;
    }
    const mask = MASKED_KEYS[key];
    if (mask && typeof value === 'string') {
      out[key] = mask(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}
