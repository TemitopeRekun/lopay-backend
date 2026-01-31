import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { UserRole, PaymentStatus, PaymentType } from '../src/generated/prisma/client';
import { FirebaseAdminProvider } from '../src/firebase/firebase-admin.provider';
import { ThrottlerGuard } from '@nestjs/throttler';

describe('Installment Payment (e2e)', () => {
  let app: INestApplication;
  let parentToken: string;
  let schoolOwnerToken: string;

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
    school: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'school-123',
        ownerId: 'user-school-owner',
      }),
    },
    childEnrollment: {
      findUnique: jest.fn().mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        schoolId: 'school-123',
        paymentStatus: PaymentStatus.ACTIVE,
        remainingBalance: 50000,
        childId: 'child-123',
      }),
      update: jest.fn().mockResolvedValue({
         id: '550e8400-e29b-41d4-a716-446655440000',
         paymentStatus: PaymentStatus.PENDING,
      }),
      findFirst: jest.fn().mockResolvedValue({ // For markEnrollmentAsDefaulted if needed, but safe to mock
         id: '550e8400-e29b-41d4-a716-446655440000',
         remainingBalance: 50000,
      }), 
    },
    payment: {
      create: jest.fn().mockResolvedValue({ id: 'payment-installment-1' }),
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'payment-installment-1',
          amountPaid: 10000,
          isConfirmed: false,
          enrollment: { id: '550e8400-e29b-41d4-a716-446655440000' },
          school: { id: 'school-123' },
        }
      ]),
      findFirst: jest.fn().mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655441111',
        amountPaid: 10000,
        isConfirmed: false,
        enrollment: {
          id: '550e8400-e29b-41d4-a716-446655440000',
          remainingBalance: 50000,
          childId: 'child-123',
        },
      }),
      update: jest.fn().mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655441111',
        isConfirmed: true,
      }),
    },
    child: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'child-123',
        parent: { userId: 'user-parent' },
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

  describe('Installment Flow', () => {
    it('/enrollments/pay-installment (POST) - Parent should submit installment', async () => {
      const dto = {
        enrollmentId: '550e8400-e29b-41d4-a716-446655440000',
        amountPaid: 10000,
      };

      await request(app.getHttpServer())
        .post('/enrollments/pay-installment')
        .set('Authorization', `Bearer ${parentToken}`)
        .send(dto)
        .expect(201);
      
      expect(prismaMock.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amountPaid: 10000,
            paymentType: PaymentType.INSTALLMENT,
            isConfirmed: false,
          }),
        })
      );
      expect(prismaMock.childEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({
            where: { id: dto.enrollmentId },
            data: { paymentStatus: PaymentStatus.PENDING }
        })
      );
    });

    it('/school-payments/pending (GET) - School Owner should see pending payment', async () => {
        const res = await request(app.getHttpServer())
          .get('/school-payments/pending')
          .set('Authorization', `Bearer ${schoolOwnerToken}`)
          .expect(200);

        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body[0].amountPaid).toBe(10000);
        expect(prismaMock.payment.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { schoolId: 'school-123', isConfirmed: false } })
        );
    });

    it('/school-payments/confirm (POST) - School Owner should confirm payment', async () => {
        await request(app.getHttpServer())
          .post('/school-payments/confirm')
          .set('Authorization', `Bearer ${schoolOwnerToken}`)
          .send({ paymentId: '550e8400-e29b-41d4-a716-446655441111' })
          .expect(201);

        expect(prismaMock.payment.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: '550e8400-e29b-41d4-a716-446655441111' },
                data: { isConfirmed: true }
            })
        );
        // Balance 50000 - 10000 = 40000
        expect(prismaMock.childEnrollment.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { remainingBalance: 40000, paymentStatus: PaymentStatus.ACTIVE }
            })
        );
    });
  });
});