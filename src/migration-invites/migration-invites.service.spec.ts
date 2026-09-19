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
    classFee: { findFirst: jest.fn() },
    parent: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const config = { get: jest.fn() };
  let service: MigrationInvitesService;

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue('https://app.example');
    prisma.classFee.findFirst.mockResolvedValue({ feeAmount: 100_000 });
    service = new MigrationInvitesService(
      prisma as never,
      config as never,
      { recordMigratedPayment: jest.fn() } as never,
      { emitEnrollmentsChanged: jest.fn(), emitPaymentsChanged: jest.fn() } as never,
    );
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

  it('claims an invite through the ledger and reuses an existing child', async () => {
    prisma.migrationInvite.findUnique.mockResolvedValue({
      id: 'invite',
      tokenHash: 'hash',
      parentPhoneHash: 'expected',
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 60_000),
      studentName: 'Ada',
      className: 'Basic 1',
      schoolId: 'school',
      totalSchoolFee: 100_000,
      amountPaid: 25_000,
      installmentFrequency: 'MONTHLY',
      migrationDate: new Date('2026-09-16'),
      termEndDate: new Date('2026-12-16'),
      school: { name: 'School' },
    });
    prisma.user.findUnique.mockResolvedValue({ phoneHash: 'expected' });
    const tx = {
      migrationInvite: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ phoneNumber: '+2348012345678' }) },
      parent: { upsert: jest.fn().mockResolvedValue({ id: 'parent' }) },
      child: { findFirst: jest.fn().mockResolvedValue({ id: 'child' }) },
    };
    prisma.$transaction.mockImplementation((callback: (value: unknown) => unknown) => callback(tx));
    const ledger = (service as never as { ledger: { recordMigratedPayment: jest.Mock } }).ledger;
    ledger.recordMigratedPayment.mockResolvedValue({
      id: 'enrollment',
      paymentStatus: 'ACTIVE',
      remainingBalance: 75_000,
    });

    await expect(service.claim('a'.repeat(32), { userId: 'parent', role: UserRole.PARENT, schoolId: null }))
      .resolves.toEqual(expect.objectContaining({ enrollmentId: 'enrollment', remainingBalance: 750 }));
    expect(tx.child.findFirst).toHaveBeenCalledWith({
      where: { parentId: 'parent', fullName: 'Ada', className: 'Basic 1' },
    });
    expect(ledger.recordMigratedPayment).toHaveBeenCalledTimes(1);
  });

  it('rejects a second claim before the ledger is touched', async () => {
    prisma.migrationInvite.findUnique.mockResolvedValue({
      id: 'invite', tokenHash: 'hash', parentPhoneHash: 'expected', status: 'CREATED',
      expiresAt: new Date(Date.now() + 60_000), school: { name: 'School' },
    });
    prisma.user.findUnique.mockResolvedValue({ phoneHash: 'expected' });
    const tx = { migrationInvite: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };
    prisma.$transaction.mockImplementation((callback: (value: unknown) => unknown) => callback(tx));

    await expect(service.claim('a'.repeat(32), { userId: 'parent', role: UserRole.PARENT, schoolId: null }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect((service as never as { ledger: { recordMigratedPayment: jest.Mock } }).ledger.recordMigratedPayment)
      .not.toHaveBeenCalled();
  });
});