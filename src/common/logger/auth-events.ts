import { Logger } from '@nestjs/common';
import { redactFields } from './redact';

/**
 * Structured events for the account-creation and sign-in surface.
 *
 * ## Why events rather than sentences
 *
 * `logger.warn('signup failed for ' + email)` is unqueryable and leaks PII. The
 * shape here is the opposite: a fixed `event` name, a fixed set of keys, and
 * values that have already been through `redactFields`. That makes the questions
 * you actually ask in an incident answerable with a single filter —
 *
 *   - `event=signup.rejected reason=PHONE_ALREADY_REGISTERED` — how many parents
 *     hit the duplicate-phone wall today? (a spike means a broken re-signup loop,
 *     or one person trying to reuse a number)
 *   - `event=signup.rejected reason=NAME_REQUIRED` — a client-side validation
 *     bypass, since the web form should never let this reach the server
 *   - `event=signup.succeeded` vs `signup.rejected` — the funnel's drop-off
 *
 * ## Contract
 *
 * `outcome` is one of `succeeded` / `rejected` / `failed`, distinguishing "the
 * user was told no for a reason we chose" (rejected — expected, carries a
 * `reason` code) from "something broke" (failed — needs a human). `reason` is
 * always one of the stable codes in `auth-error-codes.ts` or Better Auth's own,
 * never free text, so it can be grouped.
 *
 * Emitted at `log` level for successes and `warn` for rejections: a rejection is
 * not an error (the system worked as designed) but it is the thing you want
 * surfaced when scanning. Genuine faults use `error`.
 */

export type AuthEventOutcome = 'succeeded' | 'rejected' | 'failed';

export interface AuthEventFields {
  /** Stable reason code for a rejection/failure. Omit on success. */
  reason?: string;
  /** Which input the reason belongs to, when it is field-scoped. */
  field?: string;
  /** Correlates with the HTTP access log line and the error response body. */
  requestId?: string | null;
  /** Masked automatically by `redactFields` — pass the raw value. */
  email?: string;
  /** Masked automatically by `redactFields` — pass the raw value. */
  phoneNumber?: string;
  /** Anything else worth filtering on. Keep it flat and non-identifying. */
  [key: string]: unknown;
}

/** The event names in use. A closed set, so a typo can't create a new stream. */
export const AUTH_EVENTS = {
  SIGNUP_SUCCEEDED: 'signup.succeeded',
  SIGNUP_REJECTED: 'signup.rejected',
  PROFILE_PHONE_CHANGED: 'profile.phone_changed',
  PROFILE_PHONE_REJECTED: 'profile.phone_rejected',
} as const;

export type AuthEvent = (typeof AUTH_EVENTS)[keyof typeof AUTH_EVENTS];

/**
 * Emit one structured auth event.
 *
 * Passed an object rather than a string so `JsonLogger` puts it in `meta` as real
 * JSON (it special-cases a single object argument), keeping the line machine
 * -parseable end to end instead of a message that has to be regex'd apart.
 */
export function logAuthEvent(
  logger: Logger,
  event: AuthEvent,
  outcome: AuthEventOutcome,
  fields: AuthEventFields = {},
): void {
  const entry = {
    event,
    outcome,
    ...redactFields(fields),
  };

  if (outcome === 'succeeded') {
    logger.log(entry);
    return;
  }
  if (outcome === 'rejected') {
    logger.warn(entry);
    return;
  }
  logger.error(entry);
}
