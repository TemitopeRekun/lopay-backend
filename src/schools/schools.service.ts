import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SchoolPaymentsService {
  constructor(private readonly prisma: PrismaService) {}

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
  async confirmPayment(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { enrollment: true },
    });

    if (!payment) throw new BadRequestException('Payment not found');
    if (payment.isConfirmed)
      throw new BadRequestException('Payment already confirmed');

    const enrollment = payment.enrollment;

    const newRemainingBalance = enrollment.remainingBalance - payment.amountPaid;
    const newStatus = newRemainingBalance === 0 ? 'COMPLETED' : 'ACTIVE';

    return this.prisma.$transaction([
      // 1️⃣ Mark payment as confirmed
      this.prisma.payment.update({
        where: { id: paymentId },
        data: { isConfirmed: true },
      }),

      // 2️⃣ Update enrollment
      this.prisma.childEnrollment.update({
        where: { id: enrollment.id },
        data: {
          remainingBalance: newRemainingBalance,
          paymentStatus: newStatus,
        },
      }),
    ]);
  }
}
