import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentStatus } from '../generated/prisma/client';
import { LedgerService } from '../ledger/ledger.service';
import { Money } from '../common/money';

@Injectable()
export class DefaulterDetectionService {
  private readonly logger = new Logger(DefaulterDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Runs at midnight every day.
   * Finds active enrollments whose term has ended and still carry a balance,
   * then marks them as DEFAULTED and notifies the parent.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async detectDefaulters() {
    // Leader lock: when scaled to N instances, only one runs the job — otherwise
    // parents get duplicate "defaulted" notices and the audit log gets duplicate
    // rows. The daily claim auto-expires well before the next run.
    const ran = await this.prisma.withLeaderLock(
      'defaulter-detection',
      6 * 60 * 60 * 1000,
      () => this.runDetection(),
    );
    if (!ran) {
      this.logger.log(
        'Defaulter detection skipped (lock held by another instance)',
      );
    }
  }

  private async runDetection() {
    const now = new Date();
    this.logger.log(`Running defaulter detection at ${now.toISOString()}`);

    const overdue = await this.prisma.childEnrollment.findMany({
      where: {
        paymentStatus: PaymentStatus.ACTIVE,
        termEndDate: { lt: now },
        remainingBalance: { gt: 0 },
      },
      include: {
        child: { include: { parent: true } },
        school: true,
      },
    });

    if (overdue.length === 0) {
      this.logger.log('No new defaulters found');
      return;
    }

    this.logger.warn(
      `Marking up to ${overdue.length} enrollment(s) as DEFAULTED`,
    );

    // The per-row money-state flip (guarded write + audit + notify + emit) is
    // owned by LedgerService; this job only finds the candidates and logs.
    await Promise.all(
      overdue.map(async (enrollment) => {
        const flipped =
          await this.ledger.markEnrollmentDefaultedBySweep(enrollment);
        if (!flipped) return;

        this.logger.warn(
          `Defaulted enrollment ${enrollment.id} for ${enrollment.child.fullName} (balance: ${Money.fromKobo(enrollment.remainingBalance).formatNaira()})`,
        );
      }),
    );
  }
}
