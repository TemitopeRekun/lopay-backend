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
  UserRole,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { phoneBlindIndex, canonicalizePhone } from '../common/phone';
import type { AuthUser } from '../common/types/auth-user';
import { CreateMigrationInviteDto } from './dto/create-migration-invite.dto';
import { Money } from '../common/money';
import { LedgerService } from '../ledger/ledger.service';
import { EventsGateway } from '../events/events.gateway';

type InviteToken = { token: string; hash: string };

@Injectable()
export class MigrationInvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ledger: LedgerService,
    private readonly events: EventsGateway,
  ) {}

  private token(): InviteToken {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: createHash('sha256').update(token).digest('hex') };
  }

  private inviteUrl(token: string): string {
    const origin = (
      this.config.get<string>('WEB_APP_URL') ??
      this.config.get<string>('CORS_ORIGINS')?.split(',')[0]
    )?.trim().replace(/\/$/, '');
    if (!origin) throw new BadRequestException('Web app URL is not configured');
    const path = `/claim-migration-invite?token=${encodeURIComponent(token)}`;
    return `${origin}${path}`;
  }

  private async assertParentMatchesInvite(
    invite: { parentPhoneHash: string },
    userId: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneHash: true },
    });
    if (!user) {
      throw new ForbiddenException('Parent account not found');
    }
    if (!user.phoneHash) {
      throw new ForbiddenException(
        'Your account does not have a verified WhatsApp number. Add and verify the invite phone number before claiming.',
      );
    }
    if (user.phoneHash !== invite.parentPhoneHash) {
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

    const amountPaid = Money.fromNaira(dto.amountPaid).toKobo();
    const classFee = await this.prisma.classFee.findFirst({
      where: { schoolId: actor.schoolId, className: dto.className.trim(), isActive: true },
      select: { feeAmount: true },
    });
    if (!classFee) throw new BadRequestException('No active fee exists for this class');
    const totalSchoolFee = Money.fromKobo(classFee.feeAmount).toKobo();
    if (amountPaid > totalSchoolFee) {
      throw new BadRequestException('Amount already paid cannot exceed the class fee');
    }
    if (dto.migrationDate > new Date()) {
      throw new BadRequestException('Migration date cannot be in the future');
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
      totalSchoolFee: Money.fromKobo(invite.totalSchoolFee).toNaira(),
      amountPaid: Money.fromKobo(invite.amountPaid).toNaira(),
      remainingBalance: Money.fromKobo(invite.totalSchoolFee - invite.amountPaid).toNaira(),
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
      const childIdentity = { parentId: parent.id, fullName: invite.studentName, className: invite.className };
      let child = await tx.child.findFirst({ where: childIdentity });
      if (!child) {
        try {
          child = await tx.child.create({ data: childIdentity });
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
          child = await tx.child.findFirst({ where: childIdentity });
          if (!child) throw error;
        }
      }
      const enrollment = await this.ledger.recordMigratedPayment(tx, {
        invite,
        childId: child.id,
        parentUserId: user.userId,
        actor: user,
      });
      const remainingBalance = enrollment.remainingBalance;

      return {
        enrollmentId: enrollment.id,
        studentName: invite.studentName,
        status: enrollment.paymentStatus,
        remainingBalance: Money.fromKobo(remainingBalance).toNaira(),
        planStartDate: invite.migrationDate,
      };
    });
    this.events.emitEnrollmentsChanged({
      parentUserId: user.userId,
      schoolId: invite.schoolId,
      notifyAdmins: true,
    });
    this.events.emitPaymentsChanged({
      parentUserId: user.userId,
      schoolId: invite.schoolId,
      notifyAdmins: true,
    });
    return result;
  }
}