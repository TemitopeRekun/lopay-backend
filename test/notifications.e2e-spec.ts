import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { FirebaseAdminProvider } from '../src/firebase/firebase-admin.provider';
import { ThrottlerGuard } from '@nestjs/throttler';
import { UserRole } from '../src/generated/prisma/client';

describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let parentToken: string;
  let otherUserToken: string;

  const verifyIdTokenMock = jest.fn().mockImplementation((token) => {
    if (token === 'parent-token') {
      return Promise.resolve({
        email: 'parent@example.com',
        uid: 'firebase-uid-parent',
      });
    } else if (token === 'other-token') {
      return Promise.resolve({
        email: 'other@example.com',
        uid: 'firebase-uid-other',
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
    user: {
      findUnique: jest.fn().mockImplementation((args) => {
        if (args.where.email === 'parent@example.com') {
          return Promise.resolve({
            id: 'user-parent',
            email: 'parent@example.com',
            role: UserRole.PARENT,
          });
        } else if (args.where.email === 'other@example.com') {
          return Promise.resolve({
            id: 'user-other',
            email: 'other@example.com',
            role: UserRole.PARENT,
          });
        }
        return Promise.resolve(null);
      }),
    },
    notification: {
      findMany: jest.fn().mockImplementation((args) => {
        if (args.where.userId === 'user-parent') {
          return Promise.resolve([
            {
              id: 'notif-1',
              userId: 'user-parent',
              title: 'Welcome',
              isRead: false,
              createdAt: new Date(),
            },
          ]);
        }
        return Promise.resolve([]);
      }),
      findFirst: jest.fn().mockImplementation((args) => {
        if (args.where.id === 'notif-1' && args.where.userId === 'user-parent') {
          return Promise.resolve({
            id: 'notif-1',
            userId: 'user-parent',
            isRead: false,
          });
        }
        // Simulating access denied or not found
        return Promise.resolve(null);
      }),
      update: jest.fn().mockResolvedValue({
        id: 'notif-1',
        isRead: true,
      }),
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

    const otherRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ idToken: 'other-token' });
    otherUserToken = otherRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Notification Security', () => {
    it('/notifications (GET) - Should return user notifications', async () => {
      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${parentToken}`)
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe('notif-1');
      expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-parent' } })
      );
    });

    it('/notifications/:id/read (PATCH) - Should mark own notification as read', async () => {
      await request(app.getHttpServer())
        .patch('/notifications/notif-1/read')
        .set('Authorization', `Bearer ${parentToken}`)
        .expect(200);

      expect(prismaMock.notification.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'notif-1' },
          data: { isRead: true },
        })
      );
    });

    it('/notifications/:id/read (PATCH) - Should fail for other user notification', async () => {
      // User 'user-other' tries to read 'notif-1' (which belongs to 'user-parent')
      await request(app.getHttpServer())
        .patch('/notifications/notif-1/read')
        .set('Authorization', `Bearer ${otherUserToken}`)
        .expect(404); // Should return 404 because findFirst({ id, userId }) returns null
    });
  });
});