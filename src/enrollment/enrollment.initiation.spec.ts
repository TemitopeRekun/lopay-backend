import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import {
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  PaymentReceiver,
  UserRole,
  InstallmentFrequency,
} from '../generated/prisma/client';
import type { CreateEnrollmentDto } from './dto/create.enrollment.dto';

/**
 * CHARACTERIZATION suite for the two fat enrollment-initiation methods
 * (`enrollChild` — manual receipt flow, and `initiateFirstPayment` — Paystack
 * flow) ahead of the Milestone 3 decomposition into resolve → calc-split →
 * persist → notify steps. Locks the observable orchestration: idempotency
 * short-circuit, the fee/school guards, the kobo amounts written to the
 * enrollment + payment, the Paystack init call, and the notify/emit fan-out.
 *
 * The private helpers (`resolveEnrollmentTarget`, `findPaymentByIdempotencyKey`,
 * `buildEnrollmentReplay`, `resolvePendingFirstPayment`) are stubbed so each
 * method's OWN logic is isolated; `$transaction` executes its callback against a
 * `tx` double.
 */
describe('EnrollmentService — initiation (characterization)', () => {
  let tx: {
    childEnrollment: { create: jest.Mock; update: jest.Mock };
    payment: { create: jest.Mock };
    school: { findUnique: jest.Mock };
    child: { findUnique: jest.Mock };
  };
  let prisma: {
    classFee: { findFirst: jest.Mock };
    school: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock; findMany: jest.Mock };
    payment: { update: jest.Mock };
    $transaction: jest.Mock;
  };
  let paymentService: { calculateInitialPayment: jest.Mock };
  let notifications: { create: jest.Mock };
  let events: {
    emitEnrollmentsChanged: jest.Mock;
    emitPaymentsChanged: jest.Mock;
  };
  let paystack: { initializeTransaction: jest.Mock };
  let service: EnrollmentService;

  const SCHOOL_ID = 'school-1';
  const CALC = {
    schoolFees: 100_000,
    platformFee: 2_500,
    minimumDeposit: 27_500,
    remainingBalance: 72_500,
    amountToSchool: 25_000,
  };

  function baseDto(
    overrides: Partial<CreateEnrollmentDto> = {},
  ): CreateEnrollmentDto {
    return {
      childName: 'Ada Lovelace',
      schoolId: SCHOOL_ID,
      className: 'Basic 1',
      installmentFrequency: InstallmentFrequency.MONTHLY,
      firstPaymentPaid: 275, // naira
      termStartDate: new Date('2026-01-01'),
      termEndDate: new Date('2026-04-01'),
      ...overrides,
    } as CreateEnrollmentDto;
  }

  beforeEach(() => {
    tx = {
      childEnrollment: {
        create: jest.fn().mockResolvedValue({ id: 'enr-1' }),
        update: jest.fn().mockResolvedValue({ id: 'enr-1' }),
      },
      payment: {
        create: jest
          .fn()
          .mockResolvedValue({ id: 'pay-1', enrollmentId: 'enr-1' }),
      },
      school: {
        findUnique: jest.fn().mockResolvedValue({
          id: SCHOOL_ID,
          name: 'Acme',
          ownerId: 'owner-1',
        }),
      },
      child: {
        findUnique: jest.fn().mockResolvedValue({ fullName: 'Ada Lovelace' }),
      },
    };
    prisma = {
      classFee: {
        findFirst: jest.fn().mockResolvedValue({ feeAmount: 100_000 }),
      },
      school: {
        findUnique: jest.fn().mockResolvedValue({
          id: SCHOOL_ID,
          name: 'Acme',
          paystackSubaccountActive: true,
          paystackSubaccountCode: 'ACCT_x',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ email: 'parent@x.test' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }]),
      },
      payment: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    paymentService = {
      calculateInitialPayment: jest.fn().mockReturnValue(CALC),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    events = {
      emitEnrollmentsChanged: jest.fn(),
      emitPaymentsChanged: jest.fn(),
    };
    paystack = {
      initializeTransaction: jest.fn().mockResolvedValue({
        reference: 'lopay_ref',
        accessCode: 'AC_1',
        authorizationUrl: 'https://paystack.test/pay',
      }),
    };

    service = new EnrollmentService(
      prisma as never,
      paymentService as never,
      notifications as never,
      events as never,
      { record: jest.fn() } as never, // audit (unused here)
      paystack as never,
      {} as never, // ledger (unused here)
    );

    // Stub the private helpers so each method's own orchestration is isolated.
    (service as never as Record<string, unknown>).resolveEnrollmentTarget = jest
      .fn()
      .mockResolvedValue({
        childId: 'child-1',
        retryEnrollmentId: null,
        pendingEnrollmentId: null,
      });
  });

  // ------------------------------------------------------------- enrollChild
  describe('enrollChild', () => {
    it('persists enrollment + FIRST_PAYMENT in kobo and fans out notifications', async () => {
      const result = await service.enrollChild(baseDto(), 'parent-user-1');

      expect(paymentService.calculateInitialPayment).toHaveBeenCalledWith(
        100_000,
        27_500, // ₦275 -> kobo
      );
      expect(tx.childEnrollment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            childId: 'child-1',
            schoolId: SCHOOL_ID,
            totalSchoolFee: CALC.schoolFees,
            platformFee: CALC.platformFee,
            remainingBalance: CALC.remainingBalance,
            paymentStatus: PaymentStatus.PENDING,
          }),
        }),
      );
      expect(tx.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amountPaid: 27_500,
            schoolAmount: CALC.amountToSchool,
            paymentType: PaymentType.FIRST_PAYMENT,
            receiver: PaymentReceiver.PLATFORM,
            status: PaymentTransactionStatus.PENDING,
          }),
        }),
      );
      // owner + 1 admin notified
      expect(notifications.create).toHaveBeenCalledTimes(2);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { role: UserRole.SUPER_ADMIN },
        select: { id: true },
      });
      expect(events.emitEnrollmentsChanged).toHaveBeenCalled();
      expect(events.emitPaymentsChanged).toHaveBeenCalled();
      expect(result.payment).toEqual({ id: 'pay-1', enrollmentId: 'enr-1' });
    });

    it('reuses a retryable enrollment via update (not create)', async () => {
      (service as never as Record<string, unknown>).resolveEnrollmentTarget =
        jest.fn().mockResolvedValue({
          childId: 'child-1',
          retryEnrollmentId: 'enr-retry',
          pendingEnrollmentId: null,
        });

      await service.enrollChild(baseDto(), 'parent-user-1');

      expect(tx.childEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'enr-retry' } }),
      );
      expect(tx.childEnrollment.create).not.toHaveBeenCalled();
    });

    it('replays the original outcome for a known idempotency key (no new write)', async () => {
      (
        service as never as Record<string, unknown>
      ).findPaymentByIdempotencyKey = jest
        .fn()
        .mockResolvedValue({ id: 'old-pay' });
      (service as never as Record<string, unknown>).buildEnrollmentReplay = jest
        .fn()
        .mockReturnValue({ replayed: true });

      const result = await service.enrollChild(
        baseDto({ idempotencyKey: 'key-1' } as Partial<CreateEnrollmentDto>),
        'parent-user-1',
      );

      expect(result).toEqual({ replayed: true });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.classFee.findFirst).not.toHaveBeenCalled();
    });

    it('rejects when no active fee exists for the class', async () => {
      prisma.classFee.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.enrollChild(baseDto(), 'parent-user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------ initiateFirstPayment
  describe('initiateFirstPayment', () => {
    it('creates PENDING enrollment + payment, initializes Paystack, returns the access code', async () => {
      const result = await service.initiateFirstPayment(
        baseDto(),
        'parent-user-1',
      );

      expect(tx.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            paymentType: PaymentType.FIRST_PAYMENT,
            status: PaymentTransactionStatus.PENDING,
            paystackReference: expect.stringMatching(/^lopay_/),
            amountPaid: 27_500,
          }),
        }),
      );
      expect(paystack.initializeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'parent@x.test',
          subaccount: 'ACCT_x',
        }),
      );
      // access code persisted back onto the payment
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { paystackAccessCode: 'AC_1' } }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          reference: 'lopay_ref',
          accessCode: 'AC_1',
          authorizationUrl: 'https://paystack.test/pay',
        }),
      );
    });

    it('replays an in-flight intent for a known idempotency key (no charge)', async () => {
      (
        service as never as Record<string, unknown>
      ).findPaymentByIdempotencyKey = jest.fn().mockResolvedValue({
        paystackReference: 'lopay_old',
        paystackAccessCode: 'AC_old',
        amountCharged: 28_000,
        status: PaymentTransactionStatus.PENDING,
      });

      const result = await service.initiateFirstPayment(
        baseDto({ idempotencyKey: 'key-1' } as Partial<CreateEnrollmentDto>),
        'parent-user-1',
      );

      expect(result).toEqual(
        expect.objectContaining({ idempotent: true, reference: 'lopay_old' }),
      );
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a school that is not set up for online payments', async () => {
      prisma.school.findUnique.mockResolvedValueOnce({
        id: SCHOOL_ID,
        name: 'Acme',
        paystackSubaccountActive: false,
        paystackSubaccountCode: null,
      });

      await expect(
        service.initiateFirstPayment(baseDto(), 'parent-user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
    });

    it('404s when the school does not exist', async () => {
      prisma.school.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.initiateFirstPayment(baseDto(), 'parent-user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects when no active fee exists for the class', async () => {
      prisma.classFee.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.initiateFirstPayment(baseDto(), 'parent-user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
