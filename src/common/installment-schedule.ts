/**
 * The canonical installment schedule — the single place that decides how far
 * through a plan a parent's money has carried them.
 *
 * ## Why this exists
 *
 * Progress through a plan used to be measured by COUNTING confirmed installment
 * payment rows. That silently punished any parent who paid flexibly:
 *
 *   - A ₦150,000 payment against a 3 × ₦75,000 monthly plan counted as ONE
 *     installment. The balance was right (₦75,000), but the remainder was then
 *     re-spread over TWO more slots — quoting ₦37,500 and moving the due date
 *     forward by one month instead of two. The parent got no credit for paying
 *     ahead.
 *   - `common/arrears.ts` counted rows the same way, so that same prepaying
 *     parent showed up on the admin/school dashboards as four installments
 *     missed and weeks overdue, while a parent who paid the identical money in
 *     five separate transfers showed clean.
 *   - Past the slot count the divisor went to zero and the app demanded the
 *     ENTIRE remaining balance as "the next installment", so a parent making
 *     many small payments hit a wall on payment number thirteen.
 *
 * Progress is now derived from VALUE. Paying five slots' worth in one transfer
 * and paying five separate slots reach byte-identical state.
 *
 * ## The schedule
 *
 * A plan's schedule is fixed the moment its deposit is credited. That opening
 * figure is not stored, but it does not need to be: for an open plan the balance
 * only ever moves by installment money, so
 *
 *     planStartBalance = remainingBalance + confirmed installments paid
 *
 * holds for the whole life of a PENDING / ACTIVE / DEFAULTED / COMPLETED plan —
 * a reversal restores both sides of it at once.
 *
 * The one path that breaks it is a Paystack dispute
 * (`LedgerService.reversePaystackPaymentByDispute`), which resets the balance to
 * the full school fee while leaving confirmed installment rows in place. That
 * inflates the derived opening balance, so the figures below are only meaningful
 * for a plan that is not FAILED. Nothing quotes a FAILED plan — the parent
 * dashboard summary counts ACTIVE only and the arrears book excludes FAILED —
 * but a caller that starts doing so needs to handle it.
 *
 * Slots are level, rounded DOWN to whole kobo, with the final slot absorbing the
 * remainder — the same convention `PaymentService.calculateInstallments` already
 * uses, so a quoted schedule and a settled one agree to the kobo. Expressed as
 * cumulative targets:
 *
 *     target(n) = floor(planStartBalance / total) * n     for n < total
 *     target(total) = planStartBalance
 *
 * A slot is covered when paid-to-date reaches its cumulative target. Because the
 * next quote is always `target(covered + 1) - paid`, paying a quote advances
 * exactly one slot and paying k quotes advances exactly k — the property the row
 * count only accidentally had.
 *
 * All money is integer kobo (ADR 0001).
 */

import { WEEKLY_INSTALLMENTS, MONTHLY_INSTALLMENTS } from './fees';

export type InstallmentFrequency = 'WEEKLY' | 'MONTHLY';

/** Total scheduled installments for a cadence. */
export function installmentCountFor(frequency: string): number {
  return normaliseFrequency(frequency) === 'WEEKLY'
    ? WEEKLY_INSTALLMENTS
    : MONTHLY_INSTALLMENTS;
}

/**
 * Anything that isn't explicitly weekly is monthly — the same fallback the
 * enrollment view and arrears both applied inline before, kept in one place so
 * an unexpected value can't mean two different cadences to two callers.
 */
export function normaliseFrequency(frequency: string): InstallmentFrequency {
  return String(frequency).trim().toUpperCase() === 'WEEKLY'
    ? 'WEEKLY'
    : 'MONTHLY';
}

/**
 * Kobo that must have been paid, cumulatively, to have closed slot `n`
 * (1-indexed). `n <= 0` is nothing; `n >= total` is the whole schedule, which is
 * what makes the final slot absorb the rounding remainder.
 */
export function cumulativeTarget(
  planStartBalance: number,
  totalInstallments: number,
  n: number,
): number {
  if (n <= 0) return 0;
  if (n >= totalInstallments) return planStartBalance;
  return Math.floor(planStartBalance / totalInstallments) * n;
}

export interface PlanProgressInput {
  /** Kobo still owed on the plan right now. */
  remainingBalance: number;
  /** Kobo of CONFIRMED installment payments recorded against the plan. */
  installmentsPaidKobo: number;
  installmentFrequency: string;
}

export interface PlanProgress {
  /** Slots in this cadence's schedule (12 weekly / 3 monthly). */
  totalInstallments: number;
  /** Kobo the plan owed the moment its schedule opened. */
  planStartBalance: number;
  /**
   * The input's installment value after clamping. Callers doing further
   * arithmetic must use this rather than their own raw input, or they will
   * combine a clamped `planStartBalance` with an unclamped paid figure.
   */
  installmentsPaidKobo: number;
  /** Kobo per recurring slot. The final slot absorbs the remainder. */
  scheduledInstallment: number;
  /** Slots fully covered by money paid — never a row count. */
  paidInstallments: number;
  /** Slots still to close. At least 1 while any balance remains. */
  remainingInstallments: number;
  /** Kobo needed to close the next slot, capped at the balance. */
  nextInstallmentAmount: number;
  /** Kobo already paid into the next slot but not enough to close it. */
  creditTowardNextInstallment: number;
  /** True once nothing is owed. */
  settled: boolean;
}

/**
 * Where a plan stands, derived entirely from money.
 *
 * Inputs are clamped rather than rejected: this runs inside read paths that
 * render dashboards, and a single malformed row must degrade to a sane figure
 * instead of failing a parent's whole plan list.
 */
export function derivePlanProgress(input: PlanProgressInput): PlanProgress {
  const totalInstallments = installmentCountFor(input.installmentFrequency);
  const remainingBalance = Math.max(0, Math.round(input.remainingBalance || 0));
  const installmentsPaidKobo = Math.max(
    0,
    Math.round(input.installmentsPaidKobo || 0),
  );
  const planStartBalance = remainingBalance + installmentsPaidKobo;

  if (remainingBalance <= 0) {
    return {
      totalInstallments,
      planStartBalance,
      installmentsPaidKobo,
      scheduledInstallment: 0,
      paidInstallments: planStartBalance > 0 ? totalInstallments : 0,
      remainingInstallments: 0,
      nextInstallmentAmount: 0,
      creditTowardNextInstallment: 0,
      settled: true,
    };
  }

  const target = (n: number) =>
    cumulativeTarget(planStartBalance, totalInstallments, n);

  // Highest slot whose cumulative target the paid-to-date value has reached.
  // Zero-value targets (a plan whose balance is smaller than its slot count)
  // are skipped so paying nothing can never close a slot.
  let paidInstallments = 0;
  for (let n = 1; n <= totalInstallments; n++) {
    const due = target(n);
    if (due > 0 && installmentsPaidKobo >= due) paidInstallments = n;
  }

  // A plan that still owes money cannot be fully paid up. Unreachable from the
  // targets above (paid < planStartBalance implies paid < target(total)); it
  // guards the paths that can desynchronise the opening-balance derivation — the
  // ledger's reversal clamp (a restored balance capped at the total school fee)
  // and the dispute reset described in this module's header.
  paidInstallments = Math.min(paidInstallments, totalInstallments - 1);

  const nextDue = Math.max(
    0,
    target(paidInstallments + 1) - installmentsPaidKobo,
  );

  return {
    totalInstallments,
    planStartBalance,
    installmentsPaidKobo,
    scheduledInstallment: Math.floor(planStartBalance / totalInstallments),
    paidInstallments,
    remainingInstallments: totalInstallments - paidInstallments,
    // A degenerate schedule (slot target of 0, i.e. a balance smaller than the
    // slot count) would otherwise quote ₦0 forever. Quote the balance instead.
    nextInstallmentAmount:
      nextDue > 0 ? Math.min(nextDue, remainingBalance) : remainingBalance,
    creditTowardNextInstallment: Math.max(
      0,
      installmentsPaidKobo - target(paidInstallments),
    ),
    settled: false,
  };
}

/**
 * The due date of the Nth installment (1-indexed) counted from term start.
 *
 * Due dates are anchored to the TERM, not to when the parent last paid. Anchoring
 * to the last payment meant a parent who paid five weeks ahead still saw a date
 * one week out, and it let the parent's "next due" drift away from the date the
 * admin's arrears screen was quoting for the same plan.
 *
 * Month arithmetic goes through setMonth so a 31st-of-the-month term start clamps
 * to a real date rather than rolling into the following month.
 */
export function installmentDueDate(
  termStartDate: Date,
  frequency: string,
  n: number,
): Date {
  const due = new Date(termStartDate);
  if (normaliseFrequency(frequency) === 'WEEKLY') {
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
