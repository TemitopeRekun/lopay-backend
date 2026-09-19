import { EnrollmentInviteStatus } from '../generated/prisma/client';
import {
  toParentInviteView,
  toSchoolInviteView,
  type InviteRow,
} from './invite-view';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A row as Prisma hands it over, plus the two columns that must never reach a
 * client. They are deliberately present on the fixture: a projection that
 * silently spread its input would pass every value assertion below and still be
 * a data leak, so the leak assertions need something real to catch.
 */
function row(
  overrides: Partial<InviteRow> = {},
): InviteRow & Record<string, unknown> {
  return {
    id: 'invite-1',
    schoolId: 'school-1',
    studentName: 'Ada Lovelace',
    className: 'Basic 1',
    totalSchoolFee: 10_000_000, // ₦100,000
    amountAlreadyPaid: 4_000_000, // ₦40,000
    phoneNumber: '+2348012345678',
    installmentFrequency: 'MONTHLY',
    planStartDate: NOW,
    termEndDate: new Date(NOW.getTime() + 90 * DAY_MS),
    expiresAt: new Date(NOW.getTime() + 14 * DAY_MS),
    status: EnrollmentInviteStatus.PENDING,
    disputeReason: null,
    disputedAt: null,
    revokedAt: null,
    claimedAt: null,
    createdAt: NOW,
    school: { name: 'Acme Academy' },
    enrollment: null,
    // Not on InviteRow — present only so the leak tests have something to find.
    tokenHash: 'a'.repeat(64),
    parentPhoneHash: 'b'.repeat(64),
    createdByUserId: 'owner-1',
    claimedByUserId: null,
    ...overrides,
  } as InviteRow & Record<string, unknown>;
}

describe('invite projections', () => {
  describe('toSchoolInviteView', () => {
    it('converts kobo to naira and derives the outstanding balance', () => {
      const view = toSchoolInviteView(row(), NOW);
      expect(view.totalFee).toBe(100_000);
      expect(view.amountAlreadyPaid).toBe(40_000);
      expect(view.remainingBalance).toBe(60_000);
    });

    it('shows the school the number it entered, so it can be checked', () => {
      expect(toSchoolInviteView(row(), NOW).parentPhone).toBe('+2348012345678');
    });

    it('marks a pending, in-window invite as live', () => {
      expect(toSchoolInviteView(row(), NOW).isLive).toBe(true);
    });

    it('marks a lapsed invite as not live even while the column still says PENDING', () => {
      // The sweep is hourly, so this state is normal rather than exceptional.
      const view = toSchoolInviteView(
        row({ expiresAt: new Date(NOW.getTime() - 1) }),
        NOW,
      );
      expect(view.isLive).toBe(false);
    });

    it('surfaces a dispute so the school can act on it', () => {
      const view = toSchoolInviteView(
        row({
          status: EnrollmentInviteStatus.DISPUTED,
          disputeReason: 'I paid ₦35,000',
          disputedAt: NOW,
        }),
        NOW,
      );
      expect(view.disputeReason).toBe('I paid ₦35,000');
      expect(view.isLive).toBe(false);
    });

    it('links to the resulting plan once claimed', () => {
      const view = toSchoolInviteView(
        row({
          status: EnrollmentInviteStatus.CLAIMED,
          claimedAt: NOW,
          enrollment: { id: 'enrollment-9' },
        }),
        NOW,
      );
      expect(view.enrollmentId).toBe('enrollment-9');
    });

    it('never ships the token digest or the phone blind index', () => {
      const serialised = JSON.stringify(toSchoolInviteView(row(), NOW));
      expect(serialised).not.toContain('a'.repeat(64));
      expect(serialised).not.toContain('b'.repeat(64));
      expect(serialised).not.toMatch(/tokenHash|parentPhoneHash/);
    });
  });

  describe('toParentInviteView', () => {
    it('shows the figures the parent is being asked to confirm', () => {
      const view = toParentInviteView(row(), NOW);
      expect(view).toMatchObject({
        studentName: 'Ada Lovelace',
        className: 'Basic 1',
        schoolName: 'Acme Academy',
        totalFee: 100_000,
        amountAlreadyPaid: 40_000,
        remainingBalance: 60_000,
        canClaim: true,
      });
    });

    it('withholds the phone number entirely, not merely masked', () => {
      // Anyone holding a forwarded link reaches this. A mask still confirms a
      // number to someone testing one, so the field is absent altogether.
      const view = toParentInviteView(row(), NOW);
      expect(view).not.toHaveProperty('parentPhone');
      expect(JSON.stringify(view)).not.toContain('2348012345678');
    });

    it('withholds internal identifiers and provenance', () => {
      const view = toParentInviteView(row(), NOW);
      for (const field of [
        'id',
        'schoolId',
        'createdByUserId',
        'claimedByUserId',
        'tokenHash',
        'parentPhoneHash',
        'disputeReason',
      ]) {
        expect(view).not.toHaveProperty(field);
      }
    });

    it.each([
      EnrollmentInviteStatus.CLAIMED,
      EnrollmentInviteStatus.REVOKED,
      EnrollmentInviteStatus.EXPIRED,
      EnrollmentInviteStatus.DISPUTED,
    ])('refuses to offer a claim button for a %s invite', (status) => {
      expect(toParentInviteView(row({ status }), NOW).canClaim).toBe(false);
    });

    it('refuses a claim once the window has closed', () => {
      expect(
        toParentInviteView(row({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)
          .canClaim,
      ).toBe(false);
    });

    it('tolerates a school row that failed to join', () => {
      expect(
        toParentInviteView(row({ school: null }), NOW).schoolName,
      ).toBeNull();
    });
  });
});
