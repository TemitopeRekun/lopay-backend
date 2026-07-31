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
 * `installmentFrequency`, and the fixed count for that cadence
 * (`WEEKLY_INSTALLMENTS` / `MONTHLY_INSTALLMENTS`). Counting confirmed
 * INSTALLMENT payments therefore tells us how many are missing.
 *
 * Deliberately the same arithmetic the parent-facing enrollment view uses to
 * derive its next-due date and installment size, so an admin chasing a parent
 * quotes the number that parent is looking at. If that derivation changes, both
 * must change together.
 *
 * All money is integer kobo in and out; conversion to Naira stays at the DTO
 * boundary (ADR 0001).
 */

import { WEEKLY_INSTALLMENTS, MONTHLY_INSTALLMENTS } from './fees';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export type ArrearsFrequency = 'WEEKLY' | 'MONTHLY';

export interface ArrearsInput {
  /** Kobo still owed on the plan. */
  remainingBalance: number;
  installmentFrequency: ArrearsFrequency;
  termStartDate: Date;
  termEndDate: Date;
  /** Confirmed payments of type INSTALLMENT recorded against this enrollment. */
  paidInstallments: number;
}

export interface ArrearsResult {
  /** Kobo past due as of `now`. Never exceeds `remainingBalance`. */
  overdueAmount: number;
  /** Scheduled installments that should have been paid by `now` but weren't. */
  missedInstallments: number;
  /** Days since the earliest missed installment fell due; 0 when not overdue. */
  daysOverdue: number;
  /** When the next unpaid installment is/was due. Null once the plan is settled. */
  nextDueDate: Date | null;
  /** True once the term has ended with a balance still outstanding. */
  termExpired: boolean;
}

/** Total scheduled installments for a cadence. */
export function installmentCountFor(frequency: ArrearsFrequency): number {
  return frequency === 'WEEKLY' ? WEEKLY_INSTALLMENTS : MONTHLY_INSTALLMENTS;
}

/**
 * The due date of the Nth installment (1-indexed) counted from term start.
 *
 * Month arithmetic goes through setMonth so a 31st-of-the-month term start
 * clamps to a real date rather than rolling into the following month.
 */
export function installmentDueDate(
  termStartDate: Date,
  frequency: ArrearsFrequency,
  n: number,
): Date {
  const due = new Date(termStartDate);
  if (frequency === 'WEEKLY') {
    due.setDate(due.getDate() + 7 * n);
  } else {
    const targetDay = due.getDate();
    due.setDate(1);
    due.setMonth(due.getMonth() + n);
    const lastDayOfTargetMonth = new Date(
      due.getFullYear(),
      due.getMonth() + 1,
      0,
    ).getDate();
    due.setDate(Math.min(targetDay, lastDayOfTargetMonth));
  }
  return due;
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

  if (remainingBalance <= 0) {
    return {
      overdueAmount: 0,
      missedInstallments: 0,
      daysOverdue: 0,
      nextDueDate: null,
      termExpired: false,
    };
  }

  const total = installmentCountFor(installmentFrequency);
  const paidInstallments = Math.max(0, Math.min(input.paidInstallments, total));
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
      daysOverdue: Math.floor((now.getTime() - reference.getTime()) / DAY_MS),
      nextDueDate,
      termExpired: true,
    };
  }

  if (missedInstallments === 0) {
    return {
      overdueAmount: 0,
      missedInstallments: 0,
      daysOverdue: 0,
      nextDueDate,
      termExpired: false,
    };
  }

  // Installment size is the remaining balance spread over the installments that
  // are still outstanding — matching the parent view, which recomputes the
  // per-installment figure from the *current* balance rather than the original.
  const remainingInstallments = Math.max(1, total - paidInstallments);
  const installmentAmount = Math.round(
    remainingBalance / remainingInstallments,
  );

  const firstMissedDue = installmentDueDate(
    termStartDate,
    installmentFrequency,
    paidInstallments + 1,
  );

  return {
    // Can't be past due for more than is owed.
    overdueAmount: Math.min(
      missedInstallments * installmentAmount,
      remainingBalance,
    ),
    missedInstallments,
    daysOverdue: Math.max(
      0,
      Math.floor((now.getTime() - firstMissedDue.getTime()) / DAY_MS),
    ),
    nextDueDate,
    termExpired: false,
  };
}
