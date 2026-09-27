import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EnrollmentInvitesService } from '../enrollment-invites/enrollment-invites.service';
import { errorMessage } from '../common/errors';

/**
 * Retires enrollment invites whose claim window has closed.
 *
 * ## Why this is housekeeping rather than a security control
 *
 * It would be a serious bug if an invite were only unclaimable because a cron
 * job had got round to it. It is not: every read path re-checks `expiresAt`
 * against the clock, and the conditional write inside `claim` carries
 * `expiresAt: { gt: now }`, so a lapsed invite is refused whether or not this
 * has run. The sweep exists so the school's list tells the truth, and so a
 * lapsed invite stops holding its student's slot in the partial unique index —
 * without which a school would have to revoke an already-dead invite by hand
 * before re-issuing.
 *
 * Hourly is ample for both of those. The expensive precision — an invite being
 * refused the second it lapses — is already handled at read time for free.
 */
@Injectable()
export class InviteExpiryService {
  private readonly logger = new Logger(InviteExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invites: EnrollmentInvitesService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async expireInvites(): Promise<void> {
    // Leader lock so N instances do not all run the same UPDATE. The 30-minute
    // claim auto-expires comfortably before the next hourly tick.
    const ran = await this.prisma.withLeaderLock(
      'enrollment-invite-expiry',
      30 * 60 * 1000,
      async () => {
        // A scheduled job must never throw into the scheduler: an unhandled
        // rejection here takes down the tick for every job that shares it.
        try {
          await this.invites.expireStale();
        } catch (error) {
          this.logger.error(
            `Invite expiry sweep failed: ${errorMessage(error)}`,
          );
        }
      },
    );
    if (!ran) {
      this.logger.log(
        'Invite expiry sweep skipped (lock held by another instance)',
      );
    }
  }

  /**
   * Warn schools about links lapsing in three days, once a day.
   *
   * ## Why this is daily and the sweep above is hourly
   *
   * They answer different questions. The sweep keeps the DATA honest, and an
   * invite that lapses at 14:05 should not still read PENDING at 15:00 — so it
   * runs often and cheaply. This one asks a human to go and chase a parent, and
   * the same request repeated every hour is one a school stops reading.
   *
   * Daily is also what makes the reminder exactly-once without a column to
   * track it: `remindExpiring` selects a 24-hour bucket, so one run per day
   * means every invite is selected once in its life. Running it hourly would
   * send the same school the same nudge twenty-four times. The cadence is not
   * a tuning choice — it is load-bearing for the dedupe.
   *
   * Eight in the morning UTC is nine in Lagos: inside the school day, early
   * enough that acting on it is still today's work.
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async remindExpiringInvites(): Promise<void> {
    // Held for well over the run, and comfortably under the 24h gap to the next
    // one, so a second instance cannot double-send.
    const ran = await this.prisma.withLeaderLock(
      'enrollment-invite-expiry-reminder',
      30 * 60 * 1000,
      async () => {
        try {
          await this.invites.remindExpiring();
        } catch (error) {
          this.logger.error(
            `Invite expiry reminder failed: ${errorMessage(error)}`,
          );
        }
      },
    );
    if (!ran) {
      this.logger.log(
        'Invite expiry reminder skipped (lock held by another instance)',
      );
    }
  }
}
