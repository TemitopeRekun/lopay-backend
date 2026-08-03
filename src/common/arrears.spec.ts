import { computeArrears } from './arrears';

/**
 * Pure schedule/arrears arithmetic. Every figure the admin arrears screen shows
 * lands here, so the boundaries (exactly-on-due-date, term expiry, settled plan)
 * are pinned explicitly rather than inferred from a service test.
 *
 * Progress is expressed in money, not in payment rows — see
 * `installment-schedule.spec.ts` for why. The fixtures below therefore describe
 * a plan by how many SLOTS' worth has been paid and derive both the balance and
 * the paid value from that, so a case reads the way the schedule does.
 */

const TERM_START = new Date('2026-01-05T00:00:00Z'); // a Monday
const TERM_END = new Date('2026-04-05T00:00:00Z');

/** ₦12,000 over 12 weekly slots — ₦1,000 each, no rounding remainder. */
const WEEKLY_PLAN_START = 1_200_000;
const WEEKLY_SLOT = 100_000;

/** ₦3,000 over 3 monthly slots — ₦1,000 each. */
const MONTHLY_PLAN_START = 300_000;
const MONTHLY_SLOT = 100_000;

const weekly = (
  paidKobo = 0,
  overrides: Partial<Parameters<typeof computeArrears>[0]> = {},
) => ({
  remainingBalance: WEEKLY_PLAN_START - paidKobo,
  installmentFrequency: 'WEEKLY' as const,
  termStartDate: TERM_START,
  termEndDate: TERM_END,
  installmentsPaidKobo: paidKobo,
  ...overrides,
});

const monthly = (
  paidKobo = 0,
  overrides: Partial<Parameters<typeof computeArrears>[0]> = {},
) => ({
  remainingBalance: MONTHLY_PLAN_START - paidKobo,
  installmentFrequency: 'MONTHLY' as const,
  termStartDate: TERM_START,
  termEndDate: TERM_END,
  installmentsPaidKobo: paidKobo,
  ...overrides,
});

describe('computeArrears', () => {
  it('reports nothing for a settled plan', () => {
    const res = computeArrears(
      weekly(WEEKLY_PLAN_START),
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(res.overdueAmount).toBe(0);
    expect(res.missedInstallments).toBe(0);
    expect(res.nextDueDate).toBeNull();
    // Settled, but every slot its money paid for is still closed — the admin's
    // Students tab renders this figure as "N paid" and lists settled plans.
    expect(res.paidInstallments).toBe(12);
  });

  it('reports no closed slots on a plan settled by its deposit alone', () => {
    // Paid the whole fee up front: there was never an installment schedule to
    // make progress through, so "12 paid" would be a fiction.
    const res = computeArrears(
      weekly(0, { remainingBalance: 0 }),
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(res.paidInstallments).toBe(0);
    expect(res.nextDueDate).toBeNull();
  });

  it('reports nothing before the term has started', () => {
    const res = computeArrears(weekly(), new Date('2026-01-01T00:00:00Z'));
    expect(res.overdueAmount).toBe(0);
    expect(res.missedInstallments).toBe(0);
  });

  it('does not treat an on-schedule plan as in arrears', () => {
    // Three weeks in, three installments' worth paid.
    const res = computeArrears(
      weekly(3 * WEEKLY_SLOT),
      new Date('2026-01-26T00:00:00Z'),
    );
    expect(res.paidInstallments).toBe(3);
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

  it('prices arrears at what the schedule expected, not a re-spread balance', () => {
    // 4 weeks elapsed, 1 slot paid → 3 missed, each worth its scheduled ₦1,000.
    // The old form divided the CURRENT balance by the slots still open, which
    // quoted a figure the parent was never shown.
    const res = computeArrears(
      weekly(WEEKLY_SLOT),
      new Date('2026-02-02T00:00:00Z'),
    );
    expect(res.missedInstallments).toBe(3);
    expect(res.overdueAmount).toBe(3 * WEEKLY_SLOT);
    // Installment 2 was due 19 Jan.
    expect(res.daysOverdue).toBe(14);
  });

  it('credits a part-paid installment against what is past due', () => {
    // 4 weeks elapsed; one and a half slots paid. Only the unpaid half of slot
    // two is in arrears alongside slots three and four.
    const res = computeArrears(
      weekly(WEEKLY_SLOT + WEEKLY_SLOT / 2),
      new Date('2026-02-02T00:00:00Z'),
    );
    expect(res.paidInstallments).toBe(1);
    expect(res.missedInstallments).toBe(3);
    expect(res.overdueAmount).toBe(
      4 * WEEKLY_SLOT - (WEEKLY_SLOT + WEEKLY_SLOT / 2),
    );
  });

  it('never reports more overdue than is actually owed', () => {
    // Tiny balance, many periods elapsed — the per-installment figure would
    // otherwise multiply past the balance.
    const res = computeArrears(
      weekly(0, { remainingBalance: 5_000 }),
      new Date('2026-03-30T00:00:00Z'),
    );
    expect(res.overdueAmount).toBe(5_000);
  });

  it('treats the whole balance as overdue once the term has expired', () => {
    const res = computeArrears(
      weekly(4 * WEEKLY_SLOT),
      new Date('2026-05-01T00:00:00Z'),
    );
    expect(res.termExpired).toBe(true);
    expect(res.overdueAmount).toBe(WEEKLY_PLAN_START - 4 * WEEKLY_SLOT);
    // All eight unpaid installments count as missed, not just the elapsed ones.
    expect(res.missedInstallments).toBe(8);
    expect(res.daysOverdue).toBeGreaterThan(0);
  });

  it('caps elapsed periods at the scheduled installment count', () => {
    // Long past term start but within term end: can't miss more than 12.
    const res = computeArrears(
      weekly(0, { termEndDate: new Date('2027-01-01T00:00:00Z') }),
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(res.missedInstallments).toBe(12);
  });

  it('handles the monthly cadence', () => {
    // Two months elapsed, none paid → 2 of 3 missed.
    const res = computeArrears(monthly(), new Date('2026-03-06T00:00:00Z'));
    expect(res.missedInstallments).toBe(2);
    expect(res.overdueAmount).toBe(2 * MONTHLY_SLOT);
  });

  it('does not count a monthly period before its day-of-month boundary', () => {
    // 4 Feb is one day short of the 5 Feb due date.
    const res = computeArrears(monthly(), new Date('2026-02-04T00:00:00Z'));
    expect(res.missedInstallments).toBe(0);
  });

  it('reports the next due date for an up-to-date plan', () => {
    const res = computeArrears(
      weekly(2 * WEEKLY_SLOT),
      new Date('2026-01-19T00:00:00Z'),
    );
    // Two paid → installment 3, due 26 Jan.
    expect(res.nextDueDate?.toISOString()).toBe(
      new Date('2026-01-26T00:00:00Z').toISOString(),
    );
  });

  it('leaves the final slot open while any balance remains', () => {
    // A single kobo short of settled must not read as 12 of 12 paid.
    const res = computeArrears(
      weekly(WEEKLY_PLAN_START - 1),
      new Date('2026-03-01T00:00:00Z'),
    );
    expect(res.paidInstallments).toBe(11);
    expect(res.missedInstallments).toBe(0);
    expect(res.overdueAmount).toBe(0);
  });
});

describe('computeArrears — parents who pay ahead', () => {
  it('does not chase a parent who paid five weeks in one transfer', () => {
    // THE REGRESSION: this parent used to show as 4 installments missed and
    // ~₦25,000 overdue, purely because the money arrived as one row.
    const fiveWeeksIn = new Date('2026-02-09T00:00:00Z');
    const res = computeArrears(weekly(5 * WEEKLY_SLOT), fiveWeeksIn);

    expect(res.paidInstallments).toBe(5);
    expect(res.missedInstallments).toBe(0);
    expect(res.overdueAmount).toBe(0);
    expect(res.daysOverdue).toBe(0);
    // Next due is week 6, five weeks past where an unpaid plan would sit.
    expect(res.nextDueDate?.toISOString()).toBe(
      new Date('2026-02-16T00:00:00Z').toISOString(),
    );
  });

  it('reads a lump sum and separate transfers identically', () => {
    const at = new Date('2026-02-09T00:00:00Z');
    const lump = computeArrears(weekly(5 * WEEKLY_SLOT), at);
    const drip = computeArrears(
      weekly([1, 1, 1, 1, 1].reduce((sum, n) => sum + n * WEEKLY_SLOT, 0)),
      at,
    );
    expect(lump).toEqual(drip);
  });

  it('stays clear of arrears for a parent who settled the whole plan early', () => {
    const res = computeArrears(
      weekly(WEEKLY_PLAN_START),
      new Date('2026-02-09T00:00:00Z'),
    );
    expect(res.overdueAmount).toBe(0);
    expect(res.nextDueDate).toBeNull();
  });

  it('still chases them once they fall behind again', () => {
    // Paid 5 slots up front, then nothing for two more months.
    const res = computeArrears(
      weekly(5 * WEEKLY_SLOT),
      new Date('2026-03-16T00:00:00Z'),
    );
    // 10 periods elapsed, 5 covered.
    expect(res.missedInstallments).toBe(5);
    expect(res.overdueAmount).toBe(5 * WEEKLY_SLOT);
  });
});
