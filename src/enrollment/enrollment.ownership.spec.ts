import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/types/auth-user';

/**
 * Unit tests for the verify-on-return authorization (`assertReferenceOwnedBy`).
 * Only `prisma.payment.findUnique` is exercised, so the other collaborators are
 * stubbed.
 */
describe('EnrollmentService.assertReferenceOwnedBy', () => {
  const findUnique = jest.fn();
  const prisma = { payment: { findUnique } };
  const service = new EnrollmentService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // ledger (unused by assertReferenceOwnedBy)
  );

  const parent: AuthUser = {
    userId: 'parent-1',
    role: UserRole.PARENT,
    schoolId: null,
  };
  const owner: AuthUser = {
    userId: 'owner-1',
    role: UserRole.SCHOOL_OWNER,
    schoolId: 'school-1',
  };

  beforeEach(() => jest.clearAllMocks());

  it('allows the enrolled child’s parent', async () => {
    findUnique.mockResolvedValueOnce({
      schoolId: 'school-1',
      enrollment: { child: { parent: { userId: 'parent-1' } } },
    });
    await expect(
      service.assertReferenceOwnedBy('r1', parent),
    ).resolves.toBeUndefined();
  });

  it('allows the owning school owner', async () => {
    findUnique.mockResolvedValueOnce({
      schoolId: 'school-1',
      enrollment: { child: { parent: { userId: 'someone-else' } } },
    });
    await expect(
      service.assertReferenceOwnedBy('r1', owner),
    ).resolves.toBeUndefined();
  });

  it('rejects an unknown reference with 404', async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(
      service.assertReferenceOwnedBy('nope', parent),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a different parent with 403', async () => {
    findUnique.mockResolvedValueOnce({
      schoolId: 'school-1',
      enrollment: { child: { parent: { userId: 'parent-2' } } },
    });
    await expect(
      service.assertReferenceOwnedBy('r1', parent),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a school owner from a different school with 403', async () => {
    findUnique.mockResolvedValueOnce({
      schoolId: 'school-OTHER',
      enrollment: { child: { parent: { userId: 'someone-else' } } },
    });
    await expect(
      service.assertReferenceOwnedBy('r1', owner),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
