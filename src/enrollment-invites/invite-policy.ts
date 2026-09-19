/**
 * The rules an enrollment invite obeys, as pure functions.
 *
 * Nothing here touches Prisma, Nest, the ambient clock, or `process.env`. That
 * is deliberate: these are the decisions worth testing exhaustively — which
 * statuses still hold a student's slot, when a link dies, what a school-supplied
 * lifetime clamps to — and they are only cheap to test exhaustively while they
 * stay free of I/O. `now` is always a parameter, never `new Date()` read inside,
 * so expiry behaviour is testable without faking timers.
 *
 * The money a claim produces is NOT here: it lives in `common/migrated-plan.ts`,
 * because `LedgerService` needs it and the ledger must not depend on a feature
 * module. This file is the invite's lifecycle; that one is its arithmetic.
 */

import {
  EnrollmentInviteStatus,
  type InstallmentFrequency,
} from '../generated/prisma/client';
import {
  installmentCountFor,
  installmentDueDate,
} from '../common/installment-schedule';

/** How long an invite lives when the school does not say. */
export const DEFAULT_INVITE_EXPIRY_DAYS = 14;

/**
 * Bounds on a school-supplied lifetime.
 *
 * The ceiling is the security-relevant one: the token is a bearer credential
 * sitting in a WhatsApp thread, and the longer it is valid the more chances
 * there are for that thread to be forwarded, backed up, or read on a shared
 * phone. Thirty days is long enough to cover a parent who is slow to respond and
 * short enough that a forgotten invite dies on its own.
 *
 * The floor exists because `Math.min(userValue, MAX)` alone happily accepts zero
 * and negative numbers, which mint an invite that is already expired — a support
 * ticket disguised as a feature.
 */
export const MIN_INVITE_EXPIRY_DAYS = 1;
export const MAX_INVITE_EXPIRY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Statuses that still occupy the one-invite-per-student slot.
 *
 * PENDING and DISPUTED are live. CLAIMED is included because the invite became a
 * real enrollment: issuing a second invite for the same student would mint a
 * duplicate child. REVOKED and EXPIRED are deliberately absent so a school can
 * correct a mistake by revoking and re-issuing.
 *
 * Mirrored by the partial unique index `EnrollmentInvite_live_student_key`. The
 * index is the guarantee; this constant is what lets the service answer with a
 * useful message instead of a raw constraint violation. Both must move together.
 */
export const SLOT_HOLDING_STATUSES: readonly EnrollmentInviteStatus[] = [
  EnrollmentInviteStatus.PENDING,
  EnrollmentInviteStatus.DISPUTED,
  EnrollmentInviteStatus.CLAIMED,
];

/** Statuses an expiry sweep may retire. CLAIMED is always excluded — see `hasExpired`. */
export const EXPIRABLE_STATUSES: readonly EnrollmentInviteStatus[] = [
  EnrollmentInviteStatus.PENDING,
  EnrollmentInviteStatus.DISPUTED,
];

/** Clamp a requested lifetime into the allowed window. */
export function resolveExpiryDays(requested?: number | null): number {
  if (
    requested === undefined ||
    requested === null ||
    !Number.isFinite(requested)
  ) {
    return DEFAULT_INVITE_EXPIRY_DAYS;
  }
  const whole = Math.floor(requested);
  if (whole < MIN_INVITE_EXPIRY_DAYS) return MIN_INVITE_EXPIRY_DAYS;
  if (whole > MAX_INVITE_EXPIRY_DAYS) return MAX_INVITE_EXPIRY_DAYS;
  return whole;
}

/** The absolute instant an invite minted at `now` stops being claimable. */
export function expiryFrom(now: Date, requestedDays?: number | null): Date {
  return new Date(now.getTime() + resolveExpiryDays(requestedDays) * DAY_MS);
}

/**
 * Whether an invite is past its window *and* still in a state expiry can touch.
 *
 * A CLAIMED invite never expires. It has already become an enrollment, and
 * retiring it would both lie about what happened and orphan the audit trail that
 * points at it.
 */
export function hasExpired(
  invite: { status: EnrollmentInviteStatus; expiresAt: Date },
  now: Date,
): boolean {
  return (
    EXPIRABLE_STATUSES.includes(invite.status) &&
    invite.expiresAt.getTime() <= now.getTime()
  );
}

/** Whether a parent may still act on this invite (claim or dispute). */
export function isActionable(status: EnrollmentInviteStatus): boolean {
  return status === EnrollmentInviteStatus.PENDING;
}

/**
 * How far into the past a plan may start.
 *
 * The answer is "essentially not at all", and the allowance is only there to
 * absorb clock skew and the fact that a school in Lagos is on UTC+1 while the
 * server is on UTC — without it, a school setting up invites at 09:00 local on
 * the day of handover would be told their date is in the past.
 *
 * The reason it is not generous is `common/arrears.ts`. `planStartDate` anchors
 * the derived installment schedule, so a plan back-dated two months on a MONTHLY
 * cadence opens with two installments already due: the parent is greeted by an
 * overdue balance on day one, the school sees them on the Overdue tab, and the
 * platform's arrears book is overstated by plans nobody has had a chance to pay.
 * The whole point of anchoring to the handover rather than the historical term
 * start is to avoid exactly that, and a wide back-dating window would hand it
 * straight back.
 */
export const MAX_PLAN_START_BACKDATE_MS = 36 * 60 * 60 * 1000;

/**
 * How far ahead a plan may start. Loose enough for a school setting up next
 * term's migrations early, tight enough that a mistyped year (2027 for 2026) is
 * caught at the door rather than producing a plan that quietly never collects.
 */
export const MAX_PLAN_START_FUTURE_DAYS = 365;

/**
 * When a plan that starts on `planStartDate` finishes.
 *
 * ## Why this is derived and never typed
 *
 * `ChildEnrollment.termEndDate` is not the school's academic term. Everywhere
 * else in the product it is the *plan's* end, set to exactly the cadence's own
 * span: `ConfirmPlanScreen` computes `start + numberOfPayments` months for
 * MONTHLY and `start + numberOfPayments * 7` days for WEEKLY, and that is the
 * only thing that ever writes it. The instalment counts are fixed (ADR 0002),
 * so a plan always runs three months or twelve weeks regardless of how much
 * term is left.
 *
 * That column is load-bearing in two places, and both treat it as a cliff:
 *
 *   - `DefaulterDetectionService` flips every ACTIVE enrollment to DEFAULTED
 *     once it is past and a balance remains;
 *   - `computeArrears` returns the WHOLE remaining balance as overdue and every
 *     unpaid slot as missed the moment `now > termEndDate`.
 *
 * So a hand-typed term end is wrong in both directions, and validation can only
 * narrow the window rather than remove the asymmetry:
 *
 *   - **too early** — the cliff fires before the instalments are even due. The
 *     family is defaulted and their whole balance lands on the admin's Overdue
 *     tab for money nobody has asked them for. On MONTHLY, a term ending inside
 *     a fortnight defaults them before instalment one.
 *   - **too late** — the cliff never fires while the plan is alive, so that one
 *     family is exempt from defaulting and from the term-expiry escalation that
 *     every normally-enrolled family is subject to. The arrears book quietly
 *     under-reports them.
 *
 * Deriving it makes both impossible by construction. It is the same argument
 * the DTO already makes for `totalSchoolFee` — the figures the whole plan is
 * derived from do not belong in a free-text box — and it leaves the invite flow
 * writing the identical value the normal flow would.
 */
export function derivePlanEnd(
  planStartDate: Date,
  installmentFrequency: InstallmentFrequency,
): Date {
  return installmentDueDate(
    planStartDate,
    installmentFrequency,
    installmentCountFor(installmentFrequency),
  );
}

/**
 * Check the date the school chose for the plan to start, returning a message to
 * show them or null when it is sound.
 *
 * Only the start date is checked, because it is the only date the school
 * supplies — the end is `derivePlanEnd`'s, and a derived value has nothing to
 * validate.
 *
 * Returns a message rather than throwing so the rule stays a pure function the
 * unit suite can sweep across boundaries; the service turns it into a
 * `BadRequestException`.
 */
export function validatePlanStart(
  planStartDate: Date,
  now: Date,
): string | null {
  if (Number.isNaN(planStartDate.getTime())) {
    return 'Plan start must be a valid date';
  }

  if (planStartDate.getTime() < now.getTime() - MAX_PLAN_START_BACKDATE_MS) {
    return (
      'The plan start date cannot be in the past. Use the date the parent moves ' +
      'onto Lopay, not the date the term began — back-dating it would show them ' +
      'as already behind on payments.'
    );
  }

  const futureLimit = now.getTime() + MAX_PLAN_START_FUTURE_DAYS * DAY_MS;
  if (planStartDate.getTime() > futureLimit) {
    return `The plan start date cannot be more than ${MAX_PLAN_START_FUTURE_DAYS} days from now`;
  }

  return null;
}
