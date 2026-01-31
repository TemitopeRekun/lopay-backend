import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { UserRole, PaymentStatus } from '../generated/client/client';
import { FirebaseAdminProvider } from '../src/firebase/firebase-admin.provider';
import { ThrottlerGuard } from '@nestjs/throttler';

describe('School Dashboard (e2e)', () => {
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
        }
        return Promise.resolve(null);
      }),
      create: jest.fn(),
    },
    childEnrollment: {
      count: jest.fn().mockResolvedValue(50), // Mock 50 students
      findMany: jest.fn().mockImplementation((args) => {
        // If getting defaulted enrollments (for stats)
        if (args.where?.paymentStatus === PaymentStatus.DEFAULTED) {
            return Promise.resolve([{ remainingBalance: 20000 }]);
        }
        // If getting students list
        return Promise.resolve([
          {
            id: 'enrollment-1',
            child: {
              fullName: 'John Doe',
              parent: {
                user: { email: 'parent@test.com' },
                phoneNumber: '08012345678',
              },
            },
          },
        ]);
      }),
    },
    payment: {
      aggregate: jest.fn().mockImplementation((args) => {
        if (args.where.isConfirmed === true) {
          return Promise.resolve({ _sum: { amountPaid: 5000000 } }); // Confirmed Revenue
        }
        if (args.where.isConfirmed === false) {
          return Promise.resolve({ _sum: { amountPaid: 150000 } }); // Pending Revenue
        }
        return Promise.resolve({ _sum: { amountPaid: 0 } });
      }),
    },
    classFee: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'fee-1',
        schoolId: 'school-123',
        className: 'Grade 1',
        feeAmount: 50000,
      }),
      findMany: jest.fn().mockResolvedValue([
        { className: 'Grade 1', feeAmount: 50000 },
      ]),
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

    // Login as School Owner
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ idToken: 'school-owner-token' });
    schoolOwnerToken = res.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Dashboard Stats', () => {
    it('/school-payments/stats (GET) - Should return aggregated stats', async () => {
      const res = await request(app.getHttpServer())
        .get('/school-payments/stats')
        .set('Authorization', `Bearer ${schoolOwnerToken}`)
        .expect(200);

      expect(res.body).toEqual({
        totalStudents: 50,
        totalRevenue: 5000000,
        pendingRevenue: 150000,
        defaultedAmount: 20000,
      });

      // Verify Prisma calls
      expect(prismaMock.childEnrollment.count).toHaveBeenCalledWith({
        where: { schoolId: 'school-123' },
      });
      expect(prismaMock.payment.aggregate).toHaveBeenCalledTimes(2); // Confirmed & Pending
    });
  });

  describe('Student Management', () => {
    it('/school-payments/students (GET) - Should list students', async () => {
      const res = await request(app.getHttpServer())
        .get('/school-payments/students')
        .set('Authorization', `Bearer ${schoolOwnerToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].child.fullName).toBe('John Doe');
    });

    it('/school-payments/students?search=John (GET) - Should filter by name/email/phone', async () => {
      await request(app.getHttpServer())
        .get('/school-payments/students?search=John')
        .set('Authorization', `Bearer ${schoolOwnerToken}`)
        .expect(200);

      // Verify the correct OR clause was constructed
      expect(prismaMock.childEnrollment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              { child: { fullName: { contains: 'John', mode: 'insensitive' } } },
              { child: { parent: { user: { email: { contains: 'John', mode: 'insensitive' } } } } },
              { child: { parent: { phoneNumber: { contains: 'John', mode: 'insensitive' } } } },
            ]),
          }),
        }),
      );
    });

    it('/school-payments/students?className=Grade 1 (GET) - Should filter by class', async () => {
      await request(app.getHttpServer())
        .get('/school-payments/students?className=Grade 1')
        .set('Authorization', `Bearer ${schoolOwnerToken}`)
        .expect(200);

      expect(prismaMock.childEnrollment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            className: 'Grade 1',
          }),
        }),
      );
    });
  });

  describe('Class Fee Management', () => {
      it('/school-payments/fees (POST) - Should create class fee', async () => {
          await request(app.getHttpServer())
            .post('/school-payments/fees')
            .set('Authorization', `Bearer ${schoolOwnerToken}`)
            .send({ className: 'Grade 1', feeAmount: 50000 })
            .expect(201);
          
          expect(prismaMock.classFee.create).toHaveBeenCalled();
      });

      it('/school-payments/fees (GET) - Should list fees', async () => {
        const res = await request(app.getHttpServer())
          .get('/school-payments/fees')
          .set('Authorization', `Bearer ${schoolOwnerToken}`)
          .expect(200);

        expect(res.body[0].className).toBe('Grade 1');
      });
  });
});
