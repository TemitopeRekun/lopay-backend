import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { UserRole } from '../src/generated/prisma/client';
import { ThrottlerGuard } from '@nestjs/throttler';

describe('Authentication & Authorization (e2e)', () => {
  let app: INestApplication;

  // Stable Mock for verifyIdToken
  const verifyIdTokenMock = jest.fn().mockImplementation((token) => {
    if (token === 'valid-token') {
      return Promise.resolve({
        email: 'newparent@example.com',
        uid: 'firebase-uid-123',
      });
    } else if (token === 'school-owner-token') {
      return Promise.resolve({
        email: 'school@example.com',
        uid: 'firebase-uid-456',
      });
    }
    return Promise.reject(new Error('Invalid token'));
  });

  // Mock Firebase Admin
  const firebaseMock = {
    auth: () => ({
      verifyIdToken: verifyIdTokenMock,
    }),
  };

  // Mock ThrottlerGuard
  const throttlerGuardMock = {
    canActivate: () => true,
  };

  // Mock Prisma Service
  const prismaMock = {
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
        return Promise.resolve(null); // Simulate user not found for new parent
      }),
      create: jest.fn().mockImplementation((args) => {
        return Promise.resolve({
          id: 'new-user-id',
          ...args.data,
          school: null,
        });
      }),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider('FIREBASE_ADMIN') // Use the exact token string used in AuthService
      .useValue(firebaseMock)
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideGuard(ThrottlerGuard) // Disable rate limiting for tests
      .useValue(throttlerGuardMock)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Auth Flow', () => {
    it('/auth/login (POST) - Should auto-register a new Parent', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ idToken: 'valid-token' })
        .expect(201);

      expect(response.body).toHaveProperty('accessToken');
      expect(prismaMock.user.create).toHaveBeenCalled(); // Verify creation happened
    });

    it('/auth/login (POST) - Should fail with invalid token', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ idToken: 'invalid-token' })
        .expect(401);
    });
  });

  describe('RBAC & Security', () => {
    let parentToken: string;
    let schoolOwnerToken: string;

    beforeAll(async () => {
      // Login as Parent to get token
      const parentRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ idToken: 'valid-token' });
      parentToken = parentRes.body.accessToken;

      // Login as School Owner
      const schoolRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ idToken: 'school-owner-token' });
      schoolOwnerToken = schoolRes.body.accessToken;
    });

    it('/school-payments/pending (GET) - Should Block Public Access', async () => {
      await request(app.getHttpServer())
        .get('/school-payments/pending')
        .expect(401); // Unauthorized
    });

    it('/school-payments/pending (GET) - Should Block Parent Role', async () => {
      await request(app.getHttpServer())
        .get('/school-payments/pending')
        .set('Authorization', `Bearer ${parentToken}`)
        .expect(403); // Forbidden
    });

    it('/school-payments/pending (GET) - Should Allow School Owner', async () => {
      await request(app.getHttpServer())
        .get('/school-payments/pending')
        .set('Authorization', `Bearer ${schoolOwnerToken}`)
        .expect(200);
    });
  });
});
