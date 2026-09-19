import { InviteExpiryService } from './invite-expiry.service';

describe('InviteExpiryService', () => {
  let prisma: { withLeaderLock: jest.Mock };
  let invites: { expireStale: jest.Mock };
  let service: InviteExpiryService;

  beforeEach(() => {
    prisma = {
      // Default: this instance wins the lock and the body runs.
      withLeaderLock: jest.fn(
        async (_name: string, _ttl: number, fn: () => Promise<void>) => {
          await fn();
          return true;
        },
      ),
    };
    invites = { expireStale: jest.fn().mockResolvedValue(2) };
    service = new InviteExpiryService(prisma as never, invites as never);
  });

  it('runs the sweep under a leader lock', async () => {
    await service.expireInvites();

    expect(prisma.withLeaderLock).toHaveBeenCalledWith(
      'enrollment-invite-expiry',
      30 * 60 * 1000,
      expect.any(Function),
    );
    expect(invites.expireStale).toHaveBeenCalledTimes(1);
  });

  it('does nothing when another instance holds the lock', async () => {
    // Horizontal scaling: N instances tick together, one does the UPDATE.
    prisma.withLeaderLock.mockResolvedValue(false);

    await service.expireInvites();

    expect(invites.expireStale).not.toHaveBeenCalled();
  });

  it('swallows a sweep failure rather than throwing into the scheduler', async () => {
    // An unhandled rejection here would take down the tick for every job that
    // shares it, and this one is only housekeeping — read paths already refuse
    // a lapsed invite whether or not the sweep ran.
    invites.expireStale.mockRejectedValue(new Error('db down'));

    await expect(service.expireInvites()).resolves.toBeUndefined();
  });

  it('releases the lock even when the sweep fails', async () => {
    invites.expireStale.mockRejectedValue(new Error('db down'));

    await service.expireInvites();

    // The error is caught INSIDE the locked section, so withLeaderLock resolves
    // normally and its claim is released rather than held until it times out.
    await expect(prisma.withLeaderLock.mock.results[0].value).resolves.toBe(
      true,
    );
  });
});
