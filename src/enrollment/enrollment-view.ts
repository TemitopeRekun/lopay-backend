/**
 * Projection + derivations for everything the parent dashboard renders.
 *
 * Two rules this module exists to enforce:
 *
 *  1. **The server owns every figure.** The client used to re-derive the next
 *     installment (`balance / planCount`), the outstanding balance
 *     (`totalFee - paidAmount`) and the dashboard's "Next Collection Due" total
 *     by summing across enrollments. Each derivation drifted from the ledger in a
 *     different way — the balance one by exactly the platform fee baked into the
 *     first payment. All of it is computed here, once, from the same numbers the
 *     ledger moves, and rendered verbatim.
 *
 *  2. **Nothing ships that wasn't asked for.** `toEnrollmentView` is an explicit
 *     allow-list. Returning `{ ...enrollment }` carried the joined `School` row —
 *     settlement account included — into every parent's dashboard payload, and
 *     leaked the raw kobo columns (`totalSchoolFee`, `platformFee`) alongside
 *     their naira equivalents, where a client picking the wrong one is off by 100×.
 *
 * All money is integer kobo in, naira out (ADR 0001).
 */

import { Money } from './../common/money';
import {
  derivePlanProgress,
  installmentDueDate,
} from '../common/installment-schedule';

export type EnrollmentPaymentRow = {
  id: string;
  amountPaid: number;
  paymentType: string;
  status: string;
  isConfirmed: boolean;
  paymentDate: Date;
  receiptUrl: string | null;
};

export type EnrollmentRow = {
  id: string;
  childId: string;
  schoolId: string;
  className: string;
  totalSchoolFee: number;
  remainingBalance: number;
  paymentStatus: string;
  installmentFrequency: string;
  termStartDate: Date;
  termEndDate: Date;
  createdAt: Date;
  child?: { fullName?: string | null } | null;
  school?: { name?: string | null } | null;
};

/** One payment as the parent's plan card sees it. */
export interface EnrollmentPaymentView {
  id: string;
  amount: number;
  amountPaid: number;
  paymentType: string;
  type: string;
  status: string;
  isConfirmed: boolean;
  date: Date;
  paymentDate: Date;
  receiptUrl: string | null;
}

/** Every field an enrollment exposes to a client. Nothing else is serialized. */
export interface EnrollmentView {
  id: string;
  childId: string;
  schoolId: string;
  className: string;
  paymentStatus: string;
  installmentFrequency: string;
  termStartDate: Date;
  termEndDate: Date;
  studentName: string | null;
  childName: string | null;
  schoolName: string | null;
  totalFee: number;
  paidAmount: number;
  remainingBalance: number;
  availableBalance: number;
  nextDueDate: string | null;
  nextInstallmentAmount: number;
  /** Scheduled installments the parent's money has closed. */
  installmentsPaid: number;
  /** Slots in the plan's schedule (12 weekly / 3 monthly). */
  installmentsTotal: number;
  /** Naira paid into the next installment but not enough to close it. */
  creditTowardNextInstallment: number;
  payments: EnrollmentPaymentView[];
}

/** The parent dashboard's single headline figure, derived server-side. */
export interface NextCollectionSummary {
  /** Naira due at the next collection across every active plan. */
  amount: number;
  /** Earliest due date among the contributing plans (ISO yyyy-mm-dd). */
  dueDate: string | null;
  /** How many plans contribute — drives "Earliest due" vs a single plan's date. */
  enrollmentCount: number;
  /** Set only when exactly one plan contributes, so the card can name it. */
  enrollmentId: string | null;
  childName: string | null;
}

export interface ParentDashboardSummary {
  nextCollection: NextCollectionSummary;
  activePlans: number;
  totalPlans: number;
  /** Naira still owed across every open plan. */
  totalOutstanding: number;
}

/** First usable schedule anchor, or null if neither date is a real date. */
function scheduleAnchor(enrollment: EnrollmentRow): Date | null {
  for (const candidate of [enrollment.termStartDate, enrollment.createdAt]) {
    const date = candidate ? new Date(candidate) : null;
    if (date && !Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/**
 * Project one enrollment (with its payments, newest first) onto the wire.
 *
 * `payments` should be ordered `paymentDate desc` — that order is passed through
 * to the client verbatim. No figure here depends on it: the next due date is
 * derived from the plan's schedule rather than from the most recent payment, and
 * everything else is a sum.
 */
export function toEnrollmentView(
  enrollment: EnrollmentRow,
  payments: EnrollmentPaymentRow[],
): EnrollmentView {
  const confirmedPayments = payments.filter((p) => p.isConfirmed);
  const paidAmountKobo = confirmedPayments.reduce(
    (sum, p) => sum + p.amountPaid,
    0,
  );

  // Installments submitted but not yet approved are already spoken for, so they
  // can't be offered again.
  const pendingInstallmentsKobo = payments
    .filter(
      (p) =>
        p.paymentType === 'INSTALLMENT' &&
        p.status === 'PENDING' &&
        !p.isConfirmed,
    )
    .reduce((sum, p) => sum + p.amountPaid, 0);

  const availableKobo = Math.max(
    0,
    enrollment.remainingBalance - pendingInstallmentsKobo,
  );

  // How far the plan has got is decided by the VALUE paid, not by how many
  // transfers it arrived in — so paying five slots at once and paying five
  // separate slots land in identical state. `common/arrears.ts` reads the same
  // derivation, which is what keeps the parent's next-payment figure and the
  // admin's overdue figure describing the same plan.
  const installmentsPaidKobo = confirmedPayments
    .filter((p) => p.paymentType === 'INSTALLMENT')
    .reduce((sum, p) => sum + p.amountPaid, 0);

  const progress = derivePlanProgress({
    remainingBalance: enrollment.remainingBalance,
    installmentsPaidKobo,
    installmentFrequency: enrollment.installmentFrequency,
  });

  // Due dates are anchored to the term, so paying k slots ahead moves the next
  // date k periods out. Anchoring to the last payment instead advanced it by one
  // period no matter how much was paid.
  //
  // Every unsettled plan now reads the anchor (it used to be consulted only when
  // there were no confirmed payments yet), so an unusable one has to degrade to
  // "no date" rather than build an Invalid Date — `toISOString()` on one of those
  // throws, and it would take the parent's whole plan list down with it.
  const anchor = scheduleAnchor(enrollment);
  const nextDueDate =
    progress.settled || !anchor
      ? null
      : installmentDueDate(
          anchor,
          enrollment.installmentFrequency,
          progress.paidInstallments + 1,
        );

  return {
    id: enrollment.id,
    childId: enrollment.childId,
    schoolId: enrollment.schoolId,
    className: enrollment.className,
    paymentStatus: enrollment.paymentStatus,
    installmentFrequency: enrollment.installmentFrequency,
    termStartDate: enrollment.termStartDate,
    termEndDate: enrollment.termEndDate,
    studentName: enrollment.child?.fullName ?? null,
    childName: enrollment.child?.fullName ?? null,
    schoolName: enrollment.school?.name ?? null,
    totalFee: Money.fromKobo(enrollment.totalSchoolFee).toNaira(),
    paidAmount: Money.fromKobo(paidAmountKobo).toNaira(),
    remainingBalance: Money.fromKobo(enrollment.remainingBalance).toNaira(),
    availableBalance: Money.fromKobo(availableKobo).toNaira(),
    nextDueDate: nextDueDate ? nextDueDate.toISOString().split('T')[0] : null,
    nextInstallmentAmount: Money.fromKobo(
      progress.nextInstallmentAmount,
    ).toNaira(),
    installmentsPaid: progress.paidInstallments,
    installmentsTotal: progress.totalInstallments,
    creditTowardNextInstallment: Money.fromKobo(
      progress.creditTowardNextInstallment,
    ).toNaira(),
    payments: payments.map((p) => ({
      id: p.id,
      amount: Money.fromKobo(p.amountPaid).toNaira(),
      amountPaid: Money.fromKobo(p.amountPaid).toNaira(),
      paymentType: p.paymentType,
      type: p.paymentType,
      status: p.status,
      isConfirmed: p.isConfirmed,
      date: p.paymentDate,
      paymentDate: p.paymentDate,
      receiptUrl: p.receiptUrl,
    })),
  };
}

/**
 * Roll the parent's plans up into the dashboard headline.
 *
 * Only ACTIVE plans contribute. A PENDING plan's first payment hasn't been
 * confirmed, so what is owed there is the first payment (the plan card's own
 * call to action), not an installment; a FAILED plan has no schedule at all.
 * Summing those into "Next Collection Due" quoted parents a number no endpoint
 * would accept.
 */
export function summariseParentDashboard(
  views: EnrollmentView[],
): ParentDashboardSummary {
  const contributing = views.filter(
    (v) =>
      v.paymentStatus === 'ACTIVE' &&
      v.remainingBalance > 0 &&
      v.nextInstallmentAmount > 0,
  );

  const amountKobo = contributing.reduce(
    (sum, v) => sum + Money.fromNaira(v.nextInstallmentAmount).toKobo(),
    0,
  );

  const dueDates = contributing
    .map((v) => v.nextDueDate)
    .filter((d): d is string => !!d)
    .sort();

  const only = contributing.length === 1 ? contributing[0] : null;

  const outstandingKobo = views
    .filter((v) => v.paymentStatus !== 'FAILED')
    .reduce((sum, v) => sum + Money.fromNaira(v.remainingBalance).toKobo(), 0);

  return {
    nextCollection: {
      amount: Money.fromKobo(amountKobo).toNaira(),
      dueDate: dueDates[0] ?? null,
      enrollmentCount: contributing.length,
      enrollmentId: only?.id ?? null,
      childName: only?.childName ?? null,
    },
    activePlans: views.filter((v) => v.paymentStatus === 'ACTIVE').length,
    totalPlans: views.length,
    totalOutstanding: Money.fromKobo(outstandingKobo).toNaira(),
  };
}
