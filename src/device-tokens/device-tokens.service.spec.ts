import { DeviceTokensService } from './device-tokens.service';

describe('DeviceTokensService', () => {
  const prisma = {
    deviceToken: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const service = new DeviceTokensService(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  describe('register', () => {
    it('upserts, reassigning the token to the current owner on conflict', async () => {
      prisma.deviceToken.upsert.mockResolvedValueOnce({ id: 'd1' });
      const result = await service.register('u1', {
        token: 'tok',
        platform: 'ios',
      });
      expect(prisma.deviceToken.upsert).toHaveBeenCalledWith({
        where: { token: 'tok' },
        update: { userId: 'u1', platform: 'ios' },
        create: { userId: 'u1', token: 'tok', platform: 'ios' },
      });
      expect(result).toEqual({ id: 'd1' });
    });
  });

  describe('unregister', () => {
    it('scopes the delete to the caller (token + userId)', async () => {
      prisma.deviceToken.deleteMany.mockResolvedValueOnce({ count: 1 });
      await service.unregister('u1', 'tok');
      expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { token: 'tok', userId: 'u1' },
      });
    });
  });

  describe('getTokensForUser', () => {
    it('returns a flat array of token strings for the user', async () => {
      prisma.deviceToken.findMany.mockResolvedValueOnce([
        { token: 'a' },
        { token: 'b' },
      ]);
      const result = await service.getTokensForUser('u1');
      expect(prisma.deviceToken.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        select: { token: true },
      });
      expect(result).toEqual(['a', 'b']);
    });

    it('returns an empty array when the user has no tokens', async () => {
      prisma.deviceToken.findMany.mockResolvedValueOnce([]);
      expect(await service.getTokensForUser('u2')).toEqual([]);
    });
  });
});
