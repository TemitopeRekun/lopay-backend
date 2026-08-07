import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { PaystackApiError } from '../paystack/paystack.service';
import {
  InstallmentFrequency,
  PaymentReceiver,
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  Prisma,
  UserRole,
} from '../generated/prisma/client';
import type { CreateEnrollmentDto } from './dto/create.enrollment.dto';

/**
 * Coverage-focused unit suite for EnrollmentService. Complements
 * `enrollment.initiation.spec.ts` (which STUBS the private helpers) and
 * `enrollment.ownership.spec.ts` (assertReferenceOwnedBy) by exercising the
 * methods/branches they don't:
 *   - getParentEnrollments / getEnrollmentHistory + calculateEnrichment
 *   - submitInstallmentPayment (auth, guards, overpayment, idempotency)
 *   - processPaystackWebhookEvent + recordPaystackDispute
 *   - the thin ledger callers (reconcile/fail/confirm)
 *   - the REAL resolveEnrollmentTarget + resolvePendingFirstPayment private
 *     helpers (run end-to-end through enrollChild / initiateFirstPayment).
 */

const SCHOOL_ID = 'school-1';
const CALC = {
  schoolFees: 100_000,
  platformFee: 2_500,
  minimumDeposit: 27_500,
  remainingBalance: 72_500,
  amountToSchool: 25_000,
};

/** Build a Prisma P2002 unique-constraint violation for a given target field(s). */
function p2002(target: string | string[]) {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

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

function buildMocks() {
  const tx = {
    childEnrollment: {
      create: jest.fn().mockResolvedValue({ id: 'enr-1' }),
      update: jest.fn().mockResolvedValue({ id: 'enr-1' }),
    },
    payment: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'pay-1', enrollmentId: 'enr-1' }),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountPaid: 0 } }),
    },
    school: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: SCHOOL_ID, name: 'Acme', ownerId: 'owner-1' }),
    },
    child: {
      findUnique: jest.fn().mockResolvedValue({ fullName: 'Ada Lovelace' }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ remainingBalance: 100_000 }]),
  };

  const prisma = {
    parent: {
      findUnique: jest.fn().mockResolvedValue({ id: 'parent-1' }),
      create: jest.fn().mockResolvedValue({ id: 'parent-1' }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'p@x.test',
        phoneNumber: '0800',
      }),
      findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }]),
    },
    child: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'child-1', parentId: 'parent-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'child-new' }),
    },
    childEnrollment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    classFee: {
      findFirst: jest.fn().mockResolvedValue({ feeAmount: 100_000 }),
    },
    school: {
      findUnique: jest.fn().mockResolvedValue({
        id: SCHOOL_ID,
        name: 'Acme',
        ownerId: 'owner-1',
        paystackSubaccountActive: true,
        paystackSubaccountCode: 'ACCT_x',
      }),
    },
    payment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountPaid: 0 } }),
    },
    webhookEvent: {
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };

  const paymentService = {
    calculateInitialPayment: jest.fn().mockReturnValue(CALC),
  };
  const notifications = { create: jest.fn().mockResolvedValue(undefined) };
  const events = {
    emitEnrollmentsChanged: jest.fn(),
    emitPaymentsChanged: jest.fn(),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const paystack = {
    initializeTransaction: jest.fn().mockResolvedValue({
      reference: 'lopay_ref',
      accessCode: 'AC_1',
      authorizationUrl: 'https://paystack.test/pay',
    }),
    verifyTransaction: jest.fn(),
  };
  const ledger = {
    reconcilePaystackPayment: jest.fn().mockResolvedValue({ reconciled: true }),
    failPaystackPayment: jest.fn().mockResolvedValue({ failed: true }),
    confirmFirstPayment: jest.fn().mockResolvedValue({ confirmed: true }),
    reversePaystackPaymentByDispute: jest
      .fn()
      .mockResolvedValue({ reversed: true }),
  };

  const service = new EnrollmentService(
    prisma as never,
    paymentService as never,
    notifications as never,
    events as never,
    audit as never,
    paystack as never,
    ledger as never,
  );

  return {
    tx,
    prisma,
    paymentService,
    notifications,
    events,
    audit,
    paystack,
    ledger,
    service,
  };
}

type Mocks = ReturnType<typeof buildMocks>;

describe('EnrollmentService (coverage)', () => {
  let m: Mocks;

  beforeEach(() => {
    m = buildMocks();
  });

  // ---------------------------------------------------- getParentEnrollments
  describe('getParentEnrollments + calculateEnrichment', () => {
    it('returns [] when the parent profile does not exist', async () => {
      m.prisma.parent.findUnique.mockResolvedValueOnce(null);
      await expect(m.service.getParentEnrollments('u1')).resolves.toEqual([]);
      expect(m.prisma.childEnrollment.findMany).not.toHaveBeenCalled();
    });

    it('returns [] when the parent has no children', async () => {
      m.prisma.parent.findUnique.mockResolvedValueOnce({
        id: 'parent-1',
        children: [],
      });
      await expect(m.service.getParentEnrollments('u1')).resolves.toEqual([]);
      expect(m.prisma.childEnrollment.findMany).not.toHaveBeenCalled();
    });

    it('enriches a WEEKLY enrollment with a confirmed installment (next due + amount)', async () => {
      m.prisma.parent.findUnique.mockResolvedValueOnce({
        id: 'parent-1',
        children: [{ id: 'child-1' }],
      });
      m.prisma.childEnrollment.findMany.mockResolvedValueOnce([
        {
          id: 'enr-1',
          remainingBalance: 50_000,
          totalSchoolFee: 100_000,
          installmentFrequency: InstallmentFrequency.WEEKLY,
          termStartDate: new Date('2026-01-01'),
          createdAt: new Date('2026-01-01'),
          child: { fullName: 'Ada' },
          school: { name: 'Acme' },
          payments: [
            {
              isConfirmed: true,
              amountPaid: 10_000,
              paymentDate: new Date('2026-02-01'),
              paymentType: PaymentType.INSTALLMENT,
            },
          ],
        },
      ]);

      const [row] = await m.service.getParentEnrollments('u1');

      expect(row.totalFee).toBe(1_000);
      expect(row.remainingBalance).toBe(500);
      expect(row.paidAmount).toBe(100);
      expect(row.studentName).toBe('Ada');
      // The plan opened at 60_000 kobo (50_000 left + 10_000 paid) over 12
      // weekly slots of 5_000. The 10_000 paid closes two of them, so the next
      // is one slot: 5_000 kobo -> 50 naira, due in week 3.
      expect(row.installmentsPaid).toBe(2);
      expect(row.installmentsTotal).toBe(12);
      expect(row.nextInstallmentAmount).toBe(50);
      expect(row.nextDueDate).toBe('2026-01-22');
      // enriched payment amounts converted to naira
      expect(row.payments[0].amount).toBe(100);
    });

    it('anchors the first installment one period after termStartDate', async () => {
      m.prisma.parent.findUnique.mockResolvedValueOnce({
        id: 'parent-1',
        children: [{ id: 'child-1' }],
      });
      m.prisma.childEnrollment.findMany.mockResolvedValueOnce([
        {
          id: 'enr-1',
          remainingBalance: 60_000,
          totalSchoolFee: 100_000,
          installmentFrequency: InstallmentFrequency.MONTHLY,
          termStartDate: new Date('2026-03-01'),
          createdAt: new Date('2026-01-01'),
          child: { fullName: 'Ada' },
          school: { name: 'Acme' },
          payments: [
            {
              isConfirmed: false, // unconfirmed -> ignored
              amountPaid: 999,
              paymentDate: new Date('2026-02-01'),
              paymentType: PaymentType.INSTALLMENT,
            },
          ],
        },
      ]);

      const [row] = await m.service.getParentEnrollments('u1');
      expect(row.paidAmount).toBe(0);
      // Term starts 1 March; installment one falls due a month later. The
      // unconfirmed payment must not advance the schedule.
      expect(row.installmentsPaid).toBe(0);
      expect(row.nextDueDate).toBe('2026-04-01');
    });

    it('falls back to createdAt when termStartDate is null', async () => {
      m.prisma.parent.findUnique.mockResolvedValueOnce({
        id: 'parent-1',
        children: [{ id: 'child-1' }],
      });
      m.prisma.childEnrollment.findMany.mockResolvedValueOnce([
        {
          id: 'enr-1',
          remainingBalance: 60_000,
          totalSchoolFee: 100_000,
          installmentFrequency: InstallmentFrequency.MONTHLY,
          termStartDate: null,
          createdAt: new Date('2026-01-15'),
          child: { fullName: 'Ada' },
          school: { name: 'Acme' },
          payments: [],
        },
      ]);

      const [row] = await m.service.getParentEnrollments('u1');
      expect(row.nextDueDate).toBe('2026-02-15');
    });

    it('does not collapse the schedule when payments outnumber the slots', async () => {
      m.prisma.parent.findUnique.mockResolvedValueOnce({
        id: 'parent-1',
        children: [{ id: 'child-1' }],
      });
      const installment = (d: string) => ({
        isConfirmed: true,
        amountPaid: 1_000,
        paymentDate: new Date(d),
        paymentType: PaymentType.INSTALLMENT,
      });
      m.prisma.childEnrollment.findMany.mockResolvedValueOnce([
        {
          id: 'enr-1',
          remainingBalance: 30_000,
          totalSchoolFee: 100_000,
          installmentFrequency: InstallmentFrequency.MONTHLY, // 3 total
          termStartDate: new Date('2026-01-01'),
          createdAt: new Date('2026-01-01'),
          child: { fullName: 'Ada' },
          school: { name: 'Acme' },
          payments: [
            installment('2026-04-01'),
            installment('2026-03-01'),
            installment('2026-02-01'),
          ],
        },
      ]);

      const [row] = await m.service.getParentEnrollments('u1');
      // Three tiny payments against a 3-slot plan. Counting rows drove the
      // divisor to zero and demanded the WHOLE ₦300 balance in one go; counting
      // money leaves the parent part-way through slot one, owing the ₦80 that
      // closes it.
      expect(row.installmentsPaid).toBe(0);
      expect(row.creditTowardNextInstallment).toBe(30);
      expect(row.nextInstallmentAmount).toBe(80);
    });

    it('leaves next-due null and amount 0 when the balance is cleared (unknown frequency branch)', async () => {
      m.prisma.parent.findUnique.mockResolvedValueOnce({
        id: 'parent-1',
        children: [{ id: 'child-1' }, { id: 'child-2' }],
      });
      m.prisma.childEnrollment.findMany.mockResolvedValueOnce([
        {
          id: 'enr-paid',
          remainingBalance: 0,
          totalSchoolFee: 100_000,
          installmentFrequency: 'DAILY' as never, // exercises the non-WEEKLY/MONTHLY branch elsewhere
          termStartDate: new Date('2026-01-01'),
          createdAt: new Date('2026-01-01'),
          child: { fullName: 'Ada' },
          school: { name: 'Acme' },
          payments: [],
        },
      ]);

      const [row] = await m.service.getParentEnrollments('u1');
      expect(row.nextDueDate).toBeNull();
      expect(row.nextInstallmentAmount).toBe(0);
    });
  });

  // ----------------------------------------------------- getEnrollmentHistory
  describe('getEnrollmentHistory', () => {
    const found = (userId: string) => ({
      id: 'enr-1',
      remainingBalance: 40_000,
      totalSchoolFee: 100_000,
      installmentFrequency: 'DAILY' as never, // hit the else (no date shift) branch
      termStartDate: null,
      createdAt: new Date('2026-01-01'),
      child: { fullName: 'Ada', parent: { userId } },
      school: { name: 'Acme' },
      payments: [
        {
          isConfirmed: true,
          amountPaid: 5_000,
          paymentDate: new Date('2026-02-01'),
          paymentType: PaymentType.INSTALLMENT,
        },
      ],
    });

    it('404s when the enrollment does not exist', async () => {
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce(null);
      await expect(
        m.service.getEnrollmentHistory('enr-x', 'u1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects access when the caller is not the child’s parent', async () => {
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce(
        found('other-user'),
      );
      await expect(
        m.service.getEnrollmentHistory('enr-1', 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns enriched history for the owning parent', async () => {
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce(found('u1'));
      const res = await m.service.getEnrollmentHistory('enr-1', 'u1');
      expect(res.studentName).toBe('Ada');
      expect(res.paidAmount).toBe(50);
      // unknown frequency -> next due is the (unshifted) last payment date
      expect(res.nextDueDate).toBe('2026-02-01');
    });
  });

  // -------------------------------------------------- submitInstallmentPayment
  describe('submitInstallmentPayment', () => {
    const parentUser = {
      userId: 'u1',
      role: UserRole.PARENT,
      schoolId: null as string | null,
    };
    const enrollmentRow = {
      id: 'enr-1',
      schoolId: SCHOOL_ID,
      className: 'Basic 1',
      school: { ownerId: 'owner-1', name: 'Acme' },
      child: { fullName: 'Ada', parent: { userId: 'u1' } },
    };

    it('rejects a receipt path outside the caller’s namespace', async () => {
      await expect(
        m.service.submitInstallmentPayment(
          'enr-1',
          500,
          parentUser,
          'receipts/someone-else/x.jpg',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('replays the original payment for a known idempotency key', async () => {
      m.prisma.payment.findUnique.mockResolvedValueOnce({
        id: 'old-pay',
        amountPaid: 50_000,
        status: PaymentTransactionStatus.PENDING,
        paymentDate: new Date('2026-02-01'),
        paymentType: PaymentType.INSTALLMENT,
        enrollment: { child: { fullName: 'Ada' }, school: { name: 'Acme' } },
      });

      const res = await m.service.submitInstallmentPayment(
        'enr-1',
        500,
        parentUser,
        undefined,
        'idem-1',
      );
      expect(res.amount).toBe(500);
      expect(res.studentName).toBe('Ada');
      expect(m.prisma.$transaction).not.toHaveBeenCalled();
    });

    /**
     * A payment the school has REJECTED is not a replayable submission. Echoing
     * it back would answer a fresh attempt with a rejected one and report it as
     * accepted — the parent would be told their money was recorded while no
     * payment existed. The balance it was reserving is already free (the
     * reservation filter in enrollment-view only counts PENDING), so the retry
     * is safe to record for real.
     */
    it('records a new payment when the key belongs to a REJECTED one', async () => {
      m.prisma.payment.findUnique.mockResolvedValueOnce({
        id: 'rejected-pay',
        amountPaid: 50_000,
        status: PaymentTransactionStatus.FAILED,
        paymentDate: new Date('2026-02-01'),
        paymentType: PaymentType.INSTALLMENT,
        enrollment: { child: { fullName: 'Ada' }, school: { name: 'Acme' } },
      });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow);
      m.tx.$queryRaw.mockResolvedValueOnce([{ remainingBalance: 100_000 }]);
      m.tx.payment.create.mockResolvedValueOnce({
        id: 'pay-new',
        amountPaid: 50_000,
        platformAmount: 0,
        schoolAmount: 50_000,
        paymentDate: new Date('2026-02-02'),
        paymentType: PaymentType.INSTALLMENT,
      });

      const res = await m.service.submitInstallmentPayment(
        'enr-1',
        500,
        parentUser,
        undefined,
        'idem-1',
      );

      expect(m.prisma.payment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'rejected-pay',
          status: PaymentTransactionStatus.FAILED,
        },
        data: { idempotencyKey: null },
      });
      expect(m.tx.payment.create).toHaveBeenCalled();
      expect(res.id).toBe('pay-new');
    });

    it('404s when the enrollment does not exist', async () => {
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce(null);
      await expect(
        m.service.submitInstallmentPayment('enr-x', 500, parentUser),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a caller who is not the child’s parent', async () => {
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        ...enrollmentRow,
        child: { fullName: 'Ada', parent: { userId: 'someone-else' } },
      });
      await expect(
        m.service.submitInstallmentPayment('enr-1', 500, parentUser),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a non-positive amount', async () => {
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow);
      await expect(
        m.service.submitInstallmentPayment('enr-1', 0, parentUser),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s inside the transaction when the row vanished (lock returned nothing)', async () => {
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow);
      m.tx.$queryRaw.mockResolvedValueOnce([]);
      await expect(
        m.service.submitInstallmentPayment('enr-1', 500, parentUser),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an amount that exceeds the available balance', async () => {
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow);
      m.tx.$queryRaw.mockResolvedValueOnce([{ remainingBalance: 1_000 }]);
      m.tx.payment.aggregate.mockResolvedValueOnce({
        _sum: { amountPaid: 0 },
      });
      await expect(
        m.service.submitInstallmentPayment('enr-1', 500, parentUser),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates the installment, notifies the owner and emits (parent path)', async () => {
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow);
      m.tx.$queryRaw.mockResolvedValueOnce([{ remainingBalance: 100_000 }]);
      m.tx.payment.create.mockResolvedValueOnce({
        id: 'pay-i',
        amountPaid: 50_000,
        platformAmount: 0,
        schoolAmount: 50_000,
        paymentDate: new Date('2026-02-01'),
        paymentType: PaymentType.INSTALLMENT,
      });

      const res = await m.service.submitInstallmentPayment(
        'enr-1',
        500,
        parentUser,
        'receipts/u1/ok.jpg',
      );

      expect(m.tx.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amountPaid: 50_000,
            receiver: PaymentReceiver.SCHOOL,
            paymentType: PaymentType.INSTALLMENT,
            status: PaymentTransactionStatus.PENDING,
          }),
        }),
      );
      expect(m.notifications.create).toHaveBeenCalledTimes(1);
      expect(m.events.emitPaymentsChanged).toHaveBeenCalledWith({
        parentUserId: parentUser.userId,
        schoolId: SCHOOL_ID,
        notifyAdmins: true,
      });
      expect(res.amount).toBe(500);
      expect(res.schoolAmount).toBe(500);
      expect(res.schoolName).toBe('Acme');
    });

    it('BLOCKS a school owner recording a payment on a family’s enrollment', async () => {
      // This used to be allowed, which let one person both submit a payment and
      // approve it from the school dashboard — clearing a balance nobody paid.
      // See enrollment.installment-authz.spec.ts for the full rule.
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        ...enrollmentRow,
        school: { ownerId: 'owner-1', name: 'Acme' },
      });

      const owner = {
        userId: 'owner-1',
        role: UserRole.SCHOOL_OWNER,
        schoolId: SCHOOL_ID,
      };
      await expect(
        m.service.submitInstallmentPayment('enr-1', 500, owner),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(m.tx.payment.create).not.toHaveBeenCalled();
    });

    it('lets a school owner pay for their OWN child (no notify branch)', async () => {
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        ...enrollmentRow,
        school: { ownerId: null, name: 'Acme' }, // no ownerId -> skip notify branch
        child: { fullName: 'Ada', parent: { userId: 'owner-1' } },
      });
      m.tx.$queryRaw.mockResolvedValueOnce([{ remainingBalance: 100_000 }]);
      m.tx.payment.create.mockResolvedValueOnce({
        id: 'pay-i',
        amountPaid: 50_000,
        platformAmount: 0,
        schoolAmount: 50_000,
        paymentDate: new Date('2026-02-01'),
        paymentType: PaymentType.INSTALLMENT,
      });

      const owner = {
        userId: 'owner-1',
        role: UserRole.SCHOOL_OWNER,
        schoolId: SCHOOL_ID,
      };
      const res = await m.service.submitInstallmentPayment('enr-1', 500, owner);
      expect(res.amount).toBe(500);
      expect(m.notifications.create).not.toHaveBeenCalled();
    });

    it('replays on a lost idempotency race (P2002 on create)', async () => {
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow);
      m.tx.$queryRaw.mockResolvedValueOnce([{ remainingBalance: 100_000 }]);
      m.tx.payment.create.mockRejectedValueOnce(p2002(['idempotencyKey']));
      m.prisma.payment.findUnique.mockResolvedValueOnce({
        id: 'old-pay',
        amountPaid: 50_000,
        status: PaymentTransactionStatus.PENDING,
        paymentDate: new Date('2026-02-01'),
        paymentType: PaymentType.INSTALLMENT,
        enrollment: { child: { fullName: 'Ada' }, school: { name: 'Acme' } },
      });

      const res = await m.service.submitInstallmentPayment(
        'enr-1',
        500,
        parentUser,
        undefined,
        'idem-1',
      );
      expect(res.amount).toBe(500);
    });

    it('rethrows a non-idempotency transaction error', async () => {
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow);
      m.tx.$queryRaw.mockResolvedValueOnce([{ remainingBalance: 100_000 }]);
      m.tx.payment.create.mockRejectedValueOnce(new Error('db down'));
      await expect(
        m.service.submitInstallmentPayment(
          'enr-1',
          500,
          parentUser,
          undefined,
          'idem-1',
        ),
      ).rejects.toThrow('db down');
    });
  });

  // ---------------------------------------------------------- getPaymentOutcome
  describe('getPaymentOutcome', () => {
    const PARENT = {
      userId: 'user-1',
      role: UserRole.PARENT,
      schoolId: null,
    } as never;

    /** A payment row shaped as the outcome projection consumes it. */
    function outcomeRow(over: Record<string, unknown> = {}) {
      return {
        id: 'pay-1',
        schoolId: SCHOOL_ID,
        enrollmentId: 'enr-1',
        paystackReference: 'lopay_ref',
        status: PaymentTransactionStatus.PENDING,
        isConfirmed: false,
        amountPaid: 27_500_00,
        amountCharged: 28_000_00,
        paymentType: PaymentType.FIRST_PAYMENT,
        paymentDate: new Date('2026-02-01'),
        receiptUrl: null,
        enrollment: {
          id: 'enr-1',
          childId: 'child-1',
          schoolId: SCHOOL_ID,
          className: 'Basic 1',
          totalSchoolFee: 100_000_00,
          remainingBalance: 72_500_00,
          paymentStatus: PaymentStatus.ACTIVE,
          installmentFrequency: InstallmentFrequency.MONTHLY,
          termStartDate: new Date('2026-01-01'),
          termEndDate: new Date('2026-04-01'),
          createdAt: new Date('2026-01-01'),
          child: { fullName: 'Ada', parent: { userId: 'user-1' } },
          school: { name: 'Acme' },
          payments: [],
        },
        ...over,
      };
    }

    it('rejects a call with neither locator', async () => {
      await expect(
        m.service.getPaymentOutcome({}, PARENT),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s an unknown payment', async () => {
      m.prisma.payment.findFirst.mockResolvedValueOnce(null);
      await expect(
        m.service.getPaymentOutcome({ paymentId: 'nope' }, PARENT),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    /**
     * Authorization runs BEFORE the gateway call, so the endpoint cannot be
     * used to probe whether an arbitrary reference exists at Paystack.
     */
    it("refuses someone else's payment without touching Paystack", async () => {
      m.prisma.payment.findFirst.mockResolvedValueOnce(
        outcomeRow({
          enrollment: {
            ...outcomeRow().enrollment,
            child: { fullName: 'Ada', parent: { userId: 'someone-else' } },
          },
        }),
      );
      await expect(
        m.service.getPaymentOutcome({ reference: 'lopay_ref' }, PARENT),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(m.paystack.verifyTransaction).not.toHaveBeenCalled();
    });

    it('lets the school owner read a payment at their own school', async () => {
      m.prisma.payment.findFirst.mockResolvedValue(
        outcomeRow({
          status: PaymentTransactionStatus.SUCCESS,
          isConfirmed: true,
          enrollment: {
            ...outcomeRow().enrollment,
            child: { fullName: 'Ada', parent: { userId: 'someone-else' } },
          },
        }),
      );
      const res = await m.service.getPaymentOutcome({ paymentId: 'pay-1' }, {
        userId: 'owner-1',
        role: UserRole.SCHOOL_OWNER,
        schoolId: SCHOOL_ID,
      } as never);
      expect(res.state).toBe('succeeded');
    });

    /**
     * The screen loads the instant the popup closes, usually before the
     * webhook. Verifying here is what stops a parent being shown "processing"
     * for money that has already moved.
     */
    it('verifies and reconciles an unsettled charge, then reports the settled row', async () => {
      m.paystack.verifyTransaction.mockResolvedValueOnce({
        status: 'success',
        fees: 150,
        gatewayResponse: 'Successful',
      });
      m.prisma.payment.findFirst
        .mockResolvedValueOnce(outcomeRow())
        .mockResolvedValueOnce(
          outcomeRow({
            status: PaymentTransactionStatus.SUCCESS,
            isConfirmed: true,
          }),
        );

      const res = await m.service.getPaymentOutcome(
        { reference: 'lopay_ref' },
        PARENT,
      );

      expect(m.ledger.reconcilePaystackPayment).toHaveBeenCalledWith(
        'lopay_ref',
        150,
        null,
      );
      // Re-read after settling — the first row said PENDING.
      expect(res.state).toBe('succeeded');
      expect(res.childName).toBe('Ada');
      expect(res.schoolName).toBe('Acme');
      expect(res.amount).toBe(28_000); // gross charge, not the credited amount
    });

    it('fails an unsettled charge Paystack reports as failed, and surfaces the reason', async () => {
      m.paystack.verifyTransaction.mockResolvedValueOnce({
        status: 'failed',
        fees: null,
        gatewayResponse: 'Insufficient funds',
      });
      m.prisma.payment.findFirst
        .mockResolvedValueOnce(outcomeRow())
        .mockResolvedValueOnce(
          outcomeRow({ status: PaymentTransactionStatus.FAILED }),
        );

      const res = await m.service.getPaymentOutcome(
        { reference: 'lopay_ref' },
        PARENT,
      );

      expect(m.ledger.failPaystackPayment).toHaveBeenCalledWith('lopay_ref');
      expect(res.state).toBe('failed');
      expect(res.reason).toBe('Insufficient funds');
    });

    /**
     * Re-verifying a payment we have already settled spends an external call
     * (behind a circuit breaker, with retries) to be told what the row already
     * says, and puts that latency in front of the screen on every refresh.
     */
    it('does not re-verify a payment already settled in our books', async () => {
      m.prisma.payment.findFirst.mockResolvedValue(
        outcomeRow({
          status: PaymentTransactionStatus.SUCCESS,
          isConfirmed: true,
        }),
      );

      const res = await m.service.getPaymentOutcome(
        { reference: 'lopay_ref' },
        PARENT,
      );

      expect(m.paystack.verifyTransaction).not.toHaveBeenCalled();
      expect(res.state).toBe('succeeded');
    });

    /**
     * Paystack being unreachable is not a failed payment. The row we already
     * hold stays authoritative and the parent keeps seeing "processing" —
     * telling them it failed is what pushes them into paying twice.
     */
    it('degrades to the known row when Paystack is unreachable', async () => {
      m.paystack.verifyTransaction.mockRejectedValueOnce(new Error('offline'));
      m.prisma.payment.findFirst.mockResolvedValue(outcomeRow());

      const res = await m.service.getPaymentOutcome(
        { reference: 'lopay_ref' },
        PARENT,
      );

      expect(res.state).toBe('processing');
      expect(res.reason).toBeNull();
    });

    /** An installment has no reference, so the gateway is never involved. */
    it('projects an installment awaiting school confirmation', async () => {
      m.prisma.payment.findFirst.mockResolvedValue(
        outcomeRow({
          paystackReference: null,
          amountCharged: null,
          amountPaid: 50_000_00,
          paymentType: PaymentType.INSTALLMENT,
        }),
      );

      const res = await m.service.getPaymentOutcome(
        { paymentId: 'pay-1' },
        PARENT,
      );

      expect(m.paystack.verifyTransaction).not.toHaveBeenCalled();
      expect(res.state).toBe('processing');
      expect(res.paymentType).toBe(PaymentType.INSTALLMENT);
      // No amountCharged on a bank transfer — falls back to what was paid.
      expect(res.amount).toBe(50_000);
      // The id is the only locator an installment has; support quotes it.
      expect(res.reference).toBe('pay-1');
    });
  });

  // ------------------------------------------------ processPaystackWebhookEvent
  describe('processPaystackWebhookEvent', () => {
    it('short-circuits a duplicate delivery (dedupe P2002)', async () => {
      m.prisma.webhookEvent.create.mockRejectedValueOnce(p2002(['dedupeKey']));
      const res = await m.service.processPaystackWebhookEvent({
        event: 'charge.success',
        data: { id: 1, reference: 'ref-1' },
      } as never);
      expect(res).toEqual({ received: true, duplicate: true });
      expect(m.ledger.reconcilePaystackPayment).not.toHaveBeenCalled();
    });

    it('rethrows a non-dedupe persistence error', async () => {
      m.prisma.webhookEvent.create.mockRejectedValueOnce(new Error('insert'));
      await expect(
        m.service.processPaystackWebhookEvent({
          event: 'charge.success',
          data: { reference: 'ref-1' },
        } as never),
      ).rejects.toThrow('insert');
    });

    it('reconciles on charge.success and marks the row processed', async () => {
      const res = await m.service.processPaystackWebhookEvent({
        event: 'charge.success',
        data: { id: 5, reference: 'ref-1', fees: 150 },
      } as never);
      expect(m.ledger.reconcilePaystackPayment).toHaveBeenCalledWith(
        'ref-1',
        150,
        null,
      );
      expect(m.prisma.webhookEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { processedAt: expect.any(Date) } }),
      );
      expect(res).toEqual({ received: true });
    });

    it('fails the payment on charge.failed', async () => {
      await m.service.processPaystackWebhookEvent({
        event: 'charge.failed',
        data: { id: 6, reference: 'ref-2' },
      } as never);
      expect(m.ledger.failPaystackPayment).toHaveBeenCalledWith('ref-2');
    });

    it('auto-reverses on charge.dispute.* via ledger and notifies admins', async () => {
      m.prisma.payment.findUnique.mockResolvedValueOnce({
        id: 'pay-d',
        schoolId: SCHOOL_ID,
        amountPaid: 25_000,
      });
      await m.service.processPaystackWebhookEvent({
        event: 'charge.dispute.create',
        data: { id: 7, reference: 'ref-3' },
      } as never);
      expect(m.ledger.reversePaystackPaymentByDispute).toHaveBeenCalledWith(
        'ref-3',
        'charge.dispute.create',
      );
      expect(m.notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Paystack Dispute / Refund',
        }),
      );
    });

    it('handles refund with no reference (lookup returns null, still notifies admins)', async () => {
      m.prisma.payment.findUnique.mockResolvedValueOnce(null);
      await m.service.processPaystackWebhookEvent({
        event: 'refund.processed',
        data: { id: 8 }, // no reference
      } as never);
      expect(m.ledger.reversePaystackPaymentByDispute).not.toHaveBeenCalled();
      expect(m.notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Paystack Dispute / Refund',
        }),
      );
    });

    it('ignores an unrecognized event but still marks it processed', async () => {
      const res = await m.service.processPaystackWebhookEvent({
        event: 'customer.created',
        data: { id: 9, reference: 'ref-x' },
      } as never);
      expect(m.ledger.reconcilePaystackPayment).not.toHaveBeenCalled();
      expect(m.ledger.failPaystackPayment).not.toHaveBeenCalled();
      expect(m.audit.record).not.toHaveBeenCalled();
      expect(res).toEqual({ received: true });
    });

    it('records the processing error on the row and rethrows for retry', async () => {
      m.ledger.reconcilePaystackPayment.mockRejectedValueOnce(
        new Error('reconcile boom'),
      );
      await expect(
        m.service.processPaystackWebhookEvent({
          event: 'charge.success',
          data: { id: 10, reference: 'ref-4' },
        } as never),
      ).rejects.toThrow('reconcile boom');
      expect(m.prisma.webhookEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { error: 'reconcile boom' } }),
      );
    });

    it('handles a missing event object (defaults + random dedupe key)', async () => {
      const res = await m.service.processPaystackWebhookEvent(
        undefined as never,
      );
      expect(res).toEqual({ received: true });
      expect(m.prisma.webhookEvent.create).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------- thin ledger callers
  describe('thin ledger callers', () => {
    it('reconcilePaystackPayment delegates to the ledger', async () => {
      await expect(
        m.service.reconcilePaystackPayment('ref', 100, null),
      ).resolves.toEqual({ reconciled: true });
      expect(m.ledger.reconcilePaystackPayment).toHaveBeenCalledWith(
        'ref',
        100,
        null,
      );
    });

    it('failPaystackPayment delegates to the ledger', async () => {
      await expect(m.service.failPaystackPayment('ref')).resolves.toEqual({
        failed: true,
      });
      expect(m.ledger.failPaystackPayment).toHaveBeenCalledWith('ref');
    });

    it('confirmFirstPayment delegates to the ledger', async () => {
      const actor = { userId: 'admin-1' } as never;
      await expect(
        m.service.confirmFirstPayment('enr-1', SCHOOL_ID, actor),
      ).resolves.toEqual({ confirmed: true });
      expect(m.ledger.confirmFirstPayment).toHaveBeenCalledWith(
        'enr-1',
        SCHOOL_ID,
        actor,
      );
    });
  });

  // ----------------------------- resolveEnrollmentTarget (real, via enrollChild)
  describe('resolveEnrollmentTarget (through enrollChild)', () => {
    it('lazily creates a Parent from the user phone on first enrollment', async () => {
      m.prisma.parent.findUnique.mockResolvedValueOnce(null);
      m.prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneNumber: '0800',
        school: null,
      });
      m.prisma.parent.create.mockResolvedValueOnce({ id: 'parent-new' });

      await m.service.enrollChild(baseDto(), 'u1');

      expect(m.prisma.parent.create).toHaveBeenCalledWith({
        data: { userId: 'u1', phoneNumber: '0800' },
      });
    });

    it('falls back to the school phone when the user has none', async () => {
      m.prisma.parent.findUnique.mockResolvedValueOnce(null);
      m.prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneNumber: null,
        school: { phone: '0700' },
      });
      m.prisma.parent.create.mockResolvedValueOnce({ id: 'parent-new' });

      await m.service.enrollChild(baseDto(), 'u1');
      expect(m.prisma.parent.create).toHaveBeenCalledWith({
        data: { userId: 'u1', phoneNumber: '0700' },
      });
    });

    it('falls back to empty phone when neither user nor school has one', async () => {
      m.prisma.parent.findUnique.mockResolvedValueOnce(null);
      m.prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneNumber: null,
        school: null,
      });
      m.prisma.parent.create.mockResolvedValueOnce({ id: 'parent-new' });

      await m.service.enrollChild(baseDto(), 'u1');
      expect(m.prisma.parent.create).toHaveBeenCalledWith({
        data: { userId: 'u1', phoneNumber: '' },
      });
    });

    it('rejects when the user backing a missing parent cannot be found', async () => {
      m.prisma.parent.findUnique.mockResolvedValueOnce(null);
      m.prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(
        m.service.enrollChild(baseDto(), 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a childId that does not belong to the parent', async () => {
      m.prisma.child.findUnique.mockResolvedValueOnce({
        id: 'child-1',
        parentId: 'someone-else',
      });
      await expect(
        m.service.enrollChild(baseDto({ childId: 'child-1' }), 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a childId that does not exist', async () => {
      m.prisma.child.findUnique.mockResolvedValueOnce(null);
      await expect(
        m.service.enrollChild(baseDto({ childId: 'ghost' }), 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a valid childId', async () => {
      m.prisma.child.findUnique.mockResolvedValueOnce({
        id: 'child-1',
        parentId: 'parent-1',
      });
      const res = await m.service.enrollChild(
        baseDto({ childId: 'child-1', childName: undefined }),
        'u1',
      );
      expect(res.payment).toBeDefined();
      expect(m.prisma.child.create).not.toHaveBeenCalled();
    });

    it('reuses an existing child with the same identity (no create)', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-existing' });
      await m.service.enrollChild(baseDto(), 'u1');
      expect(m.prisma.child.create).not.toHaveBeenCalled();
      expect(m.tx.childEnrollment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ childId: 'child-existing' }),
        }),
      );
    });

    it('creates a new child when none matches', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce(null);
      m.prisma.child.create.mockResolvedValueOnce({ id: 'child-fresh' });
      await m.service.enrollChild(baseDto(), 'u1');
      expect(m.prisma.child.create).toHaveBeenCalled();
    });

    it('recovers from a child-create race (P2002) by re-fetching', async () => {
      m.prisma.child.findFirst
        .mockResolvedValueOnce(null) // first lookup: none
        .mockResolvedValueOnce({ id: 'child-raced' }); // re-fetch after conflict
      m.prisma.child.create.mockRejectedValueOnce(p2002(['parentId']));
      await m.service.enrollChild(baseDto(), 'u1');
      expect(m.tx.childEnrollment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ childId: 'child-raced' }),
        }),
      );
    });

    it('rethrows a child-create P2002 when the re-fetch finds nothing', async () => {
      m.prisma.child.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      m.prisma.child.create.mockRejectedValueOnce(p2002(['parentId']));
      await expect(
        m.service.enrollChild(baseDto(), 'u1'),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    it('rethrows a non-P2002 child-create error', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce(null);
      m.prisma.child.create.mockRejectedValueOnce(new Error('boom'));
      await expect(m.service.enrollChild(baseDto(), 'u1')).rejects.toThrow(
        'boom',
      );
    });

    it('rejects when neither childId nor childName is supplied', async () => {
      await expect(
        m.service.enrollChild(
          baseDto({ childId: undefined, childName: undefined }),
          'u1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('retries a FAILED enrollment for the same school (update path)', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-failed',
        schoolId: SCHOOL_ID,
        paymentStatus: PaymentStatus.FAILED,
      });
      await m.service.enrollChild(baseDto(), 'u1');
      expect(m.tx.childEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'enr-failed' } }),
      );
      expect(m.tx.childEnrollment.create).not.toHaveBeenCalled();
    });

    it('rejects a FAILED enrollment that belongs to a different school', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-failed',
        schoolId: 'other-school',
        paymentStatus: PaymentStatus.FAILED,
      });
      await expect(
        m.service.enrollChild(baseDto(), 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when an ACTIVE enrollment already exists', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-active',
        schoolId: SCHOOL_ID,
        paymentStatus: PaymentStatus.ACTIVE,
      });
      await expect(
        m.service.enrollChild(baseDto(), 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a PENDING enrollment when pending-retry is not allowed', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-pending',
        schoolId: SCHOOL_ID,
        paymentStatus: PaymentStatus.PENDING,
      });
      await expect(
        m.service.enrollChild(baseDto(), 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // -------------------------------------------- enrollChild idempotency wiring
  describe('enrollChild idempotency', () => {
    it('replays the original outcome for a known key (real replay builder)', async () => {
      m.prisma.payment.findUnique.mockResolvedValueOnce({
        id: 'old-pay',
        enrollment: { child: { fullName: 'Ada' }, school: { name: 'Acme' } },
      });
      const res = await m.service.enrollChild(
        baseDto({ idempotencyKey: 'k1' }),
        'u1',
      );
      expect(res).toEqual(
        expect.objectContaining({ idempotent: true, childName: 'Ada' }),
      );
      expect(m.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('replays after losing an idempotency race in the transaction', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.$transaction.mockRejectedValueOnce(p2002(['idempotencyKey']));
      m.prisma.payment.findUnique
        .mockResolvedValueOnce(null) // top-of-method lookup: not yet present
        .mockResolvedValueOnce({
          id: 'old-pay',
          enrollment: { child: { fullName: 'Ada' }, school: { name: 'Acme' } },
        }); // post-conflict lookup
      const res = await m.service.enrollChild(
        baseDto({ idempotencyKey: 'k1' }),
        'u1',
      );
      expect(res).toEqual(expect.objectContaining({ idempotent: true }));
    });

    it('rethrows a non-idempotency transaction failure', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.$transaction.mockRejectedValueOnce(new Error('tx boom'));
      await expect(
        m.service.enrollChild(baseDto({ idempotencyKey: 'k1' }), 'u1'),
      ).rejects.toThrow('tx boom');
    });
  });

  // ------------------------ initiateFirstPayment + resolvePendingFirstPayment
  describe('initiateFirstPayment (real target + pending resolution)', () => {
    it('rejects a receipt path outside the caller’s namespace', async () => {
      await expect(
        m.service.initiateFirstPayment(
          baseDto({ receiptUrl: 'receipts/hacker/x.jpg' }),
          'u1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when the payer has no email on file', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.user.findUnique.mockResolvedValueOnce({ email: null });
      await expect(
        m.service.initiateFirstPayment(baseDto(), 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('initializes Paystack and returns the access code (happy path)', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      const res = await m.service.initiateFirstPayment(baseDto(), 'u1');
      expect(m.paystack.initializeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'p@x.test', subaccount: 'ACCT_x' }),
      );
      expect(m.prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { paystackAccessCode: 'AC_1' } }),
      );
      expect(res.reference).toBe('lopay_ref');
      expect(res.accessCode).toBe('AC_1');
    });

    it('resumes an in-flight pending payment verified as success (reconcile, no new charge)', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-pending',
        schoolId: SCHOOL_ID,
        paymentStatus: PaymentStatus.PENDING,
      });
      m.prisma.payment.findFirst.mockResolvedValueOnce({
        paystackReference: 'lopay_old',
        paystackAccessCode: 'AC_old',
        amountCharged: 28_000,
        status: PaymentTransactionStatus.PENDING,
      });
      m.paystack.verifyTransaction.mockResolvedValueOnce({
        status: 'success',
        fees: 200,
      });

      const res = await m.service.initiateFirstPayment(baseDto(), 'u1');
      expect(m.ledger.reconcilePaystackPayment).toHaveBeenCalledWith(
        'lopay_old',
        200,
        null,
      );
      expect(res).toEqual(
        expect.objectContaining({ idempotent: true, reference: 'lopay_old' }),
      );
      expect(m.paystack.initializeTransaction).not.toHaveBeenCalled();
    });

    it('resumes the same reference when Paystack is unreachable', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-pending',
        schoolId: SCHOOL_ID,
        paymentStatus: PaymentStatus.PENDING,
      });
      m.prisma.payment.findFirst.mockResolvedValueOnce({
        paystackReference: 'lopay_old',
        paystackAccessCode: 'AC_old',
        amountCharged: null, // exercises the null->null resume branch
        status: PaymentTransactionStatus.PENDING,
      });
      m.paystack.verifyTransaction.mockRejectedValueOnce(new Error('timeout'));

      const res = await m.service.initiateFirstPayment(baseDto(), 'u1');
      expect(res).toEqual(
        expect.objectContaining({ idempotent: true, amountCharged: null }),
      );
      expect(m.paystack.initializeTransaction).not.toHaveBeenCalled();
    });

    /*
     * The trap this pair of tests exists to prevent (seen in production after the
     * live cutover): a school's subaccount existed only on the test integration,
     * so initialize was refused and the payment row was left PENDING with no
     * access code. Every retry then resolved that dead row, verify answered
     * "Transaction reference not found", the catch read that as an outage, and the
     * client was handed `accessCode: null` — which the Paystack popup reports as
     * an invalid *key*. The enrollment could never be paid again.
     */
    it('fails a pending payment Paystack has never heard of, then charges afresh', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-pending',
        schoolId: SCHOOL_ID,
        paymentStatus: PaymentStatus.PENDING,
      });
      m.prisma.payment.findFirst.mockResolvedValueOnce({
        paystackReference: 'lopay_ghost',
        paystackAccessCode: 'AC_ghost',
        amountCharged: 28_000,
        status: PaymentTransactionStatus.PENDING,
      });
      m.paystack.verifyTransaction.mockRejectedValueOnce(
        new PaystackApiError(400, 'Transaction reference not found.'),
      );

      const res = await m.service.initiateFirstPayment(baseDto(), 'u1');

      expect(m.ledger.failPaystackPayment).toHaveBeenCalledWith('lopay_ghost');
      expect(m.paystack.initializeTransaction).toHaveBeenCalled();
      expect(res.reference).toBe('lopay_ref');
      expect(res.accessCode).toBe('AC_1');
    });

    /*
     * The other half of the same guard. A 401 is ALSO a 4xx, but it means our key
     * is wrong — not that the transaction is fake. Failing on it would mark real,
     * paid charges FAILED the moment a key was misconfigured, so anything that
     * isn't an explicit "unknown reference" must stay conservative.
     */
    it('resumes (never fails) a pending payment when verify fails on auth', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-pending',
        schoolId: SCHOOL_ID,
        paymentStatus: PaymentStatus.PENDING,
      });
      m.prisma.payment.findFirst.mockResolvedValueOnce({
        paystackReference: 'lopay_real',
        paystackAccessCode: 'AC_real',
        amountCharged: 28_000,
        status: PaymentTransactionStatus.PENDING,
      });
      m.paystack.verifyTransaction.mockRejectedValueOnce(
        new PaystackApiError(401, 'Invalid key'),
      );

      const res = await m.service.initiateFirstPayment(baseDto(), 'u1');

      expect(m.ledger.failPaystackPayment).not.toHaveBeenCalled();
      expect(m.paystack.initializeTransaction).not.toHaveBeenCalled();
      expect(res).toEqual(
        expect.objectContaining({
          idempotent: true,
          reference: 'lopay_real',
          accessCode: 'AC_real',
        }),
      );
    });

    it('fails a pending payment that never got an access code, without asking Paystack', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-pending',
        schoolId: SCHOOL_ID,
        paymentStatus: PaymentStatus.PENDING,
      });
      m.prisma.payment.findFirst.mockResolvedValueOnce({
        paystackReference: 'lopay_orphan',
        paystackAccessCode: null, // initialize never completed
        amountCharged: 28_000,
        status: PaymentTransactionStatus.PENDING,
      });

      const res = await m.service.initiateFirstPayment(baseDto(), 'u1');

      // No transaction exists, so there is nothing to verify and nothing to
      // double-charge — the doomed external call is skipped entirely.
      expect(m.paystack.verifyTransaction).not.toHaveBeenCalled();
      expect(m.ledger.failPaystackPayment).toHaveBeenCalledWith('lopay_orphan');
      expect(res.accessCode).toBe('AC_1');
    });

    /*
     * The payment row is written BEFORE Paystack is called, so a refusal here is
     * exactly what minted the orphaned PENDING rows above. Failing it on the way
     * out keeps the next attempt clean and stops the reconciliation sweep
     * re-verifying a reference that was never created.
     */
    it('fails the payment it just wrote when Paystack refuses to initialize', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      const refusal = new PaystackApiError(400, 'Invalid subaccount');
      m.paystack.initializeTransaction.mockRejectedValueOnce(refusal);

      await expect(
        m.service.initiateFirstPayment(baseDto(), 'u1'),
      ).rejects.toBe(refusal);

      expect(m.ledger.failPaystackPayment).toHaveBeenCalledWith(
        expect.stringMatching(/^lopay_/),
      );
      // The access code is never written, so no half-live row is left behind.
      expect(m.prisma.payment.update).not.toHaveBeenCalled();
    });

    it('surfaces the initialize failure even if the cleanup itself fails', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      const refusal = new PaystackApiError(400, 'Invalid subaccount');
      m.paystack.initializeTransaction.mockRejectedValueOnce(refusal);
      m.ledger.failPaystackPayment.mockRejectedValueOnce(new Error('db down'));

      await expect(
        m.service.initiateFirstPayment(baseDto(), 'u1'),
      ).rejects.toBe(refusal);
    });

    it('frees a pending enrollment for a fresh charge when verify says failed', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-pending',
        schoolId: SCHOOL_ID,
        paymentStatus: PaymentStatus.PENDING,
      });
      m.prisma.payment.findFirst.mockResolvedValueOnce({
        paystackReference: 'lopay_old',
        paystackAccessCode: 'AC_old',
        amountCharged: 28_000,
        status: PaymentTransactionStatus.PENDING,
      });
      m.paystack.verifyTransaction.mockResolvedValueOnce({
        status: 'failed',
        fees: null,
      });

      const res = await m.service.initiateFirstPayment(baseDto(), 'u1');
      expect(m.ledger.failPaystackPayment).toHaveBeenCalledWith('lopay_old');
      // proceeds to a brand new charge, reusing the pending enrollment via update
      expect(m.tx.childEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'enr-pending' } }),
      );
      expect(m.paystack.initializeTransaction).toHaveBeenCalled();
      expect(res.reference).toBe('lopay_ref');
    });

    it('treats a pending enrollment with no reference as free to re-charge', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-pending',
        schoolId: SCHOOL_ID,
        paymentStatus: PaymentStatus.PENDING,
      });
      m.prisma.payment.findFirst.mockResolvedValueOnce(null); // no in-flight payment
      const res = await m.service.initiateFirstPayment(baseDto(), 'u1');
      expect(m.paystack.verifyTransaction).not.toHaveBeenCalled();
      expect(m.tx.childEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'enr-pending' } }),
      );
      expect(res.reference).toBe('lopay_ref');
    });

    it('resumes when the in-flight payment is still pending at Paystack', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-pending',
        schoolId: SCHOOL_ID,
        paymentStatus: PaymentStatus.PENDING,
      });
      m.prisma.payment.findFirst.mockResolvedValueOnce({
        paystackReference: 'lopay_old',
        paystackAccessCode: 'AC_old',
        amountCharged: 28_000,
        status: PaymentTransactionStatus.PENDING,
      });
      m.paystack.verifyTransaction.mockResolvedValueOnce({
        status: 'pending',
        fees: null,
      });

      const res = await m.service.initiateFirstPayment(baseDto(), 'u1');
      expect(m.ledger.reconcilePaystackPayment).not.toHaveBeenCalled();
      expect(m.ledger.failPaystackPayment).not.toHaveBeenCalled();
      expect(res).toEqual(expect.objectContaining({ idempotent: true }));
    });

    it('reuses a FAILED enrollment via update (retry path)', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.childEnrollment.findUnique.mockResolvedValueOnce({
        id: 'enr-failed',
        schoolId: SCHOOL_ID,
        paymentStatus: PaymentStatus.FAILED,
      });
      await m.service.initiateFirstPayment(baseDto(), 'u1');
      expect(m.tx.childEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'enr-failed' } }),
      );
    });

    it('replays an in-flight intent for a known idempotency key with a null amount', async () => {
      m.prisma.payment.findUnique.mockResolvedValueOnce({
        paystackReference: 'lopay_old',
        paystackAccessCode: 'AC_old',
        amountCharged: null,
        status: PaymentTransactionStatus.PENDING,
      });
      const res = await m.service.initiateFirstPayment(
        baseDto({ idempotencyKey: 'k1' }),
        'u1',
      );
      expect(res).toEqual(
        expect.objectContaining({ idempotent: true, amountCharged: null }),
      );
      expect(m.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('replays after losing an idempotency race in the transaction', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.$transaction.mockRejectedValueOnce(p2002(['idempotencyKey']));
      m.prisma.payment.findUnique
        .mockResolvedValueOnce(null) // top-of-method lookup
        .mockResolvedValueOnce({
          paystackReference: 'lopay_old',
          paystackAccessCode: 'AC_old',
          amountCharged: 28_000,
          status: PaymentTransactionStatus.PENDING,
        }); // post-conflict lookup
      const res = await m.service.initiateFirstPayment(
        baseDto({ idempotencyKey: 'k1' }),
        'u1',
      );
      expect(res).toEqual(expect.objectContaining({ idempotent: true }));
    });

    it('rethrows a non-idempotency transaction failure', async () => {
      m.prisma.child.findFirst.mockResolvedValueOnce({ id: 'child-1' });
      m.prisma.$transaction.mockRejectedValueOnce(new Error('tx boom'));
      await expect(
        m.service.initiateFirstPayment(baseDto({ idempotencyKey: 'k1' }), 'u1'),
      ).rejects.toThrow('tx boom');
    });
  });
});
