import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentTransactionStatus } from '../generated/prisma/client';
import { PaystackService } from '../paystack/paystack.service';
import { EnrollmentService } from '../enrollment/enrollment.service';

/**
 * Orphaned-payment sweeper — the defining fintech ops safeguard.
 *
 * A first payment is activated by the Paystack `charge.success` webhook or the
 * frontend's verify-on-return. If BOTH are lost (e.g. the browser closes and a
 * webhook is dropped during a cold start), the money is captured + split at
 * Paystack but the enrollment is stuck PENDING forever. This job periodically
 * re-verifies stale PENDING Paystack payments and routes them through the same
 * idempotent reconcile/fail paths, so a lost webhook becomes recoverable. It
 * also surfaces a count of long-stuck payments so the gap is observable.
 */
@Injectable()
export class PaystackReconciliationService {
  private readonly logger = new Logger(PaystackReconciliationService.name);

  // Don't verify too eagerly — give the popup/webhook a moment to land.
  private static readonly MIN_AGE_MS = 5 * 60 * 1000; // 5 min
  // After this, an unresolved payment is abandoned (marked FAILED, retryable).
  private static readonly ABANDON_AGE_MS = 24 * 60 * 60 * 1000; // 24 h

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly enrollment: EnrollmentService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweep() {
    const ran = await this.prisma.withLeaderLock(
      'paystack-reconciliation',
      5 * 60 * 1000,
      () => this.runSweep(),
    );
    if (!ran) {
      this.logger.debug('Paystack sweep skipped (lock held by another instance)');
    }
  }

  private async runSweep() {
    const now = Date.now();
    const stale = await this.prisma.payment.findMany({
      where: {
        status: PaymentTransactionStatus.PENDING,
        paystackReference: { not: null },
        paymentDate: { lt: new Date(now - PaystackReconciliationService.MIN_AGE_MS) },
      },
      select: { id: true, paystackReference: true, paymentDate: true },
      take: 100,
    });

    if (stale.length === 0) return;
    this.logger.warn(`Reconciling ${stale.length} stale PENDING Paystack payment(s)`);

    for (const p of stale) {
      const reference = p.paystackReference as string;
      try {
        const result = await this.paystack.verifyTransaction(reference);
        if (result.status === 'success') {
          await this.enrollment.reconcilePaystackPayment(reference, result.fees, null);
          this.logger.log(`Recovered stuck payment ${reference} via sweep`);
        } else if (result.status === 'failed') {
          await this.enrollment.failPaystackPayment(reference);
        } else if (
          now - new Date(p.paymentDate).getTime() >
          PaystackReconciliationService.ABANDON_AGE_MS
        ) {
          // Still unresolved (abandoned/never-completed) after the window — fail it
          // so the enrollment can be retried rather than dangling forever.
          await this.enrollment.failPaystackPayment(reference);
          this.logger.warn(`Abandoned stale payment ${reference} (status=${result.status})`);
        }
      } catch (err) {
        this.logger.error(
          `Sweep failed to verify ${reference}: ${(err as Error).message}`,
        );
      }
    }
  }
}
