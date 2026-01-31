import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentStatus } from '../../generated/client/client';

@Injectable()
export class SchoolPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async createClassFee(schoolId: string, className: string, feeAmount: number) {
    // Check if fee already exists for this class
    const existingFee = await this.prisma.classFee.findFirst({
      where: {
        schoolId,
        className,
      },
    });

    if (existingFee) {
      // Update existing fee
      return this.prisma.classFee.update({
        where: { id: existingFee.id },
        data: { feeAmount, isActive: true },
      });
    }

    // Create new fee
    return this.prisma.classFee.create({
      data: {
        schoolId,
        className,
        feeAmount,
      },
    });
  }

  async getClassFees(schoolId: string) {
    return this.prisma.classFee.findMany({
      where: { schoolId, isActive: true },
      orderBy: { className: 'asc' },
    });
  }

  async getDashboardStats(schoolId: string) {
    const [
      totalStudents,
      confirmedPayments,
      pendingPayments,
      enrollments,
    ] = await Promise.all([
      // 1. Total Enrolled Students
      this.prisma.childEnrollment.count({
        where: { schoolId },
      }),

      // 2. Confirmed Payments (Revenue)
      this.prisma.payment.aggregate({
        where: { schoolId, isConfirmed: true },
        _sum: { amountPaid: true },
      }),

      // 3. Pending Payments
      this.prisma.payment.aggregate({
        where: { schoolId, isConfirmed: false },
        _sum: { amountPaid: true },
      }),

      // 4. Defaulted Amount (from defaulted enrollments)
      this.prisma.childEnrollment.findMany({
        where: { schoolId, paymentStatus: PaymentStatus.DEFAULTED },
        select: { remainingBalance: true },
      }),
    ]);

    const totalRevenue = confirmedPayments._sum.amountPaid || 0;
    const pendingRevenue = pendingPayments._sum.amountPaid || 0;
    const defaultedAmount = enrollments.reduce(
      (sum, e) => sum + e.remainingBalance,
      0,
    );

    return {
      totalStudents,
      totalRevenue,
      pendingRevenue,
      defaultedAmount,
    };
  }

  async getStudents(schoolId: string, className?: string, search?: string) {
    const whereClause: any = { schoolId };
    if (className) {
      whereClause.className = className;
    }

    if (search) {
      whereClause.OR = [
        // Search by Child Name
        { child: { fullName: { contains: search, mode: 'insensitive' } } },
        // Search by Parent Email
        { child: { parent: { user: { email: { contains: search, mode: 'insensitive' } } } } },
        // Search by Parent Phone
        { child: { parent: { phoneNumber: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    return this.prisma.childEnrollment.findMany({
      where: whereClause,
      include: {
        child: { include: { parent: { include: { user: true } } } },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  /** Fetch all pending payments for a school */
  async getPendingPayments(schoolId: string) {
    return this.prisma.payment.findMany({
      where: {
        schoolId,
        isConfirmed: false,
      },
      include: {
        enrollment: true,
        school: true,
      },
      orderBy: {
        paymentDate: 'desc',
      },
    });
  }

  /** Confirm a pending installment payment */
  async confirmPayment(paymentId: string, schoolId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, schoolId },
      include: { enrollment: true },
    });

    if (!payment) throw new BadRequestException('Payment not found');
    if (payment.isConfirmed)
      throw new BadRequestException('Payment already confirmed');

    const enrollment = payment.enrollment;

    // Fetch child to get parent info for notification
    const child = await this.prisma.child.findUnique({
      where: { id: enrollment.childId },
      include: { parent: true },
    });

    if (!child) throw new BadRequestException('Child record not found');

    const newRemainingBalance =
      enrollment.remainingBalance - payment.amountPaid;
    const newStatus =
      newRemainingBalance === 0
        ? PaymentStatus.COMPLETED
        : PaymentStatus.ACTIVE;

    return this.prisma.$transaction(async (tx) => {
      // 1️⃣ Mark payment as confirmed
      await tx.payment.update({
        where: { id: paymentId },
        data: { isConfirmed: true },
      });

      // 2️⃣ Update enrollment
      await tx.childEnrollment.update({
        where: { id: enrollment.id },
        data: {
          remainingBalance: newRemainingBalance,
          paymentStatus: newStatus,
        },
      });

      // 3️⃣ Notify Parent
      await tx.notification.create({
        data: {
          userId: child.parent.userId,
          title: 'Payment Confirmed',
          message: `Your payment of ₦${payment.amountPaid} has been confirmed by the school.`,
          link: `/parent/payments`,
        },
      });
    });
  }

  async markEnrollmentAsDefaulted(enrollmentId: string, schoolId: string) {
    const enrollment = await this.prisma.childEnrollment.findFirst({
      where: { id: enrollmentId, schoolId },
    });

    if (!enrollment) throw new BadRequestException('Not found');

    if (enrollment.remainingBalance <= 0) {
      throw new BadRequestException('Cannot default a completed enrollment');
    }

    // Fetch the child to get the parent user ID
    const child = await this.prisma.child.findUnique({
      where: { id: enrollment.childId },
      include: { parent: true },
    });

    if (!child || !child.parent) {
      throw new BadRequestException('Parent user not found');
    }

    const parentUserId = child.parent.userId;

    return this.prisma.$transaction(async (tx) => {
      await tx.childEnrollment.update({
        where: { id: enrollmentId },
        data: { paymentStatus: PaymentStatus.DEFAULTED },
      });

      await tx.notification.create({
        data: {
          userId: parentUserId,
          title: 'Payment Defaulted',
          message:
            'Your child’s payment plan has been marked as defaulted. Please contact the school.',
        },
      });
    });
  }
}
