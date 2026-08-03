import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { UserRole } from '../generated/prisma/client';

/**
 * Covers the CRUD paths not exercised by users.service.spec.ts (which only
 * targets updateProfile): findAll, findOne, update, and the soft-delete remove.
 */
describe('UsersService (findAll/findOne/update/remove)', () => {
  const prisma = {
    user: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    session: { deleteMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const service = new UsersService(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  describe('findAll', () => {
    it('lists only non-deleted users, newest first', async () => {
      prisma.user.findMany.mockResolvedValueOnce([{ id: 'u1' }]);
      const result = await service.findAll();
      const args = prisma.user.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ deletedAt: null });
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      // Every row now carries a server-side plan count (see the
      // `findAll — enrollmentCount` suite); a non-parent gets 0.
      expect(result).toEqual([{ id: 'u1', enrollmentCount: 0 }]);
    });
  });

  describe('findOne', () => {
    it('returns the user when found (scoped to non-deleted)', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      expect(await service.findOne('u1')).toEqual({ id: 'u1' });
      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        id: 'u1',
        deletedAt: null,
      });
    });

    it('404s when the user does not exist', async () => {
      prisma.user.findFirst.mockResolvedValueOnce(null);
      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('verifies existence via findOne then updates', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      prisma.user.update.mockResolvedValueOnce({
        id: 'u1',
        role: UserRole.PARENT,
      });
      const result = await service.update('u1', { role: UserRole.PARENT });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'u1' },
          data: { role: UserRole.PARENT },
        }),
      );
      expect(result).toEqual({ id: 'u1', role: UserRole.PARENT });
    });

    it('404s (and never updates) for an unknown user', async () => {
      prisma.user.findFirst.mockResolvedValueOnce(null);
      await expect(service.update('missing', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('soft-deletes: anonymizes the email and revokes sessions in one transaction', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      prisma.user.update.mockReturnValueOnce({ op: 'user.update' });
      prisma.session.deleteMany.mockReturnValueOnce({
        op: 'session.deleteMany',
      });
      prisma.$transaction.mockResolvedValueOnce([
        { id: 'u1', email: 'deleted+u1@deleted.lopay' },
        { count: 1 },
      ]);

      const result = await service.remove('u1');

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'u1' },
          data: expect.objectContaining({
            email: 'deleted+u1@deleted.lopay',
            deletedAt: expect.any(Date),
          }),
        }),
      );
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
      });
      expect(result).toEqual({ id: 'u1', email: 'deleted+u1@deleted.lopay' });
    });

    it('404s (and never opens a transaction) for an unknown user', async () => {
      prisma.user.findFirst.mockResolvedValueOnce(null);
      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
