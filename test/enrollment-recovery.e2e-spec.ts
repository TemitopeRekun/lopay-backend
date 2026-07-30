/**
 * Real-database integration tests for the payment race-safety and enrollment
 * recovery logic added during the audit. Unlike the other e2e specs (which mock
 * Prisma), these run the real services against the local Postgres so the
 * Postgres row lock, the unique constraints, and the transactional guards are
 * actually exercised — the only way to prove the concurrency fixes hold.
 *
 * Requires the local Docker DB (see LOCAL_DEV.md): postgres on :5434, migrations
 * applied. External boundaries (Paystack, notifications, events, audit) are
 * stubbed; everything touching the DB is real.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { EnrollmentService } from '../src/enrollment/enrollment.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { MetricsService } from '../src/common/observability/metrics.service';
import { PaymentService } from '../src/payments/payment.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { EventsGateway } from '../src/events/events.gateway';
import { AuditService } from '../src/audit/audit.service';
import { PaystackService } from '../src/paystack/paystack.service';
import { DocumentsService } from '../src/documents/documents.service';
import {
  InstallmentFrequency,
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  UserRole,
} from '../src/generated/prisma/client';

describe('Enrollment & installment integration (real DB)', () => {
  let prisma: PrismaService;
  let enrollment: EnrollmentService;
  let ledger: LedgerService;
  let paystackStub: {
    initializeTransaction: jest.Mock;
    verifyTransaction: jest.Mock;
  };

  // Track ids created per test so we can clean up in FK-safe order.
  let schoolId: string;
  let ownerUserId: string;
  let parentUserId: string;
  let parentId: string;

  beforeAll(async () => {
    paystackStub = {
      initializeTransaction: jest.fn(async (args: { reference: string }) => ({
        authorizationUrl: 'https://paystack.test/pay',
        accessCode: `AC_${args.reference}`,
        reference: args.reference,
      })),
      verifyTransaction: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        PrismaService,
        PaymentService,
        EnrollmentService,
        LedgerService,
        { provide: DocumentsService, useValue: {} },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        {
          provide: EventsGateway,
          useValue: {
            emitPaymentsChanged: jest.fn(),
            emitEnrollmentsChanged: jest.fn(),
            pushNotification: jest.fn(),
          },
        },
        { provide: AuditService, useValue: { record: jest.fn() } },
        { provide: PaystackService, useValue: paystackStub },
        {
          provide: MetricsService,
          useValue: {
            recordPaymentOutcome: jest.fn(),
            setStalledConfirmations: jest.fn(),
          },
        },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    enrollment = moduleRef.get(EnrollmentService);
    ledger = moduleRef.get(LedgerService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Fresh school + owner + parent (no child/enrollment yet) for each test.
  beforeEach(async () => {
    // Clear accumulated call counts (keep initializeTransaction's default impl;
    // verifyTransaction is configured per-test via mockResolvedValueOnce).
    paystackStub.initializeTransaction.mockClear();
    paystackStub.verifyTransaction.mockReset();

    const tag = randomUUID().slice(0, 8);
    ownerUserId = randomUUID();
    parentUserId = randomUUID();
    schoolId = randomUUID();
    parentId = randomUUID();

    await prisma.user.create({
      data: {
        id: ownerUserId,
        email: `owner_${tag}@itest.local`,
        role: UserRole.SCHOOL_OWNER,
        fullName: 'Test Owner',
      },
    });
    await prisma.user.create({
      data: {
        id: parentUserId,
        email: `parent_${tag}@itest.local`,
        role: UserRole.PARENT,
        fullName: 'Test Parent',
        phoneNumber: '08000000000',
      },
    });
    await prisma.school.create({
      data: {
        id: schoolId,
        name: `ITEST School ${tag}`,
        email: `school_${tag}@itest.local`,
        phone: '08011111111',
        address: '1 Test Road',
        ownerId: ownerUserId,
        bankName: 'Test Bank',
        accountName: 'Test School',
        accountNumber: '0123456789',
        paystackSubaccountCode: `ACCT_${tag}`,
        paystackSubaccountActive: true,
      },
    });
    await prisma.classFee.create({
      data: {
        schoolId,
        className: 'Basic 1',
        feeAmount: 100_000,
        isActive: true,
      },
    });
    await prisma.parent.create({
      data: { id: parentId, userId: parentUserId, phoneNumber: '08000000000' },
    });
  });

  afterEach(async () => {
    // FK-safe teardown, scoped to this test's school/parent.
    await prisma.payment.deleteMany({ where: { schoolId } });
    await prisma.childEnrollment.deleteMany({ where: { schoolId } });
    await prisma.child.deleteMany({ where: { parentId } });
    await prisma.classFee.deleteMany({ where: { schoolId } });
    await prisma.parent.deleteMany({ where: { id: parentId } });
    await prisma.school.deleteMany({ where: { id: schoolId } });
    await prisma.user.deleteMany({
      where: { id: { in: [ownerUserId, parentUserId] } },
    });
  });

  // Helper: create a child + ACTIVE enrollment with a given remaining balance.
  const seedActiveEnrollment = async (remainingBalanceKobo: number) => {
    const child = await prisma.child.create({
      data: { parentId, fullName: 'Installment Kid', className: 'Basic 1' },
    });
    const enr = await prisma.childEnrollment.create({
      data: {
        childId: child.id,
        schoolId,
        className: 'Basic 1',
        totalSchoolFee: 100_000,
        platformFee: 2_500,
        schoolMinimumFee: 27_500,
        firstPaymentPaid: 27_500,
        remainingBalance: remainingBalanceKobo,
        paymentStatus: PaymentStatus.ACTIVE,
        installmentFrequency: InstallmentFrequency.MONTHLY,
        termStartDate: new Date('2026-01-01'),
        termEndDate: new Date('2026-04-01'),
      },
    });
    return enr.id;
  };

  const firstPaymentDto = (childName: string, idempotencyKey: string) => ({
    childName,
    schoolId,
    className: 'Basic 1',
    installmentFrequency: InstallmentFrequency.MONTHLY,
    firstPaymentPaid: 275, // naira; min = 25% (₦250) + 2.5% (₦25)
    termStartDate: new Date('2026-01-01'),
    termEndDate: new Date('2026-04-01'),
    idempotencyKey,
  });

  describe('concurrent installment submission (overpay race)', () => {
    it('rejects the second of two concurrent full-balance payments', async () => {
      const enrollmentId = await seedActiveEnrollment(50_000); // ₦500 balance
      const parent = {
        userId: parentUserId,
        role: UserRole.PARENT,
        schoolId: null,
      };

      // Two concurrent payments, each for the entire ₦500 balance.
      const results = await Promise.allSettled([
        enrollment.submitInstallmentPayment(enrollmentId, 500, parent),
        enrollment.submitInstallmentPayment(enrollmentId, 500, parent),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason?.message).toMatch(
        /exceeds the outstanding balance/i,
      );

      // Exactly one PENDING installment was recorded — no double-spend.
      const pending = await prisma.payment.findMany({
        where: {
          enrollmentId,
          paymentType: PaymentType.INSTALLMENT,
          status: PaymentTransactionStatus.PENDING,
        },
      });
      expect(pending).toHaveLength(1);
      expect(pending[0].amountPaid).toBe(50_000);
    });

    it('reserves unconfirmed payments so a later submission cannot exceed the balance', async () => {
      const enrollmentId = await seedActiveEnrollment(50_000); // ₦500
      const parent = {
        userId: parentUserId,
        role: UserRole.PARENT,
        schoolId: null,
      };

      // First ₦300 is fine; a second ₦300 exceeds the ₦200 that remains
      // available once the first (still-unconfirmed) payment is reserved.
      await enrollment.submitInstallmentPayment(enrollmentId, 300, parent);
      await expect(
        enrollment.submitInstallmentPayment(enrollmentId, 300, parent),
      ).rejects.toThrow(/exceeds the outstanding balance/i);

      // A ₦200 top-up (exactly the remaining available) is accepted.
      await expect(
        enrollment.submitInstallmentPayment(enrollmentId, 200, parent),
      ).resolves.toBeDefined();
    });
  });

  describe('interrupted PENDING first payment is resumable', () => {
    it('re-fails an abandoned Paystack charge and reuses the enrollment for a fresh attempt', async () => {
      // 1. Initiate — creates child + PENDING enrollment + PENDING payment.
      const first = await enrollment.initiateFirstPayment(
        firstPaymentDto('Resume Kid', randomUUID()),
        parentUserId,
      );
      const child = await prisma.child.findFirstOrThrow({
        where: { parentId, fullName: 'Resume Kid' },
      });
      const enr = await prisma.childEnrollment.findFirstOrThrow({
        where: { childId: child.id },
      });
      expect(enr.paymentStatus).toBe(PaymentStatus.PENDING);

      // 2. Re-initiate with a different key while the prior charge is abandoned.
      paystackStub.verifyTransaction.mockResolvedValueOnce({
        status: 'abandoned',
        reference: first.reference,
        amount: 0,
        fees: null,
      });
      await enrollment.initiateFirstPayment(
        firstPaymentDto('Resume Kid', randomUUID()),
        parentUserId,
      );

      // Still exactly ONE child (no duplicate) and the SAME enrollment reused.
      const children = await prisma.child.findMany({
        where: { parentId, fullName: 'Resume Kid' },
      });
      expect(children).toHaveLength(1);
      const enrollments = await prisma.childEnrollment.findMany({
        where: { childId: child.id },
      });
      expect(enrollments).toHaveLength(1);
      expect(enrollments[0].id).toBe(enr.id);

      // Old payment failed; a fresh PENDING payment now exists.
      const payments = await prisma.payment.findMany({
        where: { enrollmentId: enr.id },
        orderBy: { paymentDate: 'asc' },
      });
      expect(payments).toHaveLength(2);
      const statuses = payments.map((p) => p.status).sort();
      expect(statuses).toEqual([
        PaymentTransactionStatus.FAILED,
        PaymentTransactionStatus.PENDING,
      ]);
    });

    it('activates the enrollment when the in-flight charge already succeeded', async () => {
      const first = await enrollment.initiateFirstPayment(
        firstPaymentDto('Paid Kid', randomUUID()),
        parentUserId,
      );
      const child = await prisma.child.findFirstOrThrow({
        where: { parentId, fullName: 'Paid Kid' },
      });

      paystackStub.verifyTransaction.mockResolvedValueOnce({
        status: 'success',
        reference: first.reference,
        amount: 28_000,
        fees: 1_500,
      });
      const second = await enrollment.initiateFirstPayment(
        firstPaymentDto('Paid Kid', randomUUID()),
        parentUserId,
      );

      // Resume response points back at the original transaction (no new charge).
      expect(second).toMatchObject({
        idempotent: true,
        reference: first.reference,
      });
      expect(paystackStub.initializeTransaction).toHaveBeenCalledTimes(1);

      const enr = await prisma.childEnrollment.findFirstOrThrow({
        where: { childId: child.id },
      });
      expect(enr.paymentStatus).toBe(PaymentStatus.ACTIVE);
    });
  });

  describe('FAILED enrollment is retryable', () => {
    it('reuses the FAILED enrollment row instead of creating a new one', async () => {
      const child = await prisma.child.create({
        data: { parentId, fullName: 'Retry Kid', className: 'Basic 1' },
      });
      const failed = await prisma.childEnrollment.create({
        data: {
          childId: child.id,
          schoolId,
          className: 'Basic 1',
          totalSchoolFee: 100_000,
          platformFee: 2_500,
          schoolMinimumFee: 27_500,
          firstPaymentPaid: 27_500,
          remainingBalance: 72_500,
          paymentStatus: PaymentStatus.FAILED,
          installmentFrequency: InstallmentFrequency.MONTHLY,
          termStartDate: new Date('2026-01-01'),
          termEndDate: new Date('2026-04-01'),
        },
      });

      await enrollment.initiateFirstPayment(
        firstPaymentDto('Retry Kid', randomUUID()),
        parentUserId,
      );

      const enrollments = await prisma.childEnrollment.findMany({
        where: { childId: child.id },
      });
      expect(enrollments).toHaveLength(1);
      expect(enrollments[0].id).toBe(failed.id);
      expect(enrollments[0].paymentStatus).toBe(PaymentStatus.PENDING);
    });
  });

  describe('duplicate child guard', () => {
    it('enforces the unique (parentId, fullName, className) constraint', async () => {
      await prisma.child.create({
        data: { parentId, fullName: 'Twin', className: 'Basic 1' },
      });
      await expect(
        prisma.child.create({
          data: { parentId, fullName: 'Twin', className: 'Basic 1' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  // Full money lifecycle through the extracted LedgerService (Milestone 3),
  // against the real DB so the atomic balance inc/dec + guarded writes are
  // exercised end-to-end: confirm -> balance down -> reverse -> balance restored
  // -> re-confirm -> balance down again.
  describe('ledger lifecycle: confirm -> reverse -> re-confirm (real DB)', () => {
    const ownerActor = () => ({
      userId: ownerUserId,
      role: UserRole.SCHOOL_OWNER,
    });

    // Helper: submit an installment and return the resulting PENDING payment id.
    const submitPendingInstallment = async (
      enrollmentId: string,
      naira: number,
    ) => {
      await enrollment.submitInstallmentPayment(enrollmentId, naira, {
        userId: parentUserId,
        role: UserRole.PARENT,
        schoolId: null,
      });
      const pending = await prisma.payment.findFirstOrThrow({
        where: {
          enrollmentId,
          paymentType: PaymentType.INSTALLMENT,
          status: PaymentTransactionStatus.PENDING,
        },
        orderBy: { paymentDate: 'desc' },
      });
      return pending.id;
    };

    const balanceOf = async (enrollmentId: string) =>
      (
        await prisma.childEnrollment.findUniqueOrThrow({
          where: { id: enrollmentId },
        })
      ).remainingBalance;

    it('decrements on confirm, restores on reverse, and decrements again on re-confirm', async () => {
      const enrollmentId = await seedActiveEnrollment(50_000); // ₦500 balance
      const paymentId = await submitPendingInstallment(enrollmentId, 200); // ₦200

      // Submitting reserves but does not yet move the recorded balance.
      expect(await balanceOf(enrollmentId)).toBe(50_000);

      // 1. Confirm -> balance drops by ₦200 (20_000 kobo).
      await ledger.confirmPayment(paymentId, schoolId, ownerActor());
      expect(await balanceOf(enrollmentId)).toBe(30_000);
      const confirmed = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(confirmed.isConfirmed).toBe(true);
      expect(confirmed.status).toBe(PaymentTransactionStatus.SUCCESS);

      // 2. Reverse -> balance restored to ₦500; payment marked REVERSED.
      await ledger.reversePayment(paymentId, schoolId, ownerActor(), 'test');
      expect(await balanceOf(enrollmentId)).toBe(50_000);
      const reversed = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(reversed.isConfirmed).toBe(false);
      expect(reversed.status).toBe(PaymentTransactionStatus.REVERSED);

      // 3. Re-confirm the same (now-unconfirmed) installment -> balance drops again.
      await ledger.confirmPayment(paymentId, schoolId, ownerActor());
      expect(await balanceOf(enrollmentId)).toBe(30_000);
    });

    it('rejects a double-reverse (guarded write — balance restored exactly once)', async () => {
      const enrollmentId = await seedActiveEnrollment(50_000);
      const paymentId = await submitPendingInstallment(enrollmentId, 200);
      await ledger.confirmPayment(paymentId, schoolId, ownerActor());

      await ledger.reversePayment(paymentId, schoolId, ownerActor());
      expect(await balanceOf(enrollmentId)).toBe(50_000);

      // A second reverse finds no confirmed installment and must not inflate.
      await expect(
        ledger.reversePayment(paymentId, schoolId, ownerActor()),
      ).rejects.toThrow(/No confirmed installment payment found to reverse/i);
      expect(await balanceOf(enrollmentId)).toBe(50_000);
    });
  });
});
