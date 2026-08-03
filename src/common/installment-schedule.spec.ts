import {
  cumulativeTarget,
  derivePlanProgress,
  installmentCountFor,
  installmentDueDate,
  normaliseFrequency,
} from './installment-schedule';
import { PaymentService } from '../payments/payment.service';

/**
 * The schedule is the contract between three screens — the parent's next
 * payment, the school's confirmation queue and the admin's arrears book — so the
 * properties that make flexible payment safe are pinned here rather than
 * inferred from any one of them:
 *
 *   1. paying k slots' worth in ONE transfer == paying k separate slots;
 *   2. paying the quoted amount always advances exactly one slot;
 *   3. the quotes sum to the balance exactly, whatever the rounding;
 *   4. a plan that still owes money always has at least one slot left to pay.
 */

const WEEKLY_TOTAL = 12;
const MONTHLY_TOTAL = 3;

/** ₦12,000 over 12 weekly slots — ₦1,000 each, no rounding remainder. */
const WEEKLY_PLAN_START = 1_200_000;
const WEEKLY_SLOT = 100_000;

const weekly = (installmentsPaidKobo: number) =>
  derivePlanProgress({
    remainingBalance: WEEKLY_PLAN_START - installmentsPaidKobo,
    installmentsPaidKobo,
    installmentFrequency: 'WEEKLY',
  });

describe('installmentCountFor / normaliseFrequency', () => {
  it('uses the shared cadence constants', () => {
    expect(installmentCountFor('WEEKLY')).toBe(WEEKLY_TOTAL);
    expect(installmentCountFor('MONTHLY')).toBe(MONTHLY_TOTAL);
  });

  it('treats anything that is not weekly as monthly, case-insensitively', () => {
    expect(normaliseFrequency('weekly')).toBe('WEEKLY');
    expect(normaliseFrequency(' Weekly ')).toBe('WEEKLY');
    expect(normaliseFrequency('MONTHLY')).toBe('MONTHLY');
    expect(normaliseFrequency('QUARTERLY')).toBe('MONTHLY');
    expect(installmentCountFor('nonsense')).toBe(MONTHLY_TOTAL);
  });
});

describe('cumulativeTarget', () => {
  it('is level up to the final slot, which absorbs the remainder', () => {
    // 100,001 over 3: floor gives 33,333 per slot, the last takes 33,335.
    expect(cumulativeTarget(100_001, 3, 1)).toBe(33_333);
    expect(cumulativeTarget(100_001, 3, 2)).toBe(66_666);
    expect(cumulativeTarget(100_001, 3, 3)).toBe(100_001);
  });

  it('clamps out-of-range slot numbers', () => {
    expect(cumulativeTarget(100_001, 3, 0)).toBe(0);
    expect(cumulativeTarget(100_001, 3, -4)).toBe(0);
    expect(cumulativeTarget(100_001, 3, 99)).toBe(100_001);
  });
});

describe('derivePlanProgress — schedule position', () => {
  it('opens the schedule at the first slot', () => {
    const p = weekly(0);
    expect(p.planStartBalance).toBe(WEEKLY_PLAN_START);
    expect(p.scheduledInstallment).toBe(WEEKLY_SLOT);
    expect(p.paidInstallments).toBe(0);
    expect(p.remainingInstallments).toBe(WEEKLY_TOTAL);
    expect(p.nextInstallmentAmount).toBe(WEEKLY_SLOT);
    expect(p.settled).toBe(false);
  });

  it('credits every slot a single lump sum covers', () => {
    // THE REGRESSION: five weeks paid in one transfer used to count as one
    // installment, re-spreading the balance over 11 slots instead of 7.
    const p = weekly(5 * WEEKLY_SLOT);
    expect(p.paidInstallments).toBe(5);
    expect(p.remainingInstallments).toBe(7);
    expect(p.nextInstallmentAmount).toBe(WEEKLY_SLOT);
    expect(p.creditTowardNextInstallment).toBe(0);
  });

  it('is indifferent to how many transfers the money arrived in', () => {
    // One ₦5,000 transfer vs five ₦1,000 transfers: the input is value, so
    // these are the same call. Asserted as a property over every slot count.
    for (let slots = 0; slots <= WEEKLY_TOTAL - 1; slots++) {
      const lump = weekly(slots * WEEKLY_SLOT);
      const drip = weekly(
        Array.from({ length: slots }, () => WEEKLY_SLOT).reduce(
          (a, b) => a + b,
          0,
        ),
      );
      expect(lump).toEqual(drip);
      expect(lump.paidInstallments).toBe(slots);
    }
  });

  it('does not credit a slot the money falls short of', () => {
    const p = weekly(WEEKLY_SLOT + 40_000); // one slot and ₦400 of the next
    expect(p.paidInstallments).toBe(1);
    expect(p.creditTowardNextInstallment).toBe(40_000);
    expect(p.nextInstallmentAmount).toBe(WEEKLY_SLOT - 40_000);
  });

  it('quotes the partial remainder so the next payment closes the slot', () => {
    const partial = weekly(WEEKLY_SLOT + 40_000);
    const closed = weekly(WEEKLY_SLOT + 40_000 + partial.nextInstallmentAmount);
    expect(closed.paidInstallments).toBe(2);
    expect(closed.creditTowardNextInstallment).toBe(0);
  });
});

describe('derivePlanProgress — settled and degenerate plans', () => {
  it('reports a cleared plan as settled with nothing due', () => {
    const p = weekly(WEEKLY_PLAN_START);
    expect(p.settled).toBe(true);
    expect(p.paidInstallments).toBe(WEEKLY_TOTAL);
    expect(p.remainingInstallments).toBe(0);
    expect(p.nextInstallmentAmount).toBe(0);
  });

  it('never leaves zero slots to pay while a balance remains', () => {
    // The old divisor went to zero once the row count reached the slot count,
    // and the app then demanded the WHOLE balance as "the next installment".
    // Value-derived progress cannot reach the final slot with money still owed.
    const p = weekly(WEEKLY_PLAN_START - 1);
    expect(p.paidInstallments).toBe(WEEKLY_TOTAL - 1);
    expect(p.remainingInstallments).toBe(1);
    expect(p.nextInstallmentAmount).toBe(1);
  });

  it('quotes the balance when it is too small to split into slots', () => {
    // 5 kobo over 12 slots: every intermediate target rounds to 0, which would
    // otherwise quote ₦0 forever.
    const p = derivePlanProgress({
      remainingBalance: 5,
      installmentsPaidKobo: 0,
      installmentFrequency: 'WEEKLY',
    });
    expect(p.scheduledInstallment).toBe(0);
    expect(p.paidInstallments).toBe(0);
    expect(p.nextInstallmentAmount).toBe(5);
  });

  it('clamps negative and non-integer inputs instead of throwing', () => {
    const p = derivePlanProgress({
      remainingBalance: -500,
      installmentsPaidKobo: -1,
      installmentFrequency: 'MONTHLY',
    });
    expect(p.settled).toBe(true);
    expect(p.nextInstallmentAmount).toBe(0);

    const q = derivePlanProgress({
      remainingBalance: 100_000.4,
      installmentsPaidKobo: 0.6,
      installmentFrequency: 'MONTHLY',
    });
    expect(Number.isInteger(q.nextInstallmentAmount)).toBe(true);
    expect(Number.isInteger(q.planStartBalance)).toBe(true);
    expect(Number.isInteger(q.installmentsPaidKobo)).toBe(true);
  });

  it('reports the clamped paid figure so callers cannot mix scales', () => {
    // planStartBalance is built from the CLAMPED input. A caller subtracting its
    // own raw input from a schedule target would combine the two and, for a
    // negative input, inflate the result.
    const p = derivePlanProgress({
      remainingBalance: 1_200_000,
      installmentsPaidKobo: -5_000,
      installmentFrequency: 'WEEKLY',
    });
    expect(p.installmentsPaidKobo).toBe(0);
    expect(p.planStartBalance).toBe(1_200_000);
  });
});

/**
 * Plan shapes worth exercising against every schedule rule: cadences that divide
 * their balance evenly, ones that leave a rounding remainder for the final slot,
 * and a balance too small to split at all.
 */
const CASES: {
  name: string;
  frequency: 'WEEKLY' | 'MONTHLY';
  planStart: number;
  payments: number;
}[] = [
  {
    name: 'weekly, divides evenly',
    frequency: 'WEEKLY',
    planStart: 1_200_000,
    payments: 12,
  },
  {
    name: 'weekly, indivisible by 12',
    frequency: 'WEEKLY',
    planStart: 1_200_007,
    payments: 12,
  },
  {
    name: 'monthly, divides evenly',
    frequency: 'MONTHLY',
    planStart: 300_000,
    payments: 3,
  },
  {
    name: 'monthly, indivisible by 3',
    frequency: 'MONTHLY',
    planStart: 100_001,
    payments: 3,
  },
  {
    name: 'balance smaller than the slot count',
    frequency: 'MONTHLY',
    planStart: 1,
    payments: 1,
  },
];

describe('derivePlanProgress — the schedule always sums to the balance', () => {
  const drainPlan = (
    planStartBalance: number,
    installmentFrequency: 'WEEKLY' | 'MONTHLY',
    payQuote: (quote: number) => number,
  ) => {
    let remainingBalance = planStartBalance;
    let installmentsPaidKobo = 0;
    const quotes: number[] = [];

    // Bounded well above any real schedule so a non-converging plan fails loudly
    // rather than hanging the suite.
    for (let i = 0; i < 1000 && remainingBalance > 0; i++) {
      const p = derivePlanProgress({
        remainingBalance,
        installmentsPaidKobo,
        installmentFrequency,
      });
      const paid = Math.min(
        payQuote(p.nextInstallmentAmount),
        remainingBalance,
      );
      quotes.push(paid);
      remainingBalance -= paid;
      installmentsPaidKobo += paid;
    }

    return { quotes, remainingBalance, installmentsPaidKobo };
  };

  it.each(CASES)(
    'paying each quote settles the plan exactly ($name)',
    ({ frequency, planStart, payments }) => {
      const run = drainPlan(planStart, frequency, (quote) => quote);
      expect(run.remainingBalance).toBe(0);
      expect(run.installmentsPaidKobo).toBe(planStart);
      expect(run.quotes).toHaveLength(payments);
      expect(run.quotes.reduce((a, b) => a + b, 0)).toBe(planStart);
    },
  );

  it('settles exactly when the parent always overpays the quote', () => {
    // Paying double every time must land on zero, never negative, and must
    // finish EARLY — the point of prepaying is fewer payments, not the same
    // number of smaller ones.
    const run = drainPlan(1_200_007, 'WEEKLY', (quote) => quote * 2);
    expect(run.remainingBalance).toBe(0);
    expect(run.installmentsPaidKobo).toBe(1_200_007);
    expect(run.quotes.length).toBeLessThan(12);
  });

  it('settles exactly when the parent always underpays the quote', () => {
    // Chronic partial payments must still converge on zero rather than leaving
    // an unpayable stub behind.
    const run = drainPlan(100_001, 'MONTHLY', (quote) =>
      Math.max(1, Math.floor(quote / 3)),
    );
    expect(run.remainingBalance).toBe(0);
    expect(run.installmentsPaidKobo).toBe(100_001);
  });
});

describe('agreement with the pre-enrollment calculator', () => {
  // `PaymentService.calculateInstallments` quotes a plan on the sign-up screen,
  // BEFORE any payment exists; this module quotes the same plan afterwards. Two
  // places deriving one schedule is precisely how the row-count bug survived, so
  // their agreement is pinned rather than assumed.
  const service = new PaymentService(null as never, null as never);

  it.each(CASES)(
    'quotes the same slot sizes ($name)',
    ({ frequency, planStart, payments }) => {
      const quoted = service.calculateInstallments(planStart, frequency);
      const live = derivePlanProgress({
        remainingBalance: planStart,
        installmentsPaidKobo: 0,
        installmentFrequency: frequency,
      });

      expect(live.totalInstallments).toBe(quoted.numberOfInstallments);
      expect(live.scheduledInstallment).toBe(quoted.installmentAmount);
      // First quote is the recurring slot; the last is the one that absorbs the
      // rounding remainder. Both must match the calculator to the kobo.
      expect(live.nextInstallmentAmount).toBe(
        payments === 1
          ? quoted.finalInstallmentAmount
          : quoted.installmentAmount,
      );

      const atFinalSlot = derivePlanProgress({
        remainingBalance: quoted.finalInstallmentAmount,
        installmentsPaidKobo: planStart - quoted.finalInstallmentAmount,
        installmentFrequency: frequency,
      });
      expect(atFinalSlot.nextInstallmentAmount).toBe(
        quoted.finalInstallmentAmount,
      );
    },
  );
});

describe('installmentDueDate', () => {
  const TERM_START = new Date('2026-01-05T00:00:00Z'); // a Monday

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

  it('moves k periods out for a parent k slots ahead', () => {
    const onSchedule = installmentDueDate(TERM_START, 'WEEKLY', 1);
    const fiveAhead = installmentDueDate(TERM_START, 'WEEKLY', 6);
    expect(fiveAhead.getTime() - onSchedule.getTime()).toBe(
      5 * 7 * 24 * 60 * 60 * 1000,
    );
  });
});
