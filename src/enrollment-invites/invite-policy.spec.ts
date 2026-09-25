import { EnrollmentInviteStatus } from '../generated/prisma/client';
import {
  installmentCountFor,
  installmentDueDate,
} from '../common/installment-schedule';
import { MONTHLY_INSTALLMENTS, WEEKLY_INSTALLMENTS } from '../common/fees';
import {
  DEFAULT_INVITE_EXPIRY_DAYS,
  EXPIRABLE_STATUSES,
  MAX_INVITE_EXPIRY_DAYS,
  MAX_PLAN_START_BACKDATE_MS,
  MAX_PLAN_START_FUTURE_DAYS,
  MIGRATION_WINDOW_DAYS,
  MIN_INVITE_EXPIRY_DAYS,
  SLOT_HOLDING_STATUSES,
  derivePlanEnd,
  expiryFrom,
  hasExpired,
  isActionable,
  isMigrationWindowOpen,
  migrationDaysRemaining,
  resolveExpiryDays,
  validatePlanStart,
} from './invite-policy';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-19T12:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

describe('invite policy', () => {
  describe('resolveExpiryDays', () => {
    it('defaults when the school does not choose', () => {
      expect(resolveExpiryDays(undefined)).toBe(DEFAULT_INVITE_EXPIRY_DAYS);
      expect(resolveExpiryDays(null)).toBe(DEFAULT_INVITE_EXPIRY_DAYS);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('falls back to the default for %s', (_label, value) => {
      expect(resolveExpiryDays(value)).toBe(DEFAULT_INVITE_EXPIRY_DAYS);
    });

    it('clamps above the ceiling rather than trusting the caller', () => {
      expect(resolveExpiryDays(9_999)).toBe(MAX_INVITE_EXPIRY_DAYS);
    });

    it('clamps zero and negatives up to the floor', () => {
      // `Math.min(value, MAX)` alone would accept these and mint an invite that
      // is already dead — the bug this floor exists to prevent.
      expect(resolveExpiryDays(0)).toBe(MIN_INVITE_EXPIRY_DAYS);
      expect(resolveExpiryDays(-5)).toBe(MIN_INVITE_EXPIRY_DAYS);
    });

    it('truncates fractional days downward', () => {
      expect(resolveExpiryDays(7.9)).toBe(7);
    });

    it('passes through a value inside the window', () => {
      expect(resolveExpiryDays(21)).toBe(21);
    });
  });

  describe('expiryFrom', () => {
    it('offsets from the supplied clock, not the ambient one', () => {
      expect(expiryFrom(NOW, 3).toISOString()).toBe(
        new Date(NOW.getTime() + 3 * DAY_MS).toISOString(),
      );
    });

    it('applies the clamp before the arithmetic', () => {
      expect(expiryFrom(NOW, 10_000).getTime()).toBe(
        NOW.getTime() + MAX_INVITE_EXPIRY_DAYS * DAY_MS,
      );
    });
  });

  describe('status sets', () => {
    it('holds a student slot for pending, disputed and claimed invites', () => {
      expect([...SLOT_HOLDING_STATUSES].sort()).toEqual(
        [
          EnrollmentInviteStatus.CLAIMED,
          EnrollmentInviteStatus.DISPUTED,
          EnrollmentInviteStatus.PENDING,
        ].sort(),
      );
    });

    it('frees the slot once revoked or expired, so a school can re-issue', () => {
      expect(SLOT_HOLDING_STATUSES).not.toContain(
        EnrollmentInviteStatus.REVOKED,
      );
      expect(SLOT_HOLDING_STATUSES).not.toContain(
        EnrollmentInviteStatus.EXPIRED,
      );
    });

    it('never expires a claimed invite', () => {
      // It already became an enrollment; retiring it would misdescribe history
      // and orphan the audit trail pointing at it.
      expect(EXPIRABLE_STATUSES).not.toContain(EnrollmentInviteStatus.CLAIMED);
    });

    it('lets a parent act only while pending', () => {
      expect(isActionable(EnrollmentInviteStatus.PENDING)).toBe(true);
      for (const status of [
        EnrollmentInviteStatus.DISPUTED,
        EnrollmentInviteStatus.CLAIMED,
        EnrollmentInviteStatus.REVOKED,
        EnrollmentInviteStatus.EXPIRED,
      ]) {
        expect(isActionable(status)).toBe(false);
      }
    });
  });

  describe('hasExpired', () => {
    it('is true for a lapsed pending invite', () => {
      expect(
        hasExpired(
          { status: EnrollmentInviteStatus.PENDING, expiresAt: days(-1) },
          NOW,
        ),
      ).toBe(true);
    });

    it('treats the exact expiry instant as expired', () => {
      expect(
        hasExpired(
          { status: EnrollmentInviteStatus.PENDING, expiresAt: NOW },
          NOW,
        ),
      ).toBe(true);
    });

    it('is false one millisecond before', () => {
      expect(
        hasExpired(
          {
            status: EnrollmentInviteStatus.PENDING,
            expiresAt: new Date(NOW.getTime() + 1),
          },
          NOW,
        ),
      ).toBe(false);
    });

    it('leaves a lapsed CLAIMED invite alone', () => {
      expect(
        hasExpired(
          { status: EnrollmentInviteStatus.CLAIMED, expiresAt: days(-30) },
          NOW,
        ),
      ).toBe(false);
    });
  });

  describe('validatePlanStart', () => {
    it('accepts a plan starting now', () => {
      expect(validatePlanStart(NOW, NOW)).toBeNull();
    });

    it('rejects an invalid date rather than producing NaN dues', () => {
      expect(validatePlanStart(new Date('nonsense'), NOW)).toMatch(
        /valid date/,
      );
    });

    it('rejects a back-dated plan, naming the arrears consequence', () => {
      // The whole reason the anchor is the handover date: back-dating opens the
      // plan already overdue. See common/arrears.ts.
      const message = validatePlanStart(days(-60), NOW);
      expect(message).toMatch(/cannot be in the past/);
      expect(message).toMatch(/behind on payments/);
    });

    it('tolerates clock skew and timezone offset just inside the allowance', () => {
      expect(
        validatePlanStart(
          new Date(NOW.getTime() - MAX_PLAN_START_BACKDATE_MS + 1_000),
          NOW,
        ),
      ).toBeNull();
    });

    it('rejects just outside the back-dating allowance', () => {
      expect(
        validatePlanStart(
          new Date(NOW.getTime() - MAX_PLAN_START_BACKDATE_MS - 1_000),
          NOW,
        ),
      ).toMatch(/cannot be in the past/);
    });

    it('rejects a start date far in the future, catching a mistyped year', () => {
      expect(
        validatePlanStart(days(MAX_PLAN_START_FUTURE_DAYS + 1), NOW),
      ).toMatch(/more than 365 days/);
    });

    it('accepts a start exactly at the future limit', () => {
      expect(
        validatePlanStart(days(MAX_PLAN_START_FUTURE_DAYS), NOW),
      ).toBeNull();
    });
  });

  describe('derivePlanEnd', () => {
    /**
     * `termEndDate` is the plan's end, not the school's academic term, and it is
     * a cliff: `DefaulterDetectionService` defaults every ACTIVE plan past it,
     * and `computeArrears` calls the entire remaining balance overdue. A typed
     * date is therefore wrong in either direction — too early defaults a family
     * before instalment one is due, too late exempts them from defaulting. So it
     * is derived, and these tests pin it to the same arithmetic the rest of the
     * product uses.
     */
    it('spans exactly the cadence for a MONTHLY plan', () => {
      // `ConfirmPlanScreen` does `endDate.setMonth(start + numberOfPayments)`.
      const expected = new Date(NOW);
      expected.setMonth(expected.getMonth() + MONTHLY_INSTALLMENTS);

      expect(derivePlanEnd(NOW, 'MONTHLY').toISOString()).toBe(
        expected.toISOString(),
      );
    });

    it('spans exactly the cadence for a WEEKLY plan', () => {
      // `ConfirmPlanScreen` does `endDate.setDate(start + numberOfPayments * 7)`.
      const expected = new Date(
        NOW.getTime() + WEEKLY_INSTALLMENTS * 7 * DAY_MS,
      );

      expect(derivePlanEnd(NOW, 'WEEKLY').toISOString()).toBe(
        expected.toISOString(),
      );
    });

    it.each(['WEEKLY', 'MONTHLY'] as const)(
      'lands on the last instalment due date for %s, never before it',
      (frequency) => {
        // The property that matters: the cliff and the final payment coincide,
        // so the plan neither defaults early nor escapes defaulting.
        const lastDue = installmentDueDate(
          NOW,
          frequency,
          installmentCountFor(frequency),
        );

        expect(derivePlanEnd(NOW, frequency).getTime()).toBe(lastDue.getTime());
      },
    );

    it('always ends after it starts, so the CHECK constraint holds', () => {
      // `EnrollmentInvite_term_after_start` asserts termEndDate > planStartDate.
      for (const frequency of ['WEEKLY', 'MONTHLY'] as const) {
        for (const start of [NOW, days(1), days(365), new Date('2026-01-31')]) {
          expect(derivePlanEnd(start, frequency).getTime()).toBeGreaterThan(
            start.getTime(),
          );
        }
      }
    });

    it('clamps a month-end start rather than rolling into the next month', () => {
      // 31 Jan + 3 months has no 31st. `installmentDueDate` clamps to the last
      // day of the target month, so the plan ends 30 April, not 1 May.
      const end = derivePlanEnd(
        new Date('2026-01-31T12:00:00.000Z'),
        'MONTHLY',
      );

      expect(end.toISOString().slice(0, 10)).toBe('2026-04-30');
    });
  });
});

/**
 * The migration window.
 *
 * Migration is free, and that is only affordable because it is one-time: the
 * family's NEXT term is a normal paid enrollment. Without a bound, a school
 * could route every term's families through it and never generate revenue.
 */
describe('isMigrationWindowOpen', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');

  it('is open while the deadline is ahead', () => {
    expect(isMigrationWindowOpen(new Date('2026-10-01T00:00:00Z'), now)).toBe(
      true,
    );
  });

  it('is closed once the deadline has passed', () => {
    expect(isMigrationWindowOpen(new Date('2026-09-01T00:00:00Z'), now)).toBe(
      false,
    );
  });

  it('is closed exactly ON the deadline', () => {
    // Strictly-after, so the boundary is not a coin flip between two callers
    // reading the same instant.
    expect(isMigrationWindowOpen(now, now)).toBe(false);
  });

  it('is open one millisecond before it', () => {
    expect(isMigrationWindowOpen(new Date(now.getTime() + 1), now)).toBe(true);
  });
});

describe('migrationDaysRemaining', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');

  it('rounds partial days UP, so "1 day left" never means "already closed"', () => {
    // Shown to a school owner deciding whether to finish today. Rounding down
    // would display "0 days left" for a window that is still open.
    expect(migrationDaysRemaining(new Date('2026-09-23T01:00:00Z'), now)).toBe(
      1,
    );
  });

  it('never goes negative', () => {
    expect(migrationDaysRemaining(new Date('2026-08-01T00:00:00Z'), now)).toBe(
      0,
    );
  });

  it('counts a full window', () => {
    expect(
      migrationDaysRemaining(
        new Date(now.getTime() + MIGRATION_WINDOW_DAYS * 24 * 60 * 60 * 1000),
        now,
      ),
    ).toBe(MIGRATION_WINDOW_DAYS);
  });
});

describe('MIGRATION_WINDOW_DAYS', () => {
  it('is long enough for two invite expiry cycles', () => {
    // A school that misses a parent has to re-issue, so a window shorter than
    // two DEFAULT_INVITE_EXPIRY_DAYS cycles cannot absorb one missed round.
    expect(MIGRATION_WINDOW_DAYS).toBeGreaterThanOrEqual(
      DEFAULT_INVITE_EXPIRY_DAYS * 2,
    );
  });

  it('is shorter than a term, so it cannot cover the next intake', () => {
    // A term is MONTHLY_INSTALLMENTS months. A window that spans one would let
    // a school migrate the following term's families too — the thing it exists
    // to prevent.
    expect(MIGRATION_WINDOW_DAYS).toBeLessThan(MONTHLY_INSTALLMENTS * 30);
  });
});
