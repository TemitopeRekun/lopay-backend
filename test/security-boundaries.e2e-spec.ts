/**
 * Real-database security-boundary tests for the Milestone 2 (secure delivery)
 * slice. Runs the real services against the local Postgres so the actual queries
 * — not mocks — enforce the boundaries:
 *
 *  - the public `/schools` directory leaks no PII (id + name only),
 *  - verify-on-return is scoped to the caller's own payment (cross-tenant 403),
 *  - soft-deleting a school frees its owner for re-registration.
 *
 * Requires the local Docker DB (see LOCAL_DEV.md), migrations applied. External
 * boundaries (notifications, events, audit, documents, Better Auth) are stubbed.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { EnrollmentService } from '../src/enrollment/enrollment.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { SchoolOnboardingService } from '../src/school-onboarding/school-onboarding.service';
import { PaymentService } from '../src/payments/payment.service';
import { SchoolPaymentsService } from '../src/schools/schools.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { DocumentsService } from '../src/documents/documents.service';
import { EventsGateway } from '../src/events/events.gateway';
import { AuditService } from '../src/audit/audit.service';
import { PaystackService } from '../src/paystack/paystack.service';
import { CacheService } from '../src/cache/cache.service';
import { MetricsService } from '../src/common/observability/metrics.service';
import { AuthService } from '@thallesp/nestjs-better-auth';
import {
  InstallmentFrequency,
  PaymentReceiver,
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  UserRole,
} from '../src/generated/prisma/client';
import type { AuthUser } from '../src/common/types/auth-user';

describe('Security boundaries (real DB)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let enrollment: EnrollmentService;
  let schools: SchoolPaymentsService;

  let schoolId: string;
  let ownerUserId: string;
  let ownerEmail: string;
  let parentUserId: string;
  let parentId: string;
  let otherParentUserId: string;
  let otherParentId: string;
  let reference: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        PrismaService,
        PaymentService,
        EnrollmentService,
        SchoolPaymentsService,
        LedgerService,
        SchoolOnboardingService,
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
        {
          provide: PaystackService,
          useValue: { verifyTransaction: jest.fn() },
        },
        // In-memory cache (REDIS_CLIENT = null); SchoolPaymentsService now needs it.
        { provide: CacheService, useValue: new CacheService(null) },
        { provide: AuthService, useValue: {} },
        // LedgerService now records payment metrics (Milestone 5).
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
    schools = moduleRef.get(SchoolPaymentsService);
    await prisma.$connect();
  });

  afterAll(async () => {
    // Runs PrismaService.onModuleDestroy, which ends the caller-owned pg pool as
    // well as disconnecting Prisma. `$disconnect()` alone skips the hook.
    await moduleRef.close();
  });

  beforeEach(async () => {
    const tag = randomUUID().slice(0, 8);
    ownerUserId = randomUUID();
    parentUserId = randomUUID();
    otherParentUserId = randomUUID();
    schoolId = randomUUID();
    parentId = randomUUID();
    otherParentId = randomUUID();
    ownerEmail = `owner_${tag}@itest.local`;
    reference = `lopay_${tag}`;

    await prisma.user.create({
      data: {
        id: ownerUserId,
        email: ownerEmail,
        role: UserRole.SCHOOL_OWNER,
        fullName: 'Boundary Owner',
      },
    });
    await prisma.user.create({
      data: {
        id: parentUserId,
        email: `parent_${tag}@itest.local`,
        role: UserRole.PARENT,
        fullName: 'Owning Parent',
      },
    });
    await prisma.user.create({
      data: {
        id: otherParentUserId,
        email: `other_${tag}@itest.local`,
        role: UserRole.PARENT,
        fullName: 'Other Parent',
      },
    });
    await prisma.school.create({
      data: {
        id: schoolId,
        name: `Boundary School ${tag}`,
        email: `school_${tag}@itest.local`,
        phone: '08011111111',
        address: '1 Secret Road',
        ownerId: ownerUserId,
        bankName: 'Test Bank',
        accountName: 'Boundary School',
        accountNumber: '0123456789',
      },
    });
    await prisma.parent.create({
      data: { id: parentId, userId: parentUserId, phoneNumber: '08000000000' },
    });
    await prisma.parent.create({
      data: {
        id: otherParentId,
        userId: otherParentUserId,
        phoneNumber: '08000000001',
      },
    });

    const child = await prisma.child.create({
      data: { parentId, fullName: 'Boundary Kid', className: 'Basic 1' },
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
        remainingBalance: 72_500,
        paymentStatus: PaymentStatus.ACTIVE,
        installmentFrequency: InstallmentFrequency.MONTHLY,
        termStartDate: new Date('2026-01-01'),
        termEndDate: new Date('2026-04-01'),
      },
    });
    await prisma.payment.create({
      data: {
        enrollmentId: enr.id,
        schoolId,
        amountPaid: 27_500,
        platformAmount: 2_500,
        schoolAmount: 25_000,
        receiver: PaymentReceiver.SCHOOL,
        paymentType: PaymentType.FIRST_PAYMENT,
        status: PaymentTransactionStatus.PENDING,
        paystackReference: reference,
      },
    });
  });

  afterEach(async () => {
    await prisma.payment.deleteMany({ where: { schoolId } });
    await prisma.childEnrollment.deleteMany({ where: { schoolId } });
    await prisma.child.deleteMany({
      where: { parentId: { in: [parentId, otherParentId] } },
    });
    await prisma.parent.deleteMany({
      where: { id: { in: [parentId, otherParentId] } },
    });
    await prisma.school.deleteMany({ where: { id: schoolId } });
    await prisma.user.deleteMany({
      where: {
        id: { in: [ownerUserId, parentUserId, otherParentUserId] },
      },
    });
  });

  describe('public /schools directory shape', () => {
    it('returns id + name only — no email/address/phone PII', async () => {
      const rows = await schools.getPublicSchools();
      const mine = rows.find((s) => s.id === schoolId);
      expect(mine).toBeDefined();
      expect(Object.keys(mine as object).sort()).toEqual(['id', 'name']);
      expect(mine).not.toHaveProperty('email');
      expect(mine).not.toHaveProperty('address');
      expect(mine).not.toHaveProperty('phone');
    });
  });

  describe('verify-on-return ownership scoping (cross-tenant)', () => {
    const parent: () => AuthUser = () => ({
      userId: parentUserId,
      role: UserRole.PARENT,
      schoolId: null,
    });
    const otherParent: () => AuthUser = () => ({
      userId: otherParentUserId,
      role: UserRole.PARENT,
      schoolId: null,
    });
    const owner: () => AuthUser = () => ({
      userId: ownerUserId,
      role: UserRole.SCHOOL_OWNER,
      schoolId,
    });

    it('allows the owning parent', async () => {
      await expect(
        enrollment.assertReferenceOwnedBy(reference, parent()),
      ).resolves.toBeUndefined();
    });

    it('allows the owning school owner', async () => {
      await expect(
        enrollment.assertReferenceOwnedBy(reference, owner()),
      ).resolves.toBeUndefined();
    });

    it('rejects a different parent with 403', async () => {
      await expect(
        enrollment.assertReferenceOwnedBy(reference, otherParent()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an unknown reference with 404', async () => {
      await expect(
        enrollment.assertReferenceOwnedBy('lopay_does_not_exist', parent()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('soft-deleting a school frees its owner', () => {
    it('anonymizes the owner email + soft-deletes so the email can re-register', async () => {
      await schools.deleteSchool(schoolId);

      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: ownerUserId },
      });
      expect(owner.deletedAt).not.toBeNull();
      expect(owner.email).not.toBe(ownerEmail);
      expect(owner.email).toBe(`deleted+${ownerUserId}@deleted.lopay`);

      // The original email is now free — no active user holds it.
      const stillUsingEmail = await prisma.user.findUnique({
        where: { email: ownerEmail },
      });
      expect(stillUsingEmail).toBeNull();
    });
  });
});
