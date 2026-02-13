import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentStatus,
  PaymentType,
  PaymentReceiver,
  UserRole,
  PaymentTransactionStatus,
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

  private calculateEnrichment(enrollment: any, payments: any[]) {
    const confirmedPayments = payments.filter((p) => p.isConfirmed);
    const paidAmount = confirmedPayments.reduce(
      (sum, p) => sum + p.amountPaid,
      0,
    );

    const totalSchoolFee = enrollment.totalSchoolFee;

    let nextDueDate: Date | null = null;
    let nextInstallmentAmount = 0;

    if (enrollment.remainingBalance > 0) {
      // Find last confirmed payment
      const lastPayment = confirmedPayments[0]; // Assuming desc order

      if (lastPayment) {
        const lastDate = new Date(lastPayment.paymentDate);
        if (enrollment.installmentFrequency === 'WEEKLY') {
          lastDate.setDate(lastDate.getDate() + 7);
        } else if (enrollment.installmentFrequency === 'MONTHLY') {
          lastDate.setMonth(lastDate.getMonth() + 1);
        }
        nextDueDate = lastDate;
      } else {
        // If first payment pending, next due is now or creation date.
        // If first payment paid (and no installments yet), use term start date?
        nextDueDate = enrollment.termStartDate || enrollment.createdAt;
      }

      // Next installment amount
      const plan = enrollment.installmentFrequency;
      const totalInstallments = plan === 'WEEKLY' ? 12 : 3;
      const paidInstallments = confirmedPayments.filter(
        (p) => p.paymentType === PaymentType.INSTALLMENT,
      ).length;
      const remainingInstallments = totalInstallments - paidInstallments;

      if (remainingInstallments > 0) {
        nextInstallmentAmount =
          enrollment.remainingBalance / remainingInstallments;
      } else {
        nextInstallmentAmount = enrollment.remainingBalance;
      }
    }

    // Enrich payments with aliases
    const enrichedPayments = payments.map((p) => ({
      ...p,
      amount: p.amountPaid,
      date: p.paymentDate,
      type: p.paymentType,
    }));

    return {
      ...enrollment,
      payments: enrichedPayments, // Return enriched payments
      studentName: enrollment.child?.fullName, // Standardize with School Service
      childName: enrollment.child?.fullName,   // Handle "childName" case mentioned by frontend
      totalFee: totalSchoolFee,
      paidAmount,
      nextDueDate: nextDueDate ? nextDueDate.toISOString().split('T')[0] : null, // Standardize date format
      nextInstallmentAmount,
    };
  }

  async getParentEnrollments(userId: string) {
    console.log(
      `EnrollmentService: Fetching enrollments for userId: ${userId}`,
    );

    // Step 1: Find Parent
    const parent = await this.prisma.parent.findUnique({
      where: { userId },
      include: { children: true },
    });

    if (!parent) {
      console.log('EnrollmentService: Parent not found for userId:', userId);
      return [];
    }
    console.log(
      `EnrollmentService: Parent found. ID: ${parent.id}. Children count: ${parent.children.length}`,
    );

    if (parent.children.length === 0) {
      return [];
    }

    const childIds = parent.children.map((c) => c.id);

    // Step 2: Find Enrollments for these children
    const enrollments = await this.prisma.childEnrollment.findMany({
      where: {
        childId: { in: childIds },
      },
      include: {
        child: true,
        school: true,
        payments: {
          orderBy: { paymentDate: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    console.log(
      `EnrollmentService: Found ${enrollments.length} enrollments matching child IDs`,
    );

    return enrollments.map((enrollment) =>
      this.calculateEnrichment(enrollment, enrollment.payments),
    );
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
      throw new NotFoundException('Enrollment not found');
    }

    if (enrollment.child.parent.userId !== userId) {
      throw new BadRequestException(
        'Unauthorized access to enrollment history',
      );
    }

    return this.calculateEnrichment(enrollment, enrollment.payments);
  }

  async enrollChild(dto: CreateEnrollmentDto, userId: string) {
    // 1. Resolve Child
    let childId = dto.childId;

    // Check Parent exists
    let parent = await this.prisma.parent.findUnique({ where: { userId } });

    if (!parent) {
      // If parent profile doesn't exist, check if user is a School Owner
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: { school: true },
      });

      if (user && user.role === UserRole.SCHOOL_OWNER && user.school) {
        // Create Parent profile for School Owner
        parent = await this.prisma.parent.create({
          data: {
            userId: user.id,
            phoneNumber: user.school.phone, // Use school phone
          },
        });
      } else {
        throw new BadRequestException('Parent profile not found');
      }
    }

    if (childId) {
      const child = await this.prisma.child.findUnique({
        where: { id: childId },
      });
      if (!child || child.parentId !== parent.id) {
        throw new BadRequestException(
          'Child not found or does not belong to user',
        );
      }
    } else if (dto.childName) {
      const newChild = await this.prisma.child.create({
        data: {
          fullName: dto.childName,
          parentId: parent.id,
          className: dto.className,
        },
      });
      childId = newChild.id;
    } else {
      throw new BadRequestException(
        'Either childId or childName must be provided',
      );
    }

    // 2. Get Fees
    const classFee = await this.prisma.classFee.findFirst({
      where: {
        schoolId: dto.schoolId,
        className: dto.className,
        isActive: true,
      },
    });

    if (!classFee) {
      throw new BadRequestException(
        `No fee configuration found for class ${dto.className} in this school`,
      );
    }

    // 3. Calculate Deposit
    const calculation = this.paymentService.calculateInitialPayment(
      classFee.feeAmount,
      dto.firstPaymentPaid,
    );

    // 4. Create Enrollment & Payment
    const result = await this.prisma.$transaction(async (tx) => {
      console.log(
        `EnrollmentService: Creating enrollment for childId: ${childId}, schoolId: ${dto.schoolId}`,
      );
      const enrollment = await tx.childEnrollment.create({
        data: {
          childId,
          schoolId: dto.schoolId,
          className: dto.className,
          totalSchoolFee: calculation.schoolFees,
          platformFee: calculation.platformFee,
          schoolMinimumFee: calculation.minimumDeposit,
          firstPaymentPaid: dto.firstPaymentPaid,
          remainingBalance: calculation.remainingBalance,
          paymentStatus: PaymentStatus.PENDING,
          installmentFrequency: dto.installmentFrequency,
          termStartDate: dto.termStartDate,
          termEndDate: dto.termEndDate,
        },
      });

      const payment = await tx.payment.create({
        data: {
          enrollmentId: enrollment.id,
          schoolId: dto.schoolId,
          amountPaid: dto.firstPaymentPaid,
          platformAmount: calculation.platformFee,
          schoolAmount: calculation.amountToSchool,
          receiver: PaymentReceiver.PLATFORM,
          paymentType: PaymentType.FIRST_PAYMENT,
          status: PaymentTransactionStatus.PENDING,
          isConfirmed: false,
          receiptUrl: dto.receiptUrl,
          paymentDate: new Date(),
        },
      });

      const school = await tx.school.findUnique({
        where: { id: dto.schoolId },
      });

      // Fetch child name for notification
      const child = await tx.child.findUnique({
        where: { id: childId },
        select: { fullName: true },
      });
      const childName = child?.fullName || dto.childName || 'Student';

      return {
        enrollment,
        payment,
        calculation,
        school,
        childName,
        studentName: childName, // Alias for consistency
      };
    });

    // 5. Notify School Owner (Post-Transaction)
    if (result.school?.ownerId) {
      await this.notificationsService.create({
        userId: result.school.ownerId,
        title: 'New Enrollment Initiated',
        message: `New Student: ${result.childName} | Class: ${dto.className} | Amount Paid: ${dto.firstPaymentPaid} | Status: Pending Admin Transfer.`,
        link: '/school/pending-payments',
      });
    }

    // 6. Notify Super Admin (Platform)
    const admins = await this.prisma.user.findMany({
      where: { role: UserRole.SUPER_ADMIN },
    });

    for (const admin of admins) {
      await this.notificationsService.create({
        userId: admin.id,
        title: 'New First Payment Received',
        message: `Payment of ${dto.firstPaymentPaid} received for ${result.childName} at ${result.school?.name}. Please process 25% payout to school.`,
        link: '/admin/payments',
      });
    }

    return result;
  }

  async submitInstallmentPayment(
    enrollmentId: string,
    amountPaid: number,
    receiptUrl?: string,
  ) {
    const enrollment = await this.prisma.childEnrollment.findUnique({
      where: { id: enrollmentId },
      include: { school: true, child: true },
    });

    if (!enrollment) throw new NotFoundException('Enrollment not found');

    // Create Payment
    const payment = await this.prisma.payment.create({
      data: {
        enrollmentId,
        schoolId: enrollment.schoolId,
        amountPaid,
        platformAmount: 0, // Installments usually 100% to school?
        schoolAmount: amountPaid,
        receiver: PaymentReceiver.SCHOOL, // Installments go to school
        paymentType: PaymentType.INSTALLMENT,
        status: PaymentTransactionStatus.PENDING,
        isConfirmed: false,
        receiptUrl,
        paymentDate: new Date(),
      },
    });

    // Notify School Owner
    if (enrollment.school.ownerId) {
      await this.notificationsService.create({
        userId: enrollment.school.ownerId,
        title: 'New Installment Payment',
        message: `New payment of ${amountPaid} for ${enrollment.child.fullName} (${enrollment.className}) at ${enrollment.school.name}.`,
      });
    }

    return {
      ...payment,
      amount: payment.amountPaid, // Alias
      date: payment.paymentDate, // Alias
      type: payment.paymentType, // Alias
      studentName: enrollment.child.fullName, // Alias
      childName: enrollment.child.fullName, // Alias
      schoolName: enrollment.school.name, // Alias
    };
  }

  async confirmFirstPayment(enrollmentId: string, schoolId: string) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Verify Enrollment
      const enrollment = await tx.childEnrollment.findUnique({
        where: { id: enrollmentId },
        include: {
          child: { include: { parent: { include: { user: true } } } },
          school: true,
        },
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
        data: {
          isConfirmed: true,
          status: PaymentTransactionStatus.SUCCESS,
          paymentDate: new Date(),
        },
      });

      // 4. Activate Enrollment
      await tx.childEnrollment.update({
        where: { id: enrollmentId },
        data: { paymentStatus: PaymentStatus.ACTIVE },
      });

      // 5. Notify Parent
      await this.notificationsService.create({
        userId: enrollment.child.parent.userId,
        title: 'Enrollment Confirmed',
        message: `Your enrollment for ${enrollment.child.fullName} (${enrollment.className}) at ${enrollment.school.name} has been confirmed.`,
      });

      return { message: 'First payment confirmed and enrollment activated' };
    });
  }
}