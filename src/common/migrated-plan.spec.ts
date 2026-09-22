import { PaymentStatus, PaymentType } from '../generated/prisma/client';
import { MIGRATED_ENROLLMENT_PLATFORM_FEE_RATE } from './fees';
import {
  MOVED_THROUGH_LOPAY,
  deriveMigratedPlan,
  migratedPaymentDate,
  statusAfterMigratedAmendment,
} from './migrated-plan';
import { derivePlanProgress } from './installment-schedule';
import { computeArrears } from './arrears';
import { Money } from './money';

const naira = (n: number) => Money.fromNaira(n).toKobo();

/**
 * These pin the arithmetic a migrated plan opens with, and — more importantly —
 * that the rest of the system reads that opening position correctly. The second
 * half is the point: the feature is only correct because a migrated payment is
 * NOT an installment, and that is a property of how other modules count.
 */
describe('deriveMigratedPlan', () => {
  it('credits what was paid and leaves the rest owing', () => {
    const figures = deriveMigratedPlan({
      totalSchoolFee: naira(100_000),
      amountAlreadyPaid: naira(40_000),
    });

    expect(figures.remainingBalance).toBe(naira(60_000));
    expect(figures.paymentStatus).toBe(PaymentStatus.ACTIVE);
  });

  it('completes a plan whose fees were already paid in full', () => {
    const figures = deriveMigratedPlan({
      totalSchoolFee: naira(100_000),
      amountAlreadyPaid: naira(100_000),
    });

    expect(figures.remainingBalance).toBe(0);
    expect(figures.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });

  it('opens the whole fee as owing when nothing has been paid', () => {
    // A school may migrate a family who has paid nothing yet, purely to get them
    // onto a Lopay plan. That is valid, not an error.
    const figures = deriveMigratedPlan({
      totalSchoolFee: naira(100_000),
      amountAlreadyPaid: 0,
    });

    expect(figures.remainingBalance).toBe(naira(100_000));
    expect(figures.paymentStatus).toBe(PaymentStatus.ACTIVE);
  });

  it('charges no platform fee', () => {
    // The money never passed through the Paystack split, so there is nothing to
    // take a percentage of. Asserted against the constant rather than a literal
    // so a deliberate pricing change updates one place and this follows.
    expect(MIGRATED_ENROLLMENT_PLATFORM_FEE_RATE).toBe(0);
    expect(
      deriveMigratedPlan({
        totalSchoolFee: naira(250_000),
        amountAlreadyPaid: naira(125_000),
      }).platformFee,
    ).toBe(0);
  });

  it('never yields a negative balance even if given impossible input', () => {
    // The DTO, the service and a CHECK constraint all prevent this. The clamp is
    // the last line before a negative balance would reach the ledger.
    expect(
      deriveMigratedPlan({
        totalSchoolFee: naira(10_000),
        amountAlreadyPaid: naira(25_000),
      }).remainingBalance,
    ).toBe(0);
  });

  it('is exact to the kobo on a fee that does not divide evenly', () => {
    const figures = deriveMigratedPlan({
      totalSchoolFee: 100_001,
      amountAlreadyPaid: 33_334,
    });
    expect(figures.remainingBalance).toBe(66_667);
  });

  describe('how the rest of the system reads the result', () => {
    const totalSchoolFee = naira(120_000);
    const amountAlreadyPaid = naira(30_000);
    const { remainingBalance } = deriveMigratedPlan({
      totalSchoolFee,
      amountAlreadyPaid,
    });

    it('spreads only the REMAINING balance over the schedule', () => {
      // The load-bearing assertion for the whole feature. `derivePlanProgress`
      // reconstructs the opening balance as `remainingBalance + confirmed
      // INSTALLMENTS`; a migrated payment is not an installment, so it
      // contributes nothing and the schedule opens from ₦90,000 — not from the
      // full ₦120,000 it would have if the prior payment had been recorded as
      // installments.
      const progress = derivePlanProgress({
        remainingBalance,
        installmentsPaidKobo: 0,
        installmentFrequency: 'MONTHLY',
      });

      expect(progress.paidInstallments).toBe(0);
      expect(progress.nextInstallmentAmount).toBe(naira(30_000));
    });

    it('does not report a freshly migrated plan as in arrears', () => {
      const now = new Date('2026-09-19T12:00:00.000Z');
      const arrears = computeArrears(
        {
          remainingBalance,
          installmentFrequency: 'MONTHLY',
          termStartDate: now,
          termEndDate: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
          installmentsPaidKobo: 0,
        },
        now,
      );

      expect(arrears.overdueAmount).toBe(0);
      expect(arrears.missedInstallments).toBe(0);
      expect(arrears.daysOverdue).toBe(0);
    });
  });
});

describe('MOVED_THROUGH_LOPAY', () => {
  it('excludes migrated money and nothing else', () => {
    // Spread into a caller's `where`, so it must be exactly one clause and it
    // must be a negation — an allow-list of the other two types would silently
    // drop any PaymentType added later.
    expect(MOVED_THROUGH_LOPAY).toEqual({
      paymentType: { not: PaymentType.MIGRATED_PAYMENT },
    });
  });

  it('composes with a caller’s own conditions rather than replacing them', () => {
    const where = {
      schoolId: 's1',
      isConfirmed: true,
      ...MOVED_THROUGH_LOPAY,
    };

    expect(where).toEqual({
      schoolId: 's1',
      isConfirmed: true,
      paymentType: { not: PaymentType.MIGRATED_PAYMENT },
    });
  });

  it('does not exclude the payment types that DID move through Lopay', () => {
    // The filter is about the rail, not about confirmation. A first payment and
    // an installment both reach the school through Lopay and must keep counting.
    const excluded = (type: PaymentType) =>
      MOVED_THROUGH_LOPAY.paymentType.not === type;

    expect(excluded(PaymentType.MIGRATED_PAYMENT)).toBe(true);
    expect(excluded(PaymentType.FIRST_PAYMENT)).toBe(false);
    expect(excluded(PaymentType.INSTALLMENT)).toBe(false);
  });
});

/**
 * The date a migrated payment row carries.
 *
 * The bug this closes was not visible on the plan it belongs to — it was
 * visible on the ADMIN dashboard, where `recentTransactions` orders by
 * `paymentDate desc` with no upper bound and a future-dated confirmed payment
 * outranks everything that actually happened recently.
 */
describe('migratedPaymentDate', () => {
  const now = new Date('2026-09-22T10:00:00.000Z');

  it('uses the handover date when it has already happened', () => {
    // The ordinary case: the invite is issued and claimed around the handover,
    // and the row belongs at the head of the plan's history rather than after
    // instalments that may already have been paid against it.
    const handover = new Date('2026-09-01T00:00:00.000Z');

    expect(migratedPaymentDate(handover, now)).toEqual(handover);
  });

  it('uses the handover date when it is today', () => {
    expect(migratedPaymentDate(now, now)).toEqual(now);
  });

  it('never dates a confirmed payment into the future', () => {
    // `validatePlanStart` allows a start date up to MAX_PLAN_START_FUTURE_DAYS
    // ahead so a school can set next term's migrations up early, which made
    // this reachable through ordinary use rather than through a mistake.
    const nextTerm = new Date('2027-01-10T00:00:00.000Z');

    expect(migratedPaymentDate(nextTerm, now)).toEqual(now);
  });

  it('clamps to now even one millisecond past it', () => {
    const justAhead = new Date(now.getTime() + 1);

    expect(migratedPaymentDate(justAhead, now)).toEqual(now);
  });

  it('holds across the whole permitted future range', () => {
    // Swept rather than spot-checked, because the guard is an inequality and
    // the failure it prevents is silent — nothing throws, the row just sorts
    // above everything else until the date passes.
    for (const days of [1, 7, 30, 90, 180, 364, 365]) {
      const start = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      expect(migratedPaymentDate(start, now).getTime()).toBeLessThanOrEqual(
        now.getTime(),
      );
    }
  });
});

/**
 * What a correction may and may not say about where a family stands.
 *
 * The rule exists because re-deriving the status from the balance alone
 * silently un-defaulted a family: a migrated plan runs exactly the cadence's
 * span, so reaching `termEndDate` with a balance is ordinary, and a school
 * fixing a typo afterwards is not a statement that the parent has caught up.
 */
describe('statusAfterMigratedAmendment', () => {
  it('completes a plan whose corrected balance reaches zero', () => {
    expect(statusAfterMigratedAmendment(PaymentStatus.ACTIVE, 0)).toBe(
      PaymentStatus.COMPLETED,
    );
  });

  it('completes from ANY prior state, including DEFAULTED', () => {
    // Settling is the one transition the new balance genuinely determines: a
    // family that owes nothing is not in default, whatever the sweep last saw.
    expect(statusAfterMigratedAmendment(PaymentStatus.DEFAULTED, 0)).toBe(
      PaymentStatus.COMPLETED,
    );
  });

  it('reopens a COMPLETED plan when the correction restores a balance', () => {
    expect(statusAfterMigratedAmendment(PaymentStatus.COMPLETED, 5_000)).toBe(
      PaymentStatus.ACTIVE,
    );
  });

  it('leaves an ACTIVE plan active', () => {
    expect(statusAfterMigratedAmendment(PaymentStatus.ACTIVE, 5_000)).toBe(
      PaymentStatus.ACTIVE,
    );
  });

  it('KEEPS a defaulted plan defaulted when a balance remains', () => {
    // The regression this file exists to prevent. Returning ACTIVE here clears
    // the school's "Defaulted Amount" tile, the admin's defaulted count and the
    // arrears escalation, until the next sweep silently puts them all back.
    expect(statusAfterMigratedAmendment(PaymentStatus.DEFAULTED, 5_000)).toBe(
      PaymentStatus.DEFAULTED,
    );
  });

  it('does not resurrect a FAILED plan', () => {
    // Unreachable today — a migrated plan has no Paystack payment to dispute —
    // but the rule is "preserve what the correction does not decide", and an
    // exception carved out of that is how it stops being true.
    expect(statusAfterMigratedAmendment(PaymentStatus.FAILED, 5_000)).toBe(
      PaymentStatus.FAILED,
    );
  });

  it('treats a negative balance as settled rather than as a state of its own', () => {
    // `amendMigratedPayment` refuses an overpayment before reaching here, so
    // this is defence in depth: if one ever arrives, COMPLETED is the honest
    // answer and ACTIVE-with-a-negative-balance is not.
    expect(statusAfterMigratedAmendment(PaymentStatus.ACTIVE, -1)).toBe(
      PaymentStatus.COMPLETED,
    );
  });
});
