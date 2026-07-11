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
  let paystack: { createSubaccount: jest.Mock };
  let ledger: {
    settleFirstPayment: jest.Mock;
    rejectFirstPayment: jest.Mock;
  };
  let onboarding: { provisionSchoolAndOwner: jest.Mock };

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
    paystack = { createSubaccount: jest.fn() };
    ledger = {
      settleFirstPayment: jest.fn().mockResolvedValue({ settled: true }),
      rejectFirstPayment: jest.fn().mockResolvedValue({ rejected: true }),
    };
    onboarding = { provisionSchoolAndOwner: jest.fn() };

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
        {
          provide: CacheService,
          useValue: {
            getOrSet: (_k: string, _ttl: number, loader: () => unknown) =>
              loader(),
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
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
  });

  describe('getPendingFirstPayments', () => {
    it('maps rows into the pending-first-payment envelope (no signed URLs)', async () => {
      prisma.payment.findMany.mockResolvedValue([
        {
          id: 'p1',
          amountPaid: 250000,
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
          receiptSignedUrl: null,
        }),
      );
      // Signing skipped when not requested.
      expect(documents.createSignedUrlForPath).not.toHaveBeenCalled();
    });

    it('signs receipt URLs when asked and tolerates a signing failure', async () => {
      prisma.payment.findMany.mockResolvedValue([
        {
          id: 'p1',
          amountPaid: 100,
          paymentDate: new Date(),
          paymentType: PaymentType.FIRST_PAYMENT,
          receiptUrl: 'r/ok',
          enrollment: { child: {}, school: {} },
        },
        {
          id: 'p2',
          amountPaid: 100,
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
