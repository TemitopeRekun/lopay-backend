import { ForbiddenException } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { UserRole } from '../generated/prisma/client';

/**
 * Who may declare an installment payment against an enrollment.
 *
 * The rule is PARENTHOOD, not role. Previously a school owner qualified for any
 * enrollment at their own school, which handed one person both halves of the
 * maker-checker control: submit a payment on a family's plan, then approve it from
 * the school dashboard — clearing a balance nobody paid and writing a payment into
 * that parent's own history. The same role-gated check also locked out a school
 * owner who is a parent somewhere else, because it required `role === PARENT`.
 */
describe('EnrollmentService.submitInstallmentPayment — authorization', () => {
  const PARENT_USER = 'parent-user-1';
  const OWNER_USER = 'owner-user-1';
  const SCHOOL_ID = 'school-1';

  let prisma: {
    payment: { findUnique: jest.Mock; aggregate: jest.Mock; create: jest.Mock };
    childEnrollment: { findUnique: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let notifications: { create: jest.Mock };
  let events: { emitPaymentsChanged: jest.Mock };
  let service: EnrollmentService;

  const enrollment = {
    id: 'enr-1',
    schoolId: SCHOOL_ID,
    className: 'JSS1',
    remainingBalance: 10_000_00,
    school: { id: SCHOOL_ID, name: 'Acme', ownerId: OWNER_USER },
    child: { fullName: 'Kid A', parent: { userId: PARENT_USER } },
  };

  beforeEach(() => {
    prisma = {
      payment: {
        findUnique: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amountPaid: 0 } }),
        create: jest.fn().mockResolvedValue({
          id: 'pay-1',
          amountPaid: 5_000_00,
          platformAmount: 0,
          schoolAmount: 5_000_00,
          paymentDate: new Date('2026-01-01'),
          paymentType: 'INSTALLMENT',
        }),
      },
      childEnrollment: { findUnique: jest.fn().mockResolvedValue(enrollment) },
      $transaction: jest.fn(),
      $queryRaw: jest.fn(),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    events = { emitPaymentsChanged: jest.fn() };

    service = new EnrollmentService(
      prisma as never,
      {} as never, // paymentService — not reached by these paths
      notifications as never,
      events as never,
      {} as never, // audit
      {} as never, // paystack
      {} as never, // ledger
    );
  });

  /** Wire the transaction body to a tx client that behaves like the real one. */
  const givenTransactionRuns = () => {
    prisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => unknown) =>
        fn({
          $queryRaw: jest
            .fn()
            .mockResolvedValue([{ remainingBalance: 10_000_00 }]),
          payment: {
            aggregate: prisma.payment.aggregate,
            create: prisma.payment.create,
          },
        }),
    );
  };

  it('lets a parent pay their own child’s enrollment', async () => {
    givenTransactionRuns();

    await expect(
      service.submitInstallmentPayment('enr-1', 5_000, {
        userId: PARENT_USER,
        role: UserRole.PARENT,
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'pay-1' }));

    expect(prisma.payment.create).toHaveBeenCalled();
  });

  it('BLOCKS a school owner recording a payment on a family’s enrollment', async () => {
    await expect(
      service.submitInstallmentPayment('enr-1', 5_000, {
        userId: OWNER_USER,
        role: UserRole.SCHOOL_OWNER,
        schoolId: SCHOOL_ID,
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('explains WHY the school owner is blocked (submit + self-approve)', async () => {
    await expect(
      service.submitInstallmentPayment('enr-1', 5_000, {
        userId: OWNER_USER,
        role: UserRole.SCHOOL_OWNER,
        schoolId: SCHOOL_ID,
      }),
    ).rejects.toThrow(/the parent submits it, the school confirms it/i);
  });

  it('blocks an unrelated parent with the generic message', async () => {
    await expect(
      service.submitInstallmentPayment('enr-1', 5_000, {
        userId: 'someone-else',
        role: UserRole.PARENT,
      }),
    ).rejects.toThrow(/not authorized to pay this enrollment/i);
  });

  it('lets a SCHOOL_OWNER pay for their OWN child enrolled at another school', async () => {
    // Regression: the old `role === PARENT` gate made this impossible, even though
    // the person is the child's parent — school owners have children too.
    givenTransactionRuns();
    prisma.childEnrollment.findUnique.mockResolvedValue({
      ...enrollment,
      schoolId: 'other-school',
      school: { id: 'other-school', name: 'Other', ownerId: 'other-owner' },
      child: { fullName: 'Kid B', parent: { userId: OWNER_USER } },
    });

    await expect(
      service.submitInstallmentPayment('enr-1', 5_000, {
        userId: OWNER_USER,
        role: UserRole.SCHOOL_OWNER,
        schoolId: SCHOOL_ID,
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'pay-1' }));
  });

  it('checks authorization BEFORE the amount, so probing tells you nothing', async () => {
    // A rejected caller must not be able to distinguish a valid enrollment from an
    // invalid amount — both come back as the same authorization failure.
    await expect(
      service.submitInstallmentPayment('enr-1', -1, {
        userId: 'someone-else',
        role: UserRole.PARENT,
      }),
    ).rejects.toThrow(ForbiddenException);
  });
});
