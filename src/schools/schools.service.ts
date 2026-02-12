import {
  Injectable,
  BadRequestException,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PaymentStatus,
  UserRole,
  PaymentTransactionStatus,
  PaymentType,
} from '../generated/prisma/client';
import * as admin from 'firebase-admin';
import { CreateSchoolDto } from '../admin/dto/create.school.dto';
import { UpdateSchoolDto } from './dto/update.school.dto';

@Injectable()
export class SchoolPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    @Inject('FIREBASE_ADMIN') private readonly firebaseAdmin: admin.app.App,
  ) {}

  async createSchool(dto: CreateSchoolDto) {
    // 1. Create Firebase User
    let firebaseUser;
    try {
      firebaseUser = await this.firebaseAdmin.auth().createUser({
        email: dto.ownerEmail,
        password: dto.ownerPassword,
        displayName: dto.ownerName,
      });
    } catch (error) {
      if (error.code === 'auth/email-already-exists') {
        try {
          firebaseUser = await this.firebaseAdmin
            .auth()
            .getUserByEmail(dto.ownerEmail);
        } catch (retrieveError: any) {
          throw new BadRequestException(
            `User exists in Firebase but could not be retrieved: ${retrieveError.message}`,
          );
        }
      } else {
        throw new BadRequestException(`Firebase Error: ${error.message}`);
      }
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.ownerEmail },
    });
    if (existingUser) {
      throw new BadRequestException(
        'User with this email already exists in the database',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 2. Create User record
      const user = await tx.user.create({
        data: {
          id: firebaseUser.uid,
          email: dto.ownerEmail,
          password: 'HASHED_PASSWORD_PLACEHOLDER',
          role: UserRole.SCHOOL_OWNER,
          fullName: dto.ownerName,
        },
      });

      // 3. Create School record
      const school = await tx.school.create({
        data: {
          name: dto.schoolName,
          email: dto.ownerEmail,
          address: dto.address,
          phone: dto.phone,
          bankName: '',
          accountName: '',
          accountNumber: '',
          ownerId: user.id,
          // logo: dto.logo, // School model might not have logo yet, checking schema... DTO has it.
        },
      });

      return {
        school,
        user,
        message: 'School and School Owner created successfully',
      };
    });
  }

  async updateSchool(id: string, dto: UpdateSchoolDto) {
    const school = await this.prisma.school.findUnique({ where: { id } });
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

  async deleteSchool(id: string) {
    const school = await this.prisma.school.findUnique({ where: { id } });
    if (!school) throw new NotFoundException('School not found');

    // Might need to delete associated data or handle constraints
    // For MVP, just delete school (and cascading deletes if configured in Prisma)
    return this.prisma.school.delete({
      where: { id },
    });
  }

  async getAllSchools(search?: string) {
    console.log(`getAllSchools called with search: "${search}"`);
    const where: any = {};
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
    console.log(`getAllSchools found ${schools.length} schools`);
    return schools;
  }

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
    const [totalStudents, confirmedPayments, pendingPayments, enrollments] =
      await Promise.all([
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

    const enrollments = await this.prisma.childEnrollment.findMany({
      where: whereClause,
      include: {
        child: { include: { parent: { include: { user: true } } } },
        payments: { orderBy: { paymentDate: 'desc' } }, // Fetch all payments to calculate paid amount
      },
    });

    return enrollments.map((enrollment) => {
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
        id: enrollment.childId, // Use childId as student ID
        studentName: enrollment.child.fullName,
        className: enrollment.className,
        parentName: enrollment.child.parent.user.fullName || 'Unknown',
        totalFee: enrollment.totalSchoolFee,
        paidAmount: paidAmount,
        paymentStatus: enrollment.paymentStatus,
        nextDueDate: nextDueDate
          ? nextDueDate.toISOString().split('T')[0]
          : null,
        avatarUrl: null, // Placeholder
      };
    });
  }

  async getHistory(schoolId: string) {
    const payments = await this.prisma.payment.findMany({
      where: {
        schoolId,
        isConfirmed: true,
      },
      include: {
        enrollment: {
          include: {
            child: true,
            school: true,
          },
        },
      },
      orderBy: { paymentDate: 'desc' },
    });

    return payments.map((payment) => ({
      id: payment.id,
      date: payment.paymentDate,
      amount: payment.amountPaid,
      studentName: payment.enrollment.child.fullName,
      className: payment.enrollment.className,
      schoolName: payment.enrollment.school.name,
      type: payment.paymentType,
      status: 'SUCCESSFUL', // Since we filtered by isConfirmed: true
    }));
  }

  async getPendingPayments(schoolId: string) {
    const payments = await this.prisma.payment.findMany({
      where: {
        schoolId: schoolId,
        isConfirmed: false,
        paymentType: 'INSTALLMENT',
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

    return payments.map((p) => ({
      ...p,
      studentName: p.enrollment?.child?.fullName,
      className: p.enrollment?.className,
      schoolName: p.enrollment?.school?.name,
    }));
  }

  async confirmPayment(paymentId: string, schoolId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        schoolId,
        isConfirmed: false,
      },
      include: {
        enrollment: {
          include: { school: true, child: { include: { parent: true } } },
        },
      },
    });

    if (!payment) {
      throw new BadRequestException('Payment not found or already confirmed');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Confirm Payment
      const updatedPayment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          isConfirmed: true,
          status: PaymentTransactionStatus.SUCCESS,
          paymentDate: new Date(),
        },
      });

      // 2. Update Enrollment Balance
      // Note: remainingBalance tracks what is LEFT to pay.
      const currentBalance = payment.enrollment.remainingBalance;
      const newBalance = currentBalance - payment.amountPaid;
      // If newBalance is effectively 0 (or less), mark completed.
      const isCompleted = newBalance <= 0;

      await tx.childEnrollment.update({
        where: { id: payment.enrollmentId },
        data: {
          remainingBalance: Math.max(0, newBalance),
          paymentStatus: isCompleted
            ? PaymentStatus.COMPLETED
            : payment.enrollment.paymentStatus,
        },
      });

      // 3. Notify Parent
      let message = `Your payment of ${payment.amountPaid} for ${payment.enrollment.child.fullName} (${payment.enrollment.className}) at ${payment.enrollment.school.name} has been confirmed.`;
      if (isCompleted) {
        message += ' All payments for this semester are now completed.';
      }

      await this.notificationsService.create({
        userId: payment.enrollment.child.parent.userId,
        title: isCompleted ? 'Payment Completed' : 'Payment Confirmed',
        message: message,
      });

      return updatedPayment;
    });
  }

  async rejectPayment(paymentId: string, schoolId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        schoolId,
        isConfirmed: false,
      },
      include: {
        enrollment: {
          include: { school: true, child: { include: { parent: true } } },
        },
      },
    });

    if (!payment) {
      throw new BadRequestException('Payment not found or already processed');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Update Payment Status
      const updatedPayment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentTransactionStatus.FAILED,
          // isConfirmed stays false
        },
      });

      // 2. If First Payment, Fail Enrollment
      if (payment.paymentType === PaymentType.FIRST_PAYMENT) {
        await tx.childEnrollment.update({
          where: { id: payment.enrollmentId },
          data: {
            paymentStatus: PaymentStatus.FAILED,
          },
        });
      }

      // 3. Notify Parent
      await this.notificationsService.create({
        userId: payment.enrollment.child.parent.userId,
        title: 'Payment Rejected',
        message: `Your payment of ${payment.amountPaid} for ${payment.enrollment.child.fullName} at ${payment.enrollment.school.name} has been rejected. Please contact the school.`,
      });

      return updatedPayment;
    });
  }

  async markEnrollmentAsDefaulted(enrollmentId: string, schoolId: string) {
    const enrollment = await this.prisma.childEnrollment.findFirst({
      where: {
        id: enrollmentId,
        schoolId,
      },
      include: { school: true, child: { include: { parent: true } } },
    });

    if (!enrollment) {
      throw new BadRequestException('Enrollment not found');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Mark as Defaulted
      const updatedEnrollment = await tx.childEnrollment.update({
        where: { id: enrollmentId },
        data: { paymentStatus: PaymentStatus.DEFAULTED },
      });

      // 2. Notify Parent
      await this.notificationsService.create({
        userId: enrollment.child.parent.userId,
        title: 'Payment Defaulted',
        message: `Your enrollment for ${enrollment.child.fullName} (${enrollment.className}) at ${enrollment.school.name} has been marked as defaulted. Please contact the school.`,
      });

      return updatedEnrollment;
    });
  }
}
