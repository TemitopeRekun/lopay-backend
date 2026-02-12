import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  UserRole,
  PaymentStatus,
  PaymentType,
  PaymentTransactionStatus,
} from '../src/generated/prisma/client';
import { FirebaseAdminProvider } from '../src/firebase/firebase-admin.provider';
import { ThrottlerGuard } from '@nestjs/throttler';

describe('Payment Status Flow (e2e)', () => {
  let app: INestApplication;
  let schoolOwnerToken: string;

  const verifyIdTokenMock = jest.fn().mockImplementation((token) => {
    if (token === 'school-owner-token') {
      return Promise.resolve({
        email: 'school@example.com',
        uid: 'firebase-uid-school',
      });
    }
    return Promise.reject(new Error('Invalid token'));
  });

  const firebaseMock = {
    auth: () => ({
      verifyIdToken: verifyIdTokenMock,
    }),
  };

  const prismaMock = {
    $transaction: jest
      .fn()
      .mockImplementation((callback) => callback(prismaMock)),
    user: {
      findUnique: jest.fn().mockImplementation((args) => {
        if (args.where.email === 'school@example.com') {
          return Promise.resolve({
            id: 'user-school-owner',
            email: 'school@example.com',
            role: UserRole.SCHOOL_OWNER,
            school: { id: 'school-123' },
          });
        }
        return Promise.resolve(null);
      }),
    },
    payment: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    childEnrollment: {
      update: jest.fn(),
    },
    notification: {
      create: jest.fn(),
    },
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(FirebaseAdminProvider.provide)
      .useValue(firebaseMock)
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();

    // Login
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ idToken: 'school-owner-token' });
    schoolOwnerToken = res.body.accessToken;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Confirm Payment (Completion Flow)', () => {
    const validPaymentId = '123e4567-e89b-12d3-a456-426614174000';
    const validEnrollmentId = '123e4567-e89b-12d3-a456-426614174001';
    const validSchoolId = '123e4567-e89b-12d3-a456-426614174002';

    it('should confirm payment and mark enrollment as COMPLETED if balance is 0', async () => {
      // Mock payment with balance = amountPaid
      const mockPayment = {
        id: validPaymentId,
        amountPaid: 50000,
        schoolId: validSchoolId,
        enrollmentId: validEnrollmentId,
        paymentType: PaymentType.INSTALLMENT,
        enrollment: {
          remainingBalance: 50000, // Balance matches payment
          paymentStatus: PaymentStatus.ACTIVE,
          child: { fullName: 'Student', parent: { userId: 'parent-1' } },
          school: { name: 'School' },
        },
      };

      prismaMock.payment.findFirst.mockResolvedValue(mockPayment);
      prismaMock.payment.update.mockResolvedValue({
        ...mockPayment,
        isConfirmed: true,
        status: PaymentTransactionStatus.SUCCESS,
      });

      await request(app.getHttpServer())
        .post('/school-payments/confirm')
        .set('Authorization', `Bearer ${schoolOwnerToken}`)
        .send({ paymentId: validPaymentId })
        .expect(201);

      // Verify Payment Update
      expect(prismaMock.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: validPaymentId },
          data: expect.objectContaining({
            status: PaymentTransactionStatus.SUCCESS,
            isConfirmed: true,
          }),
        }),
      );

      // Verify Enrollment Update (Should be COMPLETED)
      expect(prismaMock.childEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: validEnrollmentId },
          data: expect.objectContaining({
            remainingBalance: 0,
            paymentStatus: PaymentStatus.COMPLETED,
          }),
        }),
      );
    });

    it('should confirm payment but NOT mark completed if balance > 0', async () => {
      // Mock payment where balance > amountPaid
      const mockPayment = {
        id: validPaymentId,
        amountPaid: 20000,
        schoolId: validSchoolId,
        enrollmentId: validEnrollmentId,
        paymentType: PaymentType.INSTALLMENT,
        enrollment: {
          remainingBalance: 50000,
          paymentStatus: PaymentStatus.ACTIVE,
          child: { fullName: 'Student', parent: { userId: 'parent-1' } },
          school: { name: 'School' },
        },
      };

      prismaMock.payment.findFirst.mockResolvedValue(mockPayment);
      prismaMock.payment.update.mockResolvedValue({
        ...mockPayment,
        isConfirmed: true,
        status: PaymentTransactionStatus.SUCCESS,
      });

      await request(app.getHttpServer())
        .post('/school-payments/confirm')
        .set('Authorization', `Bearer ${schoolOwnerToken}`)
        .send({ paymentId: validPaymentId })
        .expect(201);

      // Verify Enrollment Update (Status should stay ACTIVE/unchanged)
      expect(prismaMock.childEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: validEnrollmentId },
          data: expect.objectContaining({
            remainingBalance: 30000,
            paymentStatus: PaymentStatus.ACTIVE,
          }),
        }),
      );
    });
  });

  describe('Reject Payment (Failure Flow)', () => {
    const validPaymentId = '123e4567-e89b-12d3-a456-426614174003';
    const validEnrollmentId = '123e4567-e89b-12d3-a456-426614174004';
    const validSchoolId = '123e4567-e89b-12d3-a456-426614174002';

    it('should reject payment and mark enrollment FAILED if first payment', async () => {
      const mockPayment = {
        id: validPaymentId,
        amountPaid: 50000,
        schoolId: validSchoolId,
        enrollmentId: validEnrollmentId,
        paymentType: PaymentType.FIRST_PAYMENT,
        enrollment: {
          child: { fullName: 'Student', parent: { userId: 'parent-1' } },
          school: { name: 'School' },
        },
      };

      prismaMock.payment.findFirst.mockResolvedValue(mockPayment);
      prismaMock.payment.update.mockResolvedValue({
        ...mockPayment,
        status: PaymentTransactionStatus.FAILED,
      });

      await request(app.getHttpServer())
        .post('/school-payments/reject')
        .set('Authorization', `Bearer ${schoolOwnerToken}`)
        .send({ paymentId: validPaymentId })
        .expect(201);

      // Verify Payment Update
      expect(prismaMock.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: validPaymentId },
          data: expect.objectContaining({
            status: PaymentTransactionStatus.FAILED,
          }),
        }),
      );

      // Verify Enrollment Update (FAILED)
      expect(prismaMock.childEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: validEnrollmentId },
          data: { paymentStatus: PaymentStatus.FAILED },
        }),
      );
    });

    it('should reject payment but NOT fail enrollment if installment', async () => {
      const mockPayment = {
        id: validPaymentId,
        amountPaid: 20000,
        schoolId: validSchoolId,
        enrollmentId: validEnrollmentId,
        paymentType: PaymentType.INSTALLMENT,
        enrollment: {
          child: { fullName: 'Student', parent: { userId: 'parent-1' } },
          school: { name: 'School' },
        },
      };

      prismaMock.payment.findFirst.mockResolvedValue(mockPayment);
      prismaMock.payment.update.mockResolvedValue({
        ...mockPayment,
        status: PaymentTransactionStatus.FAILED,
      });

      await request(app.getHttpServer())
        .post('/school-payments/reject')
        .set('Authorization', `Bearer ${schoolOwnerToken}`)
        .send({ paymentId: validPaymentId })
        .expect(201);

      // Verify Payment Update
      expect(prismaMock.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: validPaymentId },
          data: expect.objectContaining({
            status: PaymentTransactionStatus.FAILED,
          }),
        }),
      );

      // Verify Enrollment Update is NOT called (or called with something else if I change logic, but currently logic only updates enrollment if FIRST_PAYMENT)
      // Actually, my code only calls `childEnrollment.update` if `paymentType === FIRST_PAYMENT` in `rejectPayment`.
      expect(prismaMock.childEnrollment.update).not.toHaveBeenCalled();
    });
  });
});
