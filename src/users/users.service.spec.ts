import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { initEncryptionKey } from '../common/encryption';
import { phoneBlindIndex } from '../common/phone';

describe('UsersService.updateProfile', () => {
  const prisma = {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({ id: 'u1' }),
    },
  };
  const service = new UsersService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    initEncryptionKey('a'.repeat(64));
    // Default: nobody else holds the number.
    prisma.user.findUnique.mockResolvedValue(null);
  });

  afterEach(() => initEncryptionKey(undefined));

  it('mirrors fullName onto Better Auth `name` and updates phone', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
    await service.updateProfile('u1', {
      fullName: 'New Name',
      phoneNumber: '08012345678',
    });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: {
          fullName: 'New Name',
          name: 'New Name',
          phoneNumber: '+2348012345678',
          phoneHash: phoneBlindIndex('08012345678'),
        },
      }),
    );
  });

  it('never writes role or email (self-service cannot escalate)', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
    await service.updateProfile('u1', { fullName: 'X' });
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('role');
    expect(data).not.toHaveProperty('email');
  });

  it('404s for an unknown user', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.updateProfile('missing', { fullName: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  describe('phone number', () => {
    it('stores the canonical form, whatever spelling was submitted', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      await service.updateProfile('u1', { phoneNumber: '0801 234-5678' });

      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.phoneNumber).toBe('+2348012345678');
    });

    // The blind index is the only thing that can enforce uniqueness (phoneNumber
    // is randomized ciphertext), so it must be rewritten on every change or the
    // account keeps reserving a number it no longer has.
    it('recomputes the blind index alongside the number', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      await service.updateProfile('u1', { phoneNumber: '08012345678' });

      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.phoneHash).toBe(phoneBlindIndex('08012345678'));
    });

    it('rejects an invalid number with a coded 400', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      await expect(
        service.updateProfile('u1', { phoneNumber: '0801' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    // This is the bypass this method has to close: without the check, a parent
    // could sign up with one number and then PATCH to a number that already
    // belongs to somebody else.
    it('rejects a number already held by another account with a coded 409', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'someone-else' });

      await expect(
        service.updateProfile('u1', { phoneNumber: '08012345678' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('carries the machine code in the conflict body', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'someone-else' });

      await service
        .updateProfile('u1', { phoneNumber: '08012345678' })
        .catch((error: unknown) => {
          expect((error as ConflictException).getResponse()).toMatchObject({
            code: 'PHONE_ALREADY_REGISTERED',
          });
        });
    });

    // The profile form submits every field, not just the changed ones, so
    // re-saving your own number must stay a no-op rather than a conflict.
    it('allows re-saving the number the caller already holds', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1' });

      await expect(
        service.updateProfile('u1', { phoneNumber: '08012345678' }),
      ).resolves.toBeDefined();
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('catches a duplicate submitted in a different spelling than the stored one', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'someone-else' });

      await expect(
        service.updateProfile('u1', { phoneNumber: '+234 801 234 5678' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('looks the number up by hash, never by the encrypted column', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      await service.updateProfile('u1', { phoneNumber: '08012345678' });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { phoneHash: phoneBlindIndex('08012345678') },
        select: { id: true },
      });
    });

    it('does not touch phone columns when the field is absent', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      await service.updateProfile('u1', { fullName: 'Only Name' });

      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('phoneNumber');
      expect(data).not.toHaveProperty('phoneHash');
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });
});

/**
 * The admin user directory counts plans server-side.
 *
 * The screen used to derive this in the browser from a SCHOOL_OWNER-only roster
 * endpoint (403 for the admin reading it) and match on `child.parentId`, a field
 * the client adapter hard-codes to `""` — so every parent rendered "0 Plans".
 */
describe('UsersService.findAll — enrollmentCount', () => {
  const prisma = {
    user: { findMany: jest.fn() },
    childEnrollment: { groupBy: jest.fn() },
    child: { findMany: jest.fn() },
  };
  const service = new UsersService(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  it('totals every plan across a parent\u2019s children', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        email: 'a@x',
        fullName: 'A',
        role: 'PARENT',
        parent: { id: 'p1' },
      },
      {
        id: 'u2',
        email: 'b@x',
        fullName: 'B',
        role: 'PARENT',
        parent: { id: 'p2' },
      },
      {
        id: 'u3',
        email: 'c@x',
        fullName: 'C',
        role: 'SUPER_ADMIN',
        parent: null,
      },
    ]);
    prisma.child.findMany.mockResolvedValue([
      { id: 'c1', parentId: 'p1' },
      { id: 'c2', parentId: 'p1' },
      { id: 'c3', parentId: 'p2' },
    ]);
    prisma.childEnrollment.groupBy.mockResolvedValue([
      { childId: 'c1', _count: { _all: 1 } },
      { childId: 'c2', _count: { _all: 1 } },
      { childId: 'c3', _count: { _all: 1 } },
    ]);

    const res = await service.findAll();

    expect(res.map((u) => [u.id, u.enrollmentCount])).toEqual([
      ['u1', 2],
      ['u2', 1],
      ['u3', 0],
    ]);
    // The relation is a lookup key, not payload.
    expect(res[0]).not.toHaveProperty('parent');
  });

  it('reports zero rather than skipping a parent with no plans', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        email: 'a@x',
        fullName: 'A',
        role: 'PARENT',
        parent: { id: 'p1' },
      },
    ]);
    prisma.child.findMany.mockResolvedValue([]);
    prisma.childEnrollment.groupBy.mockResolvedValue([]);

    await expect(service.findAll()).resolves.toEqual([
      expect.objectContaining({ id: 'u1', enrollmentCount: 0 }),
    ]);
  });

  it('does not query enrollments when nobody in the list is a parent', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u3',
        email: 'c@x',
        fullName: 'C',
        role: 'SUPER_ADMIN',
        parent: null,
      },
    ]);

    await service.findAll();

    expect(prisma.childEnrollment.groupBy).not.toHaveBeenCalled();
    expect(prisma.child.findMany).not.toHaveBeenCalled();
  });
});
