import {
  computeArrears,
  installmentCountFor,
  installmentDueDate,
} from './arrears';

/**
 * Pure schedule/arrears arithmetic. Every figure the admin arrears screen shows
 * lands here, so the boundaries (exactly-on-due-date, term expiry, settled plan)
 * are pinned explicitly rather than inferred from a service test.
 */

const TERM_START = new Date('2026-01-05T00:00:00Z'); // a Monday
const TERM_END = new Date('2026-04-05T00:00:00Z');

const weekly = (
  overrides: Partial<Parameters<typeof computeArrears>[0]> = {},
) => ({
  remainingBalance: 1_200_000, // ₦12,000 in kobo
  installmentFrequency: 'WEEKLY' as const,
  termStartDate: TERM_START,
  termEndDate: TERM_END,
  paidInstallments: 0,
  ...overrides,
});

const monthly = (
  overrides: Partial<Parameters<typeof computeArrears>[0]> = {},
) => ({
  remainingBalance: 300_000,
  installmentFrequency: 'MONTHLY' as const,
  termStartDate: TERM_START,
  termEndDate: TERM_END,
  paidInstallments: 0,
  ...overrides,
});

describe('installmentCountFor', () => {
  it('uses the shared cadence constants', () => {
    expect(installmentCountFor('WEEKLY')).toBe(12);
    expect(installmentCountFor('MONTHLY')).toBe(3);
  });
});

describe('installmentDueDate', () => {
  it('steps weekly installments by 7 days', () => {
    expect(installmentDueDate(TERM_START, 'WEEKLY', 1).toISOString()).toBe(
      new Date('2026-01-12T00:00:00Z').toISOString(),
    );
    expect(installmentDueDate(TERM_START, 'WEEKLY', 3).toISOString()).toBe(
      new Date('2026-01-26T00:00:00Z').toISOString(),
    );
  });

  it('steps monthly installments by calendar month', () => {
    const due = installmentDueDate(TERM_START, 'MONTHLY', 2);
    expect(due.getMonth()).toBe(2); // March
    expect(due.getDate()).toBe(TERM_START.getDate());
  });

  it('clamps a month-end start date instead of rolling into the next month', () => {
    // 31 Jan + 1 month must be 28/29 Feb, never 2/3 March.
    const jan31 = new Date(2026, 0, 31);
    const due = installmentDueDate(jan31, 'MONTHLY', 1);
    expect(due.getMonth()).toBe(1); // February
    expect(due.getDate()).toBe(28); // 2026 is not a leap year
  });
});

describe('computeArrears', () => {
  it('reports nothing for a settled plan', () => {
    const res = computeArrears(
      weekly({ remainingBalance: 0, paidInstallments: 12 }),
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(res.overdueAmount).toBe(0);
    expect(res.missedInstallments).toBe(0);
    expect(res.nextDueDate).toBeNull();
  });

  it('reports nothing before the term has started', () => {
    const res = computeArrears(weekly(), new Date('2026-01-01T00:00:00Z'));
    expect(res.overdueAmount).toBe(0);
    expect(res.missedInstallments).toBe(0);
  });

  it('does not treat an on-schedule plan as in arrears', () => {
    // Three weeks in, three installments paid.
    const res = computeArrears(
      weekly({ paidInstallments: 3 }),
      new Date('2026-01-26T00:00:00Z'),
    );
    expect(res.overdueAmount).toBe(0);
    expect(res.missedInstallments).toBe(0);
    expect(res.daysOverdue).toBe(0);
  });

  it('is not overdue on the exact due date', () => {
    // Week 1 falls due 12 Jan; one period has elapsed and nothing is paid, so
    // that installment is due today — counted as missed the moment it lands.
    const res = computeArrears(weekly(), new Date('2026-01-12T00:00:00Z'));
    expect(res.missedInstallments).toBe(1);
    expect(res.daysOverdue).toBe(0);
  });

  it('counts missed installments and prices them off the current balance', () => {
    // 4 weeks elapsed, 1 paid → 3 missed. Balance spread over the 11 still
    // outstanding: 1,200,000 / 11 = 109,091 kobo each.
    const res = computeArrears(
      weekly({ paidInstallments: 1 }),
      new Date('2026-02-02T00:00:00Z'),
    );
    expect(res.missedInstallments).toBe(3);
    expect(res.overdueAmount).toBe(3 * Math.round(1_200_000 / 11));
    // Installment 2 was due 19 Jan.
    expect(res.daysOverdue).toBe(14);
  });

  it('never reports more overdue than is actually owed', () => {
    // Tiny balance, many periods elapsed — the per-installment figure would
    // otherwise multiply past the balance.
    const res = computeArrears(
      weekly({ remainingBalance: 5_000, paidInstallments: 0 }),
      new Date('2026-03-30T00:00:00Z'),
    );
    expect(res.overdueAmount).toBe(5_000);
  });

  it('treats the whole balance as overdue once the term has expired', () => {
    const res = computeArrears(
      weekly({ paidInstallments: 4 }),
      new Date('2026-05-01T00:00:00Z'),
    );
    expect(res.termExpired).toBe(true);
    expect(res.overdueAmount).toBe(1_200_000);
    // All eight unpaid installments count as missed, not just the elapsed ones.
    expect(res.missedInstallments).toBe(8);
    expect(res.daysOverdue).toBeGreaterThan(0);
  });

  it('caps elapsed periods at the scheduled installment count', () => {
    // Long past term start but within term end: can't miss more than 12.
    const res = computeArrears(
      weekly({
        termEndDate: new Date('2027-01-01T00:00:00Z'),
        paidInstallments: 0,
      }),
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(res.missedInstallments).toBe(12);
  });

  it('handles the monthly cadence', () => {
    // Two months elapsed, none paid → 2 of 3 missed.
    const res = computeArrears(monthly(), new Date('2026-03-06T00:00:00Z'));
    expect(res.missedInstallments).toBe(2);
    expect(res.overdueAmount).toBe(2 * Math.round(300_000 / 3));
  });

  it('does not count a monthly period before its day-of-month boundary', () => {
    // 4 Feb is one day short of the 5 Feb due date.
    const res = computeArrears(monthly(), new Date('2026-02-04T00:00:00Z'));
    expect(res.missedInstallments).toBe(0);
  });

  it('reports the next due date for an up-to-date plan', () => {
    const res = computeArrears(
      weekly({ paidInstallments: 2 }),
      new Date('2026-01-19T00:00:00Z'),
    );
    // Two paid → installment 3, due 26 Jan.
    expect(res.nextDueDate?.toISOString()).toBe(
      new Date('2026-01-26T00:00:00Z').toISOString(),
    );
  });

  it('clamps a paid count above the schedule rather than going negative', () => {
    const res = computeArrears(
      weekly({ paidInstallments: 99 }),
      new Date('2026-03-01T00:00:00Z'),
    );
    expect(res.missedInstallments).toBe(0);
    expect(res.overdueAmount).toBe(0);
  });
});
