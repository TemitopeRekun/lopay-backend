import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PaymentStatus,
  UserRole,
  PaymentTransactionStatus,
  PaymentType,
  Prisma,
} from '../generated/prisma/client';
import { CreateSchoolDto } from '../admin/dto/create.school.dto';
import { UpdateSchoolDto } from './dto/update.school.dto';
import { DocumentsService } from '../documents/documents.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService, AuditActor } from '../audit/audit.service';
import { LedgerService } from '../ledger/ledger.service';
import { SchoolOnboardingService } from '../school-onboarding/school-onboarding.service';
import { Money } from '../common/money';
import { paymentCommonFields } from '../common/payment-dto';
import { CacheService, CacheKeys } from '../cache/cache.service';

@Injectable()
export class SchoolPaymentsService {
  private readonly logger = new Logger(SchoolPaymentsService.name);
  // Class fees change rarely; cache longer and invalidate explicitly on write.
  private static readonly CLASS_FEES_TTL_SECONDS = 5 * 60;
  // Ceiling for a single history page. A month's collection ledger for a large
  // school is legitimately bigger than a screenful, and the caller is told when
  // it hits the cap rather than silently receiving a truncated export.
  static readonly HISTORY_MAX_TAKE = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly documentsService: DocumentsService,
    private readonly events: EventsGateway,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly onboarding: SchoolOnboardingService,
    private readonly cache: CacheService,
  ) {}

  /** Thin caller — provisioning saga lives in SchoolOnboardingService (Milestone 3). */
  async createSchool(dto: CreateSchoolDto) {
    const { school, user } = await this.onboarding.provisionSchoolAndOwner(dto);
    return {
      school,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        fullName: user.fullName,
      },
      message: 'School and School Owner created successfully',
    };
  }

  async updateSchool(id: string, dto: UpdateSchoolDto) {
    const school = await this.prisma.school.findFirst({
      where: { id, deletedAt: null },
    });
    if (!school) throw new NotFoundException('School not found');

    return this.prisma.school.update({
      where: { id },
      data: {
        name: dto.schoolName,
        address: dto.address,
        phone: dto.phone,
        bankName: dto.bankName,
        accountName: dto.accountName,
        accountNumber: dto.accountNumber,
      },
    });
  }

  async getSchoolBankDetails(
    schoolId: string,
    user: { userId: string; role: UserRole; schoolId?: string | null },
  ) {
    // Bank account details are sensitive (fraud/redirection risk). Restrict to:
    // the owning school owner, a super admin, or a parent who actually has an
    // enrollment at this school — so they can't be mass-harvested by iterating
    // schoolIds.
    if (user.role === UserRole.SCHOOL_OWNER) {
      if (user.schoolId !== schoolId) {
        throw new ForbiddenException(
          'You can only view your own school details',
        );
      }
    } else if (user.role === UserRole.PARENT) {
      const hasEnrollment = await this.prisma.childEnrollment.findFirst({
        where: { schoolId, child: { parent: { userId: user.userId } } },
        select: { id: true },
      });
      if (!hasEnrollment) {
        throw new ForbiddenException(
          'You can only view bank details for a school you are enrolled with',
        );
      }
    } else if (user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Not authorized to view bank details');
    }

    const school = await this.prisma.school.findFirst({
      where: { id: schoolId, deletedAt: null },
      select: {
        bankName: true,
        accountName: true,
        accountNumber: true,
      },
    });

    if (!school) {
      throw new NotFoundException('School not found');
    }

    return school;
  }

  async updateSchoolBankDetails(schoolId: string, dto: UpdateSchoolDto) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
    });
    if (!school) {
      throw new NotFoundException('School not found');
    }

    return this.prisma.school.update({
      where: { id: schoolId },
      data: {
        bankName: dto.bankName,
        accountName: dto.accountName,
        accountNumber: dto.accountNumber,
      },
    });
  }

  async deleteSchool(id: string) {
    const school = await this.prisma.school.findFirst({
      where: { id, deletedAt: null },
    });
    if (!school) throw new NotFoundException('School not found');

    // Soft-delete the school AND free its owner so the same person can be
    // re-onboarded later. `School.ownerId` and `User.email` are both unique; if
    // we only set `school.deletedAt`, the dangling owner row keeps the email +
    // ownerId reserved and a fresh onboarding with the same email collides.
    // Mirror UsersService.remove: anonymize the owner's email, soft-delete the
    // owner, and revoke their sessions (a deleted school's owner must lose
    // access). This is why M2 needs no partial-unique migration — anonymization
    // frees the constraint without dropping the unique that auth.config's
    // `school.findUnique({ where: { ownerId } })` relies on.
    const anonymizedEmail = `deleted+${school.ownerId}@deleted.lopay`;
    const [updated] = await this.prisma.$transaction([
      this.prisma.school.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: school.ownerId },
        data: { deletedAt: new Date(), email: anonymizedEmail },
      }),
      this.prisma.session.deleteMany({ where: { userId: school.ownerId } }),
    ]);
    return updated;
  }

  /**
   * Public school directory (unauthenticated `GET /schools`). Returns ONLY the
   * fields a parent needs to pick a school — `{ id, name }`. School email,
   * address and phone are PII and must not be harvestable from an open endpoint
   * (search is by name only, for the same reason). Authenticated/admin callers
   * that need the full record use `getAllSchools`.
   */
  async getPublicSchools(search?: string) {
    const where: Prisma.SchoolWhereInput = { deletedAt: null };
    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }
    return this.prisma.school.findMany({
      where,
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async getAllSchools(search?: string) {
    this.logger.log(`getAllSchools called with search: "${search ?? ''}"`);
    const where: Prisma.SchoolWhereInput = { deletedAt: null };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const schools = await this.prisma.school.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        address: true,
        phone: true,
      },
      orderBy: { name: 'asc' },
    });
    this.logger.log(`getAllSchools found ${schools.length} schools`);
    return schools;
  }

  async createClassFee(schoolId: string, className: string, feeAmount: number) {
    const feeKobo = Money.fromNaira(feeAmount).toKobo();
    const db = this.prisma.withTenant(schoolId);
    const existingFee = await db.classFee.findFirst({ where: { className } });

    // Invalidate the cached fee list for this school — the next read repopulates.
    await this.cache.del(CacheKeys.classFees(schoolId));

    if (existingFee) {
      return this.prisma.classFee.update({
        where: { id: existingFee.id },
        data: { feeAmount: feeKobo, isActive: true },
      });
    }

    return this.prisma.classFee.create({
      data: { schoolId, className, feeAmount: feeKobo },
    });
  }

  /**
   * Upsert a whole fee schedule in one transaction.
   *
   * The client used to POST one class at a time, sleeping 2.5s between each to
   * dodge the throttle — roughly 37 seconds for a fifteen-class school, with a
   * partially-written schedule if the parent closed the tab midway. A school
   * setting up for the first time has to publish its whole schedule at once, so
   * this takes the full set and applies it atomically: either the schedule
   * lands or nothing does.
   *
   * The payload is the school's COMPLETE schedule, not a patch: any class the
   * school dropped is deactivated in the same transaction. Upserting alone would
   * leave a removed class `isActive` — `getClassFees` filters on that flag, so
   * parents would keep seeing it and could still enrol at the old price, which is
   * exactly the mistake this method exists to prevent.
   *
   * Deactivation is a soft delete: enrolments snapshot `className` and
   * `totalSchoolFee` at signing, so existing plans are untouched and keep the fee
   * they agreed. Removing a class only stops NEW enrolments, and re-adding the
   * class later revives it.
   *
   * `withTenant` does not apply inside `$transaction` (tx is a raw client), so
   * every write here carries `schoolId` explicitly.
   */
  async setClassFees(
    schoolId: string,
    fees: { className: string; feeAmount: number }[],
  ) {
    // Same class twice in one payload would make the result order-dependent.
    const seen = new Set<string>();
    for (const fee of fees) {
      const key = fee.className.trim().toLowerCase();
      if (seen.has(key)) {
        throw new BadRequestException(
          `Duplicate class name in payload: ${fee.className}`,
        );
      }
      seen.add(key);
    }

    const normalized = fees.map((fee) => ({
      className: fee.className.trim(),
      feeAmount: Money.fromNaira(fee.feeAmount).toKobo(),
    }));

    const keptNames = normalized.map((fee) => fee.className);

    await this.prisma.$transaction([
      // Retire anything the school left out of this schedule, before writing the
      // set it kept. The two groups are disjoint, so ordering is only for clarity.
      this.prisma.classFee.updateMany({
        where: {
          schoolId,
          isActive: true,
          className: { notIn: keptNames },
        },
        data: { isActive: false },
      }),
      ...normalized.map((fee) =>
        this.prisma.classFee.upsert({
          where: {
            schoolId_className: { schoolId, className: fee.className },
          },
          create: {
            schoolId,
            className: fee.className,
            feeAmount: fee.feeAmount,
          },
          update: { feeAmount: fee.feeAmount, isActive: true },
        }),
      ),
    ]);

    // Invalidate after the commit — a read racing an aborted tx must not cache
    // fees that were rolled back.
    await this.cache.del(CacheKeys.classFees(schoolId));

    this.logger.log(
      `School ${schoolId} published ${normalized.length} class fee(s)`,
    );

    return this.getClassFees(schoolId);
  }

  async getClassFees(schoolId: string) {
    return this.cache.getOrSet(
      CacheKeys.classFees(schoolId),
      SchoolPaymentsService.CLASS_FEES_TTL_SECONDS,
      async () => {
        const fees = await this.prisma.withTenant(schoolId).classFee.findMany({
          where: { isActive: true },
          orderBy: { className: 'asc' },
        });
        return fees.map((f) => ({
          ...f,
          feeAmount: Money.fromKobo(f.feeAmount).toNaira(),
        }));
      },
    );
  }

  /**
   * Dashboard headline figures.
   *
   * Every "pending" figure is filtered on `status: PENDING`, not on
   * `isConfirmed: false` alone. Rejection sets FAILED and reversal sets
   * REVERSED — both leave `isConfirmed` false, so an unfiltered query counted
   * money the owner had already declined (or clawed back) as still awaiting
   * them, forever, with nothing in the approval queue to clear it.
   *
   * The two pending buckets are also kept apart because they need different
   * actions: `pendingRevenue` is installments the owner approves themselves,
   * `awaitingActivation` is first payments that the platform settles.
   */
  async getDashboardStats(schoolId: string) {
    const db = this.prisma.withTenant(schoolId);
    const [
      totalStudents,
      activeStudents,
      confirmedPayments,
      pendingInstallments,
      pendingFirstPayments,
      defaultedEnrollments,
    ] = await Promise.all([
      // 1. Total Enrolled Students
      db.childEnrollment.count({}),

      // 2. Active plans — the count behind the dashboard's "Active Plans" tile.
      db.childEnrollment.count({
        where: { paymentStatus: PaymentStatus.ACTIVE },
      }),

      // 3. Confirmed Payments (School Revenue)
      this.prisma.payment.aggregate({
        where: {
          schoolId,
          isConfirmed: true,
          status: PaymentTransactionStatus.SUCCESS,
        },
        _sum: { schoolAmount: true },
      }),

      // 4. Installments awaiting the owner's approval — sum the SCHOOL's share,
      // not the gross deposit. For first payments amountPaid includes the 2.5%
      // platform fee, which is not owed to the school.
      this.prisma.payment.aggregate({
        where: {
          schoolId,
          isConfirmed: false,
          status: PaymentTransactionStatus.PENDING,
          paymentType: PaymentType.INSTALLMENT,
        },
        _sum: { schoolAmount: true },
      }),

      // 5. First payments taken but not yet settled/activated by the platform.
      this.prisma.payment.aggregate({
        where: {
          schoolId,
          isConfirmed: false,
          status: PaymentTransactionStatus.PENDING,
          paymentType: PaymentType.FIRST_PAYMENT,
        },
        _sum: { schoolAmount: true },
      }),

      // 6. Defaulted Amount (from defaulted enrollments)
      db.childEnrollment.findMany({
        where: { paymentStatus: PaymentStatus.DEFAULTED },
        select: { remainingBalance: true },
      }),
    ]);

    // DB stores kobo; return Naira for API consumers.
    const totalRevenue = Money.fromKobo(
      confirmedPayments._sum.schoolAmount || 0,
    ).toNaira();
    const pendingRevenue = Money.fromKobo(
      pendingInstallments._sum.schoolAmount || 0,
    ).toNaira();
    const awaitingActivation = Money.fromKobo(
      pendingFirstPayments._sum.schoolAmount || 0,
    ).toNaira();
    const defaultedAmount = Money.fromKobo(
      defaultedEnrollments.reduce((sum, e) => sum + e.remainingBalance, 0),
    ).toNaira();

    return {
      totalStudents,
      activeStudents,
      totalRevenue,
      pendingRevenue,
      awaitingActivation,
      defaultedAmount,
    };
  }

  async getStudents(
    schoolId: string,
    className?: string,
    search?: string,
    page = 1,
    limit = 50,
  ) {
    const take = Math.min(limit, 200);
    const skip = (page - 1) * take;
    const db = this.prisma.withTenant(schoolId);
    const whereClause: Prisma.ChildEnrollmentWhereInput = {};
    if (className) {
      whereClause.className = className;
    }
    if (search) {
      whereClause.OR = [
        { child: { fullName: { contains: search, mode: 'insensitive' } } },
        {
          child: {
            parent: {
              user: { fullName: { contains: search, mode: 'insensitive' } },
            },
          },
        },
      ];
    }

    const [enrollments, total] = await Promise.all([
      db.childEnrollment.findMany({
        where: whereClause,
        include: {
          child: { include: { parent: { include: { user: true } } } },
          payments: { orderBy: { paymentDate: 'desc' } },
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      db.childEnrollment.count({ where: whereClause }),
    ]);

    const items = enrollments.map((enrollment) => {
      const confirmedPayments = enrollment.payments.filter(
        (p) => p.isConfirmed,
      );
      const paidAmount = confirmedPayments.reduce(
        (sum, p) => sum + p.amountPaid,
        0,
      );
      // Installments submitted but not yet approved are already spoken for, so
      // they can't be offered again — same rule the parent-side enrichment uses.
      const reservedKobo = enrollment.payments
        .filter(
          (p) =>
            p.paymentType === PaymentType.INSTALLMENT &&
            p.status === PaymentTransactionStatus.PENDING &&
            !p.isConfirmed,
        )
        .reduce((sum, p) => sum + p.amountPaid, 0);

      // Calculate next due date (simplified logic)
      let nextDueDate: Date | null = null;
      if (enrollment.remainingBalance > 0 && confirmedPayments.length > 0) {
        const lastPayment = confirmedPayments[0];
        const lastDate = new Date(lastPayment.paymentDate);
        if (enrollment.installmentFrequency === 'WEEKLY') {
          lastDate.setDate(lastDate.getDate() + 7);
        } else {
          lastDate.setMonth(lastDate.getMonth() + 1);
        }
        nextDueDate = lastDate;
      } else if (enrollment.remainingBalance > 0) {
        // If no payments yet, due date is start date
        nextDueDate = enrollment.termStartDate;
      }

      return {
        // The enrollment is the addressable entity for every owner action
        // (confirm / default / reverse) and matches what the parent-side
        // enrollment DTO calls `id`. `childId` is kept alongside it rather
        // than standing in for it.
        id: enrollment.id,
        enrollmentId: enrollment.id,
        childId: enrollment.childId,
        studentName: enrollment.child.fullName,
        childName: enrollment.child.fullName,
        className: enrollment.className,
        schoolId: enrollment.schoolId,
        parentName: enrollment.child.parent.user.fullName || 'Unknown',
        totalFee: Money.fromKobo(enrollment.totalSchoolFee).toNaira(),
        paidAmount: Money.fromKobo(paidAmount).toNaira(),
        // Authoritative outstanding figure. Clients used to derive
        // `totalFee - paidAmount`, which is short by the platform fee baked
        // into the first payment (paidAmount is gross, the fee never reduced
        // the school-fee balance).
        remainingBalance: Money.fromKobo(enrollment.remainingBalance).toNaira(),
        availableBalance: Money.fromKobo(
          Math.max(0, enrollment.remainingBalance - reservedKobo),
        ).toNaira(),
        paymentStatus: enrollment.paymentStatus,
        installmentFrequency: enrollment.installmentFrequency,
        nextDueDate: nextDueDate
          ? nextDueDate.toISOString().split('T')[0]
          : null,
        avatarUrl: null,
      };
    });

    return {
      items,
      total,
      page,
      limit: take,
      totalPages: Math.ceil(total / take),
    };
  }

  async getHistory(
    schoolId: string,
    includeReceiptSignedUrls = false,
    receiptType: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT' = 'ALL',
    take = 100,
    range?: { from?: Date; to?: Date },
  ) {
    const cappedTake = Math.min(take, SchoolPaymentsService.HISTORY_MAX_TAKE);
    const baseWhere: Prisma.PaymentWhereInput =
      receiptType !== 'ALL' ? { paymentType: receiptType as PaymentType } : {};

    // Date window for period exports (the owner's monthly collection ledger).
    if (range?.from || range?.to) {
      baseWhere.paymentDate = {
        ...(range.from ? { gte: range.from } : {}),
        ...(range.to ? { lte: range.to } : {}),
      };
    }

    const payments = await this.prisma.withTenant(schoolId).payment.findMany({
      where: baseWhere,
      include: {
        enrollment: {
          include: {
            child: true,
            school: true,
          },
        },
      },
      orderBy: { paymentDate: 'desc' },
      take: cappedTake,
    });

    const toPaymentDto = (
      payment: (typeof payments)[0],
      receiptSignedUrl?: string | null,
    ) => ({
      id: payment.id,
      schoolId: payment.schoolId,
      date: payment.paymentDate,
      paymentDate: payment.paymentDate,
      ...paymentCommonFields(payment),
      childName: payment.enrollment.child.fullName,
      type: payment.paymentType,
      paymentType: payment.paymentType,
      status: payment.status,
      receiptUrl: payment.receiptUrl,
      ...(receiptSignedUrl !== undefined ? { receiptSignedUrl } : {}),
    });

    if (!includeReceiptSignedUrls) {
      return payments.map((payment) => toPaymentDto(payment));
    }

    const shouldSign = (paymentType: string) =>
      receiptType === 'ALL' || paymentType === receiptType;

    const enriched = await Promise.all(
      payments.map(async (payment) => {
        let receiptSignedUrl: string | null = null;
        if (payment.receiptUrl && shouldSign(payment.paymentType)) {
          try {
            receiptSignedUrl = (
              await this.documentsService.createSignedUrlForPath(
                payment.receiptUrl,
              )
            ).signedUrl;
          } catch {
            receiptSignedUrl = null;
          }
        }

        return toPaymentDto(payment, receiptSignedUrl);
      }),
    );

    return enriched;
  }

  /**
   * The owner's approval queue.
   *
   * Defaults to installments — the only thing a school owner can approve
   * themselves — but `paymentType` can widen it to the first payments that are
   * awaiting platform settlement, so a caller can reconcile the queue against
   * the dashboard's pending figures.
   */
  async getPendingPayments(
    schoolId: string,
    includeReceiptSignedUrls = false,
    receiptType: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT' = 'ALL',
    take = 100,
    paymentType: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT' = 'INSTALLMENT',
  ) {
    const cappedTake = Math.min(take, 200);
    const payments = await this.prisma.withTenant(schoolId).payment.findMany({
      where: {
        isConfirmed: false,
        ...(paymentType === 'ALL'
          ? {}
          : { paymentType: paymentType as PaymentType }),
        status: PaymentTransactionStatus.PENDING,
      },
      take: cappedTake,
      include: {
        enrollment: {
          include: {
            child: true,
            school: true,
          },
        },
      },
    });

    const toPendingDto = (
      p: (typeof payments)[0],
      receiptSignedUrl?: string | null,
    ) => ({
      ...p,
      date: p.paymentDate,
      ...paymentCommonFields(p),
      platformAmount: Money.fromKobo(p.platformAmount).toNaira(),
      schoolAmount: Money.fromKobo(p.schoolAmount).toNaira(),
      childName: p.enrollment?.child?.fullName,
      ...(receiptSignedUrl !== undefined ? { receiptSignedUrl } : {}),
    });

    if (!includeReceiptSignedUrls) {
      return payments.map((p) => toPendingDto(p));
    }

    const shouldSign = (paymentType: string) =>
      receiptType === 'ALL' || paymentType === receiptType;

    const enriched = await Promise.all(
      payments.map(async (p) => {
        let receiptSignedUrl: string | null = null;
        if (p.receiptUrl && shouldSign(p.paymentType)) {
          try {
            receiptSignedUrl = (
              await this.documentsService.createSignedUrlForPath(p.receiptUrl)
            ).signedUrl;
          } catch {
            receiptSignedUrl = null;
          }
        }

        return toPendingDto(p, receiptSignedUrl);
      }),
    );

    return enriched;
  }

  /** Thin caller — the money-state logic lives in LedgerService (Milestone 3). */
  async confirmPayment(paymentId: string, schoolId: string, actor: AuditActor) {
    return this.ledger.confirmPayment(paymentId, schoolId, actor);
  }

  /** Thin caller — see LedgerService (Milestone 3). */
  async rejectPayment(paymentId: string, schoolId: string, actor: AuditActor) {
    return this.ledger.rejectPayment(paymentId, schoolId, actor);
  }

  /** Thin caller — defaulting logic lives in LedgerService (Milestone 3). */
  async markEnrollmentAsDefaulted(
    enrollmentId: string,
    schoolId: string,
    actor: AuditActor,
  ) {
    return this.ledger.markEnrollmentAsDefaulted(enrollmentId, schoolId, actor);
  }

  /**
   * Reverse a previously-confirmed installment payment (auditable undo).
   * Restores the enrollment balance, marks the payment REVERSED, and records
   * the reason in the audit log. First-payment reversals are intentionally not
   * supported here — they change the enrollment lifecycle and need their own
   * flow.
   */
  async reversePayment(
    paymentId: string,
    schoolId: string,
    actor: AuditActor,
    reason?: string,
  ) {
    return this.ledger.reversePayment(paymentId, schoolId, actor, reason);
  }
}
