import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import {
  InstallmentFrequency,
  MigrationInviteStatus,
  PaymentReceiver,
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  UserRole,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { phoneBlindIndex, canonicalizePhone } from '../common/phone';
import type { AuthUser } from '../common/types/auth-user';
import { CreateMigrationInviteDto } from './dto/create-migration-invite.dto';

type InviteToken = { token: string; hash: string };

@Injectable()
export class MigrationInvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private token(): InviteToken {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: createHash('sha256').update(token).digest('hex') };
  }

  private inviteUrl(token: string): string {
    const origin = this.config.get<string>('WEB_APP_URL')?.replace(/\/$/, '');
    const path = `/migration-invites/claim?token=${encodeURIComponent(token)}`;
    return origin ? `${origin}${path}` : path;
  }

  private async assertParentMatchesInvite(
    invite: { parentPhoneHash: string },
    userId: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneHash: true },
    });
    if (!user || !user.phoneHash || user.phoneHash !== invite.parentPhoneHash) {
      throw new ForbiddenException(
        'This invite can only be claimed by the parent WhatsApp account it was issued to',
      );
    }
  }

  async create(dto: CreateMigrationInviteDto, actor: AuthUser) {
    if (!actor.schoolId || actor.role !== UserRole.SCHOOL_OWNER) {
      throw new ForbiddenException('Only a school owner can create migration invites');
    }
    const parentPhone = canonicalizePhone(dto.parentPhone);
    const parentPhoneHash = phoneBlindIndex(dto.parentPhone);
    if (!parentPhone || !parentPhoneHash) {
      throw new BadRequestException('A valid Nigerian WhatsApp number is required');
    }

    const totalSchoolFee = Math.round(dto.totalSchoolFee * 100);
    const amountPaid = Math.round(dto.amountPaid * 100);
    if (amountPaid > totalSchoolFee) {
      throw new BadRequestException('Amount already paid cannot exceed the class fee');
    }
    if (dto.termEndDate <= dto.migrationDate) {
      throw new BadRequestException('Term end date must be after the migration date');
    }

    const token = this.token();
    const expiresInDays = Math.min(dto.expiresInDays ?? 14, 30);
    const expiresAt = new Date(
      Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
    );
    const school = await this.prisma.school.findFirst({
      where: { id: actor.schoolId, ownerId: actor.userId, deletedAt: null },
      select: { id: true },
    });
    if (!school) throw new ForbiddenException('You can only use your own school');

    const invite = await this.prisma.migrationInvite.create({
      data: {
        schoolId: school.id,
        createdByUserId: actor.userId,
        studentName: dto.studentName.trim(),
        className: dto.className.trim(),
        totalSchoolFee,
        amountPaid,
        parentPhoneHash,
        installmentFrequency: dto.installmentFrequency,
        migrationDate: dto.migrationDate,
        termEndDate: dto.termEndDate,
        tokenHash: token.hash,
        expiresAt,
      },
    });

    return {
      id: invite.id,
      status: invite.status,
      expiresAt: invite.expiresAt,
      inviteUrl: this.inviteUrl(token.token),
      whatsappNumber: parentPhone,
      message: `Your school has prepared a Lopay migration invite for ${invite.studentName}. Open the link to review your previous payment and continue: ${this.inviteUrl(token.token)}`,
    };
  }

  private async findUsableInvite(rawToken: string) {
    if (!rawToken || rawToken.length < 32) {
      throw new NotFoundException('Migration invite not found');
    }
    const hash = createHash('sha256').update(rawToken).digest('hex');
    const invite = await this.prisma.migrationInvite.findUnique({
      where: { tokenHash: hash },
      include: { school: { select: { name: true } } },
    });
    if (!invite) throw new NotFoundException('Migration invite not found');
    if (invite.expiresAt <= new Date() && invite.status !== MigrationInviteStatus.CLAIMED) {
      await this.prisma.migrationInvite.updateMany({
        where: { id: invite.id, status: { in: [MigrationInviteStatus.CREATED, MigrationInviteStatus.DISPUTED] } },
        data: { status: MigrationInviteStatus.EXPIRED },
      });
      throw new BadRequestException('This migration invite has expired');
    }
    return { invite, hash };
  }

  async preview(rawToken: string) {
    const { invite } = await this.findUsableInvite(rawToken);
    return {
      id: invite.id,
      status: invite.status,
      studentName: invite.studentName,
      className: invite.className,
      schoolName: invite.school.name,
      totalSchoolFee: invite.totalSchoolFee / 100,
      amountPaid: invite.amountPaid / 100,
      remainingBalance: (invite.totalSchoolFee - invite.amountPaid) / 100,
      installmentFrequency: invite.installmentFrequency,
      migrationDate: invite.migrationDate,
      termEndDate: invite.termEndDate,
      requiresParentConfirmation: invite.status === MigrationInviteStatus.CREATED,
    };
  }

  async dispute(rawToken: string, user: AuthUser, reason: string) {
    const { invite } = await this.findUsableInvite(rawToken);
    await this.assertParentMatchesInvite(invite, user.userId);
    const result = await this.prisma.migrationInvite.updateMany({
      where: { id: invite.id, status: MigrationInviteStatus.CREATED },
      data: { status: MigrationInviteStatus.DISPUTED, disputeReason: reason.trim() },
    });
    if (result.count === 0) throw new BadRequestException('This invite is no longer awaiting confirmation');
    return { id: invite.id, status: MigrationInviteStatus.DISPUTED };
  }

  async claim(rawToken: string, user: AuthUser) {
    const { invite, hash } = await this.findUsableInvite(rawToken);
    await this.assertParentMatchesInvite(invite, user.userId);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.migrationInvite.updateMany({
        where: {
          id: invite.id,
          tokenHash: hash,
          status: MigrationInviteStatus.CREATED,
          expiresAt: { gt: new Date() },
        },
        data: {
          status: MigrationInviteStatus.CLAIMED,
          claimedByUserId: user.userId,
          claimedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('This migration invite has already been claimed or disputed');
      }

      const account = await tx.user.findUniqueOrThrow({
        where: { id: user.userId },
        select: { phoneNumber: true },
      });
      const parent = await tx.parent.upsert({
        where: { userId: user.userId },
        update: {},
        create: { userId: user.userId, phoneNumber: account.phoneNumber ?? '' },
      });
      const child = await tx.child.create({
        data: {
          parentId: parent.id,
          fullName: invite.studentName,
          className: invite.className,
        },
      });
      const remainingBalance = invite.totalSchoolFee - invite.amountPaid;
      const enrollment = await tx.childEnrollment.create({
        data: {
          childId: child.id,
          schoolId: invite.schoolId,
          migrationInviteId: invite.id,
          className: invite.className,
          totalSchoolFee: invite.totalSchoolFee,
          platformFee: 0,
          schoolMinimumFee: 0,
          firstPaymentPaid: invite.amountPaid,
          remainingBalance,
          paymentStatus: remainingBalance === 0 ? PaymentStatus.COMPLETED : PaymentStatus.ACTIVE,
          installmentFrequency: invite.installmentFrequency,
          termStartDate: invite.migrationDate,
          termEndDate: invite.termEndDate,
        },
      });
      await tx.payment.create({
        data: {
          enrollmentId: enrollment.id,
          schoolId: invite.schoolId,
          amountPaid: invite.amountPaid,
          platformAmount: 0,
          schoolAmount: invite.amountPaid,
          receiver: PaymentReceiver.SCHOOL,
          paymentType: PaymentType.MIGRATED_PAYMENT,
          status: PaymentTransactionStatus.SUCCESS,
          isConfirmed: true,
          paymentDate: invite.migrationDate,
        },
      });

      return {
        enrollmentId: enrollment.id,
        studentName: invite.studentName,
        status: enrollment.paymentStatus,
        remainingBalance: remainingBalance / 100,
        planStartDate: invite.migrationDate,
      };
    });
  }
}