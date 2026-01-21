import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEnrollmentDto } from './dto/create.enrollment.dto';
import { PaymentService } from '../payments/payment.service';

@Injectable()
export class EnrollmentService {
  constructor(
    private prisma: PrismaService,
    private paymentService: PaymentService,
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

          paymentStatus: 'PENDING',

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

          paymentType: 'FIRST_PAYMENT',
        },
      });

      return enrollment;
    });
  }

  async confirmFirstPayment(enrollmentId: string, schoolId: string) {
    const enrollment = await this.prisma.childEnrollment.findFirst({
      where: {
        id: enrollmentId,
        schoolId,
      },
    });

    if (!enrollment) {
      throw new BadRequestException('Enrollment not found for this school');
    }

    if (enrollment.paymentStatus !== 'PENDING') {
      throw new BadRequestException('Enrollment is not awaiting confirmation');
    }

    return this.prisma.childEnrollment.update({
      where: { id: enrollmentId },
      data: {
        paymentStatus: 'ACTIVE',
      },
    });
  }
}
