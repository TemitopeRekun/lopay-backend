import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType, UserRole } from '../generated/prisma/client';
import { CreateNotificationDto } from './dto/create.notification.dto';
import { EventsGateway } from '../events/events.gateway';
import { DeviceTokensService } from '../device-tokens/device-tokens.service';
import { FIREBASE_MESSAGING } from '../firebase/firebase.module';
import type { Messaging } from 'firebase-admin/messaging';

/**
 * Android notification channel every push is posted to.
 *
 * Must match `ANDROID_CHANNEL_ID` in the client's `services/push/config.ts` and
 * the `default_notification_channel_id` meta-data in AndroidManifest.xml.
 * Android 8+ silently DROPS a notification naming a channel that does not
 * exist, and the drop is invisible from here — FCM still reports success,
 * because delivery to the device did succeed. Changing this string requires
 * changing it in all three places at once.
 */
const ANDROID_CHANNEL_ID = 'lopay-payments';

/**
 * Sound file for the Android channel, in `android/app/src/main/res/raw`,
 * without extension — which is the form the FCM `android.notification.sound`
 * field takes.
 *
 * Note this only applies where Android builds the notification from the payload
 * itself. For a channel that already exists on the device, the CHANNEL's sound
 * wins: Android deliberately ignores per-message sound so a user's own settings
 * cannot be overridden by the sender. This field therefore matters on the first
 * delivery before the app has run, and on pre-Oreo devices.
 */
const ANDROID_SOUND = 'lopay_alert';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /**
   * Origin of the web client, used to build the absolute URL a web push opens.
   *
   * Optional. Falls back to the first configured CORS origin — which is the web
   * client by definition — so a deployment that never sets it still gets
   * working click-through. If neither is set the link is simply omitted and a
   * click focuses the app at its root.
   */
  private readonly webAppUrl: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly deviceTokens: DeviceTokensService,
    @Inject(FIREBASE_MESSAGING) private readonly messaging: Messaging,
    config: ConfigService,
  ) {
    const explicit = config.get<string>('WEB_APP_URL')?.trim();
    const firstCorsOrigin = config
      .get<string>('CORS_ORIGINS')
      ?.split(',')[0]
      ?.trim();
    const candidate = explicit || firstCorsOrigin;

    // Validate rather than trust: a malformed value would produce a link the
    // browser refuses to open, turning every push click into a no-op.
    try {
      this.webAppUrl = candidate ? new URL(candidate).origin : undefined;
    } catch {
      this.logger.warn(
        `Ignoring unparseable web app origin "${candidate}" — push notification links will be omitted.`,
      );
      this.webAppUrl = undefined;
    }
  }

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

    await this.sendPushNotification(dto.userId, {
      title: notification.title,
      body: notification.message,
      link: notification.link ?? undefined,
      // Sent so the client can mark the row read straight from a notification
      // tap, and so the in-app pop-up can pick its icon without a refetch.
      notificationId: notification.id,
      type: notification.type,
    });

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
          await this.sendPushNotification(p.id, {
            title,
            body: message,
            link,
            type: NotificationType.ANNOUNCEMENT,
          });
        }),
      );
    }

    this.logger.log(`Broadcast "${title}" sent to ${parents.length} parent(s)`);
    return { recipients: parents.length };
  }

  /**
   * A user's notifications, newest first.
   *
   * Bounded. This was the one list endpoint the pagination work missed: it
   * returned a user's ENTIRE history, and every client polls it on a five-minute
   * fallback from every screen, so a long-lived account's dashboard load grew
   * without limit. The window is generous enough that the notification screen
   * still shows everything anyone scrolls to, and `unreadCount` is counted
   * server-side so the badge stays exact regardless of the window.
   */
  static readonly LIST_LIMIT = 100;
  static readonly MAX_LIST_LIMIT = 200;

  async getUserNotifications(userId: string, limit?: number) {
    // A malformed limit (NaN from `Number('abc')`, zero, a negative) falls back
    // to the DEFAULT, not to 1 — same contract as `parseTake` on the history
    // endpoint. Clamping garbage to a single row silently starves the screen.
    const requested =
      limit !== undefined && Number.isFinite(limit) && Math.trunc(limit) > 0
        ? Math.trunc(limit)
        : NotificationsService.LIST_LIMIT;
    const take = Math.min(requested, NotificationsService.MAX_LIST_LIMIT);

    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    return { items, unreadCount, limit: take };
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

  /**
   * Build the FCM message for one recipient.
   *
   * Kept separate and pure so the payload can be asserted in a unit test — the
   * per-platform blocks below are exactly the kind of thing that silently rots,
   * because getting them wrong produces a push that FCM reports as *delivered*
   * and the user never sees.
   *
   * Every send carries BOTH a `notification` block and a `data` block, on
   * purpose:
   *   - `notification` is what makes the OS display it while the app is closed,
   *     with no code of ours running. A data-only message would need our
   *     service worker (web) or a background handler (Android) to survive and
   *     execute — and if either failed, Chrome posts its own generic "This site
   *     has been updated in the background" notice instead.
   *   - `data` is what the app reads when it IS running, to render the in-app
   *     pop-up and route the tap. FCM requires every data value to be a string,
   *     so undefined entries are dropped rather than stringified to "undefined".
   */
  private buildPushMessage(payload: {
    title: string;
    body: string;
    link?: string;
    notificationId?: string;
    type?: NotificationType;
  }) {
    const data: Record<string, string> = {
      title: payload.title,
      body: payload.body,
    };
    if (payload.link) data.link = payload.link;
    if (payload.notificationId) data.notificationId = payload.notificationId;
    if (payload.type) data.type = payload.type;

    // `link` is stored as an app-relative route (e.g. "/notifications"); the web
    // needs an absolute URL. The app runs on HashRouter, so the route lives in
    // the fragment — "/#/notifications", not "/notifications", which would 404
    // through to the SPA fallback and land on the wrong screen.
    const webLink =
      this.webAppUrl && payload.link
        ? `${this.webAppUrl}/#${payload.link}`
        : this.webAppUrl;

    return {
      notification: { title: payload.title, body: payload.body },
      data,
      android: {
        // Wakes the device and shows a heads-up banner. A confirmed or rejected
        // school-fee payment is time-sensitive; 'normal' lets Android hold it
        // until the next maintenance window in Doze.
        priority: 'high' as const,
        notification: {
          channelId: ANDROID_CHANNEL_ID,
          sound: ANDROID_SOUND,
          icon: 'ic_stat_lopay',
          color: '#4A90E2',
          // Collapses repeats about the same notification into one row instead
          // of stacking. Falls back to a constant tag so at worst everything
          // collapses — better than a parent waking to fourteen entries.
          tag: payload.notificationId ?? 'lopay-notification',
        },
      },
      webpush: {
        headers: {
          // Four weeks. A payment confirmation is still worth showing to
          // someone who reopens their laptop days later; the FCM default of the
          // same order is made explicit so it cannot drift.
          TTL: '2419200',
        },
        notification: {
          icon: '/icons/notification-icon.png',
          badge: '/icons/notification-badge.png',
          tag: payload.notificationId ?? 'lopay-notification',
        },
        // What a click opens or focuses. Must be https (or localhost) or FCM
        // rejects the send outright.
        ...(webLink ? { fcmOptions: { link: webLink } } : {}),
      },
      apns: {
        // No iOS build ships yet, but the block is cheap and its absence is the
        // kind of thing that gets discovered the week iOS launches.
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    };
  }

  private async sendPushNotification(
    userId: string,
    payload: {
      title: string;
      body: string;
      link?: string;
      notificationId?: string;
      type?: NotificationType;
    },
  ) {
    try {
      const tokens = await this.deviceTokens.getTokensForUser(userId);
      if (tokens.length === 0) return;

      const response = await this.messaging.sendEachForMulticast({
        tokens,
        ...this.buildPushMessage(payload),
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
