import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateUserDto } from './dto/update.user.dto';
import { UpdateProfileDto } from './dto/update.profile.dto';
import {
  AUTH_ERROR_CODES,
  AUTH_ERROR_MESSAGES,
} from '../common/auth-error-codes';
import { canonicalizePhone, phoneBlindIndex } from '../common/phone';
import { AUTH_EVENTS, logAuthEvent } from '../common/logger/auth-events';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    // Check if user exists
    await this.findOne(id);

    return this.prisma.user.update({
      where: { id },
      data: updateUserDto,
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Self-service profile update. Only `fullName`/`phoneNumber` are writable here
   * (see UpdateProfileDto); `fullName` is mirrored onto Better Auth's `name` to
   * keep the two in sync. Role/email changes are intentionally NOT possible.
   *
   * Phone changes go through the same canonicalisation and uniqueness rule as
   * sign-up. Without that, this endpoint would be the way around the constraint:
   * sign up with one number, then PATCH to a number that already belongs to
   * another parent. The blind index is recomputed on every change so it can never
   * fall out of step with the (encrypted, unqueryable) `phoneNumber` column.
   */
  async updateProfile(id: string, dto: UpdateProfileDto) {
    await this.findOne(id);

    let phoneData: { phoneNumber: string; phoneHash: string } | undefined;
    if (dto.phoneNumber !== undefined) {
      const canonical = canonicalizePhone(dto.phoneNumber);
      if (!canonical) {
        throw new BadRequestException({
          code: AUTH_ERROR_CODES.PHONE_INVALID,
          message: AUTH_ERROR_MESSAGES.PHONE_INVALID,
        });
      }
      const phoneHash = phoneBlindIndex(canonical);
      if (!phoneHash) {
        throw new BadRequestException({
          code: AUTH_ERROR_CODES.PHONE_INVALID,
          message: AUTH_ERROR_MESSAGES.PHONE_INVALID,
        });
      }

      // Someone else holding this number is a conflict; the caller already
      // holding it is a no-op re-save, which must stay allowed (the profile form
      // submits every field, not just the changed ones).
      const owner = await this.prisma.user.findUnique({
        where: { phoneHash },
        select: { id: true },
      });
      if (owner && owner.id !== id) {
        logAuthEvent(
          this.logger,
          AUTH_EVENTS.PROFILE_PHONE_REJECTED,
          'rejected',
          {
            reason: AUTH_ERROR_CODES.PHONE_ALREADY_REGISTERED,
            field: 'phoneNumber',
            userId: id,
            phoneNumber: dto.phoneNumber,
          },
        );
        throw new ConflictException({
          code: AUTH_ERROR_CODES.PHONE_ALREADY_REGISTERED,
          message: AUTH_ERROR_MESSAGES.PHONE_ALREADY_REGISTERED,
        });
      }

      phoneData = { phoneNumber: canonical, phoneHash };
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.fullName !== undefined
          ? { fullName: dto.fullName, name: dto.fullName }
          : {}),
        ...(phoneData ?? {}),
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        phoneNumber: true,
        updatedAt: true,
      },
    });

    if (phoneData) {
      logAuthEvent(
        this.logger,
        AUTH_EVENTS.PROFILE_PHONE_CHANGED,
        'succeeded',
        { userId: id, phoneNumber: phoneData.phoneNumber },
      );
    }

    return updated;
  }

  async remove(id: string) {
    // Check if user exists (and isn't already deleted)
    await this.findOne(id);

    // Soft-delete: a hard delete would violate the Restrict FKs on School/Parent/
    // Payment (and erase financial history). Set deletedAt, anonymize the email to
    // free the unique constraint for re-registration, and revoke active sessions.
    const anonymizedEmail = `deleted+${id}@deleted.lopay`;
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: { deletedAt: new Date(), email: anonymizedEmail },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.session.deleteMany({ where: { userId: id } }),
    ]);
    return user;
  }
}
