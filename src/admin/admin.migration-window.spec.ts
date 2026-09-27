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
import { AuditAction, UserRole } from '../generated/prisma/client';

const DAY = 24 * 60 * 60 * 1000;
const ACTOR = { userId: 'admin-1', role: UserRole.SUPER_ADMIN };
const ahead = (days: number) => new Date(Date.now() + days * DAY);

/**
 * The platform admin's control over a school's free-migration deadline.
 *
 * This endpoint exists because the product already promises it: a school whose
 * window has closed is told to "contact Lopay to have the window extended", and
 * before this that sentence resolved to someone editing the database by hand.
 *
 * What is asserted here is mostly the refusals. Granting more time is the easy
 * half; the half that matters is that a mistyped year cannot quietly hand one
 * school a century of free migration, and that stopping a school is expressible
 * rather than requiring a second endpoint nobody built.
 */
describe('AdminService — free-migration windows', () => {
  let service: AdminService;
  let prisma: {
    school: Record<string, jest.Mock>;
    enrollmentInvite: Record<string, jest.Mock>;
  };
  let audit: { record: jest.Mock };
  let notifications: { create: jest.Mock };

  const school = (overrides: Record<string, unknown> = {}) => ({
    id: 'school-1',
    name: 'Febison Montessori',
    ownerId: 'owner-1',
    createdAt: new Date(Date.now() - 30 * DAY),
    migrationDeadline: ahead(30),
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = {
      school: {
        findMany: jest.fn().mockResolvedValue([school()]),
        findFirst: jest.fn().mockResolvedValue(school()),
        update: jest
          .fn()
          .mockImplementation(
            ({ data }: { data: { migrationDeadline: Date } }) =>
              Promise.resolve({ migrationDeadline: data.migrationDeadline }),
          ),
      },
      enrollmentInvite: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    notifications = { create: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
        { provide: DocumentsService, useValue: {} },
        { provide: AuditService, useValue: audit },
        { provide: PaystackService, useValue: {} },
        { provide: LedgerService, useValue: {} },
        { provide: SchoolOnboardingService, useValue: {} },
        {
          provide: CacheService,
          useValue: {
            getOrSet: (_k: string, _t: number, load: () => unknown) => load(),
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get(AdminService);
  });

  // ============================== the listing ==============================

  describe('getMigrationWindows', () => {
    it('reports each school with how much of its window is left', async () => {
      const [row] = await service.getMigrationWindows();

      expect(row).toMatchObject({
        schoolId: 'school-1',
        schoolName: 'Febison Montessori',
        isOpen: true,
      });
      expect(row.daysRemaining).toBeGreaterThan(0);
    });

    it('reports a lapsed window as closed with zero days left', async () => {
      prisma.school.findMany.mockResolvedValue([
        school({ migrationDeadline: ahead(-3) }),
      ]);

      const [row] = await service.getMigrationWindows();
      expect(row).toMatchObject({ isOpen: false, daysRemaining: 0 });
    });

    it('counts how many students a school has actually migrated', async () => {
      // The number that turns "they want more time" into a decision: four
      // families is a different conversation from four hundred.
      prisma.enrollmentInvite.groupBy.mockResolvedValue([
        { schoolId: 'school-1', _count: { _all: 137 } },
      ]);

      const [row] = await service.getMigrationWindows();
      expect(row.migratedStudents).toBe(137);
    });

    it('counts a school with no migrations as zero, not undefined', async () => {
      const [row] = await service.getMigrationWindows();
      expect(row.migratedStudents).toBe(0);
    });

    it('asks the database once for the counts, not once per school', async () => {
      // A query per school is the obvious shape and does not survive a
      // directory of any size.
      prisma.school.findMany.mockResolvedValue([
        school({ id: 'a' }),
        school({ id: 'b' }),
        school({ id: 'c' }),
      ]);

      await service.getMigrationWindows();
      expect(prisma.enrollmentInvite.groupBy).toHaveBeenCalledTimes(1);
    });

    it('never lists a soft-deleted school', async () => {
      await service.getMigrationWindows();
      expect(prisma.school.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
        }),
      );
    });
  });

  // ============================== the setter ===============================

  describe('setMigrationWindow', () => {
    it('moves the deadline and reports both sides of the change', async () => {
      const target = ahead(45);

      const result = await service.setMigrationWindow(
        'school-1',
        target,
        ACTOR,
        'Still migrating 120 families',
      );

      expect(result.closesAt).toEqual(target);
      expect(result.previousClosesAt).toBeInstanceOf(Date);
      expect(result.isOpen).toBe(true);
    });

    it('audits the change with before, after and the reason', async () => {
      // This changes what a school is given for free. The person who has to
      // understand it later is not the person making it now.
      await service.setMigrationWindow('school-1', ahead(45), ACTOR, 'agreed');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.MIGRATION_WINDOW_CHANGED,
          entityType: 'School',
          entityId: 'school-1',
          reason: 'agreed',
          before: expect.objectContaining({ closesAt: expect.any(Date) }),
          after: expect.objectContaining({ closesAt: expect.any(Date) }),
        }),
      );
    });

    it('refuses a date more than a year out, naming what was entered', async () => {
      // The failure this exists for is a mistyped year, which is silent: every
      // downstream check simply passes and one school has free migration for a
      // century.
      await expect(
        service.setMigrationWindow('school-1', ahead(400), ACTOR, 'oops'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.school.update).not.toHaveBeenCalled();
    });

    it('refuses a date well in the past, and says how to stop a school instead', async () => {
      await expect(
        service.setMigrationWindow('school-1', ahead(-30), ACTOR, 'stop them'),
      ).rejects.toThrow(/set the deadline to today/i);
      expect(prisma.school.update).not.toHaveBeenCalled();
    });

    it('ALLOWS today, because stopping a school has to be expressible', async () => {
      // Extending and stopping are the same edit in opposite directions. If the
      // near bound refused every past-or-present date there would be no way to
      // shut down a school abusing free migration without a second endpoint.
      const today = new Date();

      await expect(
        service.setMigrationWindow('school-1', today, ACTOR, 'abuse'),
      ).resolves.toMatchObject({ isOpen: false });
    });

    it('tolerates a timezone slip of a few hours rather than rejecting it', async () => {
      // An admin meaning "today" in Lagos can produce an instant a few hours
      // behind the server's now. A hard now() bound would refuse that as "in
      // the past" for no reason a human could act on.
      await expect(
        service.setMigrationWindow(
          'school-1',
          new Date(Date.now() - 6 * 60 * 60 * 1000),
          ACTOR,
          'today',
        ),
      ).resolves.toBeDefined();
    });

    it('refuses an unparseable date before touching anything', async () => {
      await expect(
        service.setMigrationWindow(
          'school-1',
          new Date('not-a-date'),
          ACTOR,
          'x',
        ),
      ).rejects.toThrow(/valid date/i);
      expect(prisma.school.update).not.toHaveBeenCalled();
    });

    it('refuses a school that does not exist', async () => {
      prisma.school.findFirst.mockResolvedValue(null);

      await expect(
        service.setMigrationWindow('nope', ahead(30), ACTOR, 'x'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a soft-deleted school', async () => {
      await service.setMigrationWindow('school-1', ahead(30), ACTOR, 'x');

      expect(prisma.school.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
        }),
      );
    });

    it('tells the school owner, so they are not left to discover it', async () => {
      await service.setMigrationWindow(
        'school-1',
        ahead(45),
        ACTOR,
        'agreed a further month',
      );

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'owner-1',
          title: 'Migration period extended',
          message: expect.stringContaining('agreed a further month'),
        }),
      );
    });

    it('words it differently when the window is being shortened', async () => {
      // "Extended" would be a lie, and the owner reading it would go on issuing
      // invites until refused.
      await service.setMigrationWindow('school-1', ahead(1), ACTOR, 'abuse');

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Migration period updated' }),
      );
    });

    it('does not fail a committed change because the notification failed', async () => {
      notifications.create.mockRejectedValueOnce(new Error('FCM down'));

      await expect(
        service.setMigrationWindow('school-1', ahead(45), ACTOR, 'x'),
      ).resolves.toBeDefined();
      expect(prisma.school.update).toHaveBeenCalled();
    });
  });
});
