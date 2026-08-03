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
      createMany: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
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

  describe('broadcastToParents', () => {
    it('writes one row per parent and pushes to each', async () => {
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'p1' },
        { id: 'p2' },
        { id: 'p3' },
      ]);
      mockPrisma.notification.createMany.mockResolvedValue({ count: 3 });

      const res = await service.broadcastToParents('Notice', 'Body', '/x');

      expect(res).toEqual({ recipients: 3 });
      expect(mockPrisma.notification.createMany).toHaveBeenCalledWith({
        data: [
          {
            userId: 'p1',
            title: 'Notice',
            message: 'Body',
            link: '/x',
            type: 'ANNOUNCEMENT',
          },
          {
            userId: 'p2',
            title: 'Notice',
            message: 'Body',
            link: '/x',
            type: 'ANNOUNCEMENT',
          },
          {
            userId: 'p3',
            title: 'Notice',
            message: 'Body',
            link: '/x',
            type: 'ANNOUNCEMENT',
          },
        ],
      });
      expect(mockEvents.pushNotification).toHaveBeenCalledTimes(3);
    });

    it('targets only live parent accounts', async () => {
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockPrisma.notification.createMany.mockResolvedValue({ count: 1 });

      await service.broadcastToParents('T', 'M');

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        where: { role: 'PARENT', deletedAt: null },
        select: { id: true },
      });
    });

    it('types every row ANNOUNCEMENT so the parent app can filter it', async () => {
      // Nothing in a broadcast's wording distinguishes it from a payment event, so
      // the kind has to be persisted or the Announcements tab stays empty.
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
      mockPrisma.notification.createMany.mockResolvedValue({ count: 2 });

      await service.broadcastToParents('Term resumes', 'On Monday');

      const { data } = mockPrisma.notification.createMany.mock.calls[0][0] as {
        data: { type: string }[];
      };
      expect(data.every((row) => row.type === 'ANNOUNCEMENT')).toBe(true);
    });

    it('writes nothing when there are no parents', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);

      const res = await service.broadcastToParents('T', 'M');

      expect(res).toEqual({ recipients: 0 });
      expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
    });

    it('still reports success when a push fails after rows are persisted', async () => {
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
      mockPrisma.notification.createMany.mockResolvedValue({ count: 2 });
      // An announcement already committed must not be lost to a transport error.
      mockDeviceTokens.getTokensForUser.mockRejectedValue(
        new Error('fcm down'),
      );

      await expect(service.broadcastToParents('T', 'M')).resolves.toEqual({
        recipients: 2,
      });
    });
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

    it('omits type when the caller gives none, so the column default applies', async () => {
      await service.create(dto);

      const { data } = mockPrisma.notification.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect('type' in data).toBe(false);
    });

    it('persists the caller-supplied type', async () => {
      await service.create({ ...dto, type: 'ALERT' as never });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'ALERT' }),
      });
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

  /**
   * The notification list was the one endpoint the pagination work missed: it
   * returned a user's entire history, and every client polls it on a five-minute
   * fallback from every screen.
   */
  describe('getUserNotifications', () => {
    it('bounds the list and counts unread separately from the window', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([{ id: 'n1' }]);
      mockPrisma.notification.count.mockResolvedValue(7);

      const res = await service.getUserNotifications('u1');

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      // Counted server-side, so the badge stays exact even when the unread rows
      // fall outside the returned window.
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: { userId: 'u1', isRead: false },
      });
      expect(res).toEqual({
        items: [{ id: 'n1' }],
        unreadCount: 7,
        limit: 100,
      });
    });

    it('honours a smaller caller limit', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);
      mockPrisma.notification.count.mockResolvedValue(0);

      await service.getUserNotifications('u1', 10);

      expect(mockPrisma.notification.findMany.mock.calls[0][0].take).toBe(10);
    });

    it('caps an over-large limit rather than serving the whole table', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);
      mockPrisma.notification.count.mockResolvedValue(0);

      await service.getUserNotifications('u1', 100_000);

      expect(mockPrisma.notification.findMany.mock.calls[0][0].take).toBe(200);
    });

    it.each([-5, 0, Number.NaN])(
      'falls back to the default for the nonsense limit %p',
      async (limit) => {
        // `?limit=abc` reaches the service as NaN. Clamping garbage to a single
        // row would silently starve the notification screen; the default is the
        // only safe reading of an unintelligible request.
        mockPrisma.notification.findMany.mockResolvedValue([]);
        mockPrisma.notification.count.mockResolvedValue(0);

        await service.getUserNotifications('u1', limit);

        expect(mockPrisma.notification.findMany.mock.calls[0][0].take).toBe(
          100,
        );
      },
    );
  });
});
