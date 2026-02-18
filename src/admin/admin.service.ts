import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import {
  PaymentType,
  PaymentReceiver,
  PaymentStatus,
  PaymentTransactionStatus,
  UserRole,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import * as admin from 'firebase-admin';
import { CreateSchoolDto } from './dto/create.school.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    @Inject('FIREBASE_ADMIN') private readonly firebaseAdmin: admin.app.App,
  ) {}

  /** Onboard a new school and create the school owner account */
  async onboardSchool(dto: CreateSchoolDto) {
    // 1. Create Firebase User
    let firebaseUser;
    try {
      console.log(`Attempting to create Firebase user: ${dto.ownerEmail}`);
      firebaseUser = await this.firebaseAdmin.auth().createUser({
        email: dto.ownerEmail,
        password: dto.ownerPassword,
        displayName: dto.ownerName,
      });
      console.log(`Firebase user created: ${firebaseUser.uid}`);
    } catch (error) {
      console.error('Firebase creation error:', error);
      if (error.code === 'auth/email-already-exists') {
        // If user exists in Firebase, check if they exist in our DB
        try {
            console.log('User exists in Firebase, retrieving...');
            firebaseUser = await this.firebaseAdmin.auth().getUserByEmail(dto.ownerEmail);
            console.log(`Retrieved existing Firebase user: ${firebaseUser.uid}`);
        } catch (retrieveError: any) {
            throw new BadRequestException(`User exists in Firebase but could not be retrieved: ${retrieveError.message}`);
        }
      } else {
        throw new BadRequestException(`Firebase Error: ${error.message}`);
      }
    }

    // If we are reusing an existing firebase user, we must ensure they don't already have a role that conflicts,
    // or we just overwrite/assign SCHOOL_OWNER role in our DB.
    // For safety in this MVP, let's assume strict onboarding:
    // If user exists in DB, fail.

    const existingUser = await this.prisma.user.findUnique({ where: { email: dto.ownerEmail } });
    if (existingUser) {
        throw new BadRequestException('User with this email already exists in the database');
    }

    return this.prisma.$transaction(async (tx) => {
      // 2. Create User record
      const user = await tx.user.create({
        data: {
          id: firebaseUser.uid,
          email: dto.ownerEmail,
          password: 'HASHED_PASSWORD_PLACEHOLDER', // In production, we don't store passwords if using Firebase, but DB schema might require it.
          role: UserRole.SCHOOL_OWNER,
          fullName: dto.ownerName,
        },
      });

      // 3. Create School record
      const school = await tx.school.create({
        data: {
          name: dto.schoolName,
          email: dto.ownerEmail, // School email defaults to owner email
          address: dto.address,
          phone: dto.phone,
          // Bank details provided during onboarding
          bankName: dto.bankName,
          accountName: dto.accountName,
          accountNumber: dto.accountNumber,
          ownerId: user.id,
        },
      });

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
    });
  }

  /** Get all first payments waiting to be settled */
  async getPendingFirstPayments() {
    const payments = await this.prisma.payment.findMany({
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

    return payments.map((p) => ({
      ...p,
      studentName: p.enrollment?.child?.fullName,
      childName: p.enrollment?.child?.fullName, // Alias
      schoolName: p.enrollment?.school?.name,
      className: p.enrollment?.className,
      amount: p.amountPaid, // Alias
      date: p.paymentDate, // Alias
      type: p.paymentType, // Alias
    }));
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
      throw new NotFoundException('Payment not found or already settled');
    }

    const { enrollment } = payment;

    await this.prisma.$transaction([
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

    return {
      message: 'Payment settled and enrollment activated successfully',
      paymentId: payment.id,
    };
  }

  /** Get all pending installment payments across all schools (read-only) */
  async getPendingInstallments() {
    const payments = await this.prisma.payment.findMany({
      where: {
        paymentType: PaymentType.INSTALLMENT,
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

    return payments.map((p) => ({
      ...p,
      date: p.paymentDate,
      amount: p.amountPaid,
      studentName: p.enrollment?.child?.fullName,
      childName: p.enrollment?.child?.fullName,
      className: p.enrollment?.className,
      schoolName: p.enrollment?.school?.name,
    }));
  }

  /** Reject a pending first payment and mark enrollment as failed */
  async rejectFirstPayment(paymentId: string) {
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
      throw new NotFoundException('First payment not found or already processed');
    }

    const { enrollment } = payment;

    await this.prisma.$transaction([
      // 1️⃣ Mark payment as failed (not confirmed)
      this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentTransactionStatus.FAILED,
        },
      }),

      // 2️⃣ Mark enrollment as FAILED (no balance changes)
      this.prisma.childEnrollment.update({
        where: { id: payment.enrollmentId },
        data: { paymentStatus: PaymentStatus.FAILED },
      }),

      // 3️⃣ Notify School Owner (optional visibility)
      this.prisma.notification.create({
        data: {
          userId: enrollment.school.ownerId,
          title: 'First Payment Rejected',
          message:
            'The platform has rejected the first payment for this enrollment. Please review the receipt or contact the parent.',
          link: `/school/enrollments/${enrollment.id}`,
        },
      }),

      // 4️⃣ Notify Parent
      this.prisma.notification.create({
        data: {
          userId: enrollment.child.parent.userId,
          title: 'First Payment Rejected',
          message:
            'Your first payment could not be verified. Please pay again and upload a clearer receipt.',
          link: `/parent/enrollments/${enrollment.id}`,
        },
      }),
    ]);

    return {
      message: 'First payment rejected and enrollment marked as failed',
      paymentId: payment.id,
    };
  }

  /** Get students/enrollments for a specific school (admin view) */
  async getSchoolStudents(
    schoolId: string,
    className?: string,
    search?: string,
  ) {
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
        payments: { orderBy: { paymentDate: 'desc' } },
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
        nextDueDate = enrollment.termStartDate;
      }

      return {
        id: enrollment.childId,
        studentName: enrollment.child.fullName,
        childName: enrollment.child.fullName,
        className: enrollment.className,
        parentName: enrollment.child.parent.user.fullName || 'Unknown',
        totalFee: enrollment.totalSchoolFee,
        paidAmount: paidAmount,
        paymentStatus: enrollment.paymentStatus,
        nextDueDate: nextDueDate
          ? nextDueDate.toISOString().split('T')[0]
          : null,
        avatarUrl: null,
      };
    });
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
