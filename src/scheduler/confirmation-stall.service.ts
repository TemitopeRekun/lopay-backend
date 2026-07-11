import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentTransactionStatus } from '../generated/prisma/client';
import { MetricsService } from '../common/observability/metrics.service';
import { captureMessage } from '../common/observability/sentry';

/**
 * Alerts when payments sit awaiting confirmation for too long (Milestone 5 —
 * observability). Runs hourly, records the current stalled count on the
 * `lopay_confirmations_stalled` gauge, and raises a Sentry warning when any
 * payment has waited past the threshold — the roadmap's "confirmations stalled
 * > 1h" alert.
 */
@Injectable()
export class ConfirmationStallService {
  private readonly logger = new Logger(ConfirmationStallService.name);

  /** A pending, unconfirmed payment older than this counts as stalled. */
  static readonly STALL_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async checkStalledConfirmations(): Promise<void> {
    // Leader lock so only one instance emits the alert when scaled to N. The
    // 30-min claim auto-expires well before the next hourly run.
    const ran = await this.prisma.withLeaderLock(
      'confirmation-stall-check',
      30 * 60 * 1000,
      async () => {
        await this.runCheck();
      },
    );
    if (!ran) {
      this.logger.log(
        'Stalled-confirmation check skipped (lock held by another instance)',
      );
    }
  }

  /** Count stalled confirmations, update the gauge, and alert if any. */
  async runCheck(): Promise<number> {
    const cutoff = new Date(
      Date.now() - ConfirmationStallService.STALL_THRESHOLD_MS,
    );
    const stalled = await this.prisma.payment.count({
      where: {
        status: PaymentTransactionStatus.PENDING,
        isConfirmed: false,
        paymentDate: { lt: cutoff },
      },
    });

    this.metrics.setStalledConfirmations(stalled);

    if (stalled > 0) {
      this.logger.warn(
        `${stalled} payment(s) awaiting confirmation for over 1h`,
      );
      captureMessage(
        `${stalled} payment(s) stalled awaiting confirmation for over 1h`,
        'warning',
        {
          stalled,
          thresholdMs: ConfirmationStallService.STALL_THRESHOLD_MS,
        },
      );
    } else {
      this.logger.log('No stalled confirmations');
    }

    return stalled;
  }
}
