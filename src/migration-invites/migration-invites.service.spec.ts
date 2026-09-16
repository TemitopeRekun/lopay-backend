import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MigrationInvitesService } from './migration-invites.service';
import { UserRole } from '../generated/prisma/client';

describe('MigrationInvitesService', () => {
  const prisma = {
    school: { findFirst: jest.fn() },
    migrationInvite: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { findUnique: jest.fn() },
  };
  const config = { get: jest.fn() };
  let service: MigrationInvitesService;

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue('https://app.example');
    service = new MigrationInvitesService(prisma as never, config as never);
  });

  it('rejects a migration where the stated payment exceeds the fee', async () => {
    await expect(
      service.create(
        {
          studentName: 'Ada',
          className: 'Basic 1',
          totalSchoolFee: 1000,
          amountPaid: 1001,
          parentPhone: '+2348012345678',
          installmentFrequency: 'MONTHLY',
          migrationDate: new Date('2026-09-16'),
          termEndDate: new Date('2026-12-16'),
        } as never,
        { userId: 'owner', role: UserRole.SCHOOL_OWNER, schoolId: 'school' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires an owner to create an invite', async () => {
    await expect(
      service.create({} as never, {
        userId: 'parent',
        role: UserRole.PARENT,
        schoolId: 'school',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('prevents a parent with a different phone from disputing', async () => {
    prisma.migrationInvite.findUnique.mockResolvedValue({
      id: 'invite',
      tokenHash: 'hash',
      parentPhoneHash: 'expected',
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 60_000),
      school: { name: 'School' },
    });
    prisma.user.findUnique.mockResolvedValue({ phoneHash: 'other' });

    await expect(
      service.dispute(
        'a'.repeat(32),
        { userId: 'parent', role: UserRole.PARENT, schoolId: null },
        'wrong amount',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.migrationInvite.updateMany).not.toHaveBeenCalled();
  });
});