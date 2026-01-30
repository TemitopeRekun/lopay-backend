import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { UserRole, PaymentStatus, PaymentType, InstallmentFrequency } from '../generated/client/client';
import { FirebaseAdminProvider } from '../src/firebase/firebase-admin.provider';
import { ThrottlerGuard } from '@nestjs/throttler';

describe('Enrollment (e2e)', () => {
  let app: INestApplication;
  let parentToken: string;
  let schoolOwnerToken: string;

  // Stable Mock for verifyIdToken
  const verifyIdTokenMock = jest.fn().mockImplementation((token) => {
    if (token === 'parent-token') {
      return Promise.resolve({
        email: 'parent@example.com',
        uid: 'firebase-uid-parent',
      });
    } else if (token === 'school-owner-token') {
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
    $transaction: jest.fn().mockImplementation((callback) => callback(prismaMock)),
    user: {
      findUnique: jest.fn().mockImplementation((args) => {
        if (args.where.email === 'school@example.com') {
          return Promise.resolve({
            id: 'user-school-owner',
            email: 'school@example.com',
            role: UserRole.SCHOOL_OWNER,
            school: { id: 'school-123' },
          });
        } else if (args.where.email === 'parent@example.com') {
           return Promise.resolve({
            id: 'user-parent',
            email: 'parent@example.com',
            role: UserRole.PARENT,
            school: null,
          });
        }
        return Promise.resolve(null);
      }),
      create: jest.fn(),
    },
    classFee: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'class-fee-123',
        schoolId: 'school-123',
        className: 'Grade 1',
        feeAmount: 100000,
        isActive: true,
      }),
    },
    school: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'school-123',
        ownerId: 'user-school-owner',
      }),
    },
    childEnrollment: {
      create: jest.fn().mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: PaymentStatus.PENDING,
      }),
      findUnique: jest.fn().mockImplementation((args) => {
        // Mock finding the enrollment for confirmation
        return Promise.resolve({
          id: '550e8400-e29b-41d4-a716-446655440000',
          schoolId: 'school-123',
          paymentStatus: PaymentStatus.PENDING,
          className: 'Grade 1',
          child: {
            parent: {
              user: {
                id: 'user-parent'
              }
            }
          }
        });
      }),
      update: jest.fn().mockResolvedValue({
         id: '550e8400-e29b-41d4-a716-446655440000',
         paymentStatus: PaymentStatus.ACTIVE,
      }),
    },
    payment: {
      create: jest.fn().mockResolvedValue({ id: 'payment-123' }),
      findFirst: jest.fn().mockResolvedValue({
        id: 'payment-123',
        paymentType: PaymentType.FIRST_PAYMENT,
        isConfirmed: false,
      }),
      update: jest.fn().mockResolvedValue({
        id: 'payment-123',
        isConfirmed: true,
      }),
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

    // Get Tokens
    const parentRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ idToken: 'parent-token' });
    parentToken = parentRes.body.accessToken;

    const schoolRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ idToken: 'school-owner-token' });
    schoolOwnerToken = schoolRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Enrollment Flow', () => {
    it('/enrollments (POST) - Parent should enroll child', async () => {
      const dto = {
        childId: 'child-123',
        schoolId: 'school-123',
        className: 'Grade 1',
        installmentFrequency: InstallmentFrequency.MONTHLY,
        firstPaymentPaid: 30000, // > 27,500 (25% + 2.5%)
        termStartDate: new Date().toISOString(),
        termEndDate: new Date().toISOString(),
      };

      await request(app.getHttpServer())
        .post('/enrollments')
        .set('Authorization', `Bearer ${parentToken}`)
        .send(dto)
        .expect(201);
      
      expect(prismaMock.childEnrollment.create).toHaveBeenCalled();
      expect(prismaMock.payment.create).toHaveBeenCalled();
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('/enrollments/confirm-first-payment (POST) - School Owner should confirm', async () => {
      await request(app.getHttpServer())
        .post('/enrollments/confirm-first-payment')
        .set('Authorization', `Bearer ${schoolOwnerToken}`)
        .send({ enrollmentId: '550e8400-e29b-41d4-a716-446655440000' })
        .expect(201);

      expect(prismaMock.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'payment-123' }, data: { isConfirmed: true } })
      );
      expect(prismaMock.childEnrollment.update).toHaveBeenCalledWith(
         expect.objectContaining({ where: { id: '550e8400-e29b-41d4-a716-446655440000' }, data: { paymentStatus: PaymentStatus.ACTIVE } })
      );
    });

    it('/enrollments/confirm-first-payment (POST) - Parent should NOT be able to confirm', async () => {
       await request(app.getHttpServer())
        .post('/enrollments/confirm-first-payment')
        .set('Authorization', `Bearer ${parentToken}`)
        .send({ enrollmentId: '550e8400-e29b-41d4-a716-446655440000' })
        .expect(403); 
    });
  });
});