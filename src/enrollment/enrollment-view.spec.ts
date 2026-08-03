import {
  EnrollmentPaymentRow,
  EnrollmentRow,
  summariseParentDashboard,
  toEnrollmentView,
} from './enrollment-view';

/**
 * The projection the parent dashboard renders. Every figure a parent acts on —
 * what to pay next, when it is due, what is left — is decided here, so the
 * flexible-payment guarantees are pinned against real payment ROWS rather than
 * against the schedule arithmetic alone:
 *
 *   - one transfer covering k installments == k separate transfers;
 *   - paying ahead moves the due date k periods out, not one;
 *   - the quoted amounts always sum to exactly the balance.
 */

const TERM_START = new Date('2026-01-05T00:00:00Z'); // a Monday
const TERM_END = new Date('2026-04-05T00:00:00Z');

/** ₦12,000 remaining over 12 weekly slots of ₦1,000. */
const WEEKLY_PLAN_START = 1_200_000;
const WEEKLY_SLOT = 100_000;

let paymentSeq = 0;

const payment = (
  amountPaid: number,
  overrides: Partial<EnrollmentPaymentRow> = {},
): EnrollmentPaymentRow => ({
  id: `pay-${++paymentSeq}`,
  amountPaid,
  paymentType: 'INSTALLMENT',
  status: 'SUCCESS',
  isConfirmed: true,
  paymentDate: new Date('2026-01-06T00:00:00Z'),
  receiptUrl: null,
  ...overrides,
});

const enrollment = (
  remainingBalance: number,
  overrides: Partial<EnrollmentRow> = {},
): EnrollmentRow => ({
  id: 'enr-1',
  childId: 'child-1',
  schoolId: 'school-1',
  className: 'JSS 1',
  totalSchoolFee: 1_600_000,
  remainingBalance,
  paymentStatus: 'ACTIVE',
  installmentFrequency: 'WEEKLY',
  termStartDate: TERM_START,
  termEndDate: TERM_END,
  createdAt: TERM_START,
  child: { fullName: 'Ada Obi' },
  school: { name: 'Bright Star Academy' },
  ...overrides,
});

/** Build a view from a list of confirmed installment amounts (kobo). */
const viewAfter = (paidAmounts: number[], planStart = WEEKLY_PLAN_START) => {
  const paid = paidAmounts.reduce((a, b) => a + b, 0);
  return toEnrollmentView(
    enrollment(planStart - paid),
    paidAmounts.map((a) => payment(a)).reverse(), // newest first
  );
};

describe('toEnrollmentView — flexible payment', () => {
  it('opens a fresh plan on the first installment', () => {
    const v = viewAfter([]);
    expect(v.nextInstallmentAmount).toBe(1_000); // ₦1,000
    expect(v.installmentsPaid).toBe(0);
    expect(v.installmentsTotal).toBe(12);
    expect(v.nextDueDate).toBe('2026-01-12'); // one week after term start
  });

  it('credits every installment a single lump sum covers', () => {
    // THE REGRESSION: five weeks in one transfer used to count as ONE
    // installment — quoting ₦636.36 over 11 slots and moving the due date a
    // single week.
    const v = viewAfter([5 * WEEKLY_SLOT]);
    expect(v.installmentsPaid).toBe(5);
    expect(v.nextInstallmentAmount).toBe(1_000);
    expect(v.remainingBalance).toBe(7_000);
    expect(v.nextDueDate).toBe('2026-02-16'); // week 6, five weeks on
  });

  it('reads a lump sum and separate transfers identically', () => {
    const lump = viewAfter([5 * WEEKLY_SLOT]);
    const drip = viewAfter(Array.from({ length: 5 }, () => WEEKLY_SLOT));

    expect(drip.installmentsPaid).toBe(lump.installmentsPaid);
    expect(drip.nextInstallmentAmount).toBe(lump.nextInstallmentAmount);
    expect(drip.nextDueDate).toBe(lump.nextDueDate);
    expect(drip.remainingBalance).toBe(lump.remainingBalance);
  });

  it('shows part-payment as credit toward the next installment', () => {
    const v = viewAfter([WEEKLY_SLOT, 40_000]);
    expect(v.installmentsPaid).toBe(1);
    expect(v.creditTowardNextInstallment).toBe(400); // ₦400 of the next ₦1,000
    expect(v.nextInstallmentAmount).toBe(600);
    // Still owes installment 2, so the due date has not moved past it.
    expect(v.nextDueDate).toBe('2026-01-19');
  });

  it('lets a parent clear the whole plan in one payment', () => {
    const v = viewAfter([WEEKLY_PLAN_START]);
    expect(v.remainingBalance).toBe(0);
    expect(v.nextInstallmentAmount).toBe(0);
    expect(v.nextDueDate).toBeNull();
    expect(v.installmentsPaid).toBe(12);
  });

  it('never demands the whole balance just because payments outnumber slots', () => {
    // Twelve ₦500 payments against a 12-slot plan. The old row-count divisor hit
    // zero here and quoted the ENTIRE remaining balance as the next installment.
    const v = viewAfter(Array.from({ length: 12 }, () => 50_000));
    expect(v.remainingBalance).toBe(6_000);
    expect(v.installmentsPaid).toBe(6);
    expect(v.nextInstallmentAmount).toBe(1_000);
  });

  it('quotes amounts that sum to exactly the balance, however odd', () => {
    const planStart = 1_200_007; // indivisible by 12
    const paid: number[] = [];
    let balance = planStart;

    while (balance > 0 && paid.length < 50) {
      const v = viewAfter(paid, planStart);
      const next = Math.round(v.nextInstallmentAmount * 100);
      paid.push(next);
      balance -= next;
    }

    expect(balance).toBe(0);
    expect(paid).toHaveLength(12);
    expect(paid.reduce((a, b) => a + b, 0)).toBe(planStart);
  });
});

describe('toEnrollmentView — money and exposure', () => {
  it('ignores unconfirmed installments when crediting the schedule', () => {
    // A submitted-but-unapproved payment is money the school has not seen. It
    // reserves balance so it can't be spent twice, but it must not advance the
    // schedule or the parent could stop paying on an unverified receipt.
    const v = toEnrollmentView(enrollment(WEEKLY_PLAN_START), [
      payment(5 * WEEKLY_SLOT, {
        status: 'PENDING',
        isConfirmed: false,
      }),
    ]);
    expect(v.installmentsPaid).toBe(0);
    expect(v.remainingBalance).toBe(12_000);
    expect(v.availableBalance).toBe(7_000); // reserved against double-spend
    expect(v.nextInstallmentAmount).toBe(1_000);
  });

  it('does not let a first payment advance the installment schedule', () => {
    // The deposit opens the plan; it is not installment one.
    const v = toEnrollmentView(enrollment(WEEKLY_PLAN_START), [
      payment(4_000_000, { paymentType: 'FIRST_PAYMENT' }),
    ]);
    expect(v.installmentsPaid).toBe(0);
    expect(v.nextInstallmentAmount).toBe(1_000);
  });

  it('serialises only the allow-listed fields', () => {
    const v = toEnrollmentView(enrollment(WEEKLY_PLAN_START), []);
    expect(v).not.toHaveProperty('school');
    expect(v).not.toHaveProperty('totalSchoolFee');
    expect(v.schoolName).toBe('Bright Star Academy');
    expect(v.totalFee).toBe(16_000);
  });

  it('handles the monthly cadence', () => {
    const v = toEnrollmentView(
      enrollment(200_000, { installmentFrequency: 'MONTHLY' }),
      [payment(100_000)],
    );
    expect(v.installmentsTotal).toBe(3);
    expect(v.installmentsPaid).toBe(1);
    expect(v.nextInstallmentAmount).toBe(1_000);
    expect(v.nextDueDate).toBe('2026-03-05'); // month 2
  });

  it('falls back to createdAt when the plan has no term start', () => {
    const v = toEnrollmentView(
      enrollment(WEEKLY_PLAN_START, {
        termStartDate: undefined as unknown as Date,
        createdAt: new Date('2026-02-02T00:00:00Z'),
      }),
      [],
    );
    expect(v.nextDueDate).toBe('2026-02-09');
  });

  it('reports no due date rather than crashing on an unusable anchor', () => {
    // Every unsettled plan reads the anchor now. An Invalid Date is truthy, so
    // serialising one throws RangeError and takes the whole plan list with it.
    const v = toEnrollmentView(
      enrollment(WEEKLY_PLAN_START, {
        termStartDate: new Date('not-a-date'),
        createdAt: undefined as unknown as Date,
      }),
      [],
    );
    expect(v.nextDueDate).toBeNull();
    // The money is still correct — only the date is unknowable.
    expect(v.nextInstallmentAmount).toBe(1_000);
    expect(v.remainingBalance).toBe(12_000);
  });
});

describe('summariseParentDashboard', () => {
  const viewFor = (overrides: Partial<EnrollmentRow>, paid: number[] = []) =>
    toEnrollmentView(
      enrollment(
        WEEKLY_PLAN_START - paid.reduce((a, b) => a + b, 0),
        overrides,
      ),
      paid.map((a) => payment(a)),
    );

  it('sums the next collection across active plans only', () => {
    const summary = summariseParentDashboard([
      viewFor({ id: 'a' }),
      viewFor({ id: 'b' }),
      viewFor({ id: 'c', paymentStatus: 'PENDING' }),
    ]);
    expect(summary.nextCollection.amount).toBe(2_000);
    expect(summary.nextCollection.enrollmentCount).toBe(2);
    expect(summary.activePlans).toBe(2);
    expect(summary.totalPlans).toBe(3);
  });

  it('names the plan when exactly one contributes', () => {
    const summary = summariseParentDashboard([
      viewFor({ id: 'a' }),
      viewFor({ id: 'b', paymentStatus: 'COMPLETED' }),
    ]);
    expect(summary.nextCollection.enrollmentId).toBe('a');
    expect(summary.nextCollection.childName).toBe('Ada Obi');
  });

  it('drops a prepaid plan out of the earliest-due calculation', () => {
    // A parent who paid one plan five weeks ahead should see the OTHER plan's
    // date as the next thing to deal with.
    const behind = viewFor({ id: 'behind' });
    const ahead = viewFor({ id: 'ahead' }, [5 * WEEKLY_SLOT]);
    const summary = summariseParentDashboard([ahead, behind]);
    expect(summary.nextCollection.dueDate).toBe(behind.nextDueDate);
    expect(summary.nextCollection.enrollmentCount).toBe(2);
  });

  it('excludes failed plans from the outstanding total', () => {
    const summary = summariseParentDashboard([
      viewFor({ id: 'a' }),
      viewFor({ id: 'b', paymentStatus: 'FAILED' }),
    ]);
    expect(summary.totalOutstanding).toBe(12_000);
  });
});
