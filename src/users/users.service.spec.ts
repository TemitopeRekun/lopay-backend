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
