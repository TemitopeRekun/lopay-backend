import { Injectable } from '@nestjs/common';
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';
import type {
  PaymentType,
  PaymentReceiver,
} from '../../generated/prisma/client';

/** Outcome of a money-state transition, used as the `outcome` metric label. */
export type PaymentOutcome = 'confirmed' | 'rejected' | 'reversed' | 'failed';

/**
 * Prometheus metrics for the money paths (Milestone 5 — observability).
 *
 * Owns its OWN registry (not the global default) so multiple instances — e.g.
 * one per test module — never collide on "metric already registered". The
 * `LedgerService` (the single owner of money transitions) calls the record
 * methods; the scheduled stall check sets the gauge; `MetricsController` renders
 * the registry at `GET /metrics`.
 *
 * What the roadmap asks for maps to:
 *   - payment volume   -> `lopay_payments_total{outcome,type,receiver}` (counter)
 *   - failure rate     -> the `outcome="failed"|"rejected"` share of that counter
 *   - confirm latency  -> `lopay_payment_confirm_latency_seconds` (histogram)
 *   - stalled alert    -> `lopay_confirmations_stalled` (gauge) + a Sentry message
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly payments: Counter<'outcome' | 'type' | 'receiver'>;
  private readonly confirmLatency: Histogram<'type'>;
  private readonly stalled: Gauge<string>;
  private readonly reconcileConflicts: Counter<'local_status'>;
  private readonly paystackFeeDelta: Gauge<string>;

  constructor() {
    this.registry.setDefaultLabels({ app: 'lopay-backend' });
    // Node process metrics (memory, CPU, event-loop lag) on the same registry.
    collectDefaultMetrics({ register: this.registry });

    this.payments = new Counter({
      name: 'lopay_payments_total',
      help: 'Count of money-state transitions by outcome, payment type and receiver',
      labelNames: ['outcome', 'type', 'receiver'],
      registers: [this.registry],
    });

    this.confirmLatency = new Histogram({
      name: 'lopay_payment_confirm_latency_seconds',
      help: 'Seconds from payment submission to confirmation',
      labelNames: ['type'],
      // Minutes → days: covers instant Paystack reconciles up to slow manual confirms.
      buckets: [60, 300, 900, 3600, 21600, 86400, 259200],
      registers: [this.registry],
    });

    this.stalled = new Gauge({
      name: 'lopay_confirmations_stalled',
      help: 'Payments awaiting confirmation for longer than the stall threshold',
      registers: [this.registry],
    });

    // Book-vs-bank breaks: Paystack says a charge succeeded, our row says
    // FAILED/REVERSED. Any non-zero value is money that needs a human.
    this.reconcileConflicts = new Counter({
      name: 'lopay_paystack_reconcile_conflicts_total',
      help: 'Successful Paystack charges that arrived for a non-PENDING payment',
      labelNames: ['local_status'],
      registers: [this.registry],
    });

    // Signed, cumulative drift between the Paystack fee we estimated (and routed
    // via transaction_charge) and the fee Paystack actually took off the platform
    // main account. Sustained positive drift = the platform is under-recovering.
    this.paystackFeeDelta = new Gauge({
      name: 'lopay_paystack_fee_delta_kobo',
      help: 'Cumulative actual-minus-estimated Paystack fee, in kobo',
      registers: [this.registry],
    });
  }

  /**
   * Record one money-state transition. Increments the volume counter and, for a
   * successful confirmation with a known submission time, observes the latency
   * histogram. Never throws — metrics must not break a money path.
   */
  recordPaymentOutcome(
    outcome: PaymentOutcome,
    opts: {
      type: PaymentType;
      receiver: PaymentReceiver;
      latencySeconds?: number;
    },
  ): void {
    try {
      this.payments.inc({
        outcome,
        type: opts.type,
        receiver: opts.receiver,
      });
      if (
        outcome === 'confirmed' &&
        typeof opts.latencySeconds === 'number' &&
        opts.latencySeconds >= 0
      ) {
        this.confirmLatency.observe({ type: opts.type }, opts.latencySeconds);
      }
    } catch {
      // swallow — a metrics failure must never affect the transition
    }
  }

  /** Set the current count of confirmations stalled past the threshold. */
  setStalledConfirmations(count: number): void {
    try {
      this.stalled.set(count);
    } catch {
      // swallow
    }
  }

  /**
   * Count a successful Paystack charge that arrived for a payment we had already
   * closed (FAILED/REVERSED). Alert on any increase — it is unreconciled money.
   */
  recordReconcileConflict(localStatus: string): void {
    try {
      this.reconcileConflicts.inc({ local_status: localStatus });
    } catch {
      // swallow
    }
  }

  /**
   * Accumulate the signed actual-minus-estimated Paystack fee for one reconciled
   * charge (kobo). Positive means Paystack took more than we routed to the platform
   * main account, i.e. the platform absorbed the difference.
   */
  recordPaystackFeeDelta(deltaKobo: number): void {
    try {
      if (!Number.isFinite(deltaKobo) || deltaKobo === 0) return;
      this.paystackFeeDelta.inc(deltaKobo);
    } catch {
      // swallow
    }
  }

  /** Render the registry in Prometheus text exposition format. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
