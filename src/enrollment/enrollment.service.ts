import { Injectable, BadRequestException } from '@nestjs/common';
import {
  PaymentStatus,
  PaymentType,
  PaymentReceiver,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEnrollmentDto } from './dto/create.enrollment.dto';
import { PaymentService } from '../payments/payment.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class EnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async getParentEnrollments(userId: string) {
    return this.prisma.childEnrollment.findMany({
      where: {
        child: {
          parent: {
            userId: userId,
          },
        },
      },
      include: {
        child: true,
        school: true,
        payments: {
          orderBy: { paymentDate: 'desc' },
          take: 1, // Get the latest payment for context
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getEnrollmentHistory(enrollmentId: string, userId: string) {
    const enrollment = await this.prisma.childEnrollment.findUnique({
      where: { id: enrollmentId },
      include: {
        child: { include: { parent: true } },
        payments: { orderBy: { paymentDate: 'desc' } },
        school: true,
      },
    });

    if (!enrollment) {
      throw new BadRequestException('Enrollment not found');
    }

    // Security check: ensure the user requesting this is the parent of the child
    if (enrollment.child.parent.userId !== userId) {
      throw new BadRequestException('Unauthorized access to enrollment history');
    }

    return enrollment;
  }

  async confirmFirstPayment(enrollmentId: string, schoolId: string) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Verify Enrollment
      const enrollment = await tx.childEnrollment.findUnique({
        where: { id: enrollmentId },
        include: { child: { include: { parent: { include: { user: true } } } } },
      });

      if (!enrollment) {
        throw new BadRequestException('Enrollment not found');
      }

      if (enrollment.schoolId !== schoolId) {
        throw new BadRequestException(
          'Enrollment does not belong to this school',
        );
      }

      if (enrollment.paymentStatus !== PaymentStatus.PENDING) {
        throw new BadRequestException('Enrollment is not in pending status');
      }

      // 2. Find Pending First Payment
      const payment = await tx.payment.findFirst({
        where: {
          enrollmentId: enrollmentId,
          paymentType: PaymentType.FIRST_PAYMENT,
          isConfirmed: false,
        },
      });

      if (!payment) {
        throw new BadRequestException('No pending first payment found');
      }

      // 3. Update Payment
      await tx.payment.update({
        where: { id: payment.id },
        data: { isConfirmed: true },
      });

      // 4. Update Enrollment Status
      const updatedEnrollment = await tx.childEnrollment.update({
        where: { id: enrollmentId },
        data: { paymentStatus: PaymentStatus.ACTIVE },
      });

      // 5. Notify Parent
      const parentUserId = enrollment.child.parent.user.id;
      await tx.notification.create({
        data: {
          userId: parentUserId,
          title: 'Enrollment Confirmed',
          message: `Your enrollment for ${enrollment.className} has been confirmed!`,
          link: `/parent/enrollments/${enrollment.id}`,
        },
      });

      return updatedEnrollment;
    });
  }

  async enrollChild(dto: CreateEnrollmentDto, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      let childId = dto.childId;

      // Handle new child creation
      if (!childId) {
        if (!dto.childName) {
          throw new BadRequestException(
            'Either childId or childName must be provided',
          );
        }

        // Find Parent
        const parent = await tx.parent.findUnique({
          where: { userId },
        });

        if (!parent) {
          throw new BadRequestException('Parent profile not found');
        }

        // Create Child
        const newChild = await tx.child.create({
          data: {
            fullName: dto.childName,
            parentId: parent.id,
            className: dto.className,
          },
        });
        childId = newChild.id;
      }

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
          childId: childId, // Use resolved childId
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
          receiptUrl: dto.receiptUrl,
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

  async submitInstallmentPayment(
    enrollmentId: string,
    amountPaid: number,
    receiptUrl?: string,
  ) {
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
          receiptUrl: receiptUrl,
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
