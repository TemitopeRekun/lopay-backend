import { Injectable, BadRequestException } from '@nestjs/common';
import {
  PaymentStatus,
  PaymentType,
  PaymentReceiver,
} from '../../generated/client/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEnrollmentDto } from './dto/create.enrollment.dto';
import { PaymentService } from '../payments/payment.service';
import { NotificationsService } from 'src/notifications/notifications.service';

@Injectable()
export class EnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async enrollChild(dto: CreateEnrollmentDto) {
    return this.prisma.$transaction(async (tx) => {
      // 1️⃣ Fetch class fee
      const classFee = await tx.classFee.findFirst({
        where: {
          schoolId: dto.schoolId,
          className: dto.className,
          isActive: true,
        },
      });

      const school = await tx.school.findUnique({
        where: { id: dto.schoolId },
        select: { ownerId: true },
      });

      if (!school) {
        throw new BadRequestException('School not found');
      }

      if (!classFee) {
        throw new BadRequestException('Invalid or inactive class selected');
      }

      const schoolFees = classFee.feeAmount;

      // 2️⃣ Calculate deposit & validate
      const depositResult = this.paymentService.calculateInitialPayment(
        schoolFees,
        dto.firstPaymentPaid,
      );

      // 3️⃣ Create enrollment (snapshot)
      const enrollment = await tx.childEnrollment.create({
        data: {
          childId: dto.childId,
          schoolId: dto.schoolId,
          className: dto.className,

          totalSchoolFee: schoolFees,
          platformFee: Math.floor(depositResult.platformFee),
          schoolMinimumFee: Math.floor(schoolFees * 0.25),

          firstPaymentPaid: dto.firstPaymentPaid,
          remainingBalance: depositResult.remainingBalance,

          paymentStatus: PaymentStatus.PENDING,

          installmentFrequency: dto.installmentFrequency,
          termStartDate: dto.termStartDate,
          termEndDate: dto.termEndDate,
        },
      });

      // 4️⃣ Create FIRST payment record
      await tx.payment.create({
        data: {
          enrollmentId: enrollment.id,
          schoolId: dto.schoolId,

          amountPaid: dto.firstPaymentPaid,
          platformAmount: Math.floor(depositResult.platformFee),
          schoolAmount: Math.floor(depositResult.amountToSchool),

          paymentType: PaymentType.FIRST_PAYMENT,
          receiver: PaymentReceiver.PLATFORM,
          isConfirmed: false,
        },
      });

      // Use tx to ensure notification is only created if enrollment succeeds
      await tx.notification.create({
        data: {
          userId: school.ownerId,
          title: 'New Enrollment Payment',
          message: `A parent made a first payment of ₦${dto.firstPaymentPaid}. Awaiting confirmation.`,
          link: `/school/enrollments/${enrollment.id}`,
        },
      });

      return enrollment;
    });
  }

  async submitInstallmentPayment(enrollmentId: string, amountPaid: number) {
    const enrollment = await this.prisma.childEnrollment.findUnique({
      where: { id: enrollmentId },
    });

    if (!enrollment) {
      throw new BadRequestException('Enrollment not found');
    }

    const school = await this.prisma.school.findUnique({
      where: { id: enrollment.schoolId },
      select: { ownerId: true },
    });

    if (!school) {
      throw new BadRequestException('School not found');
    }

    if (enrollment.paymentStatus === PaymentStatus.COMPLETED) {
      throw new BadRequestException('Enrollment already completed');
    }

    if (amountPaid > enrollment.remainingBalance) {
      throw new BadRequestException('Amount exceeds remaining balance');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1️⃣ Create unconfirmed payment
      await tx.payment.create({
        data: {
          enrollmentId: enrollment.id,
          schoolId: enrollment.schoolId,
          amountPaid,
          platformAmount: 0,
          schoolAmount: amountPaid,
          paymentType: PaymentType.INSTALLMENT,
          receiver: PaymentReceiver.SCHOOL,
          isConfirmed: false,
        },
      });

      // 2️⃣ Lock enrollment while pending confirmation
      await tx.childEnrollment.update({
        where: { id: enrollment.id },
        data: {
          paymentStatus: PaymentStatus.PENDING,
        },
      });

      // 3️⃣ Notify School Owner (Scoped to transaction)
      await tx.notification.create({
        data: {
          userId: school.ownerId,
          title: 'Installment Payment Submitted',
          message: `An installment payment of ₦${amountPaid} has been submitted and needs confirmation.`,
          link: `/school/payments`,
        },
      });
    });
  }
}
