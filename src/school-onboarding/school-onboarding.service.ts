import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '../generated/prisma/client';
import { CreateSchoolDto } from '../admin/dto/create.school.dto';
import { errorMessage } from '../common/errors';

/**
 * Single owner of the school + owner provisioning saga (Milestone 3).
 *
 * Both onboarding paths — admin `onboardSchool` (which adds Paystack subaccount
 * provisioning) and schools-management `createSchool` — delegate here so the
 * saga can't drift between them. Better Auth creates the User outside the Prisma
 * transaction, so the School insert is followed by a compensating delete of the
 * orphaned auth user on failure.
 */
@Injectable()
export class SchoolOnboardingService {
  private readonly logger = new Logger(SchoolOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  /** Fail-fast email check → create owner (SCHOOL_OWNER) → create School (rollback owner on failure). */
  async provisionSchoolAndOwner(dto: CreateSchoolDto) {
    // Fail fast if the owner already has an account.
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.ownerEmail },
    });
    if (existingUser) {
      throw new BadRequestException(
        'User with this email already exists in the database',
      );
    }

    // 1. Create the owner via Better Auth (User + credential account).
    let ownerUserId: string;
    try {
      const signUp = await this.authService.api.signUpEmail({
        body: {
          email: dto.ownerEmail,
          password: dto.ownerPassword,
          name: dto.ownerName,
        },
      });
      ownerUserId = signUp.user.id;
      // role is not a sign-up input (security); elevate to SCHOOL_OWNER server-side.
      await this.prisma.user.update({
        where: { id: ownerUserId },
        data: { role: UserRole.SCHOOL_OWNER },
      });
    } catch (error: unknown) {
      this.logger.error(
        `Owner account creation failed: ${errorMessage(error)}`,
      );
      throw new BadRequestException(
        `Could not create owner account: ${errorMessage(error)}`,
      );
    }

    // 2. Create the School row linked to the new owner. Better Auth created the
    // User outside this transaction, so compensate by deleting it on failure.
    try {
      const school = await this.prisma.school.create({
        data: {
          name: dto.schoolName,
          email: dto.ownerEmail,
          address: dto.address,
          phone: dto.phone,
          bankName: dto.bankName,
          bankCode: dto.bankCode,
          accountName: dto.accountName,
          accountNumber: dto.accountNumber,
          ownerId: ownerUserId,
        },
      });
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: ownerUserId },
      });
      return { school, user };
    } catch (error) {
      // Roll back the orphaned auth user (cascades to session/account).
      await this.prisma.user
        .delete({ where: { id: ownerUserId } })
        .catch(() => undefined);
      throw error;
    }
  }
}
