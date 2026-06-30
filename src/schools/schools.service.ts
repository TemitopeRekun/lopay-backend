import {
  Injectable,
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

  async getDashboardStats(schoolId: string) {
    const db = this.prisma.withTenant(schoolId);
    const [totalStudents, confirmedPayments, pendingPayments, enrollments] =
      await Promise.all([
        // 1. Total Enrolled Students
        db.childEnrollment.count({}),

        // 2. Confirmed Payments (School Revenue)
        this.prisma.payment.aggregate({
          where: { schoolId, isConfirmed: true },
          _sum: { schoolAmount: true },
        }),

        // 3. Pending Payments — sum the SCHOOL's share, not the gross deposit.
        // For first payments amountPaid includes the 2.5% platform fee, which is
        // not owed to the school; schoolAmount is the school's actual share.
        this.prisma.payment.aggregate({
          where: { schoolId, isConfirmed: false },
          _sum: { schoolAmount: true },
        }),

        // 4. Defaulted Amount (from defaulted enrollments)
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
      pendingPayments._sum.schoolAmount || 0,
    ).toNaira();
    const defaultedAmount = Money.fromKobo(
      enrollments.reduce((sum, e) => sum + e.remainingBalance, 0),
    ).toNaira();

    return {
      totalStudents,
      totalRevenue,
      pendingRevenue,
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
        id: enrollment.childId,
        studentName: enrollment.child.fullName,
        childName: enrollment.child.fullName,
        className: enrollment.className,
        parentName: enrollment.child.parent.user.fullName || 'Unknown',
        totalFee: Money.fromKobo(enrollment.totalSchoolFee).toNaira(),
        paidAmount: Money.fromKobo(paidAmount).toNaira(),
        paymentStatus: enrollment.paymentStatus,
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
  ) {
    const cappedTake = Math.min(take, 200);
    const baseWhere: Prisma.PaymentWhereInput =
      receiptType !== 'ALL' ? { paymentType: receiptType as PaymentType } : {};

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

  async getPendingPayments(
    schoolId: string,
    includeReceiptSignedUrls = false,
    receiptType: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT' = 'ALL',
    take = 100,
  ) {
    const cappedTake = Math.min(take, 200);
    const payments = await this.prisma.withTenant(schoolId).payment.findMany({
      where: {
        isConfirmed: false,
        paymentType: 'INSTALLMENT',
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
