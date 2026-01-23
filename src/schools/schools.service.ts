import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { PaymentStatus } from '../../generated/client/client';

@Injectable()
export class SchoolPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

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
