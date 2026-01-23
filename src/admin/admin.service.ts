import { Injectable, BadRequestException } from '@nestjs/common';
import {
  PaymentType,
  PaymentReceiver,
  PaymentStatus,
} from '../../generated/client/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /** Get all first payments waiting to be settled */
  async getPendingFirstPayments() {
    return this.prisma.payment.findMany({
      where: {
        paymentType: PaymentType.FIRST_PAYMENT,
        receiver: PaymentReceiver.PLATFORM,
        isConfirmed: false,
      },
      include: {
        enrollment: {
          include: {
            child: true,
            school: true,
          },
        },
      },
    });
  }

  /** Settle school share and activate enrollment */
  async settleFirstPayment(paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        paymentType: PaymentType.FIRST_PAYMENT,
        receiver: PaymentReceiver.PLATFORM,
        isConfirmed: false,
      },
      include: {
        enrollment: {
          include: {
            school: true,
            child: {
              include: { parent: true },
            },
          },
        },
      },
    });

    if (!payment) {
      throw new BadRequestException('Payment not found or already settled');
    }

    const { enrollment } = payment;

    return this.prisma.$transaction([
      // 1️⃣ Mark payment as confirmed
      this.prisma.payment.update({
        where: { id: payment.id },
        data: { isConfirmed: true },
      }),

      // 2️⃣ Activate enrollment
      this.prisma.childEnrollment.update({
        where: { id: payment.enrollmentId },
        data: { paymentStatus: PaymentStatus.ACTIVE },
      }),

      // 3️⃣ Notify School Owner
      this.prisma.notification.create({
        data: {
          userId: enrollment.school.ownerId,
          title: 'First Payment Settled',
          message:
            'The platform has settled the first payment. Enrollment is now active.',
          link: `/school/enrollments/${enrollment.id}`,
        },
      }),

      // 4️⃣ Notify Parent
      this.prisma.notification.create({
        data: {
          userId: enrollment.child.parent.userId,
          title: 'Enrollment Confirmed',
          message: `Your first payment of ₦${payment.amountPaid} has been confirmed. Enrollment is active.`,
          link: `/parent/enrollments/${enrollment.id}`,
        },
      }),
    ]);
  }

  /** Platform revenue summary */
  async getPlatformRevenue() {
    const result = await this.prisma.payment.aggregate({
      where: {
        receiver: PaymentReceiver.PLATFORM,
        isConfirmed: true,
      },
      _sum: {
        platformAmount: true,
      },
    });

    return {
      totalRevenue: result._sum.platformAmount ?? 0,
    };
  }
}
