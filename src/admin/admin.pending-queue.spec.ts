import { AdminService } from './admin.service';
import {
  PaymentReceiver,
  PaymentTransactionStatus,
  PaymentType,
} from '../generated/prisma/client';

/**
 * What the admin "pending first payments" queue is allowed to contain.
 *
 * A Paystack first payment is written PENDING at initiation — the instant the
 * popup opens, before any money moves. It therefore matched this queue's filters
 * exactly, so the approvals screen rendered a Settle button on uncollected money
 * (and a Reject that would strand a charge the parent went on to complete). Only
 * MANUAL first payments belong here; card ones reconcile themselves.
 */
describe('AdminService.getPendingFirstPayments — queue contents', () => {
  let prisma: { payment: { findMany: jest.Mock; count: jest.Mock } };
  let service: AdminService;

  beforeEach(() => {
    prisma = {
      payment: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new AdminService(
      prisma as never,
      {} as never, // notifications
      {} as never, // documents
      {} as never, // audit
      {} as never, // paystack
      {} as never, // ledger
      {} as never, // onboarding
      {} as never, // cache
    );
  });

  it('excludes Paystack-collected first payments from the queue', async () => {
    await service.getPendingFirstPayments();

    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paymentType: PaymentType.FIRST_PAYMENT,
          receiver: PaymentReceiver.PLATFORM,
          isConfirmed: false,
          status: PaymentTransactionStatus.PENDING,
          paystackReference: null,
        }),
      }),
    );
  });

  it('counts the same filtered set, so the badge cannot disagree with the list', async () => {
    await service.getPendingFirstPayments();

    const [{ where: listWhere }] = prisma.payment.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    const [{ where: countWhere }] = prisma.payment.count.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(countWhere).toEqual(listWhere);
    expect(countWhere.paystackReference).toBeNull();
  });
});
