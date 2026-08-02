import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SchoolPaymentsService } from './schools.service';
import {
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  UserRole,
} from '../generated/prisma/client';

/**
 * Coverage-oriented units for the school-owner surface of SchoolPaymentsService
 * (the methods the original schools.service.spec.ts does not touch). The
 * tenant-scoped client returned by `prisma.withTenant` is mocked as `db`.
 */
describe('SchoolPaymentsService (coverage)', () => {
  let db: {
    payment: { findMany: jest.Mock };
    childEnrollment: { count: jest.Mock; findMany: jest.Mock };
    classFee: { findFirst: jest.Mock; findMany: jest.Mock };
  };
  let prisma: {
    school: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
    };
    childEnrollment: { findFirst: jest.Mock };
    payment: { aggregate: jest.Mock };
    classFee: { update: jest.Mock; create: jest.Mock };
    withTenant: jest.Mock;
  };
  let documents: { createSignedUrlForPath: jest.Mock };
  let ledger: {
    confirmPayment: jest.Mock;
    rejectPayment: jest.Mock;
    markEnrollmentAsDefaulted: jest.Mock;
    reversePayment: jest.Mock;
  };
  let onboarding: { provisionSchoolAndOwner: jest.Mock };
  let cache: { getOrSet: jest.Mock; del: jest.Mock };
  let service: SchoolPaymentsService;

  beforeEach(() => {
    jest.clearAllMocks();

    db = {
      payment: { findMany: jest.fn() },
      childEnrollment: { count: jest.fn(), findMany: jest.fn() },
      classFee: { findFirst: jest.fn(), findMany: jest.fn() },
    };
    prisma = {
      school: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({ ok: true }),
        findMany: jest.fn(),
      },
      childEnrollment: { findFirst: jest.fn() },
      payment: { aggregate: jest.fn() },
      classFee: {
        update: jest.fn().mockResolvedValue({ op: 'update' }),
        create: jest.fn().mockResolvedValue({ op: 'create' }),
      },
      withTenant: jest.fn(() => db),
    };
    documents = { createSignedUrlForPath: jest.fn() };
    ledger = {
      confirmPayment: jest.fn().mockResolvedValue({ confirmed: true }),
      rejectPayment: jest.fn().mockResolvedValue({ rejected: true }),
      markEnrollmentAsDefaulted: jest
        .fn()
        .mockResolvedValue({ defaulted: true }),
      reversePayment: jest.fn().mockResolvedValue({ reversed: true }),
    };
    onboarding = { provisionSchoolAndOwner: jest.fn() };
    cache = {
      // Passthrough: always run the loader (no caching in unit tests).
      getOrSet: jest.fn((_k: string, _ttl: number, loader: () => unknown) =>
        loader(),
      ),
      del: jest.fn().mockResolvedValue(undefined),
    };

    service = new SchoolPaymentsService(
      prisma as never,
      {} as never, // notifications
      documents as never,
      {} as never, // events
      {} as never, // audit
      ledger as never,
      onboarding as never,
      cache as never,
    );
  });

  describe('createSchool', () => {
    it('delegates to the onboarding saga and trims the owner payload', async () => {
      onboarding.provisionSchoolAndOwner.mockResolvedValue({
        school: { id: 's1', name: 'Acme' },
        user: {
          id: 'u1',
          email: 'o@x.com',
          role: UserRole.SCHOOL_OWNER,
          fullName: 'Owner',
          password: 'secret',
        },
      });

      const res = await service.createSchool({} as never);

      expect(res.school).toEqual({ id: 's1', name: 'Acme' });
      expect(res.user).toEqual({
        id: 'u1',
        email: 'o@x.com',
        role: UserRole.SCHOOL_OWNER,
        fullName: 'Owner',
      });
      expect(res.message).toBe('School and School Owner created successfully');
    });
  });

  describe('updateSchool', () => {
    it('404s when the school is missing (or soft-deleted)', async () => {
      prisma.school.findFirst.mockResolvedValue(null);
      await expect(
        service.updateSchool('missing', {} as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.school.update).not.toHaveBeenCalled();
    });

    it('maps the DTO fields onto the update payload', async () => {
      prisma.school.findFirst.mockResolvedValue({ id: 's1', deletedAt: null });
      await service.updateSchool('s1', {
        schoolName: 'New Name',
        address: 'Addr',
        phone: '080',
        bankName: 'GTB',
        accountName: 'Acme',
        accountNumber: '0001',
      } as never);

      expect(prisma.school.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: {
          name: 'New Name',
          address: 'Addr',
          phone: '080',
          bankName: 'GTB',
          accountName: 'Acme',
          accountNumber: '0001',
        },
      });
    });
  });

  describe('getSchoolBankDetails', () => {
    const details = {
      bankName: 'GTB',
      accountName: 'Acme',
      accountNumber: '0001',
    };

    it('lets a SUPER_ADMIN read any school', async () => {
      prisma.school.findFirst.mockResolvedValue(details);
      await expect(
        service.getSchoolBankDetails('s1', {
          userId: 'a',
          role: UserRole.SUPER_ADMIN,
        }),
      ).resolves.toEqual(details);
    });

    it('lets a SCHOOL_OWNER read their own school', async () => {
      prisma.school.findFirst.mockResolvedValue(details);
      await expect(
        service.getSchoolBankDetails('s1', {
          userId: 'o',
          role: UserRole.SCHOOL_OWNER,
          schoolId: 's1',
        }),
      ).resolves.toEqual(details);
    });

    it('forbids a SCHOOL_OWNER from reading another school', async () => {
      await expect(
        service.getSchoolBankDetails('s1', {
          userId: 'o',
          role: UserRole.SCHOOL_OWNER,
          schoolId: 's2',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.school.findFirst).not.toHaveBeenCalled();
    });

    it('lets a PARENT with an enrollment read the school', async () => {
      prisma.childEnrollment.findFirst.mockResolvedValue({ id: 'e1' });
      prisma.school.findFirst.mockResolvedValue(details);
      await expect(
        service.getSchoolBankDetails('s1', {
          userId: 'p',
          role: UserRole.PARENT,
        }),
      ).resolves.toEqual(details);
    });

    it('forbids a PARENT with no enrollment at the school', async () => {
      prisma.childEnrollment.findFirst.mockResolvedValue(null);
      await expect(
        service.getSchoolBankDetails('s1', {
          userId: 'p',
          role: UserRole.PARENT,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when the (authorized) school lookup finds nothing', async () => {
      prisma.school.findFirst.mockResolvedValue(null);
      await expect(
        service.getSchoolBankDetails('s1', {
          userId: 'a',
          role: UserRole.SUPER_ADMIN,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateSchoolBankDetails', () => {
    it('404s when the school does not exist', async () => {
      prisma.school.findUnique.mockResolvedValue(null);
      await expect(
        service.updateSchoolBankDetails('missing', {} as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updates only the bank fields', async () => {
      prisma.school.findUnique.mockResolvedValue({ id: 's1' });
      await service.updateSchoolBankDetails('s1', {
        bankName: 'UBA',
        accountName: 'Acme',
        accountNumber: '0002',
      } as never);

      expect(prisma.school.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { bankName: 'UBA', accountName: 'Acme', accountNumber: '0002' },
      });
    });
  });

  describe('getAllSchools', () => {
    it('returns the non-deleted directory without a search term', async () => {
      prisma.school.findMany.mockResolvedValue([{ id: 's1', name: 'Acme' }]);
      const res = await service.getAllSchools();
      expect(res).toHaveLength(1);
      expect(prisma.school.findMany.mock.calls[0][0].where).toEqual({
        deletedAt: null,
      });
    });

    it('builds a name/email OR filter when searching', async () => {
      prisma.school.findMany.mockResolvedValue([]);
      await service.getAllSchools('aca');
      const where = prisma.school.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { name: { contains: 'aca', mode: 'insensitive' } },
        { email: { contains: 'aca', mode: 'insensitive' } },
      ]);
    });
  });

  describe('createClassFee', () => {
    it('updates the existing active fee and invalidates the cache', async () => {
      db.classFee.findFirst.mockResolvedValue({ id: 'fee-1' });

      await service.createClassFee('s1', 'JSS1', 100);

      expect(cache.del).toHaveBeenCalledWith('cache:classfees:s1');
      expect(prisma.classFee.update).toHaveBeenCalledWith({
        where: { id: 'fee-1' },
        data: { feeAmount: 10000, isActive: true },
      });
      expect(prisma.classFee.create).not.toHaveBeenCalled();
    });

    it('creates a new fee (in kobo) when none exists', async () => {
      db.classFee.findFirst.mockResolvedValue(null);

      await service.createClassFee('s1', 'JSS2', 250);

      expect(prisma.classFee.create).toHaveBeenCalledWith({
        data: { schoolId: 's1', className: 'JSS2', feeAmount: 25000 },
      });
    });
  });

  describe('getClassFees', () => {
    it('reads tenant-scoped active fees and converts kobo→naira', async () => {
      db.classFee.findMany.mockResolvedValue([
        { id: 'f1', className: 'JSS1', feeAmount: 50000, isActive: true },
      ]);

      const res = await service.getClassFees('s1');

      expect(prisma.withTenant).toHaveBeenCalledWith('s1');
      expect(res).toEqual([
        expect.objectContaining({ className: 'JSS1', feeAmount: 500 }),
      ]);
    });
  });

  describe('getDashboardStats', () => {
    it('sums revenue/pending/awaiting/defaulted and returns Naira', async () => {
      db.childEnrollment.count
        .mockResolvedValueOnce(7) // totalStudents
        .mockResolvedValueOnce(5); // activeStudents
      prisma.payment.aggregate
        .mockResolvedValueOnce({ _sum: { schoolAmount: 300000 } }) // confirmed
        .mockResolvedValueOnce({ _sum: { schoolAmount: 120000 } }) // pending installments
        .mockResolvedValueOnce({ _sum: { schoolAmount: 60000 } }); // pending first payments
      db.childEnrollment.findMany.mockResolvedValue([
        { remainingBalance: 40000 },
        { remainingBalance: 10000 },
      ]);

      const res = await service.getDashboardStats('s1');

      expect(res).toEqual({
        totalStudents: 7,
        activeStudents: 5,
        totalRevenue: 3000,
        pendingRevenue: 1200,
        awaitingActivation: 600,
        defaultedAmount: 500,
      });
    });

    it('treats null aggregate sums as zero', async () => {
      db.childEnrollment.count.mockResolvedValue(0);
      prisma.payment.aggregate
        .mockResolvedValueOnce({ _sum: { schoolAmount: null } })
        .mockResolvedValueOnce({ _sum: { schoolAmount: null } })
        .mockResolvedValueOnce({ _sum: { schoolAmount: null } });
      db.childEnrollment.findMany.mockResolvedValue([]);

      const res = await service.getDashboardStats('s1');
      expect(res).toEqual({
        totalStudents: 0,
        activeStudents: 0,
        totalRevenue: 0,
        pendingRevenue: 0,
        awaitingActivation: 0,
        defaultedAmount: 0,
      });
    });

    /*
     * Rejection sets FAILED and reversal sets REVERSED — both leave
     * `isConfirmed: false`. Filtering on that flag alone counted declined and
     * clawed-back money as still awaiting the school, with nothing in the
     * approval queue that could ever clear it.
     */
    it('counts only PENDING rows as pending — never FAILED or REVERSED', async () => {
      db.childEnrollment.count.mockResolvedValue(0);
      prisma.payment.aggregate.mockResolvedValue({
        _sum: { schoolAmount: 0 },
      });
      db.childEnrollment.findMany.mockResolvedValue([]);

      await service.getDashboardStats('s1');

      const [, pendingInstallmentCall, pendingFirstCall] =
        prisma.payment.aggregate.mock.calls;
      expect(pendingInstallmentCall[0].where).toEqual({
        schoolId: 's1',
        isConfirmed: false,
        status: PaymentTransactionStatus.PENDING,
        paymentType: PaymentType.INSTALLMENT,
      });
      expect(pendingFirstCall[0].where).toEqual({
        schoolId: 's1',
        isConfirmed: false,
        status: PaymentTransactionStatus.PENDING,
        paymentType: PaymentType.FIRST_PAYMENT,
      });
    });

    it('counts revenue only from confirmed SUCCESS rows', async () => {
      db.childEnrollment.count.mockResolvedValue(0);
      prisma.payment.aggregate.mockResolvedValue({
        _sum: { schoolAmount: 0 },
      });
      db.childEnrollment.findMany.mockResolvedValue([]);

      await service.getDashboardStats('s1');

      expect(prisma.payment.aggregate.mock.calls[0][0].where).toEqual({
        schoolId: 's1',
        isConfirmed: true,
        status: PaymentTransactionStatus.SUCCESS,
      });
    });

    it('keeps first payments out of the owner-actionable pending figure', async () => {
      db.childEnrollment.count.mockResolvedValue(0);
      prisma.payment.aggregate
        .mockResolvedValueOnce({ _sum: { schoolAmount: 0 } })
        .mockResolvedValueOnce({ _sum: { schoolAmount: 0 } }) // no installments
        .mockResolvedValueOnce({ _sum: { schoolAmount: 5_000_000 } });
      db.childEnrollment.findMany.mockResolvedValue([]);

      const res = await service.getDashboardStats('s1');

      expect(res.pendingRevenue).toBe(0);
      expect(res.awaitingActivation).toBe(50000);
    });

    it('scopes the active-plan count to ACTIVE enrollments', async () => {
      db.childEnrollment.count.mockResolvedValue(0);
      prisma.payment.aggregate.mockResolvedValue({
        _sum: { schoolAmount: 0 },
      });
      db.childEnrollment.findMany.mockResolvedValue([]);

      await service.getDashboardStats('s1');

      expect(db.childEnrollment.count.mock.calls[1][0]).toEqual({
        where: { paymentStatus: PaymentStatus.ACTIVE },
      });
    });
  });

  describe('getStudents', () => {
    const baseEnrollment = {
      id: 'e1',
      childId: 'c1',
      schoolId: 's1',
      className: 'JSS1',
      totalSchoolFee: 1000000,
      paymentStatus: PaymentStatus.ACTIVE,
      installmentFrequency: 'WEEKLY',
      remainingBalance: 500000,
      termStartDate: new Date('2026-03-01'),
      child: { fullName: 'Kid A', parent: { user: { fullName: 'Parent A' } } },
      payments: [
        {
          isConfirmed: true,
          amountPaid: 500000,
          paymentDate: new Date('2026-01-01'),
          paymentType: PaymentType.INSTALLMENT,
          status: PaymentTransactionStatus.SUCCESS,
        },
      ],
    };

    it('paginates, filters and computes a WEEKLY next-due date', async () => {
      db.childEnrollment.findMany.mockResolvedValue([baseEnrollment]);
      db.childEnrollment.count.mockResolvedValue(1);

      const res = await service.getStudents('s1', 'JSS1', 'kid', 1, 50);

      expect(prisma.withTenant).toHaveBeenCalledWith('s1');
      const where = db.childEnrollment.findMany.mock.calls[0][0].where;
      expect(where.className).toBe('JSS1');
      expect(where.OR).toBeDefined();
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
          id: 'e1',
          enrollmentId: 'e1',
          childId: 'c1',
          studentName: 'Kid A',
          parentName: 'Parent A',
          totalFee: 10000,
          paidAmount: 5000,
          nextDueDate: '2026-01-08',
        }),
      );
    });

    /*
     * The roster row is the only thing the school dashboard has to show a
     * balance from. Deriving `totalFee - paidAmount` on the client came out
     * short by the platform fee inside the first payment, so the enrollment's
     * own balance has to travel with the row.
     */
    it('returns the enrollment balance rather than leaving it to be derived', async () => {
      db.childEnrollment.findMany.mockResolvedValue([
        {
          ...baseEnrollment,
          totalSchoolFee: 10_000_000, // ₦100,000
          remainingBalance: 5_000_000, // ₦50,000
          payments: [
            {
              // gross first payment: ₦27,500 deposit incl. ₦2,500 platform fee
              isConfirmed: true,
              amountPaid: 2_750_000,
              paymentDate: new Date('2026-01-01'),
              paymentType: PaymentType.FIRST_PAYMENT,
              status: PaymentTransactionStatus.SUCCESS,
            },
            {
              isConfirmed: true,
              amountPaid: 2_500_000,
              paymentDate: new Date('2026-02-01'),
              paymentType: PaymentType.INSTALLMENT,
              status: PaymentTransactionStatus.SUCCESS,
            },
          ],
        },
      ]);
      db.childEnrollment.count.mockResolvedValue(1);

      const row = (await service.getStudents('s1')).items[0];

      expect(row.remainingBalance).toBe(50000);
      // The derivation the client used to do lands ₦2,500 short.
      expect(row.totalFee - row.paidAmount).toBe(47500);
    });

    it('excludes unapproved installments from the available balance', async () => {
      db.childEnrollment.findMany.mockResolvedValue([
        {
          ...baseEnrollment,
          remainingBalance: 5_000_000,
          payments: [
            {
              isConfirmed: false,
              amountPaid: 1_000_000,
              paymentDate: new Date('2026-02-01'),
              paymentType: PaymentType.INSTALLMENT,
              status: PaymentTransactionStatus.PENDING,
            },
          ],
        },
      ]);
      db.childEnrollment.count.mockResolvedValue(1);

      const row = (await service.getStudents('s1')).items[0];

      expect(row.remainingBalance).toBe(50000);
      expect(row.availableBalance).toBe(40000);
    });

    it('never reports a negative available balance', async () => {
      db.childEnrollment.findMany.mockResolvedValue([
        {
          ...baseEnrollment,
          remainingBalance: 100_000,
          payments: [
            {
              isConfirmed: false,
              amountPaid: 900_000,
              paymentDate: new Date('2026-02-01'),
              paymentType: PaymentType.INSTALLMENT,
              status: PaymentTransactionStatus.PENDING,
            },
          ],
        },
      ]);
      db.childEnrollment.count.mockResolvedValue(1);

      expect((await service.getStudents('s1')).items[0].availableBalance).toBe(
        0,
      );
    });

    it('caps the page size at 200 and computes a MONTHLY next-due date', async () => {
      db.childEnrollment.findMany.mockResolvedValue([
        {
          ...baseEnrollment,
          installmentFrequency: 'MONTHLY',
          child: { fullName: 'Kid A', parent: { user: { fullName: '' } } },
        },
      ]);
      db.childEnrollment.count.mockResolvedValue(1);

      const res = await service.getStudents(
        's1',
        undefined,
        undefined,
        1,
        5000,
      );

      expect(res.limit).toBe(200);
      expect(res.items[0].parentName).toBe('Unknown');
      expect(res.items[0].nextDueDate).toBe('2026-02-01');
    });

    it('uses termStartDate with no payments and null once cleared', async () => {
      db.childEnrollment.findMany
        .mockResolvedValueOnce([{ ...baseEnrollment, payments: [] }])
        .mockResolvedValueOnce([{ ...baseEnrollment, remainingBalance: 0 }]);
      db.childEnrollment.count.mockResolvedValue(1);

      const noPayments = await service.getStudents('s1');
      expect(noPayments.items[0].nextDueDate).toBe('2026-03-01');

      const cleared = await service.getStudents('s1');
      expect(cleared.items[0].nextDueDate).toBeNull();
    });
  });

  describe('getHistory', () => {
    const historyRow = {
      id: 'p1',
      schoolId: 's1',
      amountPaid: 200000,
      platformAmount: 5000,
      schoolAmount: 195000,
      paymentDate: new Date('2026-01-01'),
      paymentType: PaymentType.INSTALLMENT,
      status: 'SUCCESS',
      receiptUrl: 'r/1',
      enrollment: {
        className: 'JSS1',
        child: { fullName: 'Kid A' },
        school: { name: 'Acme' },
      },
    };

    it('maps rows without signed URLs by default', async () => {
      db.payment.findMany.mockResolvedValue([historyRow]);

      const res = await service.getHistory('s1');

      expect(res).toHaveLength(1);
      expect(res[0]).toEqual(
        expect.objectContaining({
          id: 'p1',
          childName: 'Kid A',
          amount: 2000,
          type: PaymentType.INSTALLMENT,
          paymentType: PaymentType.INSTALLMENT,
          status: 'SUCCESS',
        }),
      );
      // receiptSignedUrl key omitted when not requested.
      expect('receiptSignedUrl' in res[0]).toBe(false);
      expect(documents.createSignedUrlForPath).not.toHaveBeenCalled();
    });

    it('signs matching receipts and tolerates signing failures', async () => {
      db.payment.findMany.mockResolvedValue([
        historyRow,
        { ...historyRow, id: 'p2', receiptUrl: 'r/2' },
      ]);
      documents.createSignedUrlForPath
        .mockResolvedValueOnce({ signedUrl: 'https://signed/1' })
        .mockRejectedValueOnce(new Error('gone'));

      const res = await service.getHistory('s1', true, 'ALL');

      expect(res[0].receiptSignedUrl).toBe('https://signed/1');
      expect(res[1].receiptSignedUrl).toBeNull();
    });

    it('applies the receiptType filter to the query', async () => {
      db.payment.findMany.mockResolvedValue([]);
      await service.getHistory('s1', false, 'FIRST_PAYMENT');
      expect(db.payment.findMany.mock.calls[0][0].where).toEqual({
        paymentType: 'FIRST_PAYMENT',
      });
    });

    /* The monthly collection ledger export needs a real period window. */
    it('filters by the requested date window', async () => {
      db.payment.findMany.mockResolvedValue([]);
      const from = new Date('2026-02-01T00:00:00.000Z');
      const to = new Date('2026-02-28T23:59:59.999Z');

      await service.getHistory('s1', false, 'ALL', 1000, { from, to });

      expect(db.payment.findMany.mock.calls[0][0].where).toEqual({
        paymentDate: { gte: from, lte: to },
      });
    });

    it('supports an open-ended window', async () => {
      db.payment.findMany.mockResolvedValue([]);
      const from = new Date('2026-02-01T00:00:00.000Z');

      await service.getHistory('s1', false, 'ALL', 100, { from });

      expect(db.payment.findMany.mock.calls[0][0].where).toEqual({
        paymentDate: { gte: from },
      });
    });

    it('combines the date window with the receiptType filter', async () => {
      db.payment.findMany.mockResolvedValue([]);
      const to = new Date('2026-02-28T23:59:59.999Z');

      await service.getHistory('s1', false, 'INSTALLMENT', 100, { to });

      expect(db.payment.findMany.mock.calls[0][0].where).toEqual({
        paymentType: 'INSTALLMENT',
        paymentDate: { lte: to },
      });
    });

    it('leaves the query unfiltered when no window is given', async () => {
      db.payment.findMany.mockResolvedValue([]);
      await service.getHistory('s1');
      expect(db.payment.findMany.mock.calls[0][0].where).toEqual({});
    });

    it('caps take at the export ceiling', async () => {
      db.payment.findMany.mockResolvedValue([]);
      await service.getHistory('s1', false, 'ALL', 99999);
      expect(db.payment.findMany.mock.calls[0][0].take).toBe(
        SchoolPaymentsService.HISTORY_MAX_TAKE,
      );
    });
  });

  describe('getPendingPayments', () => {
    const pendingRow = {
      id: 'p1',
      amountPaid: 100000,
      platformAmount: 2500,
      schoolAmount: 97500,
      paymentDate: new Date('2026-01-01'),
      paymentType: PaymentType.INSTALLMENT,
      receiptUrl: 'r/1',
      enrollment: {
        className: 'JSS1',
        child: { fullName: 'Kid A' },
        school: { name: 'Acme' },
      },
    };

    it('defaults to the installments the owner can approve', async () => {
      db.payment.findMany.mockResolvedValue([]);

      await service.getPendingPayments('s1');

      expect(db.payment.findMany.mock.calls[0][0].where).toEqual({
        isConfirmed: false,
        status: PaymentTransactionStatus.PENDING,
        paymentType: PaymentType.INSTALLMENT,
      });
    });

    it('can widen to first payments awaiting platform settlement', async () => {
      db.payment.findMany.mockResolvedValue([]);

      await service.getPendingPayments('s1', false, 'ALL', 100, 'ALL');

      expect(db.payment.findMany.mock.calls[0][0].where).toEqual({
        isConfirmed: false,
        status: PaymentTransactionStatus.PENDING,
      });
    });

    it('can isolate first payments', async () => {
      db.payment.findMany.mockResolvedValue([]);

      await service.getPendingPayments(
        's1',
        false,
        'ALL',
        100,
        'FIRST_PAYMENT',
      );

      expect(db.payment.findMany.mock.calls[0][0].where).toEqual({
        isConfirmed: false,
        status: PaymentTransactionStatus.PENDING,
        paymentType: PaymentType.FIRST_PAYMENT,
      });
    });

    it('maps pending installments with kobo→naira money fields (no signing)', async () => {
      db.payment.findMany.mockResolvedValue([pendingRow]);

      const res = await service.getPendingPayments('s1');

      expect(res).toHaveLength(1);
      expect(res[0]).toEqual(
        expect.objectContaining({
          platformAmount: 25,
          schoolAmount: 975,
          childName: 'Kid A',
          amount: 1000,
        }),
      );
      expect('receiptSignedUrl' in res[0]).toBe(false);
    });

    it('signs receipts when requested and swallows signing errors', async () => {
      db.payment.findMany.mockResolvedValue([
        pendingRow,
        { ...pendingRow, id: 'p2', receiptUrl: 'r/2' },
      ]);
      documents.createSignedUrlForPath
        .mockResolvedValueOnce({ signedUrl: 'https://signed/1' })
        .mockRejectedValueOnce(new Error('gone'));

      const res = await service.getPendingPayments('s1', true, 'ALL');

      expect(res[0].receiptSignedUrl).toBe('https://signed/1');
      expect(res[1].receiptSignedUrl).toBeNull();
    });
  });

  describe('thin ledger callers', () => {
    const actor = { userId: 'o', role: UserRole.SCHOOL_OWNER } as never;

    it('delegates confirmPayment', async () => {
      await expect(service.confirmPayment('p1', 's1', actor)).resolves.toEqual({
        confirmed: true,
      });
      expect(ledger.confirmPayment).toHaveBeenCalledWith('p1', 's1', actor);
    });

    it('delegates rejectPayment', async () => {
      await expect(service.rejectPayment('p1', 's1', actor)).resolves.toEqual({
        rejected: true,
      });
      expect(ledger.rejectPayment).toHaveBeenCalledWith('p1', 's1', actor);
    });

    it('delegates markEnrollmentAsDefaulted', async () => {
      await expect(
        service.markEnrollmentAsDefaulted('e1', 's1', actor),
      ).resolves.toEqual({ defaulted: true });
      expect(ledger.markEnrollmentAsDefaulted).toHaveBeenCalledWith(
        'e1',
        's1',
        actor,
      );
    });

    it('delegates reversePayment with the reason', async () => {
      await expect(
        service.reversePayment('p1', 's1', actor, 'duplicate'),
      ).resolves.toEqual({ reversed: true });
      expect(ledger.reversePayment).toHaveBeenCalledWith(
        'p1',
        's1',
        actor,
        'duplicate',
      );
    });
  });
});
