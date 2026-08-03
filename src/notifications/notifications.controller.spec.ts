import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/decorators/user.decorator';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  const service = {
    getUserNotifications: jest.fn().mockResolvedValue([]),
    markAllAsRead: jest.fn().mockResolvedValue({ count: 0 }),
    markAsRead: jest.fn().mockResolvedValue({ id: 'n1' }),
  };

  const user: AuthUser = {
    userId: 'user-1',
    role: UserRole.PARENT,
    schoolId: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: service }],
    }).compile();
    controller = module.get<NotificationsController>(NotificationsController);
  });

  it('scopes getUserNotifications to the authenticated user', async () => {
    await controller.getUserNotifications(user);
    expect(service.getUserNotifications).toHaveBeenCalledWith(
      'user-1',
      undefined,
    );
  });

  it('passes a caller-supplied limit through as a number', async () => {
    await controller.getUserNotifications(user, '25');
    expect(service.getUserNotifications).toHaveBeenCalledWith('user-1', 25);
  });

  it('scopes markAllAsRead to the authenticated user', async () => {
    await controller.markAllAsRead(user);
    expect(service.markAllAsRead).toHaveBeenCalledWith('user-1');
  });

  it('passes the notification id AND the caller userId to markAsRead', async () => {
    await controller.markAsRead('n1', user);
    expect(service.markAsRead).toHaveBeenCalledWith('n1', 'user-1');
  });
});
