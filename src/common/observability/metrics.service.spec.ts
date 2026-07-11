import { MetricsService } from './metrics.service';
import { PaymentType, PaymentReceiver } from '../../generated/prisma/client';

describe('MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  it('registers the payment metric families', async () => {
    const out = await metrics.render();
    expect(out).toContain('lopay_payments_total');
    expect(out).toContain('lopay_payment_confirm_latency_seconds');
    expect(out).toContain('lopay_confirmations_stalled');
  });

  it('counts a confirmed payment and observes its latency', async () => {
    metrics.recordPaymentOutcome('confirmed', {
      type: PaymentType.INSTALLMENT,
      receiver: PaymentReceiver.PLATFORM,
      latencySeconds: 120,
    });
    const out = await metrics.render();
    expect(out).toMatch(
      /lopay_payments_total\{[^}]*outcome="confirmed"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /lopay_payment_confirm_latency_seconds_count\{[^}]*type="INSTALLMENT"[^}]*\} 1/,
    );
  });

  it('counts a failed payment without observing latency', async () => {
    metrics.recordPaymentOutcome('failed', {
      type: PaymentType.FIRST_PAYMENT,
      receiver: PaymentReceiver.PLATFORM,
    });
    const out = await metrics.render();
    expect(out).toMatch(/lopay_payments_total\{[^}]*outcome="failed"[^}]*\} 1/);
    // No confirm-latency observation was made for this outcome.
    expect(out).not.toContain('lopay_payment_confirm_latency_seconds_count{');
  });

  it('sets the stalled-confirmations gauge', async () => {
    metrics.setStalledConfirmations(3);
    const out = await metrics.render();
    expect(out).toMatch(/lopay_confirmations_stalled(\{[^}]*\})? 3/);
  });

  it('never throws from a record call', () => {
    expect(() =>
      metrics.recordPaymentOutcome('reversed', {
        type: PaymentType.INSTALLMENT,
        receiver: PaymentReceiver.SCHOOL,
      }),
    ).not.toThrow();
  });
});
