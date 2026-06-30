import { BadRequestException } from '@nestjs/common';
import { SchoolOnboardingService } from './school-onboarding.service';
import { UserRole } from '../generated/prisma/client';
import type { CreateSchoolDto } from '../admin/dto/create.school.dto';

/**
 * CHARACTERIZATION suite for the provisioning saga shared by createSchool /
 * onboardSchool (Milestone 3). Locks: fail-fast on existing email, owner
 * creation + SCHOOL_OWNER elevation, and the compensating owner-delete when the
 * School insert fails. Better Auth + Prisma are mocked (no real external calls).
 */
describe('SchoolOnboardingService.provisionSchoolAndOwner', () => {
  let prisma: {
    user: {
      findUnique: jest.Mock;
      update: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      delete: jest.Mock;
    };
    school: { create: jest.Mock };
  };
  let authService: { api: { signUpEmail: jest.Mock } };
  let service: SchoolOnboardingService;

  const dto: CreateSchoolDto = {
    schoolName: 'Acme School',
    ownerEmail: 'owner@acme.test',
    ownerPassword: 'password8!',
    ownerName: 'Ada Lovelace',
    address: '1 Main St',
    phone: '08000000000',
    bankName: 'GTB',
    bankCode: '058',
    accountName: 'Acme School',
    accountNumber: '0001112223',
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'owner-1',
          email: dto.ownerEmail,
          role: UserRole.SCHOOL_OWNER,
          fullName: dto.ownerName,
        }),
        delete: jest.fn().mockResolvedValue({}),
      },
      school: {
        create: jest
          .fn()
          .mockResolvedValue({ id: 'school-1', name: dto.schoolName }),
      },
    };
    authService = {
      api: {
        signUpEmail: jest.fn().mockResolvedValue({ user: { id: 'owner-1' } }),
      },
    };
    service = new SchoolOnboardingService(
      prisma as never,
      authService as never,
    );
  });

  it('creates the owner, elevates to SCHOOL_OWNER, and creates the school', async () => {
    const { school, user } = await service.provisionSchoolAndOwner(dto);

    expect(authService.api.signUpEmail).toHaveBeenCalledWith({
      body: {
        email: dto.ownerEmail,
        password: dto.ownerPassword,
        name: dto.ownerName,
      },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'owner-1' },
      data: { role: UserRole.SCHOOL_OWNER },
    });
    expect(prisma.school.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: dto.schoolName,
          ownerId: 'owner-1',
          bankCode: '058',
        }),
      }),
    );
    expect(school).toEqual({ id: 'school-1', name: dto.schoolName });
    expect(user.role).toBe(UserRole.SCHOOL_OWNER);
  });

  it('fails fast (400) without creating an owner when the email already exists', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'existing' });

    await expect(service.provisionSchoolAndOwner(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(authService.api.signUpEmail).not.toHaveBeenCalled();
  });

  it('wraps a Better Auth sign-up failure as a 400', async () => {
    authService.api.signUpEmail.mockRejectedValueOnce(
      new Error('weak password'),
    );

    await expect(service.provisionSchoolAndOwner(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.school.create).not.toHaveBeenCalled();
  });

  it('rolls back the orphaned owner when the School insert fails', async () => {
    prisma.school.create.mockRejectedValueOnce(new Error('db down'));

    await expect(service.provisionSchoolAndOwner(dto)).rejects.toThrow(
      'db down',
    );
    expect(prisma.user.delete).toHaveBeenCalledWith({
      where: { id: 'owner-1' },
    });
  });
});
