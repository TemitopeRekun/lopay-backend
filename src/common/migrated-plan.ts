/**
 * What a pre-Lopay payment means for the plan it opens, and for the plan it
 * later lands on when the school corrects it.
 *
 * This sits in `common/` rather than beside the enrollment-invite feature on
 * purpose. `LedgerService` is the only writer of money state and must not depend
 * on a feature module to work out a balance — that inverts the layering and
 * would make the ledger un-loadable without the invite code. Both the ledger and
 * the invite service depend on this, and it depends on nothing but `fees` and
 * `Money`, exactly like `installment-schedule.ts` and `arrears.ts`.
 *
 * All money is integer kobo (ADR 0001).
 */

import { PaymentStatus, PaymentType } from '../generated/prisma/client';
import { MIGRATED_ENROLLMENT_PLATFORM_FEE_RATE } from './fees';
import { Money } from './money';

export interface MigratedPlanFigures {
  /** Kobo the plan opens owing, after crediting what was already paid. */
  remainingBalance: number;
  /** Always zero today — see `MIGRATED_ENROLLMENT_PLATFORM_FEE_RATE` for why. */
  platformFee: number;
  /** ACTIVE, or COMPLETED when the parent has already paid the fee in full. */
  paymentStatus: PaymentStatus;
}

/**
 * Turn the two figures on an enrollment invite into the plan they imply.
 *
 * The property that makes the whole feature work, and the reason this is a named
 * function rather than three lines at the call site: **the already-paid amount
 * takes the place of the deposit, never of installments.**
 *
 * `common/installment-schedule.ts` does not store a schedule; it reconstructs the
 * plan's opening balance as `remainingBalance + confirmed INSTALLMENT payments`
 * and spreads that over the cadence's fixed slot count. Recording migrated money
 * as installment rows would inflate that sum back to the full fee, and the
 * parent's next-due amount, their progress through the plan, the school's arrears
 * and the admin Overdue tab would all be wrong together — each in a different
 * direction, which is what makes that class of bug so slow to find.
 *
 * Because `PaymentType.MIGRATED_PAYMENT` is not `INSTALLMENT`, none of the
 * installment sums in the codebase pick it up (every one of them filters on
 * equality with INSTALLMENT, not on "anything that isn't a first payment"), while
 * `paidAmount` in `enrollment-view.ts` — which sums ALL confirmed payments — does.
 * That is precisely the behaviour a deposit has, so every existing derivation
 * stays correct with no change to any of them.
 *
 * Callers must have validated `0 <= amountAlreadyPaid <= totalSchoolFee`; the
 * database enforces it as well (`EnrollmentInvite_paid_within_fee`). The clamp
 * here is a last guard against a negative balance reaching the ledger, not a
 * substitute for either.
 */
export function deriveMigratedPlan(invite: {
  totalSchoolFee: number;
  amountAlreadyPaid: number;
}): MigratedPlanFigures {
  const total = Money.fromKobo(invite.totalSchoolFee);
  const paid = Money.fromKobo(invite.amountAlreadyPaid);
  const remainingBalance = Math.max(0, total.subtract(paid).toKobo());

  return {
    remainingBalance,
    platformFee: total.percent(MIGRATED_ENROLLMENT_PLATFORM_FEE_RATE).toKobo(),
    paymentStatus:
      remainingBalance === 0 ? PaymentStatus.COMPLETED : PaymentStatus.ACTIVE,
  };
}

/**
 * Prisma filter fragment selecting payments that actually moved *through* Lopay.
 *
 * ## Why aggregates need this and the plan arithmetic above does not
 *
 * A `MIGRATED_PAYMENT` is a true payment against a plan — it reduces the
 * balance, it belongs in the parent's history, and `paidAmount` in
 * `enrollment-view.ts` is right to sum it. What it is *not* is money Lopay
 * collected. The school banked it in cash or by transfer before Lopay was in
 * the relationship; no rail carried it, no split touched it, and
 * `platformAmount` on the row is zero.
 *
 * That distinction is invisible to any aggregate that filters only on
 * `isConfirmed` / `status`, because the row is written SUCCESS-and-confirmed on
 * purpose (there is no school confirmation step to wait for — the school is the
 * party asserting it). Two such aggregates exist, and both are labelled as
 * collections:
 *
 *   - `SchoolsService.getDashboardStats` → the owner's "School Collections" tile
 *   - `AdminService`'s per-school `collectedAmounts` breakdown
 *
 * Without this filter, the moment a parent claims an invite the school's
 * collections jump by money that was in an exercise book months earlier, dated
 * to the handover so it lands in the current period. Installment and
 * first-payment sums are already safe: every one of them filters on equality
 * with a specific `paymentType` rather than on "anything confirmed".
 *
 * Spread into a `where`, so it composes with the caller's own conditions:
 *
 *     where: { schoolId, isConfirmed: true, ...MOVED_THROUGH_LOPAY }
 */
export const MOVED_THROUGH_LOPAY = {
  paymentType: { not: PaymentType.MIGRATED_PAYMENT },
} as const;

/**
 * When the migrated payment row is dated.
 *
 * ## Why this is not simply `planStartDate`
 *
 * It was, and that was wrong in one direction. `planStartDate` is the handover
 * — the day the family moves onto Lopay — and dating the row to it reads well
 * for the plan's own history, because the migrated payment is that plan's
 * opening entry and belongs at or before its first installment.
 *
 * But `validatePlanStart` deliberately allows a start date up to
 * `MAX_PLAN_START_FUTURE_DAYS` ahead, so a school can set next term's
 * migrations up early. That makes `planStartDate` a date in the FUTURE, and a
 * confirmed payment dated in the future is wrong on every reading of it:
 *
 *   - it is not when the money was paid — that was months ago, off-platform,
 *     which is the whole premise of a migrated payment;
 *   - it is not when the record was made — that is now, at claim time;
 *   - and `AdminService.recentTransactions` orders by `paymentDate desc` with
 *     no upper bound, so every such row pins itself above genuinely recent
 *     activity on the platform dashboard until that date passes. A school
 *     migrating twenty families for next term displaces the entire list.
 *
 * ## Why clamp rather than always use `now`
 *
 * Because the ordering argument for `planStartDate` is real whenever it is in
 * the past, which is the ordinary case: the invite is issued and claimed around
 * the handover, and the row should sit at the head of the plan rather than
 * after installments that may already have been paid against it. Clamping keeps
 * that and removes only the impossible half of the range.
 *
 * The result is therefore "the handover, or now if the handover has not
 * happened yet" — which is exactly what the row means: the moment this money
 * became part of a Lopay plan.
 */
export function migratedPaymentDate(planStartDate: Date, now: Date): Date {
  return planStartDate.getTime() > now.getTime() ? now : planStartDate;
}

/**
 * The plan's status after its migrated figure has been corrected.
 *
 * ## Why the status is not simply re-derived from the balance
 *
 * `deriveMigratedPlan` answers ACTIVE-or-COMPLETED because it is opening a plan
 * and those are the only two states a new plan can be in. A correction is not
 * opening anything: it lands on a plan that has been alive for weeks and may
 * have moved on to a state the balance alone cannot reconstruct.
 *
 * `DEFAULTED` is the case that matters. `DefaulterDetectionService` flips an
 * ACTIVE enrollment to DEFAULTED once `termEndDate` has passed with a balance
 * outstanding, and a migrated plan runs exactly the cadence's span, so reaching
 * that cliff is ordinary rather than exceptional. Re-deriving ACTIVE from a
 * non-zero balance would silently un-default that family: the school's
 * "Defaulted Amount" tile, the admin's defaulted count and the arrears
 * escalation all stop seeing them until the next sweep puts it back. A
 * correction to a number is not a statement that the family is up to date.
 *
 * So only two transitions are the correction's to make, and they are the two
 * the new balance genuinely determines:
 *
 *   - **settling** — the balance reaches zero, so the plan is COMPLETED
 *     whatever it was before;
 *   - **reopening** — the plan was COMPLETED and the correction re-opens a
 *     balance, so it returns to ACTIVE.
 *
 * Everything else is preserved. This is the same rule `LedgerService.reversePayment`
 * already applies (`reopened ? ACTIVE : before.paymentStatus`); stating it once
 * here means the two cannot drift.
 *
 * `current` must be read under the same row lock as the balance it is written
 * with, or this decides against a status that has since moved.
 */
export function statusAfterMigratedAmendment(
  current: PaymentStatus,
  nextBalance: number,
): PaymentStatus {
  if (nextBalance <= 0) return PaymentStatus.COMPLETED;
  if (current === PaymentStatus.COMPLETED) return PaymentStatus.ACTIVE;
  return current;
}
