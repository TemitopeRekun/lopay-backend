import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateNotificationDto } from './dto/create.notification.dto';
import { EventsGateway } from '../events/events.gateway';
import { DeviceTokensService } from '../device-tokens/device-tokens.service';
import { FIREBASE_MESSAGING } from '../firebase/firebase.module';
import type { Messaging } from 'firebase-admin/messaging';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly deviceTokens: DeviceTokensService,
    @Inject(FIREBASE_MESSAGING) private readonly messaging: Messaging,
  ) {}

  async create(dto: CreateNotificationDto) {
    const notification = await this.prisma.notification.create({
      data: {
        userId: dto.userId,
        title: dto.title,
        message: dto.message,
        link: dto.link,
      },
    });

    this.events.pushNotification(notification.userId, notification);

    await this.sendPushNotification(dto.userId, dto.title, dto.message, dto.link);

    return notification;
  }

  async getUserNotifications(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async markAsRead(notificationId: string, userId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found or access denied');
    }

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });
  }

  /** Mark every unread notification for a user as read in one query. */
  async markAllAsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
    return { updated: result.count };
  }

  private async sendPushNotification(
    userId: string,
    title: string,
    body: string,
    link?: string,
  ) {
    try {
      const tokens = await this.deviceTokens.getTokensForUser(userId);
      if (tokens.length === 0) return;

      const response = await this.messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: link ? { link } : undefined,
      });

      // FCM error codes that mean the token is permanently invalid and should be
      // pruned (vs. transient errors like 'messaging/internal-error' or quota,
      // which we keep and retry on the next send).
      const PERMANENT_TOKEN_ERRORS = new Set([
        'messaging/registration-token-not-registered',
        'messaging/invalid-registration-token',
        'messaging/invalid-argument',
      ]);

      const invalidTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        const code = resp.error?.code;
        if (!resp.success && code && PERMANENT_TOKEN_ERRORS.has(code)) {
          invalidTokens.push(tokens[idx]);
        }
      });

      if (invalidTokens.length > 0) {
        await this.prisma.deviceToken.deleteMany({
          where: { token: { in: invalidTokens } },
        });
      }
    } catch (e) {
      // Push notifications are best-effort; never fail the core flow. Log so a
      // misconfigured/credential-expired Firebase doesn't fail silently.
      this.logger.warn(
        `Failed to send push notification to user ${userId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
