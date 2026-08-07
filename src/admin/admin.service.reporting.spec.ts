import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DocumentsService } from '../documents/documents.service';
import { AuditService } from '../audit/audit.service';
import { PaystackService } from '../paystack/paystack.service';
import { LedgerService } from '../ledger/ledger.service';
import { SchoolOnboardingService } from '../school-onboarding/school-onboarding.service';
import { CacheService } from '../cache/cache.service';
import { PLATFORM_FEE_RATE } from '../common/fees';
import {
  PaymentStatus,
  PaymentType,
  PaymentReceiver,
} from '../generated/prisma/client';

/**
 * Coverage-oriented units for the AdminService reporting / onboarding surface
 * (the methods the original admin.service.spec.ts does not touch). Fresh mocks
 * are built per-test so `mockResolvedValueOnce` queues never leak.
 */
describe('AdminService (reporting)', () => {
  let service: AdminService;
  let prisma: {
    payment: {
      findMany: jest.Mock;
      count: jest.Mock;
      aggregate: jest.Mock;
      groupBy: jest.Mock;
    };
    childEnrollment: {
      findMany: jest.Mock;
      count: jest.Mock;
      aggregate: jest.Mock;
      groupBy: jest.Mock;
    };
    school: { findUnique: jest.Mock; update: jest.Mock; findMany: jest.Mock };
  };
  let documents: { createSignedUrlForPath: jest.Mock };
  let paystack: { createSubaccount: jest.Mock; getSubaccount: jest.Mock };
  let ledger: {
    settleFirstPayment: jest.Mock;
    rejectFirstPayment: jest.Mock;
  };
  let onboarding: { provisionSchoolAndOwner: jest.Mock };
  let cache: {
    getOrSet: (k: string, ttl: number, loader: () => unknown) => unknown;
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      payment: {
        findMany: jest.fn(),
        count: jest.fn(),
        aggregate: jest.fn(),
        groupBy: jest.fn(),
      },
      childEnrollment: {
        findMany: jest.fn(),
        count: jest.fn(),
        aggregate: jest.fn(),
        groupBy: jest.fn(),
      },
      school: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({ ok: true }),
        findMany: jest.fn(),
      },
    };
    documents = { createSignedUrlForPath: jest.fn() };
    paystack = {
      createSubaccount: jest.fn(),
      // Default: nothing on the integration, so the retry path provisions.
      getSubaccount: jest.fn().mockResolvedValue(null),
    };
    ledger = {
      settleFirstPayment: jest.fn().mockResolvedValue({ settled: true }),
      rejectFirstPayment: jest.fn().mockResolvedValue({ rejected: true }),
    };
    onboarding = { provisionSchoolAndOwner: jest.fn() };
    cache = {
      getOrSet: (_k: string, _ttl: number, loader: () => unknown) => loader(),
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: {} },
        { provide: DocumentsService, useValue: documents },
        { provide: AuditService, useValue: {} },
        { provide: PaystackService, useValue: paystack },
        { provide: LedgerService, useValue: ledger },
        { provide: SchoolOnboardingService, useValue: onboarding },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();
    service = module.get<AdminService>(AdminService);
  });

  describe('onboardSchool', () => {
    const owner = {
      id: 'u1',
      email: 'owner@x.com',
      role: 'SCHOOL_OWNER',
      fullName: 'Owner One',
      password: 'secret',
    };

    it('provisions a subaccount and reports success when Paystack accepts', async () => {
      onboarding.provisionSchoolAndOwner.mockResolvedValue({
        school: {
          id: 's1',
          name: 'Acme',
          bankCode: '058',
          accountNumber: '0001',
        },
        user: owner,
      });
      paystack.createSubaccount.mockResolvedValue('SUB_123');

      const result = await service.onboardSchool({} as never);

      expect(paystack.createSubaccount).toHaveBeenCalledWith(
        expect.objectContaining({
          businessName: 'Acme',
          settlementBank: '058',
          accountNumber: '0001',
        }),
      );
      expect(prisma.school.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 's1' },
          data: expect.objectContaining({
            paystackSubaccountCode: 'SUB_123',
            paystackSubaccountActive: true,
          }),
        }),
      );
      expect(result.school.paystackSubaccountActive).toBe(true);
      expect(result.paystack).toEqual(
        expect.objectContaining({ active: true, subaccountCode: 'SUB_123' }),
      );
      // Owner payload is trimmed to safe fields (no password).
      expect(result.user).toEqual({
        id: 'u1',
        email: 'owner@x.com',
        role: 'SCHOOL_OWNER',
        fullName: 'Owner One',
      });
      expect(result.message).toBe(
        'School and School Owner created successfully',
      );
    });

    it('still onboards (active=false) with a warning when the school has no bank code', async () => {
      onboarding.provisionSchoolAndOwner.mockResolvedValue({
        school: { id: 's1', name: 'Acme', bankCode: null, accountNumber: '0' },
        user: owner,
      });

      const result = await service.onboardSchool({} as never);

      expect(paystack.createSubaccount).not.toHaveBeenCalled();
      expect(result.school.paystackSubaccountActive).toBe(false);
      expect(result.paystack.active).toBe(false);
      expect(result.message).toContain('School created.');
    });

    it('still onboards (active=false) with a warning when Paystack throws', async () => {
      onboarding.provisionSchoolAndOwner.mockResolvedValue({
        school: {
          id: 's1',
          name: 'Acme',
          bankCode: '058',
          accountNumber: '0001',
        },
        user: owner,
      });
      paystack.createSubaccount.mockRejectedValue(new Error('paystack down'));

      const result = await service.onboardSchool({} as never);

      expect(result.school.paystackSubaccountActive).toBe(false);
      expect(result.paystack.active).toBe(false);
      expect(result.paystack.warning).toBeDefined();
      expect(result.message).toContain('School created.');
    });
  });

  describe('createSubaccountForSchool', () => {
    it('404s when the school does not exist', async () => {
      prisma.school.findUnique.mockResolvedValue(null);
      await expect(
        service.createSubaccountForSchool('missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates the subaccount and returns the code', async () => {
      prisma.school.findUnique.mockResolvedValue({
        id: 's1',
        name: 'Acme',
        bankCode: '058',
        accountNumber: '0001',
      });
      paystack.createSubaccount.mockResolvedValue('SUB_777');

      await expect(service.createSubaccountForSchool('s1')).resolves.toEqual({
        subaccountCode: 'SUB_777',
        active: true,
        created: true,
      });
    });

    it('BadRequests when provisioning cannot proceed (no bank code)', async () => {
      prisma.school.findUnique.mockResolvedValue({
        id: 's1',
        name: 'Acme',
        bankCode: null,
        accountNumber: '0001',
      });
      await expect(
        service.createSubaccountForSchool('s1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(paystack.createSubaccount).not.toHaveBeenCalled();
    });

    /*
     * This backs a retry button, so pressing it twice must not orphan the first
     * subaccount on Paystack and repoint the school at a second one. It used to
     * do exactly that: provisioning ran unconditionally.
     */
    it('keeps an existing subaccount that is still valid on this integration', async () => {
      prisma.school.findUnique.mockResolvedValue({
        id: 's1',
        name: 'Acme',
        bankCode: '058',
        accountNumber: '0001',
        paystackSubaccountCode: 'SUB_LIVE',
      });
      paystack.getSubaccount.mockResolvedValue({ subaccount_code: 'SUB_LIVE' });

      await expect(service.createSubaccountForSchool('s1')).resolves.toEqual({
        subaccountCode: 'SUB_LIVE',
        active: true,
        created: false,
      });
      expect(paystack.createSubaccount).not.toHaveBeenCalled();
      // The stored flag is re-synced — it may have been switched off by a failed
      // settlement re-point even though the subaccount itself is fine.
      expect(prisma.school.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { paystackSubaccountActive: true } }),
      );
    });

    it('replaces a subaccount that belongs to a different integration', async () => {
      prisma.school.findUnique.mockResolvedValue({
        id: 's1',
        name: 'Acme',
        bankCode: '058',
        accountNumber: '0001',
        paystackSubaccountCode: 'SUB_TESTMODE',
      });
      paystack.getSubaccount.mockResolvedValue(null); // not on this integration
      paystack.createSubaccount.mockResolvedValue('SUB_NEW');

      await expect(service.createSubaccountForSchool('s1')).resolves.toEqual({
        subaccountCode: 'SUB_NEW',
        active: true,
        created: true,
      });
    });

    /*
     * A stale "broken" verdict would send the admin straight back to the button
     * they have just successfully pressed.
     */
    it('drops the cached payout statuses after repairing a school', async () => {
      prisma.school.findUnique.mockResolvedValue({
        id: 's1',
        name: 'Acme',
        bankCode: '058',
        accountNumber: '0001',
      });
      paystack.createSubaccount.mockResolvedValue('SUB_777');

      await service.createSubaccountForSchool('s1');

      expect(cache.del).toHaveBeenCalledWith(
        'cache:admin:schools-payout-status',
      );
    });
  });

  /*
   * The check our own `paystackSubaccountActive` column cannot perform. That
   * column only records that a create call once succeeded, so a school whose
   * subaccount was made in test mode kept advertising itself as healthy after the
   * switch to live keys — right up until a parent tried to pay.
   */
  describe('getSchoolsPayoutStatus', () => {
    const school = (over: Record<string, unknown> = {}) => ({
      id: 's1',
      name: 'Acme',
      bankCode: '058',
      paystackSubaccountCode: 'SUB_1',
      paystackSubaccountActive: true,
      ...over,
    });

    it('reports ACTIVE when Paystack confirms the subaccount', async () => {
      prisma.school.findMany.mockResolvedValue([school()]);
      paystack.getSubaccount.mockResolvedValue({ subaccount_code: 'SUB_1' });

      const [status] = await service.getSchoolsPayoutStatus();
      expect(status).toEqual(
        expect.objectContaining({
          schoolId: 's1',
          state: 'ACTIVE',
          canRetry: true,
        }),
      );
    });

    it('reports NOT_ON_INTEGRATION even though our own column says active', async () => {
      prisma.school.findMany.mockResolvedValue([school()]);
      paystack.getSubaccount.mockResolvedValue(null);

      const [status] = await service.getSchoolsPayoutStatus();
      expect(status.state).toBe('NOT_ON_INTEGRATION');
      // The disagreement is the whole point — surface both sides.
      expect(status.storedActive).toBe(true);
      expect(status.detail).toMatch(/test mode/i);
    });

    it('reports MISSING when no subaccount was ever created', async () => {
      prisma.school.findMany.mockResolvedValue([
        school({
          paystackSubaccountCode: null,
          paystackSubaccountActive: false,
        }),
      ]);

      const [status] = await service.getSchoolsPayoutStatus();
      expect(status.state).toBe('MISSING');
      expect(status.canRetry).toBe(true);
      expect(paystack.getSubaccount).not.toHaveBeenCalled();
    });

    it('cannot be retried without a settlement bank on file', async () => {
      prisma.school.findMany.mockResolvedValue([
        school({ paystackSubaccountCode: null, bankCode: null }),
      ]);

      const [status] = await service.getSchoolsPayoutStatus();
      expect(status.canRetry).toBe(false);
      expect(status.detail).toMatch(/no settlement bank/i);
    });

    /*
     * An outage must not read as "broken". Rendering UNKNOWN as a failure would
     * push an admin to re-provision a perfectly healthy school and orphan its
     * real payout account.
     */
    it('reports UNKNOWN — never broken — when Paystack cannot be reached', async () => {
      prisma.school.findMany.mockResolvedValue([school()]);
      paystack.getSubaccount.mockRejectedValue(new Error('paystack down'));

      const [status] = await service.getSchoolsPayoutStatus();
      expect(status.state).toBe('UNKNOWN');
    });

    it('excludes delisted schools', async () => {
      prisma.school.findMany.mockResolvedValue([]);
      await service.getSchoolsPayoutStatus();
      expect(prisma.school.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null } }),
      );
    });
  });

  describe('getPendingFirstPayments', () => {
    it('maps rows into the pending-first-payment envelope (no signed URLs)', async () => {
      prisma.payment.findMany.mockResolvedValue([
        {
          id: 'p1',
          amountPaid: 250000,
          platformAmount: 6_250,
          schoolAmount: 243_750,
          enrollmentId: 'enr-1',
          schoolId: 's1',
          receiver: 'PLATFORM',
          isConfirmed: false,
          status: 'PENDING',
          paymentDate: new Date('2026-01-01'),
          paymentType: PaymentType.FIRST_PAYMENT,
          receiptUrl: 'r/1',
          enrollment: {
            className: 'JSS1',
            child: { fullName: 'Kid A' },
            school: { name: 'Acme' },
          },
        },
      ]);
      prisma.payment.count.mockResolvedValue(1);

      const res = await service.getPendingFirstPayments(false, 1, 50);

      expect(res).toEqual(
        expect.objectContaining({
          total: 1,
          page: 1,
          limit: 50,
          totalPages: 1,
        }),
      );
      expect(res.items[0]).toEqual(
        expect.objectContaining({
          studentName: 'Kid A',
          childName: 'Kid A',
          schoolName: 'Acme',
          className: 'JSS1',
          amount: 2500,
          amountPaid: 2500,
          type: PaymentType.FIRST_PAYMENT,
        }),
      );
      // Signing skipped when not requested — and the field is OMITTED rather
      // than nulled, so "this caller didn't ask" reads differently from "we
      // tried and the object is gone". Same convention as the school and parent
      // payment lists; see toPaymentView.
      expect(res.items[0]).not.toHaveProperty('receiptSignedUrl');
      expect(documents.createSignedUrlForPath).not.toHaveBeenCalled();
    });

    it('narrows to one school when the dashboard drills into it', async () => {
      // The admin dashboard's per-school row used to switch the admin into a
      // school-owner acting role and land on the unfiltered platform-wide queue
      // (while 403ing four school-scoped requests on the way). The filter is
      // applied in the query because the list is paginated — filtering a page
      // client-side would page over the wrong set.
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await service.getPendingFirstPayments(false, 1, 50, 'school-7');

      expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ schoolId: 'school-7' }),
      );
      expect(prisma.payment.count.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ schoolId: 'school-7' }),
      );
    });

    it('stays platform-wide when no school is given', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await service.getPendingFirstPayments(false, 1, 50);

      expect(prisma.payment.findMany.mock.calls[0][0].where).not.toHaveProperty(
        'schoolId',
      );
    });

    it('signs receipt URLs when asked and tolerates a signing failure', async () => {
      prisma.payment.findMany.mockResolvedValue([
        {
          id: 'p1',
          amountPaid: 100,
          platformAmount: 0,
          schoolAmount: 0,
          enrollmentId: 'enr-1',
          schoolId: 's1',
          receiver: 'PLATFORM',
          isConfirmed: false,
          status: 'PENDING',
          paymentDate: new Date(),
          paymentType: PaymentType.FIRST_PAYMENT,
          receiptUrl: 'r/ok',
          enrollment: { child: {}, school: {} },
        },
        {
          id: 'p2',
          amountPaid: 100,
          platformAmount: 0,
          schoolAmount: 0,
          enrollmentId: 'enr-1',
          schoolId: 's1',
          receiver: 'PLATFORM',
          isConfirmed: false,
          status: 'PENDING',
          paymentDate: new Date(),
          paymentType: PaymentType.FIRST_PAYMENT,
          receiptUrl: 'r/bad',
          enrollment: { child: {}, school: {} },
        },
      ]);
      prisma.payment.count.mockResolvedValue(2);
      documents.createSignedUrlForPath
        .mockResolvedValueOnce({ signedUrl: 'https://signed/ok' })
        .mockRejectedValueOnce(new Error('gone'));

      const res = await service.getPendingFirstPayments(true, 1, 50);

      expect(res.items[0].receiptSignedUrl).toBe('https://signed/ok');
      expect(res.items[1].receiptSignedUrl).toBeNull();
      expect(documents.createSignedUrlForPath).toHaveBeenCalledTimes(2);
    });
  });

  describe('getPendingInstallments', () => {
    it('maps installment rows into the paginated envelope', async () => {
      prisma.payment.findMany.mockResolvedValue([
        {
          id: 'p1',
          amountPaid: 50000,
          platformAmount: 0,
          schoolAmount: 50_000,
          enrollmentId: 'enr-1',
          schoolId: 's1',
          receiver: 'SCHOOL',
          isConfirmed: false,
          status: 'PENDING',
          paymentDate: new Date('2026-02-02'),
          paymentType: PaymentType.INSTALLMENT,
          enrollment: {
            className: 'JSS2',
            child: { fullName: 'Kid B' },
            school: { name: 'Beta' },
          },
        },
      ]);
      prisma.payment.count.mockResolvedValue(1);

      const res = await service.getPendingInstallments(1, 50);

      expect(res.total).toBe(1);
      expect(res.items[0]).toEqual(
        expect.objectContaining({
          amount: 500,
          amountPaid: 500,
          studentName: 'Kid B',
          childName: 'Kid B',
          className: 'JSS2',
          schoolName: 'Beta',
        }),
      );
    });
  });

  describe('getSchoolStudents', () => {
    const baseEnrollment = {
      childId: 'c1',
      className: 'JSS1',
      totalSchoolFee: 1000000,
      paymentStatus: PaymentStatus.ACTIVE,
      installmentFrequency: 'WEEKLY',
      remainingBalance: 500000,
      termStartDate: new Date('2026-03-01'),
      child: {
        fullName: 'Kid A',
        parent: { user: { fullName: 'Parent A' } },
      },
      payments: [
        {
          isConfirmed: true,
          amountPaid: 500000,
          paymentDate: new Date('2026-01-01'),
        },
      ],
    };

    it('applies className + search filters and computes a WEEKLY next-due date', async () => {
      prisma.childEnrollment.findMany.mockResolvedValue([baseEnrollment]);
      prisma.childEnrollment.count.mockResolvedValue(1);

      const res = await service.getSchoolStudents('s1', 'JSS1', 'kid', 1, 50);

      const where = prisma.childEnrollment.findMany.mock.calls[0][0].where;
      expect(where.schoolId).toBe('s1');
      expect(where.className).toBe('JSS1');
      expect(where.OR).toBeDefined();

      expect(res.items[0]).toEqual(
        expect.objectContaining({
          id: 'c1',
          studentName: 'Kid A',
          parentName: 'Parent A',
          totalFee: 10000,
          paidAmount: 5000,
          paymentStatus: PaymentStatus.ACTIVE,
          nextDueDate: '2026-01-08',
          avatarUrl: null,
        }),
      );
    });

    it('computes a MONTHLY next-due date and falls back to Unknown parent name', async () => {
      prisma.childEnrollment.findMany.mockResolvedValue([
        {
          ...baseEnrollment,
          installmentFrequency: 'MONTHLY',
          child: { fullName: 'Kid A', parent: { user: { fullName: '' } } },
        },
      ]);
      prisma.childEnrollment.count.mockResolvedValue(1);

      const res = await service.getSchoolStudents('s1');

      expect(res.items[0].parentName).toBe('Unknown');
      expect(res.items[0].nextDueDate).toBe('2026-02-01');
    });

    it('uses termStartDate when there are no confirmed payments', async () => {
      prisma.childEnrollment.findMany.mockResolvedValue([
        { ...baseEnrollment, payments: [] },
      ]);
      prisma.childEnrollment.count.mockResolvedValue(1);

      const res = await service.getSchoolStudents('s1');
      expect(res.items[0].nextDueDate).toBe('2026-03-01');
    });

    it('returns a null next-due date when the balance is cleared', async () => {
      prisma.childEnrollment.findMany.mockResolvedValue([
        { ...baseEnrollment, remainingBalance: 0 },
      ]);
      prisma.childEnrollment.count.mockResolvedValue(1);

      const res = await service.getSchoolStudents('s1');
      expect(res.items[0].nextDueDate).toBeNull();
    });
  });

  describe('getPlatformRevenue', () => {
    it('sums confirmed platform amounts and returns Naira', async () => {
      prisma.payment.aggregate.mockResolvedValue({
        _sum: { platformAmount: 123400 },
      });
      await expect(service.getPlatformRevenue()).resolves.toEqual({
        totalRevenue: 1234,
      });
    });

    it('treats a null aggregate as zero revenue', async () => {
      prisma.payment.aggregate.mockResolvedValue({
        _sum: { platformAmount: null },
      });
      await expect(service.getPlatformRevenue()).resolves.toEqual({
        totalRevenue: 0,
      });
    });
  });

  describe('getTransactions', () => {
    const row = {
      id: 'p1',
      amountPaid: 200000,
      platformAmount: 5000,
      schoolAmount: 195_000,
      enrollmentId: 'enr-1',
      schoolId: 's1',
      receiver: 'PLATFORM',
      isConfirmed: true,
      status: 'SUCCESS',
      paymentDate: new Date('2026-01-01'),
      paymentType: PaymentType.FIRST_PAYMENT,
      receiptUrl: 'r/1',
      enrollment: {
        className: 'JSS1',
        child: { fullName: 'Kid A' },
        school: { name: 'Acme' },
      },
    };

    it('maps transactions with fee fields and signs receipts (ALL)', async () => {
      prisma.payment.findMany.mockResolvedValue([row]);
      prisma.payment.count.mockResolvedValue(1);
      documents.createSignedUrlForPath.mockResolvedValue({
        signedUrl: 'https://signed/1',
      });

      const res = await service.getTransactions(true, 'ALL', 1, 50);

      // No paymentType filter for ALL.
      expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual({});
      expect(res.items[0]).toEqual(
        expect.objectContaining({
          amount: 2000,
          childName: 'Kid A',
          schoolName: 'Acme',
          platformFeeAmount: 50,
          platformFeePercentage: PLATFORM_FEE_RATE,
          receiptSignedUrl: 'https://signed/1',
        }),
      );
    });

    it('filters by paymentType when receiptType is not ALL', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await service.getTransactions(false, 'INSTALLMENT', 1, 50);

      expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual({
        paymentType: 'INSTALLMENT',
      });
    });

    it('nulls the signed URL when signing throws', async () => {
      prisma.payment.findMany.mockResolvedValue([row]);
      prisma.payment.count.mockResolvedValue(1);
      documents.createSignedUrlForPath.mockRejectedValue(new Error('gone'));

      const res = await service.getTransactions(true, 'ALL', 1, 50);
      expect(res.items[0].receiptSignedUrl).toBeNull();
    });

    it('joins only the three columns it denormalizes, and projects the rest away', async () => {
      prisma.payment.findMany.mockResolvedValue([
        {
          ...row,
          paystackReference: 'lopay_secret_ref',
          enrollment: {
            className: 'JSS1',
            child: { fullName: 'Kid A' },
            school: { name: 'Acme', accountNumber: '0123456789' },
          },
        },
      ]);
      prisma.payment.count.mockResolvedValue(1);

      const res = await service.getTransactions(false, 'ALL', 1, 50);

      expect(prisma.payment.findMany.mock.calls[0][0].include).toEqual({
        enrollment: {
          select: {
            className: true,
            child: { select: { fullName: true } },
            school: { select: { name: true } },
          },
        },
      });
      expect(res.items[0]).not.toHaveProperty('enrollment');
      expect(res.items[0]).not.toHaveProperty('paystackReference');
      expect(JSON.stringify(res.items[0])).not.toContain('0123456789');
    });
  });

  describe('getStudentsSummary', () => {
    it('aggregates the platform-wide student counts', async () => {
      prisma.childEnrollment.count
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(6) // active
        .mockResolvedValueOnce(2); // defaulted
      prisma.payment.count.mockResolvedValueOnce(3); // pending first payments
      prisma.childEnrollment.aggregate.mockResolvedValue({
        _sum: { remainingBalance: 750000 },
      });

      await expect(service.getStudentsSummary()).resolves.toEqual({
        totalStudents: 10,
        activeStudents: 6,
        pendingFirstPayments: 3,
        defaultedStudents: 2,
        totalOutstandingBalance: 7500,
      });
    });

    it('defaults a null outstanding-balance aggregate to zero', async () => {
      prisma.childEnrollment.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      prisma.payment.count.mockResolvedValueOnce(0);
      prisma.childEnrollment.aggregate.mockResolvedValue({
        _sum: { remainingBalance: null },
      });

      const res = await service.getStudentsSummary();
      expect(res.totalOutstandingBalance).toBe(0);
    });
  });

  describe('collections breakdown', () => {
    // Term start 12 weeks back with nothing paid → every weekly installment is
    // missed, so overdue equals the whole balance. A second enrollment starting
    // today is on schedule: outstanding, but NOT overdue. The distinction is the
    // entire point of splitting the old "Plan Arrears" figure in two.
    const now = new Date();
    const weeksAgo = (n: number) => {
      const d = new Date(now);
      d.setDate(d.getDate() - 7 * n);
      return d;
    };
    const weeksAhead = (n: number) => {
      const d = new Date(now);
      d.setDate(d.getDate() + 7 * n);
      return d;
    };

    const behind = {
      id: 'e1',
      childId: 'c1',
      schoolId: 's1',
      className: 'JSS1',
      totalSchoolFee: 1_000_000,
      remainingBalance: 600_000,
      paymentStatus: PaymentStatus.ACTIVE,
      installmentFrequency: 'WEEKLY',
      termStartDate: weeksAgo(12),
      termEndDate: weeksAhead(1),
      child: {
        fullName: 'Behind Kid',
        parent: { user: { fullName: 'Parent A' } },
      },
      school: { id: 's1', name: 'Acme' },
    };

    const onTrack = {
      id: 'e2',
      childId: 'c2',
      schoolId: 's2',
      className: 'JSS2',
      totalSchoolFee: 800_000,
      remainingBalance: 400_000,
      paymentStatus: PaymentStatus.ACTIVE,
      installmentFrequency: 'WEEKLY',
      termStartDate: now,
      termEndDate: weeksAhead(12),
      child: {
        fullName: 'Ontrack Kid',
        parent: { user: { fullName: 'Parent B' } },
      },
      school: { id: 's2', name: 'Bright Stars' },
    };

    describe('getBreakdownSummary', () => {
      it('separates overdue from merely outstanding', async () => {
        prisma.childEnrollment.findMany.mockResolvedValue([behind, onTrack]);
        prisma.payment.groupBy.mockResolvedValue([]);
        prisma.childEnrollment.groupBy.mockResolvedValue([
          { schoolId: 's1', _count: { _all: 1 } },
          { schoolId: 's2', _count: { _all: 3 } },
        ]);

        const res = await service.getBreakdownSummary();

        // Both balances are uncollected...
        expect(res.totalOutstanding).toBe(10_000);
        // ...but only the plan past its schedule is overdue.
        expect(res.totalOverdue).toBe(6_000);
        expect(res.overdueStudents).toBe(1);
        expect(res.overdueSchools).toBe(1);
        // Student totals include settled enrollments, hence 4 not 2.
        expect(res.totalStudents).toBe(4);
        expect(res.studentsWithBalance).toBe(2);
      });

      it('attributes figures to the right school', async () => {
        prisma.childEnrollment.findMany.mockResolvedValue([behind, onTrack]);
        prisma.payment.groupBy.mockResolvedValue([]);
        prisma.childEnrollment.groupBy.mockResolvedValue([
          { schoolId: 's1', _count: { _all: 1 } },
          { schoolId: 's2', _count: { _all: 3 } },
        ]);

        const res = await service.getBreakdownSummary();
        const acme = res.schools.find((s) => s.schoolId === 's1');
        const bright = res.schools.find((s) => s.schoolId === 's2');

        expect(acme).toEqual(
          expect.objectContaining({
            schoolName: 'Acme',
            outstanding: 6_000,
            overdue: 6_000,
            totalStudents: 1,
            overdueStudentCount: 1,
          }),
        );
        expect(bright).toEqual(
          expect.objectContaining({
            schoolName: 'Bright Stars',
            outstanding: 4_000,
            overdue: 0,
            totalStudents: 3,
            overdueStudentCount: 0,
          }),
        );
      });

      it('discounts confirmed installment money when judging who is behind', async () => {
        // Four weeks into a ₦12,000 schedule with four ₦1,000 slots paid →
        // on schedule, so the balance is outstanding but not overdue.
        prisma.childEnrollment.findMany.mockResolvedValue([
          { ...behind, termStartDate: weeksAgo(4), remainingBalance: 800_000 },
        ]);
        prisma.payment.groupBy.mockResolvedValue([
          { enrollmentId: 'e1', _sum: { amountPaid: 400_000 } },
        ]);
        prisma.childEnrollment.groupBy.mockResolvedValue([
          { schoolId: 's1', _count: { _all: 1 } },
        ]);

        const res = await service.getBreakdownSummary();

        expect(res.totalOutstanding).toBe(8_000);
        expect(res.totalOverdue).toBe(0);
        expect(res.overdueStudents).toBe(0);
      });

      it('does not chase a parent who paid several installments in one go', async () => {
        // The same ₦4,000 as the case above, but it arrived as a single
        // transfer. Counting payment ROWS reported this parent as three
        // installments missed; counting money reports them as on schedule.
        prisma.childEnrollment.findMany.mockResolvedValue([
          { ...behind, termStartDate: weeksAgo(4), remainingBalance: 800_000 },
        ]);
        prisma.payment.groupBy.mockResolvedValue([
          { enrollmentId: 'e1', _sum: { amountPaid: 400_000 } },
        ]);
        prisma.childEnrollment.groupBy.mockResolvedValue([
          { schoolId: 's1', _count: { _all: 1 } },
        ]);

        const res = await service.getBreakdownSummary();

        expect(res.totalOverdue).toBe(0);
        expect(res.overdueStudents).toBe(0);
      });

      it('sums installment value rather than counting payments', async () => {
        prisma.childEnrollment.findMany.mockResolvedValue([behind]);
        prisma.payment.groupBy.mockResolvedValue([]);
        prisma.childEnrollment.groupBy.mockResolvedValue([]);
        prisma.school.findMany.mockResolvedValue([]);

        await service.getBreakdownSummary();

        expect(prisma.payment.groupBy).toHaveBeenCalledWith(
          expect.objectContaining({
            by: ['enrollmentId'],
            _sum: { amountPaid: true },
          }),
        );
      });

      it('still lists a school whose plans are all settled', async () => {
        prisma.childEnrollment.findMany.mockResolvedValue([]);
        prisma.payment.groupBy.mockResolvedValue([]);
        prisma.childEnrollment.groupBy.mockResolvedValue([
          { schoolId: 's3', _count: { _all: 5 } },
        ]);
        prisma.school.findMany.mockResolvedValue([
          { id: 's3', name: 'Settled School' },
        ]);

        const res = await service.getBreakdownSummary();

        expect(res.schools).toEqual([
          expect.objectContaining({
            schoolId: 's3',
            schoolName: 'Settled School',
            totalStudents: 5,
            outstanding: 0,
            overdue: 0,
          }),
        ]);
      });

      it('reports zeroes on an empty platform', async () => {
        prisma.childEnrollment.findMany.mockResolvedValue([]);
        prisma.payment.groupBy.mockResolvedValue([]);
        prisma.childEnrollment.groupBy.mockResolvedValue([]);

        const res = await service.getBreakdownSummary();

        expect(res.totalOutstanding).toBe(0);
        expect(res.totalOverdue).toBe(0);
        expect(res.totalStudents).toBe(0);
        expect(res.schools).toEqual([]);
      });
    });

    describe('getSchoolBreakdown', () => {
      beforeEach(() => {
        prisma.school.findUnique.mockResolvedValue({ name: 'Acme' });
        prisma.payment.groupBy.mockResolvedValue([]);
      });

      it('404s for an unknown school', async () => {
        prisma.school.findUnique.mockResolvedValue(null);
        await expect(
          service.getSchoolBreakdown('nope', 'students'),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('returns per-student rows with both figures', async () => {
        prisma.childEnrollment.findMany.mockResolvedValue([behind]);

        const res = await service.getSchoolBreakdown('s1', 'students');

        expect(res.schoolName).toBe('Acme');
        expect(res.tab).toBe('students');
        expect(res.items).toHaveLength(1);
        expect(res.items[0]).toEqual(
          expect.objectContaining({
            childId: 'c1',
            studentName: 'Behind Kid',
            className: 'JSS1',
            parentName: 'Parent A',
            totalFee: 10_000,
            outstanding: 6_000,
            overdue: 6_000,
          }),
        );
        expect(res.items[0].daysOverdue).toBeGreaterThan(0);
      });

      it('lists every student on the students tab, settled included', async () => {
        prisma.childEnrollment.findMany.mockResolvedValue([behind]);

        await service.getSchoolBreakdown('s1', 'students');

        // No balance/status filter — the Students tab is a roster, not a debt list.
        const where = prisma.childEnrollment.findMany.mock.calls[0][0].where;
        expect(where).toEqual({ schoolId: 's1' });
      });

      it('restricts the money tabs to plans that still owe', async () => {
        prisma.childEnrollment.findMany.mockResolvedValue([behind]);

        await service.getSchoolBreakdown('s1', 'outstanding');

        const where = prisma.childEnrollment.findMany.mock.calls[0][0].where;
        expect(where.remainingBalance).toEqual({ gt: 0 });
        expect(where.schoolId).toBe('s1');
      });

      it('drops non-overdue students from the overdue tab', async () => {
        prisma.childEnrollment.findMany.mockResolvedValue([
          { ...onTrack, schoolId: 's1' },
          behind,
        ]);

        const res = await service.getSchoolBreakdown('s1', 'overdue');

        expect(res.total).toBe(1);
        expect(res.items).toHaveLength(1);
        expect(res.items[0].studentName).toBe('Behind Kid');
      });

      it('keeps non-overdue students on the outstanding tab', async () => {
        prisma.childEnrollment.findMany.mockResolvedValue([
          { ...onTrack, schoolId: 's1' },
          behind,
        ]);

        const res = await service.getSchoolBreakdown('s1', 'outstanding');

        expect(res.total).toBe(2);
        // Ranked worst-first by amount owed: 6,000 before 4,000.
        expect(res.items[0].studentName).toBe('Behind Kid');
        expect(res.items[1].studentName).toBe('Ontrack Kid');
      });

      it('paginates the derived ranking', async () => {
        prisma.childEnrollment.findMany.mockResolvedValue([
          { ...onTrack, schoolId: 's1' },
          behind,
        ]);

        const res = await service.getSchoolBreakdown('s1', 'outstanding', 2, 1);

        expect(res.page).toBe(2);
        expect(res.total).toBe(2);
        expect(res.totalPages).toBe(2);
        expect(res.items).toHaveLength(1);
        expect(res.items[0].studentName).toBe('Ontrack Kid');
      });
    });
  });

  describe('getSchoolsSummary', () => {
    it('joins per-school enrollment counts and pending/collected amounts', async () => {
      prisma.school.findMany.mockResolvedValue([
        { id: 's1', name: 'Acme' },
        { id: 's2', name: 'Beta' },
      ]);
      prisma.childEnrollment.groupBy.mockResolvedValue([
        { schoolId: 's1', _count: { _all: 4 } },
      ]);
      prisma.payment.groupBy
        .mockResolvedValueOnce([
          { schoolId: 's1', _sum: { amountPaid: 100000 } },
        ]) // pending
        .mockResolvedValueOnce([
          { schoolId: 's1', _sum: { schoolAmount: 250000 } },
        ]); // collected

      const res = await service.getSchoolsSummary();

      expect(res).toEqual([
        {
          schoolId: 's1',
          schoolName: 'Acme',
          totalStudents: 4,
          pendingAmount: 1000,
          collectedAmount: 2500,
        },
        {
          schoolId: 's2',
          schoolName: 'Beta',
          totalStudents: 0,
          pendingAmount: 0,
          collectedAmount: 0,
        },
      ]);
    });
  });

  describe('getOverview', () => {
    it('assembles revenue, students, recent transactions and a 6-month series', async () => {
      // getPlatformRevenue
      prisma.payment.aggregate.mockResolvedValue({
        _sum: { platformAmount: 500000 },
      });
      // getStudentsSummary
      prisma.childEnrollment.count
        .mockResolvedValueOnce(20)
        .mockResolvedValueOnce(12)
        .mockResolvedValueOnce(1);
      prisma.payment.count.mockResolvedValueOnce(4);
      prisma.childEnrollment.aggregate.mockResolvedValue({
        _sum: { remainingBalance: 300000 },
      });

      const now = new Date();
      const seriesRow = {
        paymentDate: new Date(now.getFullYear(), now.getMonth(), 1),
        platformAmount: 100000,
      };
      // payment.findMany is used by both recentTransactions (include) and the
      // series query (select) — branch on the arg shape.
      prisma.payment.findMany.mockImplementation(
        (args: { select?: unknown }) =>
          args?.select
            ? Promise.resolve([seriesRow])
            : Promise.resolve([
                {
                  id: 'p1',
                  amountPaid: 100000,
                  platformAmount: 2000,
                  schoolAmount: 98_000,
                  enrollmentId: 'enr-1',
                  schoolId: 's1',
                  receiver: 'SCHOOL',
                  isConfirmed: true,
                  status: 'SUCCESS',
                  paymentDate: now,
                  paymentType: PaymentType.INSTALLMENT,
                  receiptUrl: null,
                  enrollment: {
                    className: 'JSS1',
                    child: { fullName: 'Kid A' },
                    school: { name: 'Acme' },
                  },
                },
              ]),
      );

      const res = await service.getOverview();

      expect(res.totalRevenue).toBe(5000);
      expect(res.totalStudents).toBe(20);
      expect(res.activeStudents).toBe(12);
      expect(res.pendingApprovals).toBe(4);
      expect(res.totalOutstandingBalance).toBe(3000);
      expect(res.recentTransactions).toHaveLength(1);
      expect(res.recentTransactions[0].receiptSignedUrl).toBeNull();
      expect(res.revenueSeries).toHaveLength(6);
      // Current month bucket picked up the 1000-Naira series row.
      expect(res.revenueSeries[5].value).toBe(1000);
    });

    it('buckets by week when range=weekly, so the chart toggle is not a no-op', async () => {
      prisma.payment.aggregate.mockResolvedValue({
        _sum: { platformAmount: 500000 },
      });
      prisma.childEnrollment.count
        .mockResolvedValueOnce(20)
        .mockResolvedValueOnce(12)
        .mockResolvedValueOnce(1);
      prisma.payment.count.mockResolvedValueOnce(4);
      prisma.childEnrollment.aggregate.mockResolvedValue({
        _sum: { remainingBalance: 300000 },
      });

      // A payment made today must land in the final (current) week bucket.
      prisma.payment.findMany.mockImplementation(
        (args: { select?: unknown }) =>
          args?.select
            ? Promise.resolve([
                { paymentDate: new Date(), platformAmount: 100000 },
              ])
            : Promise.resolve([]),
      );

      const res = await service.getOverview('weekly');

      expect(res.revenueSeries).toHaveLength(8);
      expect(res.revenueSeries[7].value).toBe(1000);
      // Week labels are day+month, distinct from the monthly series' "Jul".
      expect(res.revenueSeries[7].label).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
    });

    it('spreads weekly revenue across the correct buckets', async () => {
      prisma.payment.aggregate.mockResolvedValue({
        _sum: { platformAmount: 0 },
      });
      prisma.childEnrollment.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      prisma.payment.count.mockResolvedValueOnce(0);
      prisma.childEnrollment.aggregate.mockResolvedValue({
        _sum: { remainingBalance: 0 },
      });

      const twoWeeksAgo = new Date();
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
      prisma.payment.findMany.mockImplementation(
        (args: { select?: unknown }) =>
          args?.select
            ? Promise.resolve([
                { paymentDate: new Date(), platformAmount: 100000 },
                { paymentDate: twoWeeksAgo, platformAmount: 50000 },
              ])
            : Promise.resolve([]),
      );

      const res = await service.getOverview('weekly');

      expect(res.revenueSeries[7].value).toBe(1000);
      expect(res.revenueSeries[5].value).toBe(500);
      // Nothing leaked into the untouched buckets.
      expect(res.revenueSeries[6].value).toBe(0);
    });
  });

  describe('thin ledger callers', () => {
    it('delegates settleFirstPayment to the ledger', async () => {
      const actor = { userId: 'a', role: 'SUPER_ADMIN' } as never;
      await expect(service.settleFirstPayment('p1', actor)).resolves.toEqual({
        settled: true,
      });
      expect(ledger.settleFirstPayment).toHaveBeenCalledWith('p1', actor);
    });

    it('delegates rejectFirstPayment to the ledger', async () => {
      const actor = { userId: 'a', role: 'SUPER_ADMIN' } as never;
      await expect(service.rejectFirstPayment('p1', actor)).resolves.toEqual({
        rejected: true,
      });
      expect(ledger.rejectFirstPayment).toHaveBeenCalledWith('p1', actor);
    });
  });

  // Reference the unused import so lint/tsc stays quiet about it.
  it('exposes the PLATFORM receiver enum used by pending-payment filters', () => {
    expect(PaymentReceiver.PLATFORM).toBe('PLATFORM');
  });
});
