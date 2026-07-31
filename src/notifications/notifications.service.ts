import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType, UserRole } from '../generated/prisma/client';
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
        // Omitted rather than defaulted here so the column default (PAYMENT) stays
        // the single source of truth for the fallback kind.
        ...(dto.type ? { type: dto.type } : {}),
        link: dto.link,
      },
    });

    this.events.pushNotification(notification.userId, notification);

    await this.sendPushNotification(
      dto.userId,
      dto.title,
      dto.message,
      dto.link,
    );

    return notification;
  }

  /**
   * Fan a platform announcement out to every parent.
   *
   * Rows are written with one `createMany` so the announcement is all-or-nothing;
   * the realtime push per recipient is then best-effort, because a socket or FCM
   * failure must not lose an announcement that is already persisted. Push is
   * batched to keep a large parent base from opening thousands of concurrent
   * sends at once.
   */
  async broadcastToParents(title: string, message: string, link?: string) {
    const parents = await this.prisma.user.findMany({
      where: { role: UserRole.PARENT, deletedAt: null },
      select: { id: true },
    });

    if (parents.length === 0) {
      return { recipients: 0 };
    }

    await this.prisma.notification.createMany({
      data: parents.map((p) => ({
        userId: p.id,
        title,
        message,
        link,
        // Typed at write time so the parent app's Announcements tab can find it.
        // Nothing in the wording distinguishes a broadcast from a payment event.
        type: NotificationType.ANNOUNCEMENT,
      })),
    });

    const PUSH_BATCH = 50;
    for (let i = 0; i < parents.length; i += PUSH_BATCH) {
      await Promise.allSettled(
        parents.slice(i, i + PUSH_BATCH).map(async (p) => {
          this.events.pushNotification(p.id, { title, message, link });
          await this.sendPushNotification(p.id, title, message, link);
        }),
      );
    }

    this.logger.log(`Broadcast "${title}" sent to ${parents.length} parent(s)`);
    return { recipients: parents.length };
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
