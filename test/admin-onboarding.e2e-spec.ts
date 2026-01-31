import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { FirebaseAdminProvider } from '../src/firebase/firebase-admin.provider';
import { ThrottlerGuard } from '@nestjs/throttler';
import { UserRole } from '../src/generated/prisma/client';

describe('Admin Onboarding (e2e)', () => {
  let app: INestApplication;
  let superAdminToken: string;

  const verifyIdTokenMock = jest.fn().mockImplementation((token) => {
    if (token === 'super-admin-token') {
      return Promise.resolve({
        email: 'admin@lopay.com',
        uid: 'firebase-uid-admin',
      });
    }
    return Promise.reject(new Error('Invalid token'));
  });

  const createUserMock = jest.fn().mockResolvedValue({
    uid: 'firebase-new-school-owner',
    email: 'newowner@school.com',
  });

  const firebaseMock = {
    auth: () => ({
      verifyIdToken: verifyIdTokenMock,
      createUser: createUserMock,
    }),
  };

  const prismaMock = {
    $transaction: jest.fn().mockImplementation((callback) => callback(prismaMock)),
    user: {
      findUnique: jest.fn().mockImplementation((args) => {
        if (args.where.email === 'admin@lopay.com') {
          return Promise.resolve({
            id: 'user-admin',
            email: 'admin@lopay.com',
            role: UserRole.SUPER_ADMIN,
          });
        }
        return Promise.resolve(null); // Return null for new user check
      }),
      create: jest.fn().mockResolvedValue({
        id: 'firebase-new-school-owner',
        email: 'newowner@school.com',
        role: UserRole.SCHOOL_OWNER,
      }),
    },
    school: {
      create: jest.fn().mockResolvedValue({
        id: 'new-school-id',
        name: 'Springfield High',
        ownerId: 'firebase-new-school-owner',
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

    // Get Super Admin Token
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ idToken: 'super-admin-token' });
    superAdminToken = res.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('School Onboarding', () => {
    it('/admin/onboard-school (POST) - Should create school and owner', async () => {
      const dto = {
        schoolName: 'Springfield High',
        ownerName: 'Principal Skinner',
        ownerEmail: 'newowner@school.com',
        ownerPassword: 'securepassword123',
        address: '123 School Lane',
        phone: '08012345678',
      };

      await request(app.getHttpServer())
        .post('/admin/onboard-school')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(dto)
        .expect(201);

      // Verify Firebase user creation
      expect(createUserMock).toHaveBeenCalledWith({
        email: dto.ownerEmail,
        password: dto.ownerPassword,
        displayName: dto.ownerName,
      });

      // Verify DB User creation
      expect(prismaMock.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: dto.ownerEmail,
            role: UserRole.SCHOOL_OWNER,
          }),
        })
      );

      // Verify DB School creation
      expect(prismaMock.school.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: dto.schoolName,
            address: dto.address,
            phone: dto.phone,
            email: dto.ownerEmail,
          }),
        })
      );
    });
  });
});