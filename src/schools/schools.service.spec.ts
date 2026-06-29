import { NotFoundException } from '@nestjs/common';
import { SchoolPaymentsService } from './schools.service';

/**
 * Security-focused units for the public directory shape and the soft-delete
 * owner-freeing. Only `prisma` is exercised; the other collaborators are stubbed.
 */
describe('SchoolPaymentsService', () => {
  const prisma = {
    school: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn().mockReturnValue({ op: 'school.update' }),
    },
    user: {
      update: jest.fn().mockReturnValue({ op: 'user.update' }),
    },
    session: {
      deleteMany: jest.fn().mockReturnValue({ op: 'session.deleteMany' }),
    },
    $transaction: jest.fn(),
  };
  const service = new SchoolPaymentsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  beforeEach(() => jest.clearAllMocks());

  describe('getPublicSchools', () => {
    it('selects ONLY id + name (no email/address/phone PII)', async () => {
      prisma.school.findMany.mockResolvedValueOnce([
        { id: 's1', name: 'Acme' },
      ]);
      await service.getPublicSchools();
      const arg = prisma.school.findMany.mock.calls[0][0];
      expect(arg.select).toEqual({ id: true, name: true });
      expect(arg.where).toEqual({ deletedAt: null });
    });

    it('searches by name only', async () => {
      prisma.school.findMany.mockResolvedValueOnce([]);
      await service.getPublicSchools('aca');
      const arg = prisma.school.findMany.mock.calls[0][0];
      expect(arg.where.name).toEqual({ contains: 'aca', mode: 'insensitive' });
      expect(arg.where.email).toBeUndefined();
    });
  });

  describe('deleteSchool', () => {
    it('soft-deletes the school AND frees the owner (anonymize + revoke sessions)', async () => {
      prisma.school.findFirst.mockResolvedValueOnce({
        id: 'school-1',
        ownerId: 'owner-1',
        deletedAt: null,
      });
      prisma.$transaction.mockResolvedValueOnce([
        { id: 'school-1', deletedAt: new Date() },
        { id: 'owner-1' },
        { count: 2 },
      ]);

      const result = await service.deleteSchool('school-1');

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'owner-1' },
          data: expect.objectContaining({
            email: 'deleted+owner-1@deleted.lopay',
          }),
        }),
      );
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'owner-1' },
      });
      expect(result).toEqual({ id: 'school-1', deletedAt: expect.any(Date) });
    });

    it('404s when the school does not exist', async () => {
      prisma.school.findFirst.mockResolvedValueOnce(null);
      await expect(service.deleteSchool('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
