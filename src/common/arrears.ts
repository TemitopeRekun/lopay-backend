/**
 * Arrears derivation — how much of an enrollment's balance is *past due* right
 * now, as opposed to merely uncollected.
 *
 * ## Why this exists
 *
 * The admin dashboard used to headline `SUM(remainingBalance)` as "Plan Arrears".
 * That is the total uncollected book, not arrears: a parent who enrolled
 * yesterday and owes eleven on-schedule installments contributed their whole
 * balance to it. The figure could only ever overstate how far behind the
 * platform's parents actually were, so it carried no signal about collection
 * health.
 *
 * ## Why no schema change is needed
 *
 * Lopay does not persist a per-installment schedule, but the schedule is fully
 * determined by data already on the enrollment: `termStartDate`,
 * `installmentFrequency`, and the fixed count for that cadence. How far through
 * that schedule the parent has got is derived from the VALUE of their confirmed
 * installments by `common/installment-schedule.ts` — see that module for why
 * counting payment rows instead reported a parent who paid five weeks ahead as
 * four installments in arrears.
 *
 * Deliberately the same arithmetic the parent-facing enrollment view uses to
 * derive its next-due date and installment size, so an admin chasing a parent
 * quotes the number that parent is looking at. Both now go through
 * `derivePlanProgress` / `installmentDueDate`, so they cannot drift apart.
 *
 * All money is integer kobo in and out; conversion to Naira stays at the DTO
 * boundary (ADR 0001).
 */

// Deliberately not re-exported. Callers import the schedule helpers from
// `installment-schedule` directly — a second path to the same function is how
// the parent view and this module drifted apart in the first place.
import {
  cumulativeTarget,
  derivePlanProgress,
  installmentDueDate,
} from './installment-schedule';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export type ArrearsFrequency = 'WEEKLY' | 'MONTHLY';

export interface ArrearsInput {
  /** Kobo still owed on the plan. */
  remainingBalance: number;
  installmentFrequency: ArrearsFrequency;
  termStartDate: Date;
  termEndDate: Date;
  /**
   * Kobo of CONFIRMED INSTALLMENT payments recorded against this enrollment.
   *
   * Value, not a row count: one transfer covering five slots has to land a
   * parent in the same place as five separate transfers of the same size.
   */
  installmentsPaidKobo: number;
}

export interface ArrearsResult {
  /** Kobo past due as of `now`. Never exceeds `remainingBalance`. */
  overdueAmount: number;
  /** Scheduled installments that should have been paid by `now` but weren't. */
  missedInstallments: number;
  /** Scheduled installments the parent's money has actually closed. */
  paidInstallments: number;
  /** Days since the earliest missed installment fell due; 0 when not overdue. */
  daysOverdue: number;
  /** When the next unpaid installment is/was due. Null once the plan is settled. */
  nextDueDate: Date | null;
  /** True once the term has ended with a balance still outstanding. */
  termExpired: boolean;
}

/**
 * How many installment periods have fully elapsed since `termStartDate`.
 *
 * Weekly is exact arithmetic on the epoch difference. Monthly counts calendar
 * months and then backs off one if the day-of-month boundary hasn't been reached
 * yet, so an installment isn't treated as due before its date.
 */
function elapsedPeriods(
  termStartDate: Date,
  frequency: ArrearsFrequency,
  now: Date,
): number {
  if (now <= termStartDate) return 0;

  if (frequency === 'WEEKLY') {
    return Math.floor((now.getTime() - termStartDate.getTime()) / WEEK_MS);
  }

  const months =
    (now.getFullYear() - termStartDate.getFullYear()) * 12 +
    (now.getMonth() - termStartDate.getMonth());
  if (months <= 0) return 0;

  // Not yet reached this month's due day → the latest period hasn't elapsed.
  const boundaryReached =
    now.getDate() >=
    installmentDueDate(termStartDate, 'MONTHLY', months).getDate();
  return boundaryReached ? months : months - 1;
}

/**
 * Past-due position of a single enrollment.
 *
 * A settled plan (`remainingBalance <= 0`) is never in arrears. Once the term
 * has ended with a balance left, the *entire* balance is past due — that is the
 * same condition the nightly sweep uses to flip an enrollment to DEFAULTED, so
 * the dashboard and the sweep agree on who is behind.
 */
export function computeArrears(
  input: ArrearsInput,
  now: Date = new Date(),
): ArrearsResult {
  const { remainingBalance, installmentFrequency, termStartDate, termEndDate } =
    input;

  const progress = derivePlanProgress({
    remainingBalance,
    installmentsPaidKobo: input.installmentsPaidKobo,
    installmentFrequency,
  });
  const total = progress.totalInstallments;
  const paidInstallments = progress.paidInstallments;

  // A settled plan is never in arrears — but it has still closed every slot its
  // money paid for. Reporting 0 here made the admin's Students tab render
  // "0 paid" against a fully-paid plan.
  if (progress.settled) {
    return {
      overdueAmount: 0,
      missedInstallments: 0,
      paidInstallments,
      daysOverdue: 0,
      nextDueDate: null,
      termExpired: false,
    };
  }

  const termExpired = now > termEndDate;

  const elapsed = elapsedPeriods(termStartDate, installmentFrequency, now);
  const expectedPaid = Math.min(elapsed, total);
  const missedInstallments = Math.max(0, expectedPaid - paidInstallments);

  // The next installment the parent owes, whether or not it is late yet.
  const nextIndex = Math.min(paidInstallments + 1, total);
  const nextDueDate = installmentDueDate(
    termStartDate,
    installmentFrequency,
    nextIndex,
  );

  if (termExpired) {
    const firstMissedDue = installmentDueDate(
      termStartDate,
      installmentFrequency,
      paidInstallments + 1,
    );
    const reference =
      firstMissedDue < termEndDate ? firstMissedDue : termEndDate;
    return {
      overdueAmount: remainingBalance,
      missedInstallments: Math.max(
        missedInstallments,
        total - paidInstallments,
      ),
      paidInstallments,
      daysOverdue: Math.floor((now.getTime() - reference.getTime()) / DAY_MS),
      nextDueDate,
      termExpired: true,
    };
  }

  if (missedInstallments === 0) {
    return {
      overdueAmount: 0,
      missedInstallments: 0,
      paidInstallments,
      daysOverdue: 0,
      nextDueDate,
      termExpired: false,
    };
  }

  // What is past due is the gap between the schedule's cumulative target for the
  // slots that have already come round and what the parent has actually paid.
  //
  // The old form — missed slots × (balance ÷ slots still open) — re-derived a
  // notional installment size from the CURRENT balance, so it neither credited a
  // part-paid slot nor agreed with the figure the parent was quoted. Measuring
  // against the cumulative target does both: pay half a slot late and only the
  // half is in arrears.
  const expectedValue = cumulativeTarget(
    progress.planStartBalance,
    total,
    expectedPaid,
  );

  const firstMissedDue = installmentDueDate(
    termStartDate,
    installmentFrequency,
    paidInstallments + 1,
  );

  return {
    // Can't be past due for more than is owed. Uses the schedule's normalised
    // paid figure so this subtraction and `planStartBalance` above agree.
    overdueAmount: Math.min(
      Math.max(0, expectedValue - progress.installmentsPaidKobo),
      remainingBalance,
    ),
    missedInstallments,
    paidInstallments,
    daysOverdue: Math.max(
      0,
      Math.floor((now.getTime() - firstMissedDue.getTime()) / DAY_MS),
    ),
    nextDueDate,
    termExpired: false,
  };
}
