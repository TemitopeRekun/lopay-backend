import { InviteExpiryService } from './invite-expiry.service';

describe('InviteExpiryService', () => {
  let prisma: { withLeaderLock: jest.Mock };
  let invites: { expireStale: jest.Mock; remindExpiring: jest.Mock };
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
    invites = {
      expireStale: jest.fn().mockResolvedValue(2),
      remindExpiring: jest.fn().mockResolvedValue(1),
    };
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

  /**
   * The nudge that makes a migration campaign visible while it can still be
   * saved.
   *
   * Addressed to the school, because the parent cannot be reached: by the
   * premise of the whole feature they have no account yet, so there is no
   * `userId` to write a notification against and no SMS or email provider to
   * fall back on. The school has the thread the link was sent in.
   */
  describe('expiry reminders', () => {
    it("runs under a lock of its OWN, not the sweep's", async () => {
      // A shared lock name would mean the hourly sweep, which holds it for 30
      // minutes, could starve the daily reminder out of ever running.
      await service.remindExpiringInvites();

      expect(prisma.withLeaderLock).toHaveBeenCalledWith(
        'enrollment-invite-expiry-reminder',
        30 * 60 * 1000,
        expect.any(Function),
      );
      expect(invites.remindExpiring).toHaveBeenCalledTimes(1);
    });

    it('does nothing when another instance holds the lock', async () => {
      // Without this, N instances would send N copies of the same nudge — and
      // `remindExpiring` dedupes by running once a day, not by row state, so
      // there is nothing downstream to catch a double send.
      prisma.withLeaderLock.mockResolvedValue(false);

      await service.remindExpiringInvites();

      expect(invites.remindExpiring).not.toHaveBeenCalled();
    });

    it('swallows a failure rather than throwing into the scheduler', async () => {
      // It shares a tick with every other job, and a courtesy nudge must not be
      // able to take the expiry sweep down with it.
      invites.remindExpiring.mockRejectedValue(new Error('db down'));

      await expect(service.remindExpiringInvites()).resolves.toBeUndefined();
    });

    it('does not touch the expiry sweep', async () => {
      await service.remindExpiringInvites();

      expect(invites.expireStale).not.toHaveBeenCalled();
    });
  });
});
