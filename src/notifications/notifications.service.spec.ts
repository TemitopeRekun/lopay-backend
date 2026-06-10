import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { DeviceTokensService } from '../device-tokens/device-tokens.service';
import { FIREBASE_MESSAGING } from '../firebase/firebase.module';

describe('NotificationsService', () => {
  let service: NotificationsService;

  const mockPrisma = {
    notification: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    deviceToken: {
      deleteMany: jest.fn(),
    },
  };

  const mockEvents = {
    pushNotification: jest.fn(),
  };

  const mockDeviceTokens = {
    getTokensForUser: jest.fn(),
  };

  const mockMessaging = {
    sendEachForMulticast: jest.fn(),
  };

  const dto = {
    userId: 'user-1',
    title: 'Payment received',
    message: 'Your payment was confirmed',
    link: '/payments/1',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.notification.create.mockResolvedValue({
      id: 'notif-1',
      ...dto,
    });
    mockDeviceTokens.getTokensForUser.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventsGateway, useValue: mockEvents },
        { provide: DeviceTokensService, useValue: mockDeviceTokens },
        { provide: FIREBASE_MESSAGING, useValue: mockMessaging },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('persists the notification and emits it over the websocket', async () => {
      const result = await service.create(dto);

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: {
          userId: dto.userId,
          title: dto.title,
          message: dto.message,
          link: dto.link,
        },
      });
      expect(mockEvents.pushNotification).toHaveBeenCalledWith(
        dto.userId,
        expect.objectContaining({ id: 'notif-1' }),
      );
      expect(result).toEqual(expect.objectContaining({ id: 'notif-1' }));
    });

    it('skips FCM when the user has no device tokens', async () => {
      mockDeviceTokens.getTokensForUser.mockResolvedValue([]);

      await service.create(dto);

      expect(mockMessaging.sendEachForMulticast).not.toHaveBeenCalled();
    });

    it('sends a multicast push to all of the user tokens', async () => {
      mockDeviceTokens.getTokensForUser.mockResolvedValue(['tok-a', 'tok-b']);
      mockMessaging.sendEachForMulticast.mockResolvedValue({
        responses: [{ success: true }, { success: true }],
      });

      await service.create(dto);

      expect(mockMessaging.sendEachForMulticast).toHaveBeenCalledWith({
        tokens: ['tok-a', 'tok-b'],
        notification: { title: dto.title, body: dto.message },
        data: { link: dto.link },
      });
      expect(mockPrisma.deviceToken.deleteMany).not.toHaveBeenCalled();
    });

    it('prunes tokens FCM reports as no-longer-registered', async () => {
      mockDeviceTokens.getTokensForUser.mockResolvedValue(['good', 'stale']);
      mockMessaging.sendEachForMulticast.mockResolvedValue({
        responses: [
          { success: true },
          {
            success: false,
            error: { code: 'messaging/registration-token-not-registered' },
          },
        ],
      });

      await service.create(dto);

      expect(mockPrisma.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { token: { in: ['stale'] } },
      });
    });

    it('does not prune tokens for transient send errors', async () => {
      mockDeviceTokens.getTokensForUser.mockResolvedValue(['tok']);
      mockMessaging.sendEachForMulticast.mockResolvedValue({
        responses: [
          { success: false, error: { code: 'messaging/internal-error' } },
        ],
      });

      await service.create(dto);

      expect(mockPrisma.deviceToken.deleteMany).not.toHaveBeenCalled();
    });

    it('never throws when push delivery fails (best-effort)', async () => {
      mockDeviceTokens.getTokensForUser.mockResolvedValue(['tok']);
      mockMessaging.sendEachForMulticast.mockRejectedValue(
        new Error('FCM unavailable'),
      );

      await expect(service.create(dto)).resolves.toEqual(
        expect.objectContaining({ id: 'notif-1' }),
      );
    });
  });

  describe('markAsRead', () => {
    it('throws when the notification does not belong to the user', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null);

      await expect(service.markAsRead('notif-x', 'user-1')).rejects.toThrow(
        'Notification not found or access denied',
      );
      expect(mockPrisma.notification.update).not.toHaveBeenCalled();
    });

    it('marks the notification read when owned by the user', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue({ id: 'notif-1' });
      mockPrisma.notification.update.mockResolvedValue({
        id: 'notif-1',
        isRead: true,
      });

      const result = await service.markAsRead('notif-1', 'user-1');

      expect(mockPrisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'notif-1' },
        data: { isRead: true },
      });
      expect(result).toEqual({ id: 'notif-1', isRead: true });
    });
  });
});
