import { ConfirmationStallService } from './confirmation-stall.service';
import * as sentry from '../common/observability/sentry';

describe('ConfirmationStallService', () => {
  let prisma: {
    payment: { count: jest.Mock };
    withLeaderLock: jest.Mock;
  };
  let metrics: { setStalledConfirmations: jest.Mock };
  let service: ConfirmationStallService;
  let captureSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      payment: { count: jest.fn() },
      withLeaderLock: jest.fn(),
    };
    metrics = { setStalledConfirmations: jest.fn() };
    service = new ConfirmationStallService(prisma as never, metrics as never);
    captureSpy = jest
      .spyOn(sentry, 'captureMessage')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('counts only pending, unconfirmed payments older than the 1h threshold', async () => {
    prisma.payment.count.mockResolvedValue(0);
    await service.runCheck();
    const where = prisma.payment.count.mock.calls[0][0].where;
    expect(where.status).toBe('PENDING');
    expect(where.isConfirmed).toBe(false);
    expect(where.paymentDate.lt).toBeInstanceOf(Date);
    // cutoff is ~1h in the past
    const ageMs = Date.now() - (where.paymentDate.lt as Date).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 5000);
    expect(ageMs).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
  });

  it('sets the gauge and raises a Sentry alert when payments are stalled', async () => {
    prisma.payment.count.mockResolvedValue(4);
    const n = await service.runCheck();
    expect(n).toBe(4);
    expect(metrics.setStalledConfirmations).toHaveBeenCalledWith(4);
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy.mock.calls[0][0]).toContain('4 payment(s) stalled');
  });

  it('sets the gauge to 0 and does not alert when none are stalled', async () => {
    prisma.payment.count.mockResolvedValue(0);
    const n = await service.runCheck();
    expect(n).toBe(0);
    expect(metrics.setStalledConfirmations).toHaveBeenCalledWith(0);
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('runs the check under a leader lock', async () => {
    prisma.withLeaderLock.mockResolvedValue(true);
    await service.checkStalledConfirmations();
    expect(prisma.withLeaderLock).toHaveBeenCalledWith(
      'confirmation-stall-check',
      30 * 60 * 1000,
      expect.any(Function),
    );
  });
});
