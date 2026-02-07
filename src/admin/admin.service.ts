import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import {
  PaymentType,
  PaymentReceiver,
  PaymentStatus,
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
        user,
        message: 'School and School Owner created successfully',
      };
    });
  }

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
