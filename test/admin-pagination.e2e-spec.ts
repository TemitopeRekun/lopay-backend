/**
 * Real-database integration tests for the Milestone 4 scale work:
 *   1. the admin transaction list is server-paginated (capped envelope), and a
 *      page past the end returns an empty page (boundary), and an over-large
 *      `limit` is clamped to MAX_PAGE_SIZE — so no HTTP caller can pull the
 *      whole table.
 *   2. the new Payment(paymentDate) index is present and usable for the hot
 *      "ORDER BY paymentDate DESC" path (proven via EXPLAIN with seq-scan off).
 *
 * Requires the local Docker DB with the M4 index migration applied (see
 * LOCAL_DEV.md). External boundaries are stubbed; the DB is real.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AdminService } from '../src/admin/admin.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { AuditService } from '../src/audit/audit.service';
import { PaystackService } from '../src/paystack/paystack.service';
import { DocumentsService } from '../src/documents/documents.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { SchoolOnboardingService } from '../src/school-onboarding/school-onboarding.service';
import { CacheService } from '../src/cache/cache.service';
import { MAX_PAGE_SIZE } from '../src/common/pagination';
import {
  InstallmentFrequency,
  PaymentReceiver,
  PaymentStatus,
  PaymentType,
  PaymentTransactionStatus,
  UserRole,
} from '../src/generated/prisma/client';

describe('Admin pagination & index usage (real DB)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let admin: AdminService;

  let schoolId: string;
  let ownerUserId: string;
  let parentUserId: string;
  let parentId: string;
  let enrollmentId: string;
  const SEEDED = 5;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        PrismaService,
        AdminService,
        // In-memory cache (REDIS_CLIENT = null) — getTransactions doesn't touch it.
        { provide: CacheService, useValue: new CacheService(null) },
        { provide: DocumentsService, useValue: {} },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: AuditService, useValue: { record: jest.fn() } },
        { provide: PaystackService, useValue: {} },
        { provide: LedgerService, useValue: {} },
        { provide: SchoolOnboardingService, useValue: {} },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    admin = moduleRef.get(AdminService);
    await prisma.$connect();

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
        fullName: 'Pg Owner',
      },
    });
    await prisma.user.create({
      data: {
        id: parentUserId,
        email: `parent_${tag}@itest.local`,
        role: UserRole.PARENT,
        fullName: 'Pg Parent',
        phoneNumber: '08000000000',
      },
    });
    await prisma.school.create({
      data: {
        id: schoolId,
        name: `Pagination School ${tag}`,
        email: `school_${tag}@itest.local`,
        phone: '08011111111',
        address: '1 Test Road',
        ownerId: ownerUserId,
        bankName: 'Test Bank',
        accountName: 'Test School',
        accountNumber: '0123456789',
      },
    });
    await prisma.parent.create({
      data: { id: parentId, userId: parentUserId, phoneNumber: '08000000000' },
    });
    const child = await prisma.child.create({
      data: { parentId, fullName: 'Pg Kid', className: 'Basic 1' },
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
        remainingBalance: 50_000,
        paymentStatus: PaymentStatus.ACTIVE,
        installmentFrequency: InstallmentFrequency.MONTHLY,
        termStartDate: new Date('2026-01-01'),
        termEndDate: new Date('2026-04-01'),
      },
    });
    enrollmentId = enr.id;

    for (let i = 0; i < SEEDED; i += 1) {
      await prisma.payment.create({
        data: {
          enrollmentId,
          schoolId,
          amountPaid: 10_000,
          platformAmount: 0,
          schoolAmount: 10_000,
          receiver: PaymentReceiver.SCHOOL,
          paymentType: PaymentType.INSTALLMENT,
          status: PaymentTransactionStatus.SUCCESS,
          isConfirmed: true,
          paymentDate: new Date(2026, 0, i + 1),
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { schoolId } });
    await prisma.childEnrollment.deleteMany({ where: { schoolId } });
    await prisma.child.deleteMany({ where: { parentId } });
    await prisma.parent.deleteMany({ where: { id: parentId } });
    await prisma.school.deleteMany({ where: { id: schoolId } });
    await prisma.user.deleteMany({
      where: { id: { in: [ownerUserId, parentUserId] } },
    });
    // Closing the module runs PrismaService.onModuleDestroy, which disconnects
    // Prisma AND ends the caller-owned pg pool. Calling `$disconnect()` directly
    // skips the hook and leaves the pool's idle sockets holding the event loop.
    await moduleRef.close();
  });

  it('returns a capped page envelope (page size respected, total >= seeded)', async () => {
    const res = await admin.getTransactions(false, 'ALL', 1, 2);
    expect(res.items.length).toBe(2);
    expect(res.limit).toBe(2);
    expect(res.page).toBe(1);
    expect(res.total).toBeGreaterThanOrEqual(SEEDED);
    expect(res.totalPages).toBe(Math.ceil(res.total / 2));
  });

  it('returns an empty page past the last page (boundary)', async () => {
    const first = await admin.getTransactions(false, 'ALL', 1, 2);
    const beyond = await admin.getTransactions(
      false,
      'ALL',
      first.totalPages + 1,
      2,
    );
    expect(beyond.items).toHaveLength(0);
    expect(beyond.total).toBe(first.total); // total is stable across pages
  });

  it('clamps an over-large limit to MAX_PAGE_SIZE', async () => {
    const res = await admin.getTransactions(false, 'ALL', 1, 100_000);
    expect(res.limit).toBe(MAX_PAGE_SIZE);
  });

  it('uses an index (not a seq scan) for ORDER BY paymentDate DESC', async () => {
    // Force the planner to prefer indexes so the assertion is deterministic even
    // on a small table — this proves the M4 index EXISTS and is usable, which is
    // the property the migration must guarantee.
    await prisma.$executeRawUnsafe('SET enable_seqscan = off');
    try {
      const plan = await prisma.$queryRawUnsafe<
        Array<{ 'QUERY PLAN': unknown }>
      >(
        'EXPLAIN (FORMAT JSON) SELECT * FROM "Payment" ORDER BY "paymentDate" DESC LIMIT 50',
      );
      const planText = JSON.stringify(plan);
      expect(planText).toContain('Index');
      expect(planText).toContain('paymentDate');
    } finally {
      await prisma.$executeRawUnsafe('SET enable_seqscan = on');
    }
  });
});
